# Live latency measurement procedure

The deterministic benchmark (`pnpm benchmark`) proves correctness — canvas divergence and stale-mutation rate — with a synthetic, synchronous harness. It cannot measure real interruption→silence timing, because there's no real audio or network round-trip in it. This document is the manual procedure for that number, and a place to paste the real results once collected.

**Status: not yet run.** The numbers below are placeholders — do not report them as measured. Per the project's own rule, an unverified number is worse than an omitted one.

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

## Results (paste `pnpm --filter DD_agent latency` output here)

**Status: not yet run.** No numbers are reported until a real session is captured and parsed.

| # | fence latency (ms) | recovery latency (ms) | warm/cold | notes |
|--:|--:|--:|---|---|
| 1 | | | cold | first turn after connect |
| … | | | | |
| 20 | | | | |

**Fence latency** (warm) — median: _pending_, p95: _pending_
**Recovery latency** (warm) — median: _pending_, p95: _pending_
