import { describe, expect, it } from 'vitest';
import { DeliveryTracker } from './delivery.ts';
import { ACK_TOKENS, isBackchannel, SINGLE_WORD_COMMANDS } from './turn-taking.ts';

describe('isBackchannel', () => {
  it('treats short acknowledgements as backchannels', () => {
    for (const t of ['mm', 'mm-hmm', 'mhm', 'yeah', 'yep', 'right', 'okay', 'uh huh', 'got it']) {
      expect(isBackchannel(t), t).toBe(true);
    }
  });

  it('treats an empty final transcript as a backchannel', () => {
    expect(isBackchannel('')).toBe(true);
    expect(isBackchannel('   ')).toBe(true);
    expect(isBackchannel('...')).toBe(true);
  });

  it('never swallows a hard-interrupt word, even alone', () => {
    for (const t of ['no', 'wait', 'stop', 'no wait', 'actually hang on', 'scratch that']) {
      expect(isBackchannel(t), t).toBe(false);
    }
  });

  it('treats a real instruction as not a backchannel', () => {
    for (const t of [
      'add a redis cache',
      'connect the gateway to the database',
      'make that postgres instead',
      'use kafka for the queue',
    ]) {
      expect(isBackchannel(t), t).toBe(false);
    }
  });

  it('respects a custom minWords', () => {
    expect(isBackchannel('one two', { minWords: 3 })).toBe(true);
    expect(isBackchannel('one two three', { minWords: 3 })).toBe(false);
  });

  it('a longer acknowledgement string is still a real turn (too much content)', () => {
    // Four+ tokens: the user is saying something substantive even if it starts with "yeah".
    expect(isBackchannel('yeah so about that cache')).toBe(false);
  });

  // ROUND3 B3 — single-word command vocabulary
  it('fences on a bare single-word command', () => {
    for (const t of ['undo', 'clear', 'reset', 'vertical', 'horizontal', 'left', 'up', 'down', 'flip', 'again']) {
      expect(isBackchannel(t), t).toBe(false);
    }
  });

  it('still swallows the grunts it always did — the command list did not open the floodgates', () => {
    for (const t of ['mm', 'mhm', 'yeah', 'yep', 'uh', 'hmm', 'sure', 'okay']) {
      expect(isBackchannel(t), t).toBe(true);
    }
  });

  it('"right" collision: an acknowledgement while speaking, a command while silent', () => {
    expect(isBackchannel('right', { agentSpeaking: true })).toBe(true); // "correct"
    expect(isBackchannel('right', { agentSpeaking: false })).toBe(false); // "go right"
    // Two words with "right" is unambiguously a turn either way.
    expect(isBackchannel('go right', { agentSpeaking: true })).toBe(false);
  });

  // ROUND3 B2 — the acknowledgement invariant
  it('no acknowledgement token ends in a sentence terminator (DeliveryTracker must not count it)', () => {
    for (const t of ACK_TOKENS) {
      expect(t, t).not.toMatch(/[.!?।॥。？！؟]\s*$/);
      const tracker = new DeliveryTracker();
      tracker.push({ text: t, startTime: 0, endTime: 0.3 });
      expect(tracker.sentenceCount, t).toBe(0); // never advances the sentence count
    }
  });

  it('the single-word command list covers every arrangeLayout direction', () => {
    for (const dir of ['left', 'up', 'down']) {
      // 'right' is handled by the ambiguity path, not the hard list.
      expect(SINGLE_WORD_COMMANDS).toContain(dir);
    }
    expect(SINGLE_WORD_COMMANDS).toContain('right');
    // And the zero-arg tool verbs.
    for (const verb of ['undo', 'clear']) expect(SINGLE_WORD_COMMANDS).toContain(verb);
  });
});
