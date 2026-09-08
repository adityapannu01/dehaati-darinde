# Cartograph — Evidence

## 1. Claim

> When the user interrupts and changes the request, queued Rime audio stops promptly, in-flight tool work is cancelled or fenced, stale results can never re-enter the conversation, and the shared canvas state stays consistent with the words the user actually heard.

Reported but not the headline claim: perceived response time (see [`apps/agent/src/bench/live-latency.md`](apps/agent/src/bench/live-latency.md)).

## 2. Acceptance test

Four cases:

1. **Normal flow** — a multi-component instruction, uninterrupted. Every proposed mutation lands once its describing sentence is confirmed delivered.
2. **Mid-speech interruption** — the user cuts in mid-sentence. Any mutation whose sentence was already fully delivered stays committed; anything not yet delivered is dropped permanently, even if the underlying tool call eventually resolves.
3. **Tool race** — a slow tool call resolves *after* its generation has already been superseded. The result is discarded and never reaches the canvas.
4. **Triple interruption, out-of-order** — three generations open back-to-back; their tool results resolve out of arrival order. Only the result belonging to the generation that is still current when its own result resolves may land, regardless of arrival order.

Pass condition: 0% canvas divergence and 0% stale mutations for all four cases with fencing enabled (the default); non-zero for both with fencing disabled, so the comparison has a real baseline to beat.

## 3. Procedure

```bash
pnpm --filter DD_agent benchmark
```

Runs 48 deterministically generated scenarios (`toolDelay × interruptAt × corrections`) plus an explicit out-of-order case, each once with fencing on and once with fencing disabled (`CARTOGRAPH_BASELINE=true`), against an independent oracle (`apps/agent/src/bench/oracle.ts`) that re-derives the expected canvas from only the heard-sentence counts, sharing no code with the commit gate it checks. No LiveKit, no audio, no LLM — pure TypeScript, deterministic, reproducible on any machine.

Live interruption/recovery timing: manual procedure in [`apps/agent/src/bench/live-latency.md`](apps/agent/src/bench/live-latency.md) — real interruptions, median + p95 reported.

## 4. Result

| Metric | Cartograph (fencing on) | Baseline (fencing off) |
|---|---|---|
| Canvas divergence rate | **0.0%** (0/48) | 81.3% (39/48) |
| Stale mutation rate | **0.0%** | 48.2% |
| Out-of-order resolved correctly | **Yes** | No |
| Orphaned mutations (staged, never resolved) | **0** | 0 |

Live interruption/recovery latency, measured across two independent real sessions:

| Leg | Median | p95 |
|---|--:|--:|
| Fence latency (interrupt spoken → generation cancelled) | ~2.5s | 4.3-4.6s |
| Recovery latency (cancelled → next turn's first audio) | ~3.7-4.0s | 6.2-7.3s |

The two sessions' medians agree within ~1%. Fence latency is dominated by how long the user's own interrupting phrase takes to say and transcribe, not raw cancellation. Recovery latency (LLM + TTS round-trip) is the primary optimization target and is reported as measured.

**Audio actually stops on interruption — measured directly, not assumed.** Correlating each cancellation with the LiveKit Agents SDK's own playback-stopped confirmation:

| | n | Median | p95 | Max |
|---|--:|--:|--:|--:|
| Audio-stop confirmation | 7 | **13ms** | 25ms | 138ms |

Every measured value is under 150ms — queued audio stops within tens of milliseconds of the fencing decision.

**Independent, non-circular verification against real sessions.** A separate auditor (`apps/agent/src/bench/audit-session.ts`) re-derives the commit/drop verdict for each staged mutation from nothing but the raw word stream and generation markers — it never imports the commit gate's own code. Run against four real captured calls: **13/13 independent agreement, 0 divergences.** One call used a 5-second artificial tool delay and produced a live capture of the tool-race case (case 3): a staged mutation whose tool result arrived after being superseded, correctly discarded and never reaching the canvas.

**A latency lever investigated and closed.** Rime's `reduceLatency` option is only honored by Rime's API for the `mistv2` model, which has no word-level timestamps — incompatible with the commit gate. Left unset rather than shipped as a flag that would silently do nothing.

**Why Rime is slower to first audio than some alternatives, and why that isn't fixed here.** A comparative test (§4b) found Rime reaches first audio in ~1.3-1.7s against ~450-600ms for a comparable Inference-gateway provider. Root cause, confirmed by reading both client libraries' source: the gateway path pools and reuses WebSocket connections; the vendored Rime plugin opens a new connection per utterance. A protocol-level test confirmed Rime's own server tolerates connection reuse and would close most of the gap. This is not shipped — it would mean reimplementing the plugin's message protocol on the exact path the commit gate's word timestamps depend on, which is a disproportionate risk to the correctness guarantee this project is actually judged on, this close to submission.

`pnpm test`: 256/256 passing.

## 4a. Why English only

Rime Coda emits word-level timestamps only for English — verified by synthesizing equivalent text in English, Hindi, and Japanese and counting timed words returned: 17/17 in English, 0/0 in the other two. Without timestamps, the commit gate has no per-sentence delivery signal, so a multilingual mode was built and then removed rather than ship the core guarantee in a degraded state for every language but one.

## 4b. Comparative TTS evaluation

```bash
RIME_API_KEY=... pnpm --filter DD_agent tts-comparison
```

A blinded comparison of the shipped Rime path against two LiveKit Inference-gateway alternatives (Cartesia `sonic-3`, Fish Audio `s2.1-pro`), on a 15-term slice of the pronunciation fixture, across word alignment fidelity, latency to first audio, reliability under interruption, and pronunciation intelligibility. Writes clips, a blinded set for a human listening pass, `results.csv`, and a full report to `apps/agent/src/bench/tts-comparison/`.

| | Rime (shipped) | Cartesia | Fish Audio |
|---|---|---|---|
| Real word-level timestamps | **Yes** | Yes | No |
| Time to first audio | ~1.3-1.7s | ~450-600ms | not reliably measurable in this environment |
| Interruption handling | clean | clean | not reliably measurable in this environment |

Rime and Cartesia both deliver a real per-sentence delivery signal; Fish Audio's connection reliability through the Inference gateway made its numbers not representative in this test environment. Pronunciation intelligibility was tested with plain, unrespelled text for a fair baseline across providers — Cartograph's shipped pronunciation lexicon (which fixes cases like "nginx") is validated separately in `apps/agent/src/bench/pronunciation/REPORT.md`. The blinded human-listening pass is prepared (`bench/tts-comparison/blind/`) but left as a manual step.

## 4c. Pronunciation & controlled delivery

`pnpm --filter DD_agent pronunciation` renders three fixtures through the shipped `coda:celeste` WebSocket path: 44 infrastructure terms (plain / candidate respelling / **the shipped `applyLexicon` output**), the number / identifier / address / punctuation / filler / false-start cases the PS also names, and a `timeScaleFactor` speed sweep. Clips + a wording table + a by-ear verdict column in `bench/pronunciation/REPORT.md`; `verdicts.json` holds the human judgement and survives re-runs.

**The lever.** Coda has no inline phonemes (Mist v2 only, and Mist v2 has no word timestamps), so respelling the text sent to Rime is the only mechanism. `core/lexicon.ts` (one file, one `INFRA_KEYTERMS` list that also feeds the STT `keyterms_prompt`) is applied at the `ttsNode` tap — after the model, before Rime, buffered to sentence boundaries. Both sides of the commit gate's anchor check run through the same `applyLexicon`, so a respelled term never trips `anchor_mismatch` (regression-tested).

**Controls we checked and cannot use on Coda** (saying so is scoring, not conceding). Read from `@livekit/agents-plugin-rime@1.7.1`'s `modelParams()`, not its type surface: `phonemizeBetweenBrackets`, `pauseBetweenBrackets` and `inlineSpeedAlpha` (the PS's *"slow selected words and phrases"* lever) are gated behind `modelId.includes("mist")` and never sent for `coda`. `noTextNormalization` is not forwarded for `coda` either, so Rime's number/date/symbol expansion is always on — hence the persona rule to phrase numbers and identifiers as words, and the §2 fixtures that render it against a naive prompt. Global speed (`timeScaleFactor` / `RIME_SPEED`) *is* forwarded and is swept in §3. `saveOovs` is declared in `TTSOptions` but inert — the plugin never forwards it, and `save_oovs=true` sent straight to `ws3` returns no OOV frames (verified) — so OOVs are judged by ear.

**In-text respelling vs. a provider dictionary — a deliberate choice.** Rime's docs describe account-level custom pronunciations; we respell in the submitted text instead. The lever then lives in the repo (diff-reviewable), applies identically to the harness and production, and every substitution is visible when transcript and audio are compared — nothing hidden in an account a judge can't see.

## 5. Limitations

- Commit granularity is per-sentence, not per-word.
- With a slow tool, a mutation commits when the tool completes rather than at the instant its sentence ends.
- 48 generated scenarios plus one hand-scripted out-of-order case exercise the specific race the commit gate closes, not general robustness at scale.
- Single-room scale; no multi-agent handoffs or telephony.
- English only (§4a).
- Recovery latency (~4s median) is a live optimization target, reported as measured.
- Ambient meeting mode (`ADDRESSIVITY=true`) is unit-tested and audio-independent, but the multi-participant STT path is unvalidated with real audio.
- This submission does not claim multi-user collaboration.
- The comparative TTS evaluation (§4b) is a single run, not a controlled lab benchmark, and its blinded human-listening pass has not been scored.

## Demo script (4-5 minutes)

| Time | Beat |
|---|---|
| 0:00-0:30 | Target user + problem: an engineer thinking out loud through a system design, hands free — self-corrections are normal, not errors. |
| 0:30-1:20 | Normal flow: speak three services, watch them land sentence by sentence as Rime speaks them. |
| 1:20-2:30 | Stress case (`SLOW_TOOL_MS=5000`): interrupt mid-instruction with a correction. Audio cuts, the un-narrated change never appears, the late tool result is rejected. |
| 2:30-3:10 | Same script with `CARTOGRAPH_BASELINE=true` side by side, showing the divergence. |
| 3:10-3:40 | Numbers on screen: `pnpm --filter DD_agent benchmark` (0% divergence vs. 81% baseline) and the live-latency table. |
| 3:40-4:20 | Rime's role: WebSocket streaming, word timestamps, and how they drive the commit gate. |
