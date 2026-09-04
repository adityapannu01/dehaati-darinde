import { describe, expect, it } from 'vitest';
import { runAll, runOutOfOrderScenario } from './runner.ts';
import { SCENARIOS } from './scenarios.ts';

describe('benchmark runner — the actual headline claim, checked automatically', () => {
  it('cartograph mode has zero canvas divergence across every generated scenario', () => {
    const results = runAll(SCENARIOS).filter((r) => !r.baselineMode);
    const divergent = results.filter((r) => r.divergent);
    expect(divergent).toEqual([]);
  });

  it('cartograph mode has zero stale mutations across every generated scenario', () => {
    const results = runAll(SCENARIOS).filter((r) => !r.baselineMode);
    expect(results.every((r) => r.staleCount === 0)).toBe(true);
  });

  it('baseline mode (fencing disabled) diverges on at least one scenario — proves the comparison has teeth', () => {
    const results = runAll(SCENARIOS).filter((r) => r.baselineMode);
    expect(results.some((r) => r.divergent)).toBe(true);
  });

  it('the generated matrix is non-trivial (more than a handful of scenarios)', () => {
    expect(SCENARIOS.length).toBeGreaterThan(20);
  });
});

describe('out-of-order resolution (brainstorm §20)', () => {
  it('cartograph: only the last-arriving-while-still-current result lands', () => {
    const result = runOutOfOrderScenario(false);
    expect(result.landedNodeIds).toEqual(['gen-3']);
    expect(result.correct).toBe(true);
  });

  it('baseline: fencing disabled lets every stale result land', () => {
    const result = runOutOfOrderScenario(true);
    expect(result.landedNodeIds.length).toBeGreaterThan(1);
    expect(result.correct).toBe(false);
  });
});
