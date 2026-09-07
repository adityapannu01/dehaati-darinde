import { describe, expect, it } from 'vitest';
import { evaluate, TRANSCRIPT } from './addressivity-fixture.ts';

describe('addressivity fixture (§2.6)', () => {
  it('every human utterance is labelled on both axes', () => {
    for (const u of TRANSCRIPT) {
      expect(typeof u.addressed, u.text).toBe('boolean');
      expect(typeof u.salient, u.text).toBe('boolean');
    }
  });

  it('produces a confusion matrix that sums to the human-turn count for every axis/threshold', () => {
    const humanTurns = TRANSCRIPT.filter((u) => u.speaker !== 'agent').length;
    for (const r of evaluate([0.5, 0.6, 0.7])) {
      const { tp, fp, tn, fn } = r.matrix;
      expect(tp + fp + tn + fn, `${r.axis}@${r.threshold}`).toBe(humanTurns);
    }
  });

  it('the prefilter never false-triggers "addressed" on this transcript (precision 1.0)', () => {
    // The whole point of the conservative prefilter: it must not make the agent
    // speak over a conversation. Recall is the model layer's job.
    for (const r of evaluate().filter((x) => x.axis === 'addressed')) {
      expect(r.matrix.fp, `${r.axis}@${r.threshold}`).toBe(0);
    }
  });

  it('salience detection is strong on its own (F1 >= 0.8)', () => {
    for (const r of evaluate().filter((x) => x.axis === 'salient')) {
      expect(r.f1).toBeGreaterThanOrEqual(0.8);
    }
  });
});
