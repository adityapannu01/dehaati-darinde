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

**Run against real sessions, 2026-09-08: 10/10 independent agreement, 0 divergences**, across three separate calls and four real interruptions. The independent auditor reached the same commit verdict as the production commit gate every time, using none of its code. Caveat, stated plainly and consistently across all three runs: every interruption landed after its sentence had already finished playing — nothing was ever dropped mid-flight in live testing. This isn't bad luck; the persona keeps replies to short, single-component sentences by design ("describe exactly ONE change per sentence... 1-3 sentences"), so a sentence often finishes in under a second, genuinely hard to interrupt mid-word without either a longer narrated sentence or `SLOW_TOOL_MS` (the project's own documented stress-test knob for reproducing this race reliably — see the Demo script). This run set validates the *committed* side live, three times over; the *dropped* side is validated by the 48-scenario deterministic benchmark and by `audit-session.test.ts`'s own synthetic fixture for that case, not yet by a live drop through this specific tool.

**A lever investigated and closed, not left unexplored:** Rime's `reduceLatency` option looked like a direct fix for the recovery leg. Checked the plugin's compiled source (`@livekit/agents-plugin-rime@1.7.1`), not just its types: `reduceLatency` is only forwarded into the actual Rime request when `modelId` is `mistv2` — for `coda` it's silently dropped on both the WebSocket and HTTP paths. Switching to Mist v2 to reach it isn't an option either, since Mist v2 has no word-level timestamps, which the commit gate requires. Left unset in `tts.ts` rather than shipped as a config flag that would silently do nothing.

Rime pronunciation: 44 infrastructure terms rendered through the shipped `coda:celeste` WebSocket path in three variants each (plain / hand-respelled / **the shipped `applyLexicon` output**) — clips + comparison table in `apps/agent/src/bench/pronunciation/REPORT.md`. `RIME_SAVE_OOVS=true` logs Rime's out-of-vocabulary words for a real session.

`pnpm test` (~218 tests across core engine, tools, commit gate, transport, benchmark, planner/graph, layout, turn-taking, addressivity/proposals/ambient, language router, lexicon, the real slow tool, and the agent evals): **all passing** as of this commit.

## 4a. Multilingual & pronunciation (MULTILINGUAL_AND_PRONUNCIATION.md)

**§0 gate spike (recorded, not committed as code).** Synthesised 3-sentence strings through the shipped Coda WebSocket plugin in English, Hindi (`nadi`) and Japanese (`akatsuki`), logging every aligned word:

| Language | audio frames | words with `startTime`/`endTime` |
|---|--:|--:|
| English (`eng` / celeste) | 78 | **17** |
| Hindi (`hin` / nadi) | 92 | **0** |
| Japanese (`jpn` / akatsuki) | 96 | **0** |

**Rime Coda returns word-level timestamps only for English.** Non-English audio synthesises fine, but the commit gate has no per-sentence delivery signal. Per the plan's §2.7, multilingual therefore ships in **degraded mode** for non-English: mutations commit on `onTurnComplete` (turn granularity) rather than per sentence, and an interruption drops everything still pending. The HUD shows `degraded timing` when a non-English voice is active. English keeps the full per-sentence gate.

**Disclosure matrix** (PS p.2 — exact model/speaker/lang/transport, now a matrix):

| Language | Rime model | Speaker | `lang` | Word timestamps | Commit gate | Tested |
|---|---|---|---|---|---|---|
| English | coda | celeste | eng | **yes** (17/17 verified) | per-sentence | **yes** |
| Hindi | coda | nadi | hin | no (0 verified) | degraded (onTurnComplete) | **yes** |
| Spanish | coda | brisa | spa | not verified | degraded | no |
| French | coda | aurelie | fra | not verified | degraded | no |
| German | coda | lorelei | ger | not verified | degraded | no |
| Italian | coda | livia | ita | not verified | degraded | no |
| Japanese | coda | akatsuki | jpn | no (0 verified) | degraded | no |
| Portuguese | coda | estela | por | not verified | degraded | no |
| Arabic | coda | layla | ara | not verified | degraded | no |

Endpoint `wss://users-ws.rime.ai/ws3?...` · PCM 24 kHz mono · WebSocket, all languages. Speakers picked for demographic continuity with `celeste` (Female / Young Adult) where a match exists — see `apps/agent/src/voices.ts`. **This trades against a persistent voice identity: no Coda voice crosses languages, so the agent audibly becomes a different person on a switch. Matched demographics soften it; they don't remove it.**

Code-switching: `universal-3-5-pro` *understands* mixed-language input natively; the agent *replies* in the dominant language of the turn, technical nouns in Latin script. It cannot speak a mixed-language reply — one Rime request binds one speaker to one language.

**Pronunciation.** Coda has no inline phonemes (Mist v2 only, and Mist v2 has no word timestamps), so respelling the text sent to Rime is the only lever. The lexicon (`core/lexicon.ts`) is applied at the `ttsNode` tap — after the model produces correct text, before Rime — buffered to sentence boundaries so a term can't split across a chunk. Both sides of the commit gate's anchor check are normalised through the same lexicon, so a respelled term never trips `anchor_mismatch` (regression-tested). The STT gets the same term list via `keyterms_prompt` so recognition biases toward "nginx"/"etcd" too.

## 5. Limitations

- Read-only/reversible tools only — no purchases, deletes, or emails; an irreversible external effect can't be meaningfully fenced.
- The anchor-phrase mismatch guard is a warning on the event ledger, not a block — a genuine mismatch still commits, deliberately, so a monitoring feature can't become a live-demo failure.
- Commit granularity is per-sentence, not per-word.
- With a slow tool, a mutation commits when the tool completes (the catch-up path), not at the instant its sentence ends — heard-correct, but not visually instantaneous. `SLOW_TOOL_MS` defaults to `0` outside the interruption stress demo so the two coincide.
- 48 generated scenarios + 1 hand-scripted out-of-order case are not a production traffic distribution — they exercise the specific race the commit gate closes, not general robustness. The generator matrix is parametric (`apps/agent/src/bench/scenarios.ts`) rather than 100 hand-authored scripts, trading raw scenario count for higher confidence that each generated case is actually correct.
- Single-room scale; no multi-agent handoffs or telephony.
- Multilingual (`RIME_MULTILINGUAL=true`): non-English runs in degraded commit mode (see §4a — Coda gives no non-English word timestamps). `eng` + `hin` tested; the other 7 Coda languages configured but unverified. Not a translation feature — the agent replies in the room's language, it does not translate.
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
| 3:10-3:40 | Numbers on screen, not a slide: `pnpm --filter DD_agent benchmark` (0% divergence vs 81% baseline) and the measured live-latency table (two independent runs, medians agreeing within ~1%). |
| 3:40-4:20 | Rime's role: WebSocket streaming, word timestamps, and the fact that they're what drives the commit gate. Show the disclosure table in `README.md`. |
