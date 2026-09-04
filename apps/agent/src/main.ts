import { ServerOptions, cli, defineAgent, inference, voice } from '@livekit/agents';
import { audioEnhancement } from '@livekit/plugins-ai-coustics';
import { logger } from '@repo/logger';
import dotenv from 'dotenv';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createAgent } from './agent.ts';
import { CanvasStore } from './core/canvas.ts';
import { CommitGate } from './core/commit-gate.ts';
import { GenerationManager } from './core/generation.ts';
import type { LedgerEvent } from '@repo/protocol';
import { EventLedger } from './core/ledger.ts';
import { StagingBuffer } from './core/staging.ts';
import { CanvasPublisher } from './transport/publisher.ts';
import { createTTS } from './tts.ts';

// Load environment variables from a local file.
// Make sure to set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET
// when running locally or self-hosting your agent server.
dotenv.config({ path: '.env.local' });

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export default defineAgent({
  entry: async (ctx) => {
    // Pick the TTS engine (Rime by default) from TTS_PROVIDER. See src/tts.ts.
    const { tts, supportsExpressive, describe } = createTTS();
    logger.info(`[DD_agent] TTS: ${describe}`);

    // Core Cartograph engine: generation fencing, staged mutations, the
    // canvas itself, and the event ledger the browser will stream. See
    // src/core/**. Baseline mode disables fencing for the naive-agent
    // comparison the benchmark reports.
    const baselineMode = env('CARTOGRAPH_BASELINE', 'false').toLowerCase() === 'true';
    const gm = new GenerationManager({ baselineMode });
    const staging = new StagingBuffer();
    const ledger = new EventLedger();
    const canvas = new CanvasStore();
    const commitGate = new CommitGate({ canvas, staging, ledger, baselineMode });
    const slowMs = Number(env('SLOW_TOOL_MS', '5000'));

    // Bootstrap generation 1 for the initial greeting below, which has no
    // preceding user turn to open one via UserInputTranscribed.
    gm.start('');
    commitGate.startGeneration();

    // Transport to the browser: constructed once the room is connected
    // (below), so the ledger buffers/drops nothing said before that ever
    // fires this hook — see setOnPush.
    let publisher: CanvasPublisher | undefined = undefined;
    let speaking = false;
    let toolsInFlight = 0;
    let eventBuffer: LedgerEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const EVENT_FLUSH_MS = 50;

    function pushStatus(): void {
      void publisher?.send({
        kind: 'status',
        generation: gm.currentId,
        ttsProvider: describe,
        baselineMode,
        speaking,
        toolRunning: toolsInFlight > 0,
        heardText: commitGate.heardText,
      });
    }

    ledger.setOnPush((event) => {
      // Coalesce a burst of events (e.g. several mutations committed off one
      // sentence) into a single packet instead of one send per event.
      eventBuffer.push(event);
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          const events = eventBuffer;
          eventBuffer = [];
          flushTimer = undefined;
          void publisher?.send({ kind: 'events', events });
        }, EVENT_FLUSH_MS);
      }

      if (event.type === 'mutation_committed') {
        void publisher?.send({ kind: 'snapshot', snapshot: canvas.snapshot(event.generation) });
      }
      if (event.type === 'tool_started') {
        toolsInFlight += 1;
        pushStatus();
      } else if (
        event.type === 'tool_completed' ||
        event.type === 'tool_aborted' ||
        event.type === 'tool_stale_discarded'
      ) {
        toolsInFlight = Math.max(0, toolsInFlight - 1);
        pushStatus();
      } else if (event.type === 'generation_started' || event.type === 'speech_interrupted') {
        pushStatus();
      }
    });

    // Set up a voice AI pipeline using AssemblyAI, the selected TTS, and the LiveKit turn detector
    const session = new voice.AgentSession({
      // Speech-to-text (STT) is your agent's ears, turning the user's speech into text that the LLM can understand
      // See all available models at https://docs.livekit.io/agents/models/stt/
      stt: new inference.STT({
        model: 'assemblyai/universal-3-5-pro',
        language: 'en',
      }),

      // Text-to-speech (TTS) is your agent's voice, turning the LLM's text into speech that the user can hear.
      // The engine is chosen in src/tts.ts based on the TTS_PROVIDER env var (default: Rime).
      // See all available models as well as voice selections at https://docs.livekit.io/agents/models/tts/
      tts,

      turnHandling: {
        // Turn detection determines when the user is speaking and when the agent should respond.
        // The LiveKit audio turn detector is a multimodal model that encodes the user's audio
        // directly to predict end of turn. It's built into the SDK (no extra plugin) and
        // AgentSession supplies the required VAD automatically.
        // See more at https://docs.livekit.io/agents/logic/turns/turn-detector/
        turnDetection: new inference.TurnDetector(),
        // Adaptive interruptions use the turn detector to tell a real interruption from a
        // backchannel like "mhm" or "right", so the agent keeps talking through the latter.
        interruption: { mode: 'adaptive' },
        // Allow the LLM to generate a response while waiting for the end of turn
        preemptiveGeneration: { enabled: true },
      },

      // Expressive mode injects the TTS provider's markup guide into the LLM prompt so the model
      // emits inline delivery tags that the TTS renders and the transcript strips. Only
      // cartesia/fishaudio/inworld/xai support it via inference.TTS; Rime does not, so this is
      // wired to the selected provider by the factory in src/tts.ts.
      expressive: supportsExpressive,
    });

    // Start the session, which initializes the voice pipeline and warms up the models
    await session.start({
      agent: createAgent({ gm, commitGate, ledger, canvas, slowMs }),
      room: ctx.room,
      inputOptions: {
        // ai-coustics QUAIL audio enhancement for noise cancellation
        // Works for both WebRTC and telephony (SIP) participants
        noiseCancellation: audioEnhancement({ model: 'quailVfS' }),
      },
    });

    // Generational Conversation Control: fence the previous turn and open a
    // new generation the instant the user's final transcript lands.
    //
    // Ordering caveat (verified empirically — do not assume otherwise):
    // UserInputTranscribed(isFinal) and ConversationItemAdded for the
    // interrupted assistant message are NOT guaranteed to arrive in a fixed
    // order. Reading gm.currentId lazily inside the ConversationItemAdded
    // handler would sometimes read the *new* generation instead of the one
    // that was actually interrupted. pendingInterruptGeneration is captured
    // synchronously before gm advances, and is a safe fallback either way:
    // if ConversationItemAdded fires first, gm.currentId is still the old
    // (correct) generation; if UserInputTranscribed fires first, the stashed
    // value is used instead.
    let pendingInterruptGeneration: number | null = null;

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (!ev.isFinal) return;
      pendingInterruptGeneration = gm.currentId;
      gm.cancelCurrent();
      // Live latency measurement (see bench/live-latency.md): interruption -> fenced.
      logger.info(`[latency] generation_cancelled t=${Date.now()}`);
      const g = gm.start(ev.transcript);
      commitGate.startGeneration();
      ledger.push('generation_started', g.id, ev.transcript);
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const item = ev.item;
      if (item.type !== 'message' || item.role !== 'assistant') return;
      const heard = item.textContent ?? '';
      if (item.interrupted) {
        const gen = pendingInterruptGeneration ?? gm.currentId;
        pendingInterruptGeneration = null;
        commitGate.onInterrupted(gen);
        ledger.push('speech_interrupted', gen, heard);
      } else {
        commitGate.onTurnComplete(gm.currentId);
      }
    });

    session.on(voice.AgentSessionEventTypes.AgentFalseInterruption, () => {
      ledger.push('speech_started', gm.currentId, 'false interruption ignored');
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      speaking = ev.newState === 'speaking';
      pushStatus();
    });

    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.newState === 'speaking') {
        // Live latency measurement (see bench/live-latency.md): user speech start.
        logger.info(`[latency] user_speech_start t=${Date.now()}`);
      }
    });

    // // Add a virtual avatar to the session, if desired
    // // For other providers, see https://docs.livekit.io/agents/models/avatar/
    // const avatar = new anam.AvatarSession({
    //   personaConfig: {
    //     name: '...',
    //     avatarId: '...', // See https://docs.livekit.io/agents/models/avatar/plugins/anam
    //   },
    // });
    // // Start the avatar and wait for it to join
    // await avatar.start(session, ctx.room);

    // Join the room and connect to the user
    await ctx.connect();
    logger.info(`[DD_agent] Connected to room: ${ctx.room.name}`);

    // Now that the room is connected, the browser can receive the initial
    // canvas/status state and every subsequent mutation/event as it happens.
    publisher = new CanvasPublisher(ctx.room);
    void publisher.send({ kind: 'snapshot', snapshot: canvas.snapshot(gm.currentId) });
    pushStatus();

    // Greet the user on joining
    session.generateReply({
      instructions: 'Greet the user in a helpful and friendly manner.',
    });
  },
});

// Run the agent server
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: process.env.AGENT_NAME || 'DD_agent',
  }),
);
