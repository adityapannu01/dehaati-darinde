import { describe, expect, it } from 'vitest';
import { audioStopDelays } from './latency.ts';

// The SDK's line has no date, only time-of-day, so audioStopDelays anchors it
// to "today" via `new Date()` at parse time. Building fixture lines relative
// to the actual current time (rather than a fixed clock) keeps these tests
// stable regardless of when they run — the delta between two nearby
// timestamps is what's under test, not their absolute values.
function hhmmssmmm(d: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

describe('audioStopDelays', () => {
  it('pairs a playout-stopped line with its preceding generation_cancelled and returns the gap', () => {
    const cancelledAt = new Date();
    const stoppedAt = new Date(cancelledAt.getTime() + 13);
    const text = [
      `[INFO] [latency] generation_cancelled t=${cancelledAt.getTime()}`,
      `[${hhmmssmmm(stoppedAt)}] [32mINFO[39m (12345): [36mplayout completed with interrupt[39m`,
    ].join('\n');

    expect(audioStopDelays(text)).toEqual([13]);
  });

  it('ignores a playout-stopped line with no preceding cancellation', () => {
    const text = `[${hhmmssmmm(new Date())}] [32mINFO[39m (12345): [36mplayout completed with interrupt[39m`;
    expect(audioStopDelays(text)).toEqual([]);
  });

  it('drops a pairing more than 2s apart as unrelated rather than reporting false precision', () => {
    const cancelledAt = new Date();
    const stoppedAt = new Date(cancelledAt.getTime() + 5000);
    const text = [
      `[INFO] [latency] generation_cancelled t=${cancelledAt.getTime()}`,
      `[${hhmmssmmm(stoppedAt)}] [32mINFO[39m (1): [36mplayout completed with interrupt[39m`,
    ].join('\n');

    expect(audioStopDelays(text)).toEqual([]);
  });

  it('only counts stopped lines when the agent was actually mid-speech — playout-completed-without-interrupt does not pair', () => {
    const cancelledAt = new Date();
    const text = [
      `[INFO] [latency] generation_cancelled t=${cancelledAt.getTime()}`,
      `[${hhmmssmmm(new Date(cancelledAt.getTime() + 10))}] [32mINFO[39m (1): [36mplayout completed without interruption[39m`,
    ].join('\n');

    expect(audioStopDelays(text)).toEqual([]);
  });

  it('pairs each cancellation with its own nearest following stop across multiple turns', () => {
    const c1 = new Date();
    const s1 = new Date(c1.getTime() + 3);
    const c2 = new Date(c1.getTime() + 200);
    const s2 = new Date(c2.getTime() + 20);
    const text = [
      `[INFO] [latency] generation_cancelled t=${c1.getTime()}`,
      `[${hhmmssmmm(s1)}] [32mINFO[39m (1): [36mplayout completed with interrupt[39m`,
      `[INFO] [latency] generation_cancelled t=${c2.getTime()}`,
      `[${hhmmssmmm(s2)}] [32mINFO[39m (1): [36mplayout completed with interrupt[39m`,
    ].join('\n');

    expect(audioStopDelays(text)).toEqual([3, 20]);
  });
});
