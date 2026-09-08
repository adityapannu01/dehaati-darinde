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
import { AmbientListener } from './core/ambient-listener.ts';
import type { AddressivityContext } from './core/addressivity.ts';
import { classifyUtterance, route } from './core/addressivity.ts';
import { INFRA_KEYTERMS } from './core/lexicon.ts';
import { EventLedger } from './core/ledger.ts';
import { layoutCanvas } from './core/layout.ts';
import { ProposalStore } from './core/proposals.ts';
import { StagingBuffer } from './core/staging.ts';
import { ACK_TOKENS, isBackchannel } from './core/turn-taking.ts';
import { CanvasPublisher } from './transport/publisher.ts';
import { createTTS } from './tts.ts';
import { resolveLLMEngine } from './graph/config.ts';
import { makeAddressModel } from './graph/nodes/address.ts';

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

// Best-effort component name from an overheard utterance, for a ghost proposal
// (§2). A ghost is low-stakes by design — a planner pass would give a cleaner
// label but costs an LLM call per overheard sentence. Grabs the noun phrase
// after an article, capped at 4 words, dropping a trailing preposition.
const INFRA_HINT =
  /\b(service|gateway|api|database|db|datastore|cache|queue|bus|broker|balancer|proxy|cdn|bucket|worker|cluster|node|endpoint|topic|stream|lambda|function|frontend|backend|redis|postgres|kafka|mongo|mysql|dynamo|nginx|s3|rabbitmq|sqs|sns|elasticsearch|clickhouse)\b/i;
function ghostLabelFrom(utterance: string): string | null {
  const m = utterance.match(/\b(?:a|an|the)\s+([A-Za-z0-9][\w-]*(?:\s+[A-Za-z0-9][\w-]*){0,3})/);
  const phrase = m?.[1]?.replace(/\s+(in|on|to|for|from|between|behind|of|and|that)$/i, '').trim();
  if (phrase && INFRA_HINT.test(`${phrase} ${utterance}`)) {
    return phrase.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return null;
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
    // ROUND3 B2: on by default — it's a free perceived-latency win. Off for the
    // latency A/B and for anyone who finds it chatty.
    const ackEnabled = env('ACK_ON_INTERRUPT', 'true').toLowerCase() === 'true';
    let ackIndex = 0;
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

    // §2: ambient meeting mode. Off by default — it needs a two-browser-tab
    // live check (TECHNICAL_REVIEW.md §2.2) that hasn't happened. When on, a
    // second engineer's overheard speech can only ever create or destroy
    // *proposals* (ghosts); committed state still changes only on addressed
    // speech. See core/addressivity.ts + core/proposals.ts.
    const addressivityEnabled = env('ADDRESSIVITY', 'false').toLowerCase() === 'true';
    const addressivityThreshold = Number(env('ADDRESSIVITY_THRESHOLD', '0.6'));
    const proposals = new ProposalStore();
    const addressModel = addressivityEnabled ? makeAddressModel(env('GRAPH_LLM_MODEL', 'google/gemma-4-31b-it')) : undefined;
    const recentUtterances: { speaker: string; text: string; atMs: number }[] = [];
    let agentLastSaid: string | undefined;
    let agentAskedQuestion = false;
    const noteUtterance = (speaker: string, text: string): void => {
      recentUtterances.push({ speaker, text, atMs: Date.now() });
      const cutoff = Date.now() - 12_000;
      while (recentUtterances.length > 12 || (recentUtterances[0] && recentUtterances[0].atMs < cutoff)) {
        recentUtterances.shift();
      }
    };

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
    // ROUND3 A1: LAYOUT_DIRECTION is only the INITIAL value now — arrangeLayout
    // changes it per session, and relayout() reads it from the snapshot.
    const initialLayoutDirection: 'RIGHT' | 'DOWN' | 'LEFT' | 'UP' =
      (['RIGHT', 'DOWN', 'LEFT', 'UP'] as const).find((d) => d === env('LAYOUT_DIRECTION', 'RIGHT')) ??
      'RIGHT';
    if (initialLayoutDirection !== 'RIGHT') canvas.setInitialDirection(initialLayoutDirection);
    let layoutSeq = 0;
    async function relayout(): Promise<void> {
      const mySeq = ++layoutSeq;
      const snap = canvas.snapshot(gm.currentId);
      let placements;
      try {
        // A2: groups go to ELK so members cluster inside their box; A1: direction
        // from the store, not a boot constant.
        placements = await layoutCanvas(snap.nodes, snap.edges, snap.groups, snap.direction);
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

    function publishGhosts(): void {
      if (!addressivityEnabled) return;
      void publisher?.send({ kind: 'ghosts', ghosts: proposals.list() });
      pushStatus();
    }

    /**
     * §2: classify one overheard utterance from a non-primary participant and
     * act on it. Never commits — the strongest thing it can do is create a
     * proposal or reject one.
     */
    async function handleOverheard(speaker: string, text: string): Promise<void> {
      noteUtterance(speaker, text);
      const ctxForClassify: AddressivityContext = {
        recent: recentUtterances.slice(-8),
        agentRecentlySaid: agentLastSaid,
        agentAskedQuestion,
        canvasVocabulary: canvas.snapshot(0).nodes.map((n) => n.label),
        threshold: addressivityThreshold,
      };
      const score = await classifyUtterance(text, ctxForClassify, addressModel);
      const decision = route(score, addressivityThreshold);
      ledger.push(
        'utterance_scored',
        gm.currentId,
        `${speaker}: addressed=${score.addressed.toFixed(2)} salient=${score.salient.toFixed(2)} stance=${score.stance} (${score.by})`,
      );

      // A disagreement removes matching proposals — never a committed node.
      if (score.stance === 'disagree') {
        for (const g of proposals.rejectMatching(text)) {
          ledger.push('proposal_rejected', gm.currentId, `${g.label} (heard "${text.slice(0, 40)}")`);
        }
        publishGhosts();
      }

      // Not addressed + architecture content -> a silent proposal. Overheard
      // speech never draws on the committed canvas and never speaks (§2.7:
      // narrating every overheard idea would be intolerable). The browser plays
      // a soft earcon when a ghost lands.
      if (decision.draw && !decision.speak) {
        // Reuse the graph planner would be ideal; for the ghost we take the
        // whole utterance as the label candidate, trimmed to a noun phrase by
        // the classifier's own salience having already passed.
        const label = ghostLabelFrom(text);
        if (label) {
          const g = proposals.propose({
            element: 'node',
            label,
            proposedBy: speaker,
            confidence: score.salient,
          });
          ledger.push('proposal_created', gm.currentId, `${g.label} by ${speaker}`);
          publishGhosts();
        }
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
        addressivity: addressivityEnabled
          ? { enabled: true, threshold: addressivityThreshold, ghostCount: proposals.list().length }
          : { enabled: false },
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
      // §2: a committed mutation supersedes any matching proposal — the primary
      // confirmed it (or the agent drew it), so the ghost is now real.
      if (addressivityEnabled && event.type === 'mutation_committed') {
        let cleared = false;
        for (const n of canvas.snapshot(0).nodes) {
          for (const g of proposals.rejectMatching(n.label)) {
            ledger.push('proposal_promoted', gm.currentId, `${g.label} committed`);
            cleared = true;
          }
        }
        if (cleared) publishGhosts();
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
        // Bias recognition toward the infra vocabulary the lexicon respells for
        // TTS — so "nginx"/"etcd" are recognised too, not just pronounced (§3.5).
        modelOptions: { keyterms_prompt: [...INFRA_KEYTERMS] },
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
        { gm, commitGate, ledger, canvas, slowMs, publish: (msg) => void publisher?.send(msg) },
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
      // §2: keep the addressed participant's turns in the rolling context
      // window, and let their disagreement clear a matching proposal (a
      // primary "no, not Kafka" is as good as an overheard one).
      if (addressivityEnabled && ev.transcript.trim()) {
        noteUtterance('user', ev.transcript);
        if (/\b(no|not|don'?t|scratch that|never mind|instead)\b/i.test(ev.transcript)) {
          for (const g of proposals.rejectMatching(ev.transcript)) {
            ledger.push('proposal_rejected', gm.currentId, `${g.label} (primary)`);
          }
          publishGhosts();
        }
      }
      // B1: a backchannel ("mm-hmm", "yeah", "right") must NOT roll the
      // generation. LiveKit's adaptive interruption already keeps the agent
      // talking through it; rolling here anyway resets the delivery tracker and
      // silently orphans the mutation whose sentence is still being spoken.
      // The word-count floor matches turnHandling.interruption.minWords so the
      // two layers agree — see core/turn-taking.ts.
      if (isBackchannel(ev.transcript, { minWords: INTERRUPTION_MIN_WORDS, agentSpeaking: speaking })) {
        ledger.push('speech_started', gm.currentId, `backchannel ignored: "${ev.transcript}"`);
        return;
      }
      // A generation that spoke literally zero words before being superseded
      // (cut off before the agent said anything at all) never gets a
      // ConversationItemAdded from the SDK — it only inserts a chat message
      // when some text was actually forwarded. Without this, its staged
      // mutations (if a tool call resolved fast enough to stage one) never
      // reach a terminal state: a real orphan, invisible on the canvas but a
      // genuine violation of "every staged mutation resolves" (live-observed
      // 2026-09-08). Resolve it here instead of waiting for an event that will
      // never come. Safe unconditionally: zero spoken words can only mean "cut
      // off before speaking," never "completed normally" — that requires
      // having actually said the reply — so there's no ambiguity the way
      // there would be if some words had been delivered (that case is already
      // handled correctly by ConversationItemAdded below).
      if (commitGate.spokenText.trim() === '') {
        commitGate.onInterrupted(gm.currentId);
      }
      pendingInterruptGeneration = gm.currentId;
      gm.cancelCurrent();
      // Live latency measurement (see bench/live-latency.md): interruption -> fenced.
      logger.info(`[latency] generation_cancelled t=${Date.now()}`);
      const g = gm.start(ev.transcript);
      commitGate.startGeneration();
      ledger.push('generation_started', g.id, ev.transcript);

      // ROUND3 B2: an instant acknowledgement while the LLM plans — the biggest
      // *perceived* latency win, at zero real latency. It carries NO mutation,
      // stages nothing, and (critically) ends WITHOUT sentence punctuation so
      // DeliveryTracker never counts it as sentence 0 — which would commit the
      // reply's first mutation before its describing sentence. addToChatCtx:
      // false keeps it out of the conversation history. One token, never two.
      if (ackEnabled) {
        const ack = ACK_TOKENS[ackIndex++ % ACK_TOKENS.length]!;
        void session.say(ack, { addToChatCtx: false, allowInterruptions: true });
        ledger.push('speech_started', g.id, `ack "${ack}"`);
      }
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const item = ev.item;
      if (item.type !== 'message' || item.role !== 'assistant') return;
      const heard = item.textContent ?? '';
      if (addressivityEnabled && heard.trim()) {
        agentLastSaid = heard;
        agentAskedQuestion = /\?\s*$/.test(heard.trim());
        noteUtterance('agent', heard);
      }
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

    // §2.2: hear the OTHER engineers in the room. AgentSession only listens to
    // its bound participant; this runs a separate STT stream per extra
    // participant and routes every final transcript through the classifier.
    // ⚠️ Not yet validated with two live browser tabs.
    if (addressivityEnabled) {
      logger.info(`[DD_agent] addressivity ON (τ=${addressivityThreshold})`);
      const ambientStt = new inference.STT({
        model: 'assemblyai/universal-3-5-pro',
        language: 'en',
        modelOptions: { keyterms_prompt: [...INFRA_KEYTERMS] },
      });
      const listener = new AmbientListener({
        room: ctx.room,
        agentIdentity: ctx.room.localParticipant?.identity ?? 'agent',
        // The participant AgentSession bound its own STT to (RoomIO internals —
        // there's no public accessor in 1.7.1).
        primaryIdentity: () => session._roomIO?.linkedParticipant?.identity ?? undefined,
        makeSttStream: () => ambientStt.stream(),
        onUtterance: ({ speaker, text }) => {
          void handleOverheard(speaker, text).catch((err) =>
            logger.warn(`[ambient] handleOverheard failed: ${String(err)}`),
          );
        },
        logger: { info: (m) => logger.info(m), warn: (m) => logger.warn(m) },
      });
      listener.start();
      const sweep = setInterval(() => {
        const expired = proposals.expire();
        if (expired.length > 0) {
          for (const g of expired) ledger.push('proposal_expired', gm.currentId, g.label);
          publishGhosts();
        }
      }, 5_000);
      ctx.addShutdownCallback(async () => {
        clearInterval(sweep);
        listener.stop();
      });
    }

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
