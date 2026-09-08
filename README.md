# Cartograph

**Voice-Commanded Architecture Canvas · DataForge: Pathway x Rime**

An engineer thinks out loud through a system design — hands free, never breaking flow to touch a mouse. The agent listens, narrates what it is drawing, and the canvas fills in with services and their connections in real time as they talk. They correct themselves mid-sentence constantly, the way anyone does when thinking aloud ("...writes to Redis — no, Memcached") — and the canvas ends up showing **exactly what they actually heard the agent say**, never what it merely intended to say.

See [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) (if present locally — it is not committed) for the full design rationale. This README is the disclosure document: what's running, how to reproduce it, and what it can't do yet.

## The claim, in one sentence

> When the user interrupts and changes the request, queued Rime audio stops promptly, in-flight tool work is fenced, stale results can never re-enter the conversation, and the shared canvas state stays consistent with the words the user actually heard.

Reported but not the headline claim: perceived response time (see [`apps/agent/src/bench/live-latency.md`](apps/agent/src/bench/live-latency.md)).

## Rime & stack disclosure

| Field | Value |
|---|---|
| Provider | Rime, via the official `@livekit/agents-plugin-rime` — the **direct plugin**, not the LiveKit Inference gateway |
| Package | `@livekit/agents-plugin-rime@1.7.1` (peer-pinned to `@livekit/agents@1.7.1`) |
| Model ID | `coda` (all languages) |
| Endpoint | `wss://users-ws.rime.ai/ws3?...` (WebSocket streaming) |
| Transport | Browser ↔ LiveKit WebRTC room ↔ agent worker ↔ Rime WebSocket |
| Audio format | PCM, 24 000 Hz, mono |
| Auth | `RIME_API_KEY`, server-side only (`apps/agent/.env.local`), never in `apps/web` |

**Speaker / language matrix** (the single-language row became a matrix once `RIME_MULTILINGUAL` was added — see `RIME_EVIDENCE.md §4a` for the full one):

| Language | Speaker | `lang` | Word timestamps | Commit gate | Tested |
|---|---|---|---|---|---|
| English | `celeste` | `eng` | **yes** (verified live) | per-sentence | **yes** |
| Hindi | `nadi` | `hin` | **no** (§0 spike) | degraded — `onTurnComplete` | **yes** |
| es / fr / de / it / ja / pt / ar | mapped in `voices.ts` | — | not verified | degraded | no |

**Why the plugin and not the Inference gateway:** the gateway's `RimeOptions` exposes no timestamp flag, so it never emits aligned word timings — and without those, the commit gate (the whole point of this project) has no signal to key off. The gateway path is kept in `apps/agent/src/tts.ts` as a disclosed, observable fallback (`TTS_PROVIDER=rime`): it works, but degrades commit granularity from per-sentence to per-turn since there's no word-level delivery evidence. `TTS_PROVIDER=fishaudio` is the pre-Rime baseline, kept only as a rollback path.

**Multilingual is off by default and, for non-English, degraded** — the §0 spike found Coda returns word timestamps only for English, so a Hindi turn commits at turn granularity, not per sentence. English is unaffected. See `RIME_EVIDENCE.md §4a`.

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

- **Generational Conversation Control** (`apps/agent/src/core/generation.ts`): every user turn gets a monotonic generation id. Interrupting fences the old one immediately — `AbortController` cancellation, plus a fencing check every async result re-validates before it's allowed to touch state. A backchannel ("mm-hmm", "yeah") is classified in `apps/agent/src/core/turn-taking.ts` and does **not** roll the generation — LiveKit's adaptive interruption keeps the agent talking through it, and so do we, so the mutation whose sentence is still being spoken is never orphaned.
- **Heard-State Commit Gate** (`apps/agent/src/core/commit-gate.ts`): tools never mutate the canvas directly. They stage a mutation; it only reaches the canvas once Rime has actually delivered the sentence describing it (per word-level timestamps). Interrupt mid-sentence and the undelivered mutation is dropped, permanently. Every staged mutation ends in exactly one terminal state (committed or dropped) — `orphanedMutationIds` asserts silent orphaning is impossible, and the benchmark checks it on every scenario.
- **Canvas Divergence Oracle** (`apps/agent/src/bench/oracle.ts`): independently re-derives the expected canvas from only the heard transcript and diffs it against the actual canvas — turns "state matches what was heard" into a pass/fail with a number.
- **Layered layout** (`apps/agent/src/core/layout.ts`): the agent recomputes an ELK `layered` layout after every committed mutation and re-publishes node positions; the browser animates nodes to their new places. The agent stays the sole owner of positions.
- **Word-synced forming nodes** (`{ kind: 'word' | 'staging' }` on the data channel): Rime's aligned word timestamps are forwarded to the browser, and a staged-but-uncommitted node renders "forming" (dashed, translucent) — firming up as the word naming it is spoken, going solid when its sentence commits it.
- **Pronunciation harness** (`apps/agent/src/bench/pronunciation/`): 44 infrastructure terms rendered through the shipped `coda:celeste` WebSocket path in two spellings each, with `saveOovs` on. Clips + a wording table are committed; `pnpm --filter DD_agent pronunciation` regenerates.
- **Ambient meeting mode** (`ADDRESSIVITY=true`, `apps/agent/src/core/{addressivity,proposals,ambient-listener}.ts`): every overheard utterance is scored on two independent axes — *addressed* (→ the agent speaks) and *salient* (→ it draws). A colleague's idea becomes a dashed **ghost** proposal, promoted to committed state only when a human confirms it or the agent narrates it, removed by a disagreement or a timeout. **Overheard speech can only ever create or destroy proposals — committed state changes only on addressed speech.**
- **Multilingual** (`RIME_MULTILINGUAL=true`, `apps/agent/src/core/language-router.ts` + `voices.ts`): AssemblyAI detects the language per turn; a two-turn-hysteresis router swaps the Coda speaker + `lang` between turns (never mid-utterance). The `DeliveryTracker` counts non-Latin sentence terminators (`।` `。` `？` `؟`). Component names stay Latin in every language. Non-English is a documented degraded mode — see the disclosure above.
- **Pronunciation lexicon** (`apps/agent/src/core/lexicon.ts`): applied at the `ttsNode` tap, buffered to sentence boundaries, after the model and before Rime — the transcript, ledger and canvas keep real spellings. Both sides of the commit gate's anchor check run through the same lexicon so a respelled term (`nginx` → `engine ex`) never trips `anchor_mismatch`. The infra term list also feeds the STT `keyterms_prompt`.

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

### What the agent can draw

`addService` · `connectServices` (with `flow: sync|async` and `bidirectional`) · `replaceComponent` · `renameComponent` · `removeComponent` · `groupComponents` (a labelled boundary — VPC, trust boundary, bounded context) · `undoLast` (reverse the last committed change) · `clearCanvas` (one atomic wipe) · `exportDiagram` (a copyable Mermaid panel) · `explainComponent` (a real network lookup with a bundled fixture) · `describeArchitecture` (read the diagram back).

Nodes get real vendor logos (Iconify) matched from their labels. `?sketch=1` on the URL flips node borders to a hand-drawn rough.js style (opt-in, reversible).

### Demo/benchmark knobs

- `SLOW_TOOL_MS` (default `0`) — artificial delay injected into staging tool calls, so an interruption race reproduces reliably. The **deterministic test fixture** the benchmark relies on — kept deliberately (§5.4). `explainComponent` is a *real* slow tool alongside it.
- `CARTOGRAPH_BASELINE=true` — disables generation fencing and the commit gate entirely (mutations land the instant they're staged, regardless of whether the describing sentence was ever spoken). This is the naive-agent comparison mode; the HUD shows a **BASELINE MODE** badge when it's on.
- `ADDRESSIVITY=true` (+ `ADDRESSIVITY_THRESHOLD`, default `0.6`) — ambient meeting mode: listen to *every* participant, not just the one `AgentSession` binds to. A second engineer's overheard speech can only ever create or destroy **proposals** (dashed "ghost" nodes); committed state still changes only on speech addressed to the agent. **Not yet validated with two live browser tabs** — the multi-participant STT path is best-effort.
- `RIME_MULTILINGUAL=true` — detect the language per turn (AssemblyAI `multi`) and swap the Rime speaker/language between turns with two-turn hysteresis. **Non-English is degraded** (no per-sentence commit gate — Coda gives no non-English word timestamps). `eng` + `hin` tested; 7 more Coda languages configured, untested. `RIME_SAVE_OOVS=true` for a pronunciation-harness session.
- `LAYOUT_DIRECTION` (`RIGHT` | `DOWN`) · `COMPONENT_LOOKUP=fixture` (skip the network for `explainComponent` on stage).

### Benchmark

```bash
pnpm --filter DD_agent benchmark
```

Runs 48 deterministic scenarios (a `toolDelay x interruptAt x corrections` matrix, plus 3 backchannel-during-narration cases) plus an explicit out-of-order case, twice each — once with fencing on, once with `CARTOGRAPH_BASELINE`'s naive behaviour — against an independent oracle. Also reports the orphaned-mutation count (always 0). No LiveKit, no audio, no LLM: pure TypeScript, reproducible on any machine. See [`RIME_EVIDENCE.md`](RIME_EVIDENCE.md) for the actual measured numbers.

Live interruption/recovery latency: `pnpm --filter DD_agent dev 2>&1 | tee /tmp/agent.log`, hold a call with ~20 real interruptions, then `pnpm --filter DD_agent latency < /tmp/agent.log` — see [`apps/agent/src/bench/live-latency.md`](apps/agent/src/bench/live-latency.md).

Other harnesses: `pnpm --filter DD_agent pronunciation` (44 infra terms × 2 spellings through the shipped Rime path → clips + `bench/pronunciation/REPORT.md`); `pnpm --filter DD_agent addressivity` (hand-labelled §2 confusion matrix → `bench/ADDRESSIVITY_MATRIX.md`). The ambient safety invariant (scenarios 47/48) is asserted in `bench/ambient.test.ts`.

## Third-party services

- **LiveKit Cloud** — WebRTC transport, room/participant management, STT (`assemblyai/universal-3-5-pro`) and LLM (`google/gemma-4-31b-it`) via LiveKit Inference, turn detection.
- **Rime** — text-to-speech, direct WebSocket plugin.
- **AssemblyAI** and **Google** (Gemma) — reached only through LiveKit Inference, no direct API keys held by this repo.

## Third-party UI sources

The aesthetic layer copies component source (not a runtime dependency) from:

- **[React Bits](https://reactbits.dev)** ([GitHub](https://github.com/DavidHDev/react-bits)) — MIT + Commons Clause. `BlurText`, `SplitFlapText`, `DotGrid` (`apps/web/components/`), each modified after copying — see the file headers/comments for what changed. Commons Clause restricts *reselling the library itself*, not using it in a product like this one.

## Known limitations

- Read-only/reversible tools only (brainstorm §26): no purchases, deletes, or emails — an irreversible external effect can't be meaningfully fenced. `clearCanvas` is destructive-looking but fully reversible (re-describe the diagram) and gated on its own sentence like any mutation.
- The anchor-phrase mismatch guard is a warning surfaced on the event ledger, not a block: a genuine mismatch still commits, because a hard block would turn a monitoring feature into a live-demo failure.
- Commit granularity is per-sentence, not per-word: a mutation lands once its whole describing sentence is confirmed delivered. The "forming node" reveal is per-word, but that's a *preview* of the in-progress sentence — the committed canvas still only ever reflects fully-heard sentences.
- Commit timing is a race between a tool finishing its work and its sentence being spoken. It resolves correctly from either side — if the tool stages first the sentence commits it, if the sentence lands first the tool commits on the catch-up path — but the *visual* tightness (a node appearing exactly as its sentence ends, not a beat later) depends on tools being fast, which is why `SLOW_TOOL_MS` defaults to `0` outside the interruption stress demo.
- The 48 generated benchmark scenarios plus one hand-scripted out-of-order case are not a production traffic distribution — they exercise the specific race the commit gate is built to close, not general robustness.
- A backchannel is classified lexically (`core/turn-taking.ts`) with a 2-word floor matching `turnHandling.interruption.minWords`. A single-word command that isn't in the hard-interrupt list ("stop", "wait", "no", "actually", …) — e.g. "bigger" — is treated as a backchannel and won't fence until the user says more.
- Live interruption/recovery latency is **measured across two independent real sessions** — fence ~2.5s median / 4.3-4.6s p95, recovery ~3.7-4.0s median / 6.2-7.3s p95, medians agreeing within ~1% between runs. Recovery latency (LLM + TTS round-trip) is slower than we'd like and is a live optimization target, not something tuned away before reporting. Full tables and disclosed caveats in `apps/agent/src/bench/live-latency.md`.
- **"Queued Rime audio stops promptly" is measured directly**, not assumed from the architecture: correlating `generation_cancelled` with the LiveKit SDK's own playout-stopped confirmation gives median 13ms / p95 25ms / max 138ms (n=7 — only turns where the agent was genuinely mid-speech at cancellation). See `RIME_EVIDENCE.md` §4.
- Single-room scale; no multi-agent handoffs, no telephony.
- **Multilingual (`RIME_MULTILINGUAL=true`) is degraded for non-English and only `eng`+`hin` are tested.** The §0 spike (recorded in `RIME_EVIDENCE.md §4a`) found Coda emits word-level timestamps only for English — synthesised Hindi and Japanese returned audio but zero timed words. So a non-English turn loses the per-sentence commit gate and falls back to `onTurnComplete` granularity (an interruption drops everything pending). The HUD shows `degraded timing`. English keeps the full gate. The other 7 Coda languages are mapped in `voices.ts` but their voices and segmentation are untested. It is not a translation feature — the agent replies in the room's language, it never translates.
- **Ambient meeting mode (§2) is behind `ADDRESSIVITY=true` and unvalidated live.** The classifier (prefilter + optional model), the ghost/proposal store, the safety invariant, and scenarios 47/48 are all unit-tested and audio-independent. The one piece that needs a two-browser-tab check is the multi-participant STT subscription in `core/ambient-listener.ts` — LiveKit Agents 1.7.1 binds `AgentSession` to a single participant, so a second engineer needs a separate STT stream off the raw track, and that plumbing has not been exercised with real audio. Measured classifier F1 (synthetic fixture): salient 0.92, addressed precision 1.0 / recall 0.30 — the prefilter never false-triggers the agent into speaking; recall is the model layer's job.
- Ghost labels are extracted from the overheard utterance heuristically (`ghostLabelFrom` in `main.ts`), not by a planner pass — cheaper for frequent ambient chatter, at the cost of occasionally awkward proposal names. A proposal is low-stakes by design.
- **This submission does not claim multi-user collaboration.** Cartograph is presented as a single-operator tool — one person, thinking out loud. `publishData` broadcasts to every room participant, so a second viewer would likely see the same canvas, but that's untested and nothing in the pitch depends on it.
- A real reliability bug was found and fixed during validation: tools referencing an *existing* component (`connectServices`, `renameComponent`, `removeComponent`, `replaceComponent`, `groupComponents`) used to hash whatever label the LLM said directly into a node id. A natural paraphrase — "connect the gateway to the auth service" for a node actually added as "API Gateway," or "the database" for one named "Postgres" — produced a dangling reference: the mutation staged and reported success, but nothing rendered. `CanvasStore.resolveId` now resolves spoken labels against the real canvas (exact id → case-insensitive label → unambiguous substring → generic kind-noun when there's exactly one match → token overlap), falling back to the old behaviour only when nothing resolves unambiguously. Regression-tested against the exact failing transcripts observed live.
- `apps/web`'s text-chat input is not wired to trigger agent turns in this starter — voice is the only input path exercised end-to-end.
- `apps/web`'s ESLint config (`next lint` + `.eslintrc.json`) is incompatible with the installed ESLint 9 and errors out; `pnpm --filter web check-types` is clean. Pre-existing; a flat-config migration is out of scope here.

## Failure behaviour

- **Rime unreachable at construction** (`TTS_PROVIDER=rime-plugin` with no `RIME_API_KEY`): fails fast and loudly at boot — the plugin throws, the worker never starts serving jobs.
- **Rime failing mid-session**: surfaces as a TTS synthesis error in the agent log; the session does not silently fall back to another provider. The PS makes a submission ineligible if Rime is not the primary spoken output, so no silent non-Rime fallback is wired in. The disclosed fallback (`TTS_PROVIDER=rime`, the Inference gateway) is a deploy-time switch, not an automatic runtime failover, and the HUD's active-provider readout would show it if it were active.
- **Tool timeout beyond the delay budget**: not separately bounded — a stuck tool call simply never resolves; the generation fence still protects the canvas if the user moves on before it does.
- **LiveKit disconnect/reconnect**: handled by the LiveKit Agents SDK's own reconnection logic; Cartograph's state (`GenerationManager`, `CanvasStore`) lives in the worker process and is not persisted across a worker restart.
