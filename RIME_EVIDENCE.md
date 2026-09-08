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

Runs 48 deterministically generated scenarios (`toolDelay × interruptAt × corrections`, 3×5×3, plus 3 backchannel-during-narration cases — the B1 regression guard) plus the explicit out-of-order case, each once with fencing on and once with `CARTOGRAPH_BASELINE=true`, against an independent oracle (`apps/agent/src/bench/oracle.ts`) that re-derives the expected canvas from only the heard-sentence counts — sharing no code with the commit gate it's checking. The same invariant is asserted directly in `apps/agent/src/bench/runner.test.ts`, so `pnpm test` catches a regression here too, not only a human reading the printed table.

The commit itself fires **as each sentence is delivered**, not once at end of turn: `CommitGate.onWord` commits every staged mutation whose sentence has just cleared, and a mutation that stages *after* its sentence was already spoken (a slow tool) commits immediately on a catch-up path rather than waiting for `onTurnComplete`. So the canvas matches the heard transcript continuously through the turn, not only at its end.

Live interruption/recovery timing: manual procedure in [`apps/agent/src/bench/live-latency.md`](apps/agent/src/bench/live-latency.md) — 20 real interruptions, median + p95, warm/cold labelled separately.

## 4. Results

Measured 2026-09-07, this repo, `pnpm --filter DD_agent benchmark`:

| Metric | Cartograph (fencing on) | Baseline (`CARTOGRAPH_BASELINE=true`) |
|---|---|---|
| Canvas divergence rate | **0.0%** (0/48) | 81.3% (39/48) |
| Stale mutation rate (of landed mutations) | **0.0%** | 48.2% |
| Out-of-order (1→3→2) resolved correctly | **yes** | no |
| Orphaned mutations (staged, never committed or dropped) | **0** | 0 |
| Fence latency (interruption → generation cancelled) | N/A in the synchronous harness | see live-latency.md |

The 3 backchannel-during-narration scenarios (46) guard the B1 fix: a "mm-hmm" mid-sentence must not roll the generation and orphan the mutation whose sentence is still being spoken. `runner.test.ts` also runs the pre-fix always-fence path and asserts it *does* orphan — so the scenario has teeth.

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

**A non-circular check of the headline claim against a real session, not simulated data.** The 45-scenario benchmark's oracle (`oracle.ts`) is independent of the commit gate, but only ever runs against synthetic scenarios. Every live-session check up to this point (the interruption tests above) reads the same ledger the commit gate itself writes — a check on the system's own bookkeeping, not an outside audit. `apps/agent/src/bench/audit-session.ts` closes that gap: for a REAL captured session, it independently decides — from nothing but the raw `[Cartograph] word:` stream and the ledger's generation markers, never importing `commit-gate.ts` or `delivery.ts` — whether each staged mutation's anchor phrase was actually spoken before its generation ended, and diffs that verdict against what the log says actually happened. The only shared code is `applyLexicon` (text normalisation, not the commit/drop decision). `pnpm --filter DD_agent audit < session.log`; `audit-session.test.ts` covers the comparator against synthetic fixtures, including the pronunciation-lexicon and already-disclosed anchor-mismatch cases.

**Run against real sessions, 2026-09-08: 13/13 independent agreement, 0 divergences**, across four separate calls. The independent auditor reached the same commit verdict as the production commit gate every time, using none of its code.

Three of the four calls ran at `SLOW_TOOL_MS=0`: every interruption in them landed *after* its sentence had already finished playing — nothing was dropped mid-flight, because the persona keeps replies to short, single-component sentences by design ("describe exactly ONE change per sentence... 1-3 sentences"), so a sentence often finishes in under a second. The fourth call used `SLOW_TOOL_MS=5000` (the project's own documented stress knob), and produced a genuine live capture of **acceptance-test case 3** — a tool call still asleep when its generation was superseded, resolving to `STALE_DISCARDED` and never reaching the canvas:

```
tool_started gen=2 addService(Redis cache)          <- still inside the 5s delay
generation_started gen=3 "...make that Memcached"    <- interruption lands
tool_stale_discarded gen=2 addService(Redis cache)
  output: "STALE_DISCARDED: this instruction was superseded."
```

That's a different, earlier checkpoint than the `mutation_dropped` path `audit-session.ts` covers — it fires inside the tool's own `gm.isCurrent()` check, before anything reaches the commit gate's staging buffer, so there's nothing for the independent auditor to weigh in on there (by design: a mutation that never staged has no "was it heard" question to ask). That checkpoint has its own dedicated test (`canvas-tools.test.ts`: "advancing the generation during the delay returns STALE_DISCARDED and stages nothing"); this run is its first live confirmation.

The one case still not caught live, specifically, is a mutation that reaches `mutation_staged` and is *then* dropped by `onInterrupted` — a narrower timing window than either case above. It remains covered by the 48-scenario deterministic benchmark and `audit-session.test.ts`'s synthetic fixture, not yet by a live capture.

**A real, visible defect this live testing surfaced, fixed, and regression-tested — not just "nothing technically wrong."** In the `STALE_DISCARDED` run above, the fencing was correct (nothing wrong ever committed) but the *reply* still said "Okay, adding a Redis cache" before "replacing it with Memcached" — so Redis cache flashed on the canvas before being corrected, even though the user had already said the correction before the agent said anything at all. `PERSONA` (`agent.ts`) had a rule for a tool result coming back stale (`STALE_DISCARDED`, "say nothing about it") but none for this case: a superseded instruction the agent never got as far as replying to. Added explicit guidance for it, and proved the fix does something rather than assuming it: `agent.test.ts`'s new eval fails reliably (3/3) against the real LLM with the guidance removed — it calls `addService` for Redis before correcting, exactly the observed defect — and passes reliably (3/3) with it, asserting no `addService`/`replaceComponent` call and no spoken mention of the superseded name.

**A second, purely internal defect the same round of live testing surfaced: a real orphaned mutation.** Re-running the fixed persona live, the correction landed so fast the previous generation never spoke a single word before being superseded. The LiveKit SDK only emits `ConversationItemAdded` (the event that normally drives `commitGate.onInterrupted()`) when some text was actually forwarded — with zero words ever delivered, that event never fires. The staged mutation for that generation just sat unresolved forever: invisible on the canvas (correct outcome) but never reaching a terminal state (a genuine violation of the "every staged mutation resolves" invariant `orphanedMutationIds` exists to assert, and a real bookkeeping leak over a long session). `main.ts`'s `UserInputTranscribed` handler now checks `commitGate.spokenText` and calls `onInterrupted()` itself the instant it's empty, rather than waiting for an event that will never come — safe unconditionally, since zero spoken words can only mean "cut off before speaking," never "completed normally." `commit-gate.test.ts` locks in the specific case (a generation interrupted with zero `onWord` calls resolves cleanly, not as an orphan) alongside the existing mid-sentence-interruption test.

**A lever investigated and closed, not left unexplored:** Rime's `reduceLatency` option looked like a direct fix for the recovery leg. Checked the plugin's compiled source (`@livekit/agents-plugin-rime@1.7.1`), not just its types: `reduceLatency` is only forwarded into the actual Rime request when `modelId` is `mistv2` — for `coda` it's silently dropped on both the WebSocket and HTTP paths. Switching to Mist v2 to reach it isn't an option either, since Mist v2 has no word-level timestamps, which the commit gate requires. Left unset in `tts.ts` rather than shipped as a config flag that would silently do nothing.

**A second, larger lever found during the comparative TTS evaluation (§4b), investigated at the protocol level, and deliberately not shipped.** That evaluation showed Cartesia reaching first audio ~3x faster than Rime. Read both client libraries' compiled source to find out why, rather than assume Cartesia's model is faster: `inference.TTS` (Cartesia's path) wraps every call in a real `ConnectionPool` (`@livekit/agents`' `connection_pool.js`) that prewarms a WebSocket in the background and reuses it across calls; `@livekit/agents-plugin-rime`'s `SynthesizeStream.run()` opens a brand-new WebSocket handshake to `wss://users-ws.rime.ai` for *every* utterance and unconditionally closes it in a `finally` block — no pooling at all. The wire protocol carries a per-utterance `contextId`, which only makes sense if the server expects to multiplex several utterances over one connection — so this was tested directly, not assumed: a throwaway script (not part of the shipped agent) opened one raw WebSocket and sent three separate utterances over it, comparing against the plugin's current fresh-connection-per-call behaviour:

| | connect | time to first audio |
|---|--:|--:|
| Fresh connection each time (current plugin behaviour) | ~910ms | ~1260ms total |
| Reused connection, 2nd utterance | *(already open)* | **~350ms total** |
| Reused connection, 3rd utterance | *(already open)* | **~350ms total** |

Rime's server accepted every reused-connection utterance cleanly — correct audio, correct chunk counts, no errors. Once warm, that's a real ~3.5x improvement, and ~350ms is faster than Cartesia's own warm number (~450-600ms) under the same conditions. **Deliberately not shipped.** The plugin exposes no hook for connection reuse — realizing this would mean replacing it with a hand-rolled reimplementation of its whole message protocol (token-by-token sends, `contextId` tracking, `chunk`/`timestamps`/`done`/`error` parsing, abort/close semantics) on the exact hot path the commit gate's word-level timestamps depend on, plus new handling for `RIME_MULTILINGUAL` (a pooled connection is only valid while speaker/lang/model stay constant, so a language switch would need to invalidate it and reconnect). That's proportional to the validation the commit gate itself has already received (48 scenarios, an independent oracle, a live 13/13 audit) — not a drop-in patch — and this project's own stated headline claim is correctness under interruption, not latency ("Reported but not the headline claim: perceived response time"). Trading a protocol-correct, already-proven synthesis path for an unproven one, this close to submission, for a metric the project already disclosed as secondary, is the wrong trade. Recorded here as a real, evidenced, actionable next step rather than shipped under time pressure.

Rime pronunciation: 44 infrastructure terms rendered through the shipped `coda:celeste` WebSocket path in three variants each (plain / hand-respelled / **the shipped `applyLexicon` output**) — clips + comparison table in `apps/agent/src/bench/pronunciation/REPORT.md`. `RIME_SAVE_OOVS=true` logs Rime's out-of-vocabulary words for a real session.

`pnpm test` (~231 tests across core engine, tools, commit gate, transport, benchmark, planner/graph, layout, turn-taking, addressivity/proposals/ambient, lexicon, the real slow tool, and the agent evals): **all passing** as of this commit.

## 4a. Why this is an English-only product

Multilingual output was built and then removed deliberately, on evidence.

Synthesising 3-sentence strings through the shipped Coda WebSocket path in English, Hindi
(`nadi`) and Japanese (`akatsuki`), logging every aligned word:

| Language | audio frames | words with `startTime`/`endTime` |
|---|--:|--:|
| English (`eng` / celeste) | 78 | **17** |
| Hindi (`hin` / nadi) | 92 | **0** |
| Japanese (`jpn` / akatsuki) | 96 | **0** |

Rime Coda emits word-level timestamps only for English. The commit gate — the mechanism this
whole product rests on — has no per-sentence delivery signal without them. A multilingual build
would therefore have shipped a *weaker* version of the central claim in every language but one.

We removed it rather than ship a degraded gate behind a feature flag. Cartograph is an
English-only product, and the claim holds at full strength everywhere it applies.

**Shipped path:** Rime `coda` / speaker `celeste` / `lang` `eng`, WebSocket streaming over
`wss://users-ws.rime.ai/ws3` (US West, `us-west-2` — configurable via `RIME_BASE_URL`; Rime has
no APAC endpoint), PCM 24 kHz mono. Word timestamps verified live (17/17). `pnpm --filter
DD_agent test tts.preflight` re-checks that model/voice/language against Rime's live catalog
before submission (PS p.5).

**Pronunciation** (kept — it is on-thesis for English). Coda has no inline phonemes (Mist v2
only, and Mist v2 has no word timestamps), so respelling the text sent to Rime is the only
lever. The lexicon (`core/lexicon.ts`) is applied at the `ttsNode` tap — after the model
produces correct text, before Rime — buffered to sentence boundaries so a term can't split
across a chunk. Both sides of the commit gate's anchor check are normalised through the same
lexicon, so a respelled term never trips `anchor_mismatch` (regression-tested). The STT gets the
same term list via `keyterms_prompt` so recognition biases toward "nginx"/"etcd" too.

## 4b. Comparative TTS evaluation (bench/tts-comparison)

Required by the PS's benchmark rules, not this project's headline claim (that's still correctness under interruption — see §1). Blinded, disclosed comparison of Rime `coda:celeste` (the shipped path, direct WebSocket plugin) against two LiveKit Inference gateway providers picked to need zero new credentials: Cartesia `sonic-3` (voice Blake) and Fish Audio `s2.1-pro` (voice Adrian) — both current, non-deprecated model IDs verified against LiveKit's docs at build time (Cartesia `sonic-2` and every ElevenLabs model are retired). Four metrics on a 15-of-44-term slice of the pronunciation fixture: word alignment fidelity, latency to first audio, reliability under interruption, and intelligibility (synthesize → re-transcribe with this project's own STT → compare to the canonical term).

```bash
RIME_API_KEY=... pnpm --filter DD_agent tts-comparison
```

Writes clips, a blinded copy of every clip under randomized filenames (for a human listening pass — `blind-key.json` stays git-ignored until that pass is actually done), per-item `results.csv`, and the full `REPORT.md` to `apps/agent/src/bench/tts-comparison/`.

**Alignment.** Rime (direct plugin) and Cartesia (Inference gateway, `add_timestamps: true`) both return real, populated word-level timestamps — checked against actual synthesis output, not documentation. Fish Audio has no alignment path via either route. Worth stating plainly: Cartograph's commit-gate architecture isn't uniquely tied to Rime — it could theoretically run on Cartesia's timestamps too. Rime stays the shipped path per the PS's own requirement; this is a fairness disclosure, not a design change.

**Latency.** Cartesia reaches first audio in ~450-600ms against Rime's ~1.3-1.7s. Root-caused, not just reported — see the connection-pooling finding above (§4): the gap is a client-library difference (Cartesia's path pools/reuses connections, Rime's plugin doesn't), not a difference in model speed, confirmed with a real protocol-level test.

**An unplanned but real finding: this harness became a live stress test of `agent-gateway.livekit.cloud`.** Running ~75 back-to-back synthesis/re-transcription calls surfaced genuine reliability differences that shaped the other two metrics more than the models did:

| Leg | attempts | failures | failure rate |
|---|--:|--:|--:|
| Rime `coda:celeste` (direct plugin, bypasses the gateway) | 20 | 0 | **0%** |
| STT re-transcription of real audio (any provider) | 15 | 10 | 67% |
| Cartesia `sonic-3` (Inference gateway) | 20 | 15 | 75% |
| Fish Audio `s2.1-pro` (Inference gateway) | 20 | 20 | **100%** |

Two different failure shapes, disclosed as such rather than flattened into one "unreliable" verdict: Cartesia's alignment/latency/reliability sections (the first ~11 calls) came back completely clean; its intelligibility section (15 more calls immediately after) came back 0% once the connection degraded under that sustained load — a real, load-dependent reliability characteristic of the shared gateway. Fish Audio failed on *every* attempt made across this whole investigation — this run and every isolated single-call smoke test, across two separate LiveKit Cloud projects, with its model/voice ID verified word-for-word against LiveKit's current docs each time — a different, unconditional pattern, read as "never connected," not "measured and failing." Rime, going over its own direct WebSocket straight to Rime's servers rather than through that gateway, saw zero failures regardless. `REPORT.md` cross-references this in every table it affects rather than leaving a `-1` or a blank transcript to be misread as a clean measurement.

**Intelligibility.** Deliberately tested with plain, unrespelled text for all three providers ("a fair, unmodified baseline"), so this does *not* exercise Cartograph's shipped pronunciation fix (`core/lexicon.ts`, §4a) — that's validated separately in `bench/pronunciation/REPORT.md` (44 terms × 2 spellings). Read together with the audio-actually-produced column: most of Rime's and all of Cartesia's/Fish Audio's "no match" rows are gateway connection failures counted as misses (see above), not measured mispronunciations. The few results that did come through cleanly are real: unrespelled Rime rendered "nginx" as "NGX" (letters, not "engine-x") and "Redis" as something closer to "Read this" — exactly the gap the shipped lexicon exists to close.

**Not attempted here: the PS's blinded human listening test.** `blind/` holds every clip generated (45 files) under randomized filenames with no provider/term name in them; `blind-key.json` (git-ignored) holds the real mapping until that pass is run. That step needs a human ear and is intentionally left undone by the script.

## 5. Limitations

- Read-only/reversible tools only — no purchases, deletes, or emails; an irreversible external effect can't be meaningfully fenced.
- The anchor-phrase mismatch guard is a warning on the event ledger, not a block — a genuine mismatch still commits, deliberately, so a monitoring feature can't become a live-demo failure.
- Commit granularity is per-sentence, not per-word.
- With a slow tool, a mutation commits when the tool completes (the catch-up path), not at the instant its sentence ends — heard-correct, but not visually instantaneous. `SLOW_TOOL_MS` defaults to `0` outside the interruption stress demo so the two coincide.
- 48 generated scenarios + 1 hand-scripted out-of-order case are not a production traffic distribution — they exercise the specific race the commit gate closes, not general robustness. The generator matrix is parametric (`apps/agent/src/bench/scenarios.ts`) rather than 100 hand-authored scripts, trading raw scenario count for higher confidence that each generated case is actually correct.
- Single-room scale; no multi-agent handoffs or telephony.
- English only (see §4a): a multilingual mode was built and then removed rather than ship the commit gate degraded for non-English on Coda. The STT runs `language: 'en'`.
- Live interruption/recovery latency is measured — see §4 and `live-latency.md`. Recovery latency (~4s median) is slower than ideal; not yet tuned.
- A real reliability bug was found and fixed during this round of testing: `connectServices`/`renameComponent`/`removeComponent`/`replaceComponent`/`groupComponents` used to hash whatever label the LLM said directly into a node id, so a natural paraphrase ("connect the gateway to the auth service" for a node actually added as "API Gateway") produced a dangling reference — the mutation staged and "succeeded" but nothing rendered, silently. `CanvasStore.resolveId` now resolves spoken labels against the actual canvas (exact → case-insensitive → substring → generic-kind-noun → token overlap), falling back to the old behaviour only when nothing matches unambiguously. Regression-tested against the exact failing transcripts.
- Ambient meeting mode (`ADDRESSIVITY=true`) is unvalidated with two live browser tabs — the classifier, proposal store and safety invariant (scenarios 47/48) are unit-tested and audio-independent, but the multi-participant STT subscription has not run against real audio. Classifier F1 on the synthetic fixture: salient 0.92, addressed precision 1.0 / recall 0.30.
- **Collaboration is not a claim of this submission.** Cartograph is presented as a single-operator tool; `publishData` broadcasts to every participant in the room so a second viewer likely sees the same canvas, but this has not been tested and nothing in the pitch depends on it.
- Rime is measurably slower to first audio than Cartesia (~1.3-1.7s vs ~450-600ms), root-caused to the vendored plugin opening a fresh WebSocket per utterance with no connection reuse, against Cartesia's client library, which pools and prewarms connections (§4/§4b). A throwaway protocol-level test confirmed Rime's server tolerates connection reuse and would recover most of that gap (~350ms once warm) — real, evidenced, and deliberately not shipped: fixing it means reimplementing the plugin's whole message protocol on the exact path the commit gate's word timestamps depend on, which is disproportionate risk to this project's actual headline claim (correctness under interruption, not latency).
- The comparative TTS evaluation (§4b) is a single run, not a controlled lab benchmark: ~75 back-to-back calls against `agent-gateway.livekit.cloud` surfaced real, load-dependent connection reliability differences (0% Rime, since it bypasses that gateway; 75% Cartesia; 100% Fish Audio) that shaped the latency/reliability/intelligibility numbers as much as the underlying models did. Read `REPORT.md`'s own cross-references before citing any single number from it in isolation.
- The PS's blinded human listening test for the TTS comparison is prepared (`blind/` + `blind-key.json`) but not run — it needs a human ear and was left as a manual step.

## Demo script (4-5 minutes)

Not code — rehearse against it before presenting.

| Time | Beat |
|---|---|
| 0:00-0:30 | Target user + problem: an engineer thinking out loud through a system design, hands free — the canvas builds itself, and self-corrections are treated as normal, not errors. |
| 0:30-1:20 | Normal flow: speak three services, watch them land sentence by sentence as Rime speaks them. |
| 1:20-2:30 | **Stress case.** `SLOW_TOOL_MS=5000`. Say "add a Redis cache and connect it to the API gateway," interrupt on the second sentence with "wait, make that MongoDB." Show: audio cuts, the un-narrated edge never appears, the event ledger turns red, the 5-second-late tool result arrives and is rejected. |
| 2:30-3:10 | Same script with `CARTOGRAPH_BASELINE=true` — the ghost node/edge appears. Side by side against the fenced run. |
| 3:10-3:40 | Numbers on screen, not a slide: `pnpm --filter DD_agent benchmark` (0% divergence vs 81% baseline) and the measured live-latency table (two independent runs, medians agreeing within ~1%). |
| 3:40-4:20 | Rime's role: WebSocket streaming, word timestamps, and the fact that they're what drives the commit gate. Show the disclosure table in `README.md`. |
