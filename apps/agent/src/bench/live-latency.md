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

1. `TTS_PROVIDER=rime-plugin pnpm dev:agent` and `pnpm dev:web` (or `pnpm dev` for both).
2. Open the browser, start a call, and hold a real conversation with real interruptions — not scripted single-word cuts. A natural rhythm: let the agent start describing a component, cut in mid-sentence with a correction, repeat.
3. **Run 20 real interruptions.** For each: from the agent's log, take `generation_cancelled.t - user_speech_start.t` (detection + fence latency) and, for the *next* turn, `first_audio_frame.t - generation_cancelled.t` (recovery latency — how long until the new turn is audible).
4. Record every raw pair in the table below. Do not discard outliers without saying so.
5. Report median and p95 separately for both legs, and note whether the run was on a warm connection (subsequent turns) or cold (first turn after connect) — cold includes model/connection warm-up and will skew latency high; label it and don't average it into the warm numbers.
6. Distinguish network latency (LiveKit region distance to the client) from model latency (STT/LLM/TTS processing) where possible — the LiveKit dashboard's per-session metrics can help separate these if the aggregate number looks off.

## Results (fill in after running the procedure)

| # | user_speech_start | generation_cancelled | fence latency (ms) | first_audio_frame (next turn) | recovery latency (ms) | warm/cold | notes |
|---|---|---|---|---|---|---|---|
| 1 | | | | | | | |
| ... | | | | | | | |
| 20 | | | | | | | |

**Fence latency** — median: _pending_, p95: _pending_
**Recovery latency** — median: _pending_, p95: _pending_
