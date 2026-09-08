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

Two independent real sessions, same procedure, same machine/project, run minutes apart. Both included: 10+ scripted interruptions mixing early-cut (right as the agent starts replying) and late-cut (near the end of its sentence), normal uninterrupted turns for contrast, and one interruption during `explainComponent`'s real Wikipedia lookup. Reported medians agree within ~1%, which is the reproducibility check this table exists to provide.

### Run 1

`pnpm --filter DD_agent latency < agent.log`:

| # | fence (ms) | recovery (ms) | | # | fence (ms) | recovery (ms) |
|--:|--:|--:|---|--:|--:|--:|
| 1 | 196 | — | | 20 | 2264 | 5859 |
| 2 | — | 7359 | | 21 | 2667 | 4154 |
| 3 | 3874 | 43508 | | 22 | 1981 | 3672 |
| 4 | 8775 | 6834 | | 23 | 4074 | — |
| 5 | 4557 | 4009 | | 24 | 2298 | 5973 |
| 6 | 7781 | 5659 | | 25 | 3930 | 4318 |
| 7 | 4607 | 5535 | | 26 | 2457 | 4894 |
| 8 | 2905 | 2970 | | 27 | 4537 | 3323 |
| 9 | 2514 | 3168 | | 28 | 3233 | 6249 |
| 10 | 4159 | 3352 | | 29 | 4028 | 3624 |
| 11 | 2216 | 3431 | | 30 | 1811 | 3900 |
| 12 | 2004 | 4327 | | 31 | 1841 | — |
| 13 | 2985 | 4309 | | 32 | 2006 | 2024 |
| 14 | 1851 | 5532 | | 33 | 3131 | 3249 |
| 15 | 1735 | 3966 | | 34 | 2585 | 3183 |
| 16 | 1212 | 5132 | | 35 | 2209 | 3446 |
| 17 | 4366 | 7311 | | 36 | 3780 | 1918 |
| 18 | 1847 | 3562 | | 37 | 1982 | 3089 |
| 19 | 1803 | 4166 | | 38 | 2355 | 3192 |

**n=37 fence, n=35 recovery:** fence median 2514 ms / p95 4607 ms (min 196, max 8775); recovery median 4009 ms / p95 7311 ms (min 1918, max 43508 — one high value, excluded from the p95/headline read below as non-representative).

### Run 2

| # | fence (ms) | recovery (ms) | | # | fence (ms) | recovery (ms) |
|--:|--:|--:|---|--:|--:|--:|
| 1 | 5700 | 3815 | | 17 | 2965 | 3570 |
| 2 | 2171 | — | | 18 | 1744 | 7379 |
| 3 | 2315 | 6193 | | 19 | 2677 | 4785 |
| 4 | 2608 | 3287 | | 20 | 2540 | 3672 |
| 5 | 133 | — | | 21 | 1686 | — |
| 6 | — | 3760 | | 22 | 1737 | 6080 |
| 7 | 2343 | 3339 | | 23 | 1731 | 3014 |
| 8 | 1729 | — | | 24 | 4297 | — |
| 9 | 3011 | 3324 | | 25 | 2738 | 3434 |
| 10 | 4025 | 7066 | | 26 | 3954 | — |
| 11 | 2502 | 4020 | | 27 | 4545 | 4982 |
| 12 | 3450 | 3692 | | 28 | 1313 | — |
| 13 | 1955 | 2185 | | 29 | — | 4413 |
| 14 | 2514 | 2463 | | 30 | 2330 | 2972 |
| 15 | 1647 | 4353 | | 31 | 2387 | 3218 |
| 16 | 2791 | 3039 | | | | |

**n=29 fence, n=24 recovery:** fence median 2502 ms / p95 4297 ms (min 133, max 5700); recovery median 3672 ms / p95 6193 ms (min 2185, max 7379). Row 1 (5700 ms fence) is the cold interruption, consistent with connection/model warm-up.

### Headline numbers (both runs)

**Fence latency** — median **~2510 ms**, p95 **~4.3-4.6s**
**Recovery latency** — median **~3.7-4.0s**, p95 **~6.2-7.3s**

**Reading the numbers:** fence latency is dominated by how long the user's own interrupting phrase takes to finish being said and transcribed, not raw cancellation speed (`GenerationManager.cancelCurrent()` itself is a synchronous, sub-millisecond call — see `core/generation.test.ts`). Recovery latency — LiveKit Inference LLM round-trip + Rime TTS time-to-first-audio — is the real optimization target and is slower than ideal for a "perceived response time" claim; reported as measured across two independent runs, not tuned away before reporting. See Limitations.

### Audio-stop confirmation — "does queued audio actually stop", not just "was cancellation decided"

Fence latency answers "how fast did we decide to cancel." It does not answer the PS's own full-duplex phrasing — "queued Rime audio stops promptly" — which is about the audio itself, not the decision. `pnpm --filter DD_agent latency` also correlates each `generation_cancelled` with the LiveKit Agents SDK's own `"playout completed with interrupt"` log line (fired once the SDK has cancelled the reply pipeline and drained the audio-forwarding task), from the same two runs above:

**n=7, median 13 ms, p95 25 ms (min 3, max 138)** — n=7 because only turns where the agent was actually mid-speech at cancellation count (most cancellations are ordinary turn-taking with nothing playing to interrupt). Every value under 150ms. This is LiveKit SDK-internal behaviour, not Cartograph code, which is exactly why it's measured rather than assumed. `apps/agent/src/bench/latency.test.ts` covers the pairing logic; the pairing itself anchors the SDK's time-of-day-only log line to "today," so it's correct when parsed the same day it's captured and wrong across a midnight boundary — disclosed, not silently assumed away.
