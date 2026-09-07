import { describe, expect, it } from 'vitest';
import { isBackchannel } from './turn-taking.ts';

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
});
