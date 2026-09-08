// Parses the agent worker's `[latency]` log lines into the fence- and
// recovery-latency table live-latency.md asks for. Turns "read the log by
// hand" into:
//
//   pnpm --filter DD_agent dev 2>&1 | tee /tmp/agent.log      # hold a real call
//   pnpm --filter DD_agent latency < /tmp/agent.log
//
// Three instrumented lines (main.ts / agent.ts), all level `info`:
//   [latency] user_speech_start t=<ms>
//   [latency] generation_cancelled t=<ms>
//   [latency] first_audio_frame gen=<id> t=<ms>
//
// fence latency    = generation_cancelled.t - preceding user_speech_start.t
// recovery latency = next first_audio_frame.t - generation_cancelled.t
//
// A fourth, separately-reported number: audio-stop confirmation. The PS's own
// full-duplex example asks specifically whether "queued Rime audio stops
// promptly" — which fence latency does NOT measure (that's decision speed,
// not confirmed silence). The LiveKit Agents SDK logs "playout completed with
// interrupt" once it has actually cancelled the reply pipeline and drained
// the audio-forwarding task — a real (if LiveKit-internal, not agent-decided)
// confirmation that playback stopped. That line uses the SDK's own pino
// pretty-print time-of-day format ([HH:MM:SS.mmm]), not our epoch `t=`
// timestamps, so it's parsed and paired separately.

import { readFileSync } from 'node:fs';
import process from 'node:process';

type Kind = 'user_speech_start' | 'generation_cancelled' | 'first_audio_frame';
interface Event {
  kind: Kind;
  t: number;
  gen?: number | undefined;
}

const LINE = /\[latency\]\s+(user_speech_start|generation_cancelled|first_audio_frame)(?:\s+gen=(\d+))?\s+t=(\d+)/;
// Pino's pretty-printed time-of-day prefix, on the SDK's own interruption-confirmation line.
const PLAYOUT_STOPPED_LINE = /^\[(\d\d):(\d\d):(\d\d)\.(\d\d\d)\].*playout completed with interrupt/;

function parse(text: string): Event[] {
  const events: Event[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(LINE);
    if (!m) continue;
    events.push({
      kind: m[1] as Kind,
      gen: m[2] ? Number(m[2]) : undefined,
      t: Number(m[3]),
    });
  }
  return events;
}

/**
 * Pairs each SDK-confirmed playout stop with the nearest preceding
 * generation_cancelled, and returns the gap in ms. NOTE: the SDK's line only
 * carries a time-of-day, not a date, so this anchors it to "today" (when this
 * script runs) — correct for the normal workflow (parse the log the same day
 * it's captured), wrong if parsing a log across a midnight boundary. A pairing
 * more than 2s apart (or a "stop" before its "cancel") is treated as
 * unrelated and dropped rather than reported as a false precision.
 */
export function audioStopDelays(text: string): number[] {
  type Tagged = { kind: 'cancelled' | 'stopped'; t: number };
  const events: Tagged[] = [];
  for (const line of text.split('\n')) {
    const cancel = line.match(/\[latency\] generation_cancelled t=(\d+)/);
    if (cancel) {
      events.push({ kind: 'cancelled', t: Number(cancel[1]) });
      continue;
    }
    const stopped = line.match(PLAYOUT_STOPPED_LINE);
    if (stopped) {
      const [, hh, mm, ss, ms] = stopped;
      const d = new Date();
      d.setHours(Number(hh), Number(mm), Number(ss), Number(ms));
      events.push({ kind: 'stopped', t: d.getTime() });
    }
  }

  const delays: number[] = [];
  let lastCancel: number | null = null;
  for (const e of events) {
    if (e.kind === 'cancelled') {
      lastCancel = e.t;
    } else if (lastCancel !== null) {
      const delta = e.t - lastCancel;
      if (delta >= -500 && delta < 2000) delays.push(delta);
    }
  }
  return delays;
}

interface Interruption {
  n: number;
  userSpeechStart?: number | undefined;
  generationCancelled?: number | undefined;
  firstAudioFrame?: number | undefined;
  fenceMs?: number | undefined;
  recoveryMs?: number | undefined;
}

function pair(events: Event[]): Interruption[] {
  const rows: Interruption[] = [];
  let pendingSpeechStart: number | undefined;
  let current: Interruption | undefined;
  let n = 0;

  for (const ev of events) {
    if (ev.kind === 'user_speech_start') {
      pendingSpeechStart = ev.t;
    } else if (ev.kind === 'generation_cancelled') {
      n += 1;
      current = { n, userSpeechStart: pendingSpeechStart, generationCancelled: ev.t };
      if (pendingSpeechStart !== undefined) current.fenceMs = ev.t - pendingSpeechStart;
      rows.push(current);
      pendingSpeechStart = undefined;
    } else if (ev.kind === 'first_audio_frame') {
      const c = current;
      if (c && c.firstAudioFrame === undefined) {
        c.firstAudioFrame = ev.t;
        if (c.generationCancelled !== undefined) c.recoveryMs = ev.t - c.generationCancelled;
        current = undefined;
      }
    }
  }
  return rows;
}

function stats(xs: number[]): { n: number; median: number; p95: number; min: number; max: number } | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const at = (q: number): number => {
    const idx = Math.min(v.length - 1, Math.floor(q * (v.length - 1)));
    return v[idx] ?? 0;
  };
  return { n: v.length, median: at(0.5), p95: at(0.95), min: v[0] ?? 0, max: v[v.length - 1] ?? 0 };
}

function main(): void {
  const text = readFileSync(0, 'utf8');
  const rows = pair(parse(text));

  if (rows.length === 0) {
    console.error('No [latency] lines found on stdin. Pipe the agent worker log in.');
    process.exit(1);
  }

  console.log('| # | fence latency (ms) | recovery latency (ms) |');
  console.log('|--:|--:|--:|');
  for (const r of rows) {
    console.log(`| ${r.n} | ${r.fenceMs ?? '—'} | ${r.recoveryMs ?? '—'} |`);
  }

  const fence = stats(rows.map((r) => r.fenceMs ?? NaN));
  const recovery = stats(rows.map((r) => r.recoveryMs ?? NaN));
  console.log('');
  if (fence) {
    console.log(
      `Fence latency    — n=${fence.n}  median ${fence.median} ms  p95 ${fence.p95} ms  (min ${fence.min}, max ${fence.max})`,
    );
  }
  if (recovery) {
    console.log(
      `Recovery latency — n=${recovery.n}  median ${recovery.median} ms  p95 ${recovery.p95} ms  (min ${recovery.min}, max ${recovery.max})`,
    );
  }
  console.log('\nNote: the first interruption after connect is cold (model/connection warm-up). Label it and exclude it from the warm medians.');

  const audioStop = stats(audioStopDelays(text));
  if (audioStop) {
    console.log(
      `\nAudio-stop confirmation — n=${audioStop.n}  median ${audioStop.median} ms  p95 ${audioStop.p95} ms  (min ${audioStop.min}, max ${audioStop.max})`,
    );
    console.log(
      '(generation_cancelled -> SDK\'s own "playout completed with interrupt" log; answers "does queued audio actually stop", not just "was cancellation decided". Only counts turns where the agent was actually mid-speech when cancelled.)',
    );
  }
}

// Runnable directly: `pnpm --filter DD_agent latency`.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
