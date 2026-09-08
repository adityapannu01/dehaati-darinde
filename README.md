# Cartograph

**Voice-Commanded Architecture Canvas · DataForge: Pathway x Rime**

An engineer thinks out loud through a system design — hands free, never breaking flow to touch a mouse. The agent listens, narrates what it is drawing, and the canvas fills in with services and their connections in real time as they talk. Self-corrections mid-sentence are treated as normal, not errors ("...writes to Redis — no, Memcached"): the canvas ends up showing **exactly what the user actually heard the agent say**, never what it merely intended to say.

This README covers what's running, how to reproduce it, and its known limitations. [`RIME_EVIDENCE.md`](RIME_EVIDENCE.md) holds the hard-voice-problem claim, acceptance test, procedure, and measured results. [`TECHNICAL_REVIEW.md`](TECHNICAL_REVIEW.md) is the design/decision log behind the commit gate.

## The claim, in one sentence

> When the user interrupts and changes the request, queued Rime audio stops promptly, in-flight tool work is fenced, stale results can never re-enter the conversation, and the shared canvas state stays consistent with the words the user actually heard.

Reported but not the headline claim: perceived response time (see [`apps/agent/src/bench/live-latency.md`](apps/agent/src/bench/live-latency.md)).

## Rime & stack disclosure

| Field | Value |
|---|---|
| Provider | Rime, via the official `@livekit/agents-plugin-rime` — the **direct plugin**, not the LiveKit Inference gateway |
| Package | `@livekit/agents-plugin-rime@1.7.1` (peer-pinned to `@livekit/agents@1.7.1`) |
| Model ID | `coda` |
| Speaker / Language | `celeste` / `eng` — English only (see below) |
| Endpoint | `wss://users-ws.rime.ai/ws3?...` (WebSocket streaming), US West (`us-west-2`) by default — `RIME_BASE_URL` switches to `wss://users-east-ws.rime.ai` (US East) |
| Transport | Browser ↔ LiveKit WebRTC room ↔ agent worker ↔ Rime WebSocket |
| Audio format | PCM, 24,000 Hz, mono |
| Word timestamps | **Yes** (verified live) — this is what drives the commit gate |
| Auth | `RIME_API_KEY`, server-side only (`apps/agent/.env.local`), never exposed to the browser |
| Catalog check | `pnpm --filter DD_agent test tts.preflight` verifies `coda`/`celeste`/`eng` against Rime's live voice catalog |

**Why the direct plugin and not the Inference gateway:** the gateway's `RimeOptions` exposes no timestamp flag, so it never emits aligned word timings — and without those, the commit gate has no signal to key off. The gateway path is kept in `apps/agent/src/tts.ts` as a disclosed, observable fallback (`TTS_PROVIDER=rime`), at reduced commit granularity (per-turn instead of per-sentence).

**English only, deliberately.** Rime Coda emits word-level timestamps only for English (verified: 17/17 timed words in English vs. 0/0 in Hindi and Japanese at equivalent length). A multilingual mode was built and then removed rather than ship the commit gate — the mechanism the whole product rests on — in a degraded state for every other language. See [`RIME_EVIDENCE.md`](RIME_EVIDENCE.md) for the measurement.

## Architecture

The agent owns canvas state; the browser is a pure renderer.

```
browser mic → LiveKit room → DD_agent worker
                                  │
                    STT → GenerationManager → LLM
                                  │              │
                                  ▼              ▼
                          fenced tools      Rime TTS (WebSocket)
                                  │              │
                          StagedMutations   word timestamps
                                  └──────┬───────┘
                                         ▼
                                   CommitGate
                                         │
                                         ▼
                                  CanvasStore ── truth
                                         │  publishData(topic: "cartograph")
                                         ▼
                          browser: @xyflow/react renderer
```

- **Generational conversation control** (`apps/agent/src/core/generation.ts`): every user turn gets a monotonic generation id. Interrupting fences the previous one immediately — `AbortController` cancellation, plus a re-validation check before any async result is allowed to touch state. Backchannels ("mm-hmm", "yeah") are classified separately and don't roll the generation, so the mutation whose sentence is still being spoken is never orphaned.
- **Heard-state commit gate** (`apps/agent/src/core/commit-gate.ts`): tools never mutate the canvas directly. They stage a mutation; it only reaches the canvas once Rime has actually delivered the sentence describing it, per word-level timestamps. Interrupting mid-sentence drops the undelivered mutation permanently. Every staged mutation resolves to exactly one terminal state — committed or dropped, never orphaned.
- **Canvas divergence oracle** (`apps/agent/src/bench/oracle.ts`): independently re-derives the expected canvas from only the heard transcript and diffs it against the actual canvas.
- **Layered layout** (`apps/agent/src/core/layout.ts`): the agent recomputes an ELK `layered` layout after every committed mutation and re-publishes node positions; the browser animates nodes into place.
- **Word-synced forming nodes**: Rime's aligned word timestamps are forwarded to the browser, and a staged-but-uncommitted node renders "forming" (dashed, translucent), going solid the instant its sentence commits.
- **Pronunciation lexicon** (`apps/agent/src/core/lexicon.ts`): applied after the LLM and before Rime, so infrastructure terms (e.g. `nginx` → "engine ex") are pronounced correctly without ever touching the transcript, ledger, or canvas.
- **Ambient meeting mode** (`ADDRESSIVITY=true`): every overheard utterance is scored on two independent axes — *addressed* (should the agent speak) and *salient* (should it draw). Overheard speech can only ever create or destroy proposals; committed canvas state changes only on speech addressed to the agent.

## Setup

```bash
corepack enable && corepack prepare pnpm@8.15.6 --activate
pnpm install --no-frozen-lockfile
cp apps/agent/.env.example apps/agent/.env.local
cp apps/web/.env.example apps/web/.env.local
```

Fill in both `.env.local` files: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (from https://cloud.livekit.io), matching `AGENT_NAME=DD_agent` in both. In `apps/agent/.env.local`, also set `RIME_API_KEY` (from https://rime.ai's dashboard).

```bash
pnpm dev            # runs the agent worker + the web frontend
```

Open http://localhost:3000, click **Start call**, and describe an architecture out loud.

### What the agent can draw

`addService` · `connectServices` (with `flow: sync|async` and `bidirectional`) · `replaceComponent` · `renameComponent` · `removeComponent` · `groupComponents` (a labelled boundary — VPC, trust boundary, bounded context) · `undoLast` · `clearCanvas` · `exportDiagram` (a copyable Mermaid panel) · `explainComponent` (a real network lookup) · `describeArchitecture` (read the diagram back).

Nodes get real vendor logos (Iconify) matched from their labels. `?sketch=1` on the URL flips node borders to a hand-drawn rough.js style.

### Demo/benchmark knobs

- `SLOW_TOOL_MS` (default `0`) — artificial delay injected into staging tool calls, so an interruption race reproduces reliably.
- `CARTOGRAPH_BASELINE=true` — disables generation fencing and the commit gate entirely, for a naive-agent comparison. The HUD shows a **BASELINE MODE** badge when on.
- `ADDRESSIVITY=true` (+ `ADDRESSIVITY_THRESHOLD`, default `0.6`) — ambient meeting mode.
- `RIME_SAVE_OOVS=true` — log Rime's out-of-vocabulary words for a pronunciation-harness session. `RIME_BASE_URL` switches the Rime WebSocket region.
- `LAYOUT_DIRECTION` (`RIGHT` | `DOWN`) · `COMPONENT_LOOKUP=fixture` (skip the network for `explainComponent`).

### Benchmark

```bash
pnpm --filter DD_agent benchmark
```

Runs 48 deterministic scenarios (a `toolDelay × interruptAt × corrections` matrix, plus backchannel-during-narration cases) plus an explicit out-of-order case, twice each — once with fencing on, once with `CARTOGRAPH_BASELINE`'s naive behaviour — against an independent oracle. No LiveKit, no audio, no LLM: pure TypeScript, reproducible on any machine. See [`RIME_EVIDENCE.md`](RIME_EVIDENCE.md) for measured numbers.

Live interruption/recovery latency: `pnpm --filter DD_agent dev 2>&1 | tee /tmp/agent.log`, hold a call with real interruptions, then `pnpm --filter DD_agent latency < /tmp/agent.log` — see [`apps/agent/src/bench/live-latency.md`](apps/agent/src/bench/live-latency.md).

Other harnesses: `pnpm --filter DD_agent pronunciation` (44 infra terms through the shipped Rime path → clips + `bench/pronunciation/REPORT.md`); `pnpm --filter DD_agent addressivity` (confusion matrix → `bench/ADDRESSIVITY_MATRIX.md`); `pnpm --filter DD_agent tts-comparison` (blinded comparison against Cartesia and Fish Audio → `bench/tts-comparison/REPORT.md`, see [`RIME_EVIDENCE.md`](RIME_EVIDENCE.md) for the summary).

## Third-party services

- **LiveKit Cloud** — WebRTC transport, room/participant management, STT (`assemblyai/universal-3-5-pro`) and LLM (`google/gemma-4-31b-it`) via LiveKit Inference, turn detection.
- **Rime** — text-to-speech, direct WebSocket plugin.
- **AssemblyAI** and **Google** (Gemma) — reached only through LiveKit Inference, no direct API keys held by this repo.

## Third-party UI sources

The aesthetic layer copies component source (not a runtime dependency) from:

- **[React Bits](https://reactbits.dev)** ([GitHub](https://github.com/DavidHDev/react-bits)) — MIT + Commons Clause. `BlurText`, `SplitFlapText`, `DotGrid` (`apps/web/components/`), each modified after copying.

## Known limitations

- Read-only/reversible tools only: no purchases, deletes, or emails. `clearCanvas` is destructive-looking but fully reversible and gated on its own sentence like any mutation.
- Commit granularity is per-sentence, not per-word: a mutation lands once its whole describing sentence is confirmed delivered. The "forming node" reveal is per-word, but that's a preview of the in-progress sentence.
- With a slow tool, a mutation commits when the tool completes rather than at the instant its sentence ends — heard-correct, but not always visually instantaneous. `SLOW_TOOL_MS` defaults to `0` outside the interruption stress demo.
- The 48 generated benchmark scenarios exercise the specific race the commit gate is built to close, not general robustness at large scale.
- A backchannel is classified lexically with a 2-word floor. A single-word command outside the hard-interrupt list (e.g. "bigger") is treated as a backchannel and won't fence until the user says more.
- Live interruption/recovery latency, measured across two independent real sessions: fence ~2.5s median / 4.3-4.6s p95, recovery ~3.7-4.0s median / 6.2-7.3s p95. Recovery latency (LLM + TTS round-trip) is a live optimization target. Full tables in `apps/agent/src/bench/live-latency.md`.
- Queued Rime audio stops within tens of milliseconds of a fencing decision (median 13ms, p95 25ms, n=7 real interruptions) — measured directly against the LiveKit SDK's own playback-stopped confirmation, not assumed from the architecture. See `RIME_EVIDENCE.md`.
- Single-room scale; no multi-agent handoffs, no telephony.
- **English only** — see the Rime disclosure above and `RIME_EVIDENCE.md` for the measurement behind it.
- Ambient meeting mode (`ADDRESSIVITY=true`) is unvalidated with two live browser tabs: the classifier, proposal store, and safety invariant are unit-tested and audio-independent, but the multi-participant STT path has not been exercised with real audio. Classifier F1 on a synthetic fixture: salient 0.92, addressed precision 1.0 / recall 0.30.
- This submission does not claim multi-user collaboration. Cartograph is presented as a single-operator tool — one person, thinking out loud.
- `apps/web`'s text-chat input is not wired to trigger agent turns in this starter — voice is the only input path exercised end-to-end.
- Rime reaches first audio slower than some alternative providers in the LiveKit Inference ecosystem (see `RIME_EVIDENCE.md`) — a known, disclosed, and root-caused gap that is not fixed in this submission because doing so would mean touching the exact code path the commit gate's word timestamps depend on, this close to submission.

## Failure behaviour

- **Rime unreachable at construction** (no `RIME_API_KEY`): fails fast and loudly at boot — the plugin throws, the worker never starts serving jobs.
- **Rime failing mid-session**: surfaces as a TTS synthesis error in the agent log; the session does not silently fall back to another provider, so Rime always stays the primary spoken output. The disclosed fallback (`TTS_PROVIDER=rime`, the Inference gateway) is a deploy-time switch, not an automatic runtime failover.
- **Tool timeout beyond the delay budget**: not separately bounded — a stuck tool call simply never resolves; the generation fence still protects the canvas if the user moves on before it does.
- **LiveKit disconnect/reconnect**: handled by the LiveKit Agents SDK's own reconnection logic; Cartograph's state lives in the worker process and is not persisted across a worker restart.
