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
import { layoutCanvas } from './core/layout.ts';
import { StagingBuffer } from './core/staging.ts';
import { isBackchannel } from './core/turn-taking.ts';
import { CanvasPublisher } from './transport/publisher.ts';
import { createTTS } from './tts.ts';
import { resolveLLMEngine } from './graph/config.ts';

// Minimum words in a final transcript for it to count as an interruption rather
// than a backchannel. Wired into both turnHandling.interruption.minWords (so
// LiveKit itself ignores shorter utterances for interruption) and the B1 fence
// gate in core/turn-taking.ts (so our generation counter agrees).
const INTERRUPTION_MIN_WORDS = 2;
// Minimum speech length (ms) to register as an interruption — filters coughs,
// chair scrapes, door slams. LiveKit's own default is 500; kept explicit here.
const INTERRUPTION_MIN_DURATION_MS = 500;

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

    // Kill switch for the LangGraph planner: 'direct' (default) is today's
    // single inference.LLM call; 'graph' routes through CanvasAgent.llmNode.
    // Resolved (and thrown on if invalid) at boot, same pattern as TTS_PROVIDER.
    const llmEngine = resolveLLMEngine();
    logger.info(`[DD_agent] LLM engine: ${llmEngine}`);

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
    // 0 on the normal/judged path — a 5s artificial delay per edit both loses
    // the staging-vs-delivery race (mutations batch at turn end instead of
    // landing with their sentence) and is just bad product. Set SLOW_TOOL_MS
    // explicitly for the interruption stress demo and the benchmark.
    const slowMs = Number(env('SLOW_TOOL_MS', '0'));

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

    // B4: layered layout, recomputed after every committed mutation.
    const layoutDirection = env('LAYOUT_DIRECTION', 'RIGHT') === 'DOWN' ? 'DOWN' : 'RIGHT';
    let layoutSeq = 0;
    async function relayout(): Promise<void> {
      const mySeq = ++layoutSeq;
      const snap = canvas.snapshot(gm.currentId);
      let placements;
      try {
        placements = await layoutCanvas(snap.nodes, snap.edges, layoutDirection);
      } catch (err) {
        logger.warn(`[layout] ELK failed, keeping current positions: ${String(err)}`);
        return;
      }
      // A newer commit already kicked its own relayout — its result wins.
      if (mySeq !== layoutSeq) return;
      if (canvas.applyLayout(placements)) {
        void publisher?.send({ kind: 'snapshot', snapshot: canvas.snapshot(gm.currentId) });
      }
    }

    function pushStatus(): void {
      void publisher?.send({
        kind: 'status',
        generation: gm.currentId,
        ttsProvider: describe,
        llmEngine,
        baselineMode,
        speaking,
        toolRunning: toolsInFlight > 0,
        heardText: commitGate.heardText,
        spokenText: commitGate.spokenText,
        pendingText: commitGate.pendingText,
      });
    }

    ledger.setOnPush((event) => {
      logger.info(`[ledger] ${event.type} gen=${event.generation} ${event.detail ?? ''}`);
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
        const snap = canvas.snapshot(event.generation);
        logger.info(
          `[publish] snapshot v${snap.version} nodes=${snap.nodes.length} edges=${snap.edges.length} publisher=${publisher ? 'ready' : 'MISSING'}`,
        );
        void publisher?.send({ kind: 'snapshot', snapshot: snap });
        // B4: re-run the layered layout now that the graph changed, then
        // publish the repositioned snapshot. Async and superseding — a burst of
        // commits collapses to one final layout, and the browser animates
        // nodes to their new places (a diagram that reflows as it grows).
        void relayout();
      }
      // §3.3: keep the browser's "forming" set in sync with what is staged but
      // not yet committed, so a node can render as its sentence is spoken.
      if (
        event.type === 'mutation_staged' ||
        event.type === 'mutation_committed' ||
        event.type === 'mutation_dropped' ||
        event.type === 'generation_started'
      ) {
        void publisher?.send({
          kind: 'staging',
          generation: gm.currentId,
          elements: commitGate.formingElements(gm.currentId),
        });
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
        // minWords / minDuration raise the floor so grunts, single filler words, coughs and
        // chair noise never register as an interruption (B2). resumeFalseInterruption +
        // falseInterruptionTimeout (both at their LiveKit defaults, pinned here) recover the
        // agent's speech if a pause turns out to be nothing. The B1 fence in
        // UserInputTranscribed applies the same minWords floor so the two layers agree.
        interruption: {
          mode: 'adaptive',
          minWords: INTERRUPTION_MIN_WORDS,
          minDuration: INTERRUPTION_MIN_DURATION_MS,
          resumeFalseInterruption: true,
          falseInterruptionTimeout: 2000,
        },
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
      agent: createAgent(
        { gm, commitGate, ledger, canvas, slowMs },
        {
          // §3.3: forward Rime's aligned word timings to the browser so a
          // forming node's label reveal can finish exactly as the word is said.
          onSpokenWord: (generation, word) => {
            void publisher?.send({
              kind: 'word',
              generation,
              text: word.text,
              startTime: word.startTime,
              endTime: word.endTime,
            });
          },
        },
      ),
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
      // B1: a backchannel ("mm-hmm", "yeah", "right") must NOT roll the
      // generation. LiveKit's adaptive interruption already keeps the agent
      // talking through it; rolling here anyway resets the delivery tracker and
      // silently orphans the mutation whose sentence is still being spoken.
      // The word-count floor matches turnHandling.interruption.minWords so the
      // two layers agree — see core/turn-taking.ts.
      if (isBackchannel(ev.transcript, { minWords: INTERRUPTION_MIN_WORDS })) {
        ledger.push('speech_started', gm.currentId, `backchannel ignored: "${ev.transcript}"`);
        return;
      }
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

    session.on(voice.AgentSessionEventTypes.AgentFalseInterruption, (ev) => {
      // LiveKit paused the agent on a suspected interruption, waited out
      // falseInterruptionTimeout with no real follow-up, and is resuming. If we
      // fenced that generation on the transcript event, restore it so its
      // resumed speech is `current` again and its staged mutations can still
      // commit (B1 fix b). We deliberately do NOT reset the delivery tracker
      // here — the resumed audio rebuilds it, and the eventual
      // ConversationItemAdded(interrupted=false) flushes anything still pending
      // via onTurnComplete. A false interruption means the whole reply WAS
      // heard, so committing all of it on turn-end is correct.
      const gen = pendingInterruptGeneration ?? gm.currentId;
      commitGate.unfence(gen);
      if (pendingInterruptGeneration !== null) {
        gm.restore(pendingInterruptGeneration);
      }
      pendingInterruptGeneration = null;
      ledger.push('speech_started', gen, `false interruption (resumed=${ev.resumed})`);
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

// Run the agent server.
// AGENT_NAME set -> explicit dispatch (worker only joins rooms that request it
// by name). AGENT_NAME empty/unset -> automatic dispatch (worker joins every
// room). Local dev uses automatic so a frontend token doesn't need a matching
// RoomAgentDispatch to get the agent in the room.
const agentName = process.env.AGENT_NAME;
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    ...(agentName ? { agentName } : {}),
  }),
);
