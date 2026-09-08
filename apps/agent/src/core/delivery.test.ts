import { describe, expect, it } from 'vitest';
import { DeliveryTracker } from './delivery.ts';

// Sentence 1: "Adding a Redis cache." (4 words, ends at word 4)
// Sentence 2: "Now wiring it." (3 words, ends at word 7)
const WORDS = ['Adding', ' a', ' Redis', ' cache.', ' Now', ' wiring', ' it.'];

function timed(text: string, i: number) {
  return { text, startTime: i, endTime: i + 0.4 };
}

describe('DeliveryTracker', () => {
  it('counts complete sentences as they are pushed, word by word', () => {
    const tracker = new DeliveryTracker();
    const counts = WORDS.map((w, i) => tracker.push(timed(w, i)));
    expect(counts).toEqual([0, 0, 0, 1, 1, 1, 2]);
  });

  it('a stream cut mid-sentence-2 reports 1 and deliveredText ends at the first period', () => {
    const tracker = new DeliveryTracker();
    for (let i = 0; i < 6; i++) tracker.push(timed(WORDS[i] as string, i));
    expect(tracker.sentenceCount).toBe(1);
    expect(tracker.deliveredText).toBe('Adding a Redis cache.');
  });

  it('a token with no endTime does not advance the count', () => {
    const tracker = new DeliveryTracker();
    tracker.push({ text: 'Adding a Redis cache.', startTime: 0 }); // no endTime
    expect(tracker.sentenceCount).toBe(0);
    expect(tracker.deliveredText).toBe('');
  });

  it('reset() clears everything', () => {
    const tracker = new DeliveryTracker();
    for (let i = 0; i < 4; i++) tracker.push(timed(WORDS[i] as string, i));
    expect(tracker.sentenceCount).toBe(1);
    tracker.reset();
    expect(tracker.sentenceCount).toBe(0);
    expect(tracker.deliveredText).toBe('');
  });

  it('spokenText includes the in-flight unterminated sentence; deliveredText does not', () => {
    const tracker = new DeliveryTracker();
    for (let i = 0; i < 6; i++) tracker.push(timed(WORDS[i] as string, i)); // through "wiring", sentence 2 not closed
    expect(tracker.deliveredText).toBe('Adding a Redis cache.');
    expect(tracker.spokenText).toBe('Adding a Redis cache. Now wiring');
  });

  it('spokenText equals deliveredText once every sentence is closed', () => {
    const tracker = new DeliveryTracker();
    WORDS.forEach((w, i) => tracker.push(timed(w, i)));
    expect(tracker.spokenText).toBe(tracker.deliveredText);
  });
});
