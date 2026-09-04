# Cartograph

**Voice-Commanded Collaborative Canvas · DataForge: Pathway x Rime**

Two or more engineers talk through a system architecture out loud. The agent listens, narrates what it is drawing, and a shared canvas fills in with services and their connections in real time. Interrupt it mid-sentence and change your mind — the canvas ends up showing **exactly what you actually heard the agent say**, never what it merely intended to say.

See [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) (if present locally — it is not committed) for the full design rationale. This README is the disclosure document: what's running, how to reproduce it, and what it can't do yet.

## The claim, in one sentence

> When the user interrupts and changes the request, queued Rime audio stops promptly, in-flight tool work is fenced, stale results can never re-enter the conversation, and the shared canvas state stays consistent with the words the user actually heard.

Reported but not the headline claim: perceived response time (see [`apps/agent/src/bench/live-latency.md`](apps/agent/src/bench/live-latency.md)).

## Rime & stack disclosure

| Field | Value |
|---|---|
| Provider | Rime, via the official `@livekit/agents-plugin-rime` — the **direct plugin**, not the LiveKit Inference gateway |
| Package | `@livekit/agents-plugin-rime@1.7.1` (peer-pinned to `@livekit/agents@1.7.1`) |
| Model ID | `coda` |
| Speaker | `celeste` |
| Language | `eng` |
| Endpoint | `wss://users-ws.rime.ai/ws3?...` (WebSocket streaming) |
| Transport | Browser ↔ LiveKit WebRTC room ↔ agent worker ↔ Rime WebSocket |
| Audio format | PCM, 24 000 Hz, mono |
| Word timestamps | Yes — WebSocket mode reports `alignedTranscript: true`; verified live (`startTime`/`endTime` populated on every word) |
| Auth | `RIME_API_KEY`, server-side only (`apps/agent/.env.local`), never in `apps/web` |

**Why the plugin and not the Inference gateway:** the gateway's `RimeOptions` exposes no timestamp flag, so it never emits aligned word timings — and without those, the commit gate (the whole point of this project) has no signal to key off. The gateway path is kept in `apps/agent/src/tts.ts` as a disclosed, observable fallback (`TTS_PROVIDER=rime`): it works, but degrades commit granularity from per-sentence to per-turn since there's no word-level delivery evidence. `TTS_PROVIDER=fishaudio` is the pre-Rime baseline, kept only as a rollback path.

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

- **Generational Conversation Control** (`apps/agent/src/core/generation.ts`): every user turn gets a monotonic generation id. Interrupting fences the old one immediately — `AbortController` cancellation, plus a fencing check every async result re-validates before it's allowed to touch state.
- **Heard-State Commit Gate** (`apps/agent/src/core/commit-gate.ts`): tools never mutate the canvas directly. They stage a mutation; it only reaches the canvas once Rime has actually delivered the sentence describing it (per word-level timestamps). Interrupt mid-sentence and the undelivered mutation is dropped, permanently.
- **Canvas Divergence Oracle** (`apps/agent/src/bench/oracle.ts`): independently re-derives the expected canvas from only the heard transcript and diffs it against the actual canvas — turns "state matches what was heard" into a pass/fail with a number.

## Setup

```bash
corepack enable && corepack prepare pnpm@8.15.6 --activate
pnpm install --no-frozen-lockfile
cp apps/agent/.env.example apps/agent/.env.local
cp apps/web/.env.example apps/web/.env.local
```

Fill in both `.env.local` files: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (from https://cloud.livekit.io, or `lk cloud auth && lk app env -w -d apps/agent/.env.local`), matching `AGENT_NAME=DD_agent` in both. In `apps/agent/.env.local` also set `RIME_API_KEY` (from https://rime.ai's dashboard — the judged path, `TTS_PROVIDER=rime-plugin`, requires it).

```bash
pnpm dev            # runs the agent worker + the web frontend
```

Open http://localhost:3000, click **Start call**, and describe an architecture out loud.

### Demo/benchmark knobs

- `SLOW_TOOL_MS` (default `5000`) — artificial delay injected into staging tool calls, so an interruption race reproduces reliably instead of only sometimes.
- `CARTOGRAPH_BASELINE=true` — disables generation fencing and the commit gate entirely (mutations land the instant they're staged, regardless of whether the describing sentence was ever spoken). This is the naive-agent comparison mode; the HUD shows a **BASELINE MODE** badge when it's on.

### Benchmark

```bash
pnpm --filter DD_agent benchmark
```

Runs 45 deterministic scenarios (a `toolDelay x interruptAt x corrections` matrix) plus an explicit out-of-order case, twice each — once with fencing on, once with `CARTOGRAPH_BASELINE`'s naive behaviour — against an independent oracle. No LiveKit, no audio, no LLM: pure TypeScript, reproducible on any machine. See [`RIME_EVIDENCE.md`](RIME_EVIDENCE.md) for the actual measured numbers.

## Third-party services

- **LiveKit Cloud** — WebRTC transport, room/participant management, STT (`assemblyai/universal-3-5-pro`) and LLM (`google/gemma-4-31b-it`) via LiveKit Inference, turn detection.
- **Rime** — text-to-speech, direct WebSocket plugin.
- **AssemblyAI** and **Google** (Gemma) — reached only through LiveKit Inference, no direct API keys held by this repo.

## Known limitations

- Read-only/reversible tools only (brainstorm §26): no purchases, deletes, or emails — an irreversible external effect can't be meaningfully fenced.
- The anchor-phrase mismatch guard is a warning surfaced on the event ledger, not a block: a genuine mismatch still commits, because a hard block would turn a monitoring feature into a live-demo failure.
- Commit granularity is per-sentence, not per-word: a mutation lands once its whole describing sentence is confirmed delivered.
- The 45 generated benchmark scenarios plus one hand-scripted out-of-order case are not a production traffic distribution — they exercise the specific race the commit gate is built to close, not general robustness.
- Single-room scale; no multi-agent handoffs, no telephony, no multilingual routing (all cut deliberately — seeded in `IMPLEMENTATION_PLAN.md §2.3`, not rebuilt here since it isn't committed to the repo).
- `apps/web`'s text-chat input is not wired to trigger agent turns in this starter — voice is the only input path exercised end-to-end.

## Failure behaviour

- **Rime unreachable at construction** (`TTS_PROVIDER=rime-plugin` with no `RIME_API_KEY`): fails fast and loudly at boot — the plugin throws, the worker never starts serving jobs.
- **Rime failing mid-session**: surfaces as a TTS synthesis error in the agent log; the session does not silently fall back to another provider. The PS makes a submission ineligible if Rime is not the primary spoken output, so no silent non-Rime fallback is wired in. The disclosed fallback (`TTS_PROVIDER=rime`, the Inference gateway) is a deploy-time switch, not an automatic runtime failover, and the HUD's active-provider readout would show it if it were active.
- **Tool timeout beyond the delay budget**: not separately bounded — a stuck tool call simply never resolves; the generation fence still protects the canvas if the user moves on before it does.
- **LiveKit disconnect/reconnect**: handled by the LiveKit Agents SDK's own reconnection logic; Cartograph's state (`GenerationManager`, `CanvasStore`) lives in the worker process and is not persisted across a worker restart.
