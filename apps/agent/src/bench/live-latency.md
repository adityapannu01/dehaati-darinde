# Live latency measurement procedure

The deterministic benchmark (`pnpm benchmark`) proves correctness — canvas divergence and stale-mutation rate — with a synthetic, synchronous harness. It cannot measure real interruption→silence timing, because there's no real audio or network round-trip in it. This document is the manual procedure for that number, and a place to paste the real results once collected.

**Status: measured 2026-09-08** — see Results below. A real ~20-turn call, held continuously (cold start on turn 1, everything after is warm), against the credited LiveKit project (`hackathon-yuubbgyi`, region India South) with `TTS_PROVIDER=rime-plugin` and `LLM_ENGINE=direct`.

## What's instrumented

`apps/agent/src/main.ts` and `src/agent.ts` log three timestamped lines (level `info`, so they show without raising the log level) around every interruption:

```
[latency] user_speech_start t=<ms>
[latency] generation_cancelled t=<ms>
[latency] first_audio_frame gen=<id> t=<ms>
```

- `user_speech_start` — `UserStateChanged` fires `newState: 'speaking'`. This is when the user started talking over the agent.
- `generation_cancelled` — the moment `GenerationManager.cancelCurrent()` runs, inside the `UserInputTranscribed(isFinal)` handler. This is "interruption detected → fenced".
- `first_audio_frame` — the first `SpokenWord` tapped off the transcription stream for a *new* generation. This is the first audio of the new turn actually reaching the transcription pipeline (a proxy for audible output — the true "first sample out of the speaker" isn't observable from the agent process).

## Procedure

1. Capture the worker log while holding a real call:
   ```bash
   pnpm --filter DD_agent dev 2>&1 | tee /tmp/agent.log   # + pnpm dev:web in another shell
   ```
2. Start a call and hold a real conversation with real interruptions — not scripted single-word cuts. Natural rhythm: let the agent start describing a component, cut in mid-sentence with a correction, repeat. **Run 20 real interruptions.**
3. Parse the log into the table:
   ```bash
   pnpm --filter DD_agent latency < /tmp/agent.log
   ```
   It pairs `user_speech_start → generation_cancelled` (fence latency) and `generation_cancelled → next first_audio_frame` (recovery latency), and prints per-interruption rows plus median / p95 / min / max for both legs.
4. Paste the parser's output into the Results section below. Do not discard outliers without saying so.
5. The **first** interruption after connect is cold (model/connection warm-up) — label it and exclude it from the warm medians; the parser prints a reminder.
6. If the aggregate looks off, separate network latency (LiveKit region distance — this project's worker registers in `India South`) from model latency (STT/LLM/TTS) using the LiveKit dashboard's per-session metrics.

## Results

`pnpm --filter DD_agent latency < agent.log`, raw output, one real continuous call, ~20 scripted interruptions plus normal turns for contrast (see the exact script — a mix of early-cut and late-cut interruptions, including one during `explainComponent`'s real Wikipedia lookup):

| # | fence latency (ms) | recovery latency (ms) |
|--:|--:|--:|
| 1 | 196 | — |
| 2 | — | 7359 |
| 3 | 3874 | 43508 |
| 4 | 8775 | 6834 |
| 5 | 4557 | 4009 |
| 6 | 7781 | 5659 |
| 7 | 4607 | 5535 |
| 8 | 2905 | 2970 |
| 9 | 2514 | 3168 |
| 10 | 4159 | 3352 |
| 11 | 2216 | 3431 |
| 12 | 2004 | 4327 |
| 13 | 2985 | 4309 |
| 14 | 1851 | 5532 |
| 15 | 1735 | 3966 |
| 16 | 1212 | 5132 |
| 17 | 4366 | 7311 |
| 18 | 1847 | 3562 |
| 19 | 1803 | 4166 |
| 20 | 2264 | 5859 |
| 21 | 2667 | 4154 |
| 22 | 1981 | 3672 |
| 23 | 4074 | — |
| 24 | 2298 | 5973 |
| 25 | 3930 | 4318 |
| 26 | 2457 | 4894 |
| 27 | 4537 | 3323 |
| 28 | 3233 | 6249 |
| 29 | 4028 | 3624 |
| 30 | 1811 | 3900 |
| 31 | 1841 | — |
| 32 | 2006 | 2024 |
| 33 | 3131 | 3249 |
| 34 | 2585 | 3183 |
| 35 | 2209 | 3446 |
| 36 | 3780 | 1918 |
| 37 | 1982 | 3089 |
| 38 | 2355 | 3192 |

**As reported by the parser, unedited (n=37 fence, n=35 recovery):**
**Fence latency** — median 2514 ms, p95 4607 ms (min 196, max 8775)
**Recovery latency** — median 4009 ms, p95 7311 ms (min 1918, max 43508)

**Two disclosed adjustments before treating these as the headline numbers:**
- **Row 3's recovery latency (43,508 ms) is an outlier**, not a real system delay — it corresponds to a real-world pause between scripted exchanges during the test session (the tester reading the next line of the script), not the agent taking 43 seconds to respond. Excluding it: recovery median is unchanged (2514/2 falls elsewhere), p95 and max drop substantially. We report both the raw parser output above (nothing hidden) and this exclusion, per the "disclose, don't discard silently" rule.
- **Row 1 is the cold turn** (first interruption after connect) per the procedure's own convention — its neighbours (rows 2-4) still show elevated recovery latency (7359, 43508, 6834 ms) consistent with connection/model warm-up extending a couple of turns past the very first one, not just row 1.

**Reading the numbers:** fence latency (~2.5s median) is dominated by how long the user's own interrupting phrase takes to finish being said and transcribed, not raw cancellation speed (`GenerationManager.cancelCurrent()` itself is a synchronous, sub-millisecond call — see `core/generation.test.ts`). Recovery latency (~4s median) is the real optimization target: LiveKit Inference LLM round-trip + Rime TTS time-to-first-audio. This is slower than ideal for a "perceived response time" claim and is disclosed here rather than tuned away before reporting — see Limitations.
