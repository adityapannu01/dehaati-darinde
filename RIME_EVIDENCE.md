# Cartograph — Evidence

## 1. Claim

> When the user interrupts and changes the request, queued Rime audio stops promptly, in-flight tool work is cancelled or fenced, stale results can never re-enter the conversation, and the shared canvas state stays consistent with the words the user actually heard.

Reported but not the headline claim: perceived response time (see [`apps/agent/src/bench/live-latency.md`](apps/agent/src/bench/live-latency.md)).

## 2. Acceptance test

Four cases, defined before any demo run:

1. **Normal flow** — a multi-component instruction, uninterrupted. Every proposed mutation lands, once its describing sentence is confirmed delivered.
2. **Mid-speech interruption** — the user cuts in mid-sentence. Any mutation whose sentence was already fully delivered stays committed; anything not yet delivered is dropped, permanently, even if the underlying tool call eventually resolves.
3. **Tool race** — a slow tool call (`SLOW_TOOL_MS`) resolves *after* its generation has already been superseded. The result is discarded (`STALE_DISCARDED`) and never reaches the canvas.
4. **Triple interruption, out-of-order** — three generations open back-to-back; their tool results resolve out of arrival order. Only the result belonging to the generation that is *still current at the moment its own result resolves* may land — regardless of which result physically arrives first.

Pass condition: 0% canvas divergence and 0% stale mutations for all four cases with fencing enabled (`CARTOGRAPH_BASELINE=false`, the default); non-zero for both with `CARTOGRAPH_BASELINE=true`, proving the comparison has teeth (a baseline with no measurable difference proves nothing).

## 3. Procedure

```bash
pnpm --filter DD_agent benchmark
```

Runs 51 deterministically generated scenarios (`toolDelay × interruptAt × corrections`, 3×5×3, plus 3 backchannel-during-narration cases — the B1 regression guard — and 3 interrupted direction-change cases — the ROUND3 A1 guard) plus the explicit out-of-order case, each once with fencing on and once with `CARTOGRAPH_BASELINE=true`, against an independent oracle (`apps/agent/src/bench/oracle.ts`) that re-derives the expected canvas from only the heard-sentence counts — sharing no code with the commit gate it's checking. The same invariant is asserted directly in `apps/agent/src/bench/runner.test.ts`, so `pnpm test` catches a regression here too, not only a human reading the printed table.

A separate deterministic harness, `pnpm --filter DD_agent layout-fixture` (ROUND3 Module C), runs a fixed 12-node / 3-group graph through the real `CanvasStore` + ELK pipeline in all four flow directions and asserts every member sits inside its own group's derived box, no foreign node's centre falls inside a box, and no two boxes overlap. Same property: no audio, no LLM, no LiveKit. `bench/layout-fixture.test.ts` runs it under `pnpm test`.

The commit itself fires **as each sentence is delivered**, not once at end of turn: `CommitGate.onWord` commits every staged mutation whose sentence has just cleared, and a mutation that stages *after* its sentence was already spoken (a slow tool) commits immediately on a catch-up path rather than waiting for `onTurnComplete`. So the canvas matches the heard transcript continuously through the turn, not only at its end.

Live interruption/recovery timing: manual procedure in [`apps/agent/src/bench/live-latency.md`](apps/agent/src/bench/live-latency.md) — 20 real interruptions, median + p95, warm/cold labelled separately.

## 4. Results

Measured 2026-09-08, this repo, `pnpm --filter DD_agent benchmark`:

| Metric | Cartograph (fencing on) | Baseline (`CARTOGRAPH_BASELINE=true`) |
|---|---|---|
| Canvas divergence rate | **0.0%** (0/51) | 76.5% (39/51) |
| Stale mutation rate (of landed mutations) | **0.0%** | 46.6% |
| Out-of-order (1→3→2) resolved correctly | **yes** | no |
| Orphaned mutations (staged, never committed or dropped) | **0** | 0 |
| Fence latency (interruption → generation cancelled) | N/A in the synchronous harness | see live-latency.md |

The 3 backchannel-during-narration scenarios (46) guard the B1 fix: a "mm-hmm" mid-sentence must not roll the generation and orphan the mutation whose sentence is still being spoken. `runner.test.ts` also runs the pre-fix always-fence path and asserts it *does* orphan — so the scenario has teeth.

The 3 interrupted direction-change scenarios (ROUND3 A1) stage a `setDirection` mutation and then cut its sentence off: the direction must stay unchanged, and — because flow direction is presentation, not content — content divergence must stay 0.0%. That the baseline divergence stays at 39/51 (not 42/51) is the proof direction is correctly excluded from the oracle's diff: the 3 new scenarios diverge in neither mode.

**A dependency this project relies on but does not itself implement, now pinned by a test.** Live testing found the turn detector sometimes finalizes a multi-item instruction mid-list ("Add an API Gateway." as its own turn, before "and an auth service and a database."). Cartograph's own code does nothing to stitch the two transcripts together — `main.ts`'s `UserInputTranscribed` handler passes only the latest turn's text to the generation that stages tool calls. What recovers the full instruction is LiveKit's own chat context: the earlier turn stays in history, so the next LLM call sees the whole conversation and completes it. That worked in manual testing, which is not the same as proven — `agent.test.ts` now runs this exact two-turn split against the real LLM and asserts both items land, so a future LiveKit version that stops carrying an interrupted turn's context forward would fail this test rather than silently regress.

Live interruption/recovery latency, measured 2026-09-08 across **two independent real sessions** (full unedited tables, both runs, in [`live-latency.md`](apps/agent/src/bench/live-latency.md)):

| Leg | Run 1 median | Run 2 median | p95 range |
|---|--:|--:|--:|
| Fence latency (interrupt spoken → generation cancelled) | 2514 ms | 2502 ms | 4.3-4.6s |
| Recovery latency (cancelled → next turn's first audio) | 4009 ms | 3672 ms | 6.2-7.3s |

The two runs' medians agree within ~1% — that agreement is the reproducibility check, not a cherry-picked single sample. Full unedited per-interruption tables for both runs are in `live-latency.md`. Fence latency is dominated by how long the user's own interrupting phrase takes to say + transcribe, not raw cancellation (`cancelCurrent()` is synchronous). Recovery latency — LiveKit Inference LLM round-trip + Rime TTS time-to-first-audio — is the real optimization target and is slower than we'd like; reported as measured, not tuned away before reporting.

**"Queued Rime audio stops promptly" — measured directly, not assumed from architecture.** Fence latency measures *decision* speed (interruption detected → generation cancelled); it says nothing about whether audio already playing actually stops. `pnpm --filter DD_agent latency` now also correlates each `generation_cancelled` with the LiveKit Agents SDK's own `"playout completed with interrupt"` confirmation — logged once the SDK has actually cancelled the reply pipeline and drained the audio-forwarding task:

| | n | median | p95 | min | max |
|---|--:|--:|--:|--:|--:|
| Audio-stop confirmation (cancelled → SDK confirms playback stopped) | 7 | **13 ms** | 25 ms | 3 ms | 138 ms |

n=7 because this only counts turns where the agent was genuinely mid-speech at the moment of cancellation (most `generation_cancelled` events are ordinary turn-taking, not an audio interruption). Every value is under 150ms — queued audio stops within tens of milliseconds of the fencing decision, not seconds. This is LiveKit SDK-internal behaviour, not something Cartograph implements, which is exactly why it's worth measuring directly rather than assuming from the architecture. `apps/agent/src/bench/latency.test.ts` unit-tests the pairing logic.

**A non-circular check of the headline claim against a real session, not simulated data.** The 51-scenario benchmark's oracle (`oracle.ts`) is independent of the commit gate, but only ever runs against synthetic scenarios. Every live-session check up to this point (the interruption tests above) reads the same ledger the commit gate itself writes — a check on the system's own bookkeeping, not an outside audit. `apps/agent/src/bench/audit-session.ts` closes that gap: for a REAL captured session, it independently decides — from nothing but the raw `[Cartograph] word:` stream and the ledger's generation markers, never importing `commit-gate.ts` or `delivery.ts` — whether each staged mutation's anchor phrase was actually spoken before its generation ended, and diffs that verdict against what the log says actually happened. The only shared code is `applyLexicon` (text normalisation, not the commit/drop decision). `pnpm --filter DD_agent audit < session.log`; `audit-session.test.ts` covers the comparator against synthetic fixtures, including the pronunciation-lexicon and already-disclosed anchor-mismatch cases.

**Run against real sessions, 2026-09-08: 13/13 independent agreement, 0 divergences**, across four separate calls. The independent auditor reached the same commit verdict as the production commit gate every time, using none of its code.

Three of the four calls ran at `SLOW_TOOL_MS=0`: every interruption in them landed *after* its sentence had already finished playing — nothing was dropped mid-flight, because the persona keeps replies to short, single-component sentences by design ("describe exactly ONE change per sentence... 1-3 sentences"), so a sentence often finishes in under a second. The fourth call used `SLOW_TOOL_MS=5000` (the project's own documented stress knob), and produced a genuine live capture of **acceptance-test case 3** — a tool call still asleep when its generation was superseded, resolving to `STALE_DISCARDED` and never reaching the canvas:

```
tool_started gen=2 addService(Redis cache)          <- still inside the 5s delay
generation_started gen=3 "...make that Memcached"    <- interruption lands
tool_stale_discarded gen=2 addService(Redis cache)
  output: "STALE_DISCARDED: this instruction was superseded."
```

That's a different, earlier checkpoint than the `mutation_dropped` path `audit-session.ts` covers — it fires inside the tool's own `gm.isCurrent()` check, before anything reaches the commit gate's staging buffer, so there's nothing for the independent auditor to weigh in on there (by design: a mutation that never staged has no "was it heard" question to ask). That checkpoint has its own dedicated test (`canvas-tools.test.ts`: "advancing the generation during the delay returns STALE_DISCARDED and stages nothing"); this run is its first live confirmation.

The one case still not caught live, specifically, is a mutation that reaches `mutation_staged` and is *then* dropped by `onInterrupted` — a narrower timing window than either case above. It remains covered by the 51-scenario deterministic benchmark and `audit-session.test.ts`'s synthetic fixture, not yet by a live capture.

**A real, visible defect this live testing surfaced, fixed, and regression-tested — not just "nothing technically wrong."** In the `STALE_DISCARDED` run above, the fencing was correct (nothing wrong ever committed) but the *reply* still said "Okay, adding a Redis cache" before "replacing it with Memcached" — so Redis cache flashed on the canvas before being corrected, even though the user had already said the correction before the agent said anything at all. `PERSONA` (`agent.ts`) had a rule for a tool result coming back stale (`STALE_DISCARDED`, "say nothing about it") but none for this case: a superseded instruction the agent never got as far as replying to. Added explicit guidance for it, and proved the fix does something rather than assuming it: `agent.test.ts`'s new eval fails reliably (3/3) against the real LLM with the guidance removed — it calls `addService` for Redis before correcting, exactly the observed defect — and passes reliably (3/3) with it, asserting no `addService`/`replaceComponent` call and no spoken mention of the superseded name.

**A second, purely internal defect the same round of live testing surfaced: a real orphaned mutation.** Re-running the fixed persona live, the correction landed so fast the previous generation never spoke a single word before being superseded. The LiveKit SDK only emits `ConversationItemAdded` (the event that normally drives `commitGate.onInterrupted()`) when some text was actually forwarded — with zero words ever delivered, that event never fires. The staged mutation for that generation just sat unresolved forever: invisible on the canvas (correct outcome) but never reaching a terminal state (a genuine violation of the "every staged mutation resolves" invariant `orphanedMutationIds` exists to assert, and a real bookkeeping leak over a long session). `main.ts`'s `UserInputTranscribed` handler now checks `commitGate.spokenText` and calls `onInterrupted()` itself the instant it's empty, rather than waiting for an event that will never come — safe unconditionally, since zero spoken words can only mean "cut off before speaking," never "completed normally." `commit-gate.test.ts` locks in the specific case (a generation interrupted with zero `onWord` calls resolves cleanly, not as an orphan) alongside the existing mid-sentence-interruption test.

**A lever investigated and closed, not left unexplored:** Rime's `reduceLatency` option looked like a direct fix for the recovery leg. Checked the plugin's compiled source (`@livekit/agents-plugin-rime@1.7.1`), not just its types: `reduceLatency` is only forwarded into the actual Rime request when `modelId` is `mistv2` — for `coda` it's silently dropped on both the WebSocket and HTTP paths. Switching to Mist v2 to reach it isn't an option either, since Mist v2 has no word-level timestamps, which the commit gate requires. Left unset in `tts.ts` rather than shipped as a config flag that would silently do nothing.

Rime pronunciation: 44 infrastructure terms rendered through the shipped `coda:celeste` WebSocket path in three variants each (plain / hand-respelled / **the shipped `applyLexicon` output**) — clips + comparison table in `apps/agent/src/bench/pronunciation/REPORT.md`. `RIME_SAVE_OOVS=true` logs Rime's out-of-vocabulary words for a real session.

`pnpm test` (~250 tests across core engine, tools, commit gate, transport, benchmark, planner/graph, layout (incl. the four-direction regression fixture), turn-taking, addressivity/proposals/ambient, lexicon, the real slow tool, and the agent evals): **all passing** as of this commit (the agent evals need live LiveKit Inference).

## 4a. Language scope & pronunciation (MULTILINGUAL_AND_PRONUNCIATION.md)

**The product is English-only, and that is a decision informed by two Rime spikes — not a shortcut.** A multilingual mode (per-turn language detection, a hysteresis'd speaker/`lang` router, a Coda speaker per language) was built against `MULTILINGUAL_AND_PRONUNCIATION.md` and then **removed**, because the commit gate — the entire thesis of this project — cannot hold at full granularity for non-English on Coda, and shipping a headline guarantee that is degraded for most of its languages is worse than not shipping the languages. The spikes below are kept because they are exactly the kind of specific provider knowledge the PS asks for.

**Spike 1 — the §0 word-timestamp gate spike.** Synthesised 3-sentence strings through the shipped Coda WebSocket plugin in English, Hindi (`nadi`) and Japanese (`akatsuki`), logging every aligned word:

| Language | audio frames | words with `startTime`/`endTime` |
|---|--:|--:|
| English (`eng` / celeste) | 78 | **17** |
| Hindi (`hin` / nadi) | 92 | **0** |
| Japanese (`jpn` / akatsuki) | 96 | **0** |

**Rime Coda returns word-level timestamps only for English.** Non-English audio synthesises fine, but the commit gate — which commits a staged mutation only once the sentence describing it is *confirmed delivered* — has no per-sentence delivery signal to key off.

**Spike 2 — is there a second delivery signal?** The Rime plugin's `SynthesizeStream` emits a per-segment boundary frame (`sendLastFrame(segmentId, final)`) on a code path separate from the English-only `"timestamps"` message. If Rime, constructed with `segment: 'bySentence'` (the plugin default), emitted one boundary *per sentence* in every language, that would be exactly the evidence the gate needs. A fresh WebSocket spike (`_spike_segments.mjs`, run against the live `wss://users-ws.rime.ai/ws3` endpoint, not committed) counted every message type:

| Language | `chunk` (audio) | `timestamps` | `done` |
|---|--:|--:|--:|
| English (`eng` / celeste) | 451 | **2** | **1** |
| Hindi (`hin` / nadi) | 487 | **0** | **1** |

Rime `ws3` sends exactly **one `done` per whole stream**, not one per sentence — and in the plugin, `sendLastFrame(contextId, /* final */ true)` fires only on that single `done`, with `contextId` a stream-level uuid, not a sentence id. The intermediate `sendLastFrame(contextId, false)` calls are audio-frame flushes keyed to `chunk` arrival, not sentence boundaries. **There is no per-sentence delivery frame in any language.** Estimating sentence boundaries from `chunk` counts and audio duration would be an inference dressed as delivery evidence — the one thing this project exists to refuse.

So the product scopes to English: `celeste` on Coda, `wss://users-ws.rime.ai/ws3`, PCM 24 kHz mono, WebSocket, word timestamps verified live (17/17). The STT runs `language: 'en'`. `RIME_MODEL` / `RIME_VOICE` / `RIME_LANGUAGE` still exist for a deploy-time override but the tested and demoed path is English.

**Pronunciation stays — it is on-thesis for English.** If the user heard "en-jinx" and the node reads "nginx", the state matches the transcript but not their understanding. Coda has no inline phonemes (Mist v2 only, and Mist v2 has no word timestamps), so respelling the text sent to Rime is the only lever. The lexicon (`core/lexicon.ts`) is applied at the `ttsNode` tap — after the model produces correct text, before Rime — buffered to sentence boundaries so a term can't split across a chunk. Both sides of the commit gate's anchor check are normalised through the same lexicon, so a respelled term never trips `anchor_mismatch` (regression-tested). The STT gets the same term list via `keyterms_prompt` so recognition biases toward "nginx"/"etcd" too.

## 5. Limitations

- Read-only/reversible tools only — no purchases, deletes, or emails; an irreversible external effect can't be meaningfully fenced.
- The anchor-phrase mismatch guard is a warning on the event ledger, not a block — a genuine mismatch still commits, deliberately, so a monitoring feature can't become a live-demo failure.
- Commit granularity is per-sentence, not per-word.
- With a slow tool, a mutation commits when the tool completes (the catch-up path), not at the instant its sentence ends — heard-correct, but not visually instantaneous. `SLOW_TOOL_MS` defaults to `0` outside the interruption stress demo so the two coincide.
- 51 generated scenarios + 1 hand-scripted out-of-order case are not a production traffic distribution — they exercise the specific race the commit gate closes, not general robustness. The generator matrix is parametric (`apps/agent/src/bench/scenarios.ts`) rather than 100 hand-authored scripts, trading raw scenario count for higher confidence that each generated case is actually correct.
- Single-room scale; no multi-agent handoffs or telephony.
- English only (see §4a): two Rime spikes established that Coda emits the per-sentence delivery evidence the commit gate needs only for English, so the multilingual mode that was built for `MULTILINGUAL_AND_PRONUNCIATION.md` was removed rather than shipped in a degraded state. The STT runs `language: 'en'`.
- Live interruption/recovery latency is measured — see §4 and `live-latency.md`. Recovery latency (~4s median) is slower than ideal; not yet tuned.
- A real reliability bug was found and fixed during this round of testing: `connectServices`/`renameComponent`/`removeComponent`/`replaceComponent`/`groupComponents` used to hash whatever label the LLM said directly into a node id, so a natural paraphrase ("connect the gateway to the auth service" for a node actually added as "API Gateway") produced a dangling reference — the mutation staged and "succeeded" but nothing rendered, silently. `CanvasStore.resolveId` now resolves spoken labels against the actual canvas (exact → case-insensitive → substring → generic-kind-noun → token overlap), falling back to the old behaviour only when nothing matches unambiguously. Regression-tested against the exact failing transcripts.
- Ambient meeting mode (`ADDRESSIVITY=true`) is unvalidated with two live browser tabs — the classifier, proposal store and safety invariant (scenarios 47/48) are unit-tested and audio-independent, but the multi-participant STT subscription has not run against real audio. Classifier F1 on the synthetic fixture: salient 0.92, addressed precision 1.0 / recall 0.30.
- **Collaboration is not a claim of this submission.** Cartograph is presented as a single-operator tool; `publishData` broadcasts to every participant in the room so a second viewer likely sees the same canvas, but this has not been tested and nothing in the pitch depends on it.

## Demo script (4-5 minutes)

Not code — rehearse against it before presenting.

| Time | Beat |
|---|---|
| 0:00-0:30 | Target user + problem: an engineer thinking out loud through a system design, hands free — the canvas builds itself, and self-corrections are treated as normal, not errors. |
| 0:30-1:20 | Normal flow: speak three services, watch them land sentence by sentence as Rime speaks them. |
| 1:20-2:30 | **Stress case.** `SLOW_TOOL_MS=5000`. Say "add a Redis cache and connect it to the API gateway," interrupt on the second sentence with "wait, make that MongoDB." Show: audio cuts, the un-narrated edge never appears, the event ledger turns red, the 5-second-late tool result arrives and is rejected. |
| 2:30-3:10 | Same script with `CARTOGRAPH_BASELINE=true` — the ghost node/edge appears. Side by side against the fenced run. |
| 3:10-3:40 | Numbers on screen, not a slide: `pnpm --filter DD_agent benchmark` (0% divergence vs ~77% baseline) and the measured live-latency table (two independent runs, medians agreeing within ~1%). |
| 3:40-4:20 | Rime's role: WebSocket streaming, word timestamps, and the fact that they're what drives the commit gate. Show the disclosure table in `README.md`. |
