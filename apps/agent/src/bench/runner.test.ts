import { describe, expect, it } from 'vitest';
import { runAll, runOutOfOrderScenario, runScenarioFixed, runScenarioLegacy } from './runner.ts';
import { BACKCHANNEL_SCENARIOS, DIRECTION_SCENARIOS, SCENARIOS } from './scenarios.ts';

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

  it('no scenario ever orphans a staged mutation — silent orphaning is impossible (B1 criterion 3)', () => {
    const results = runAll(SCENARIOS);
    expect(results.every((r) => r.orphanCount === 0)).toBe(true);
  });

  it('baseline mode (fencing disabled) diverges on at least one scenario — proves the comparison has teeth', () => {
    const results = runAll(SCENARIOS).filter((r) => r.baselineMode);
    expect(results.some((r) => r.divergent)).toBe(true);
  });

  it('the generated matrix is non-trivial (more than a handful of scenarios)', () => {
    expect(SCENARIOS.length).toBeGreaterThan(20);
  });
});

describe('scenario 46 — backchannel during narration (TECHNICAL_REVIEW.md B1)', () => {
  it('the fixed engine commits every described mutation and orphans nothing', () => {
    for (const scenario of BACKCHANNEL_SCENARIOS) {
      const { snapshot, orphanCount } = runScenarioFixed(scenario);
      // cache node + api->cache edge, both described and heard.
      expect(snapshot.nodes.map((n) => n.id).sort(), scenario.id).toEqual(['cache-svc']);
      expect(snapshot.edges.map((e) => e.id).sort(), scenario.id).toEqual(['cache-edge']);
      expect(orphanCount, scenario.id).toBe(0);
    }
  });

  it('the pre-B1 always-fence bug orphans the tail mutation — the scenario has teeth', () => {
    const buggy = BACKCHANNEL_SCENARIOS.map(runScenarioLegacy);
    // At least one delay reproduces: the edge is described and heard but never
    // lands because the spurious roll left onTurnComplete pointed at the wrong
    // generation.
    expect(buggy.some((r) => r.orphanCount > 0 || r.snapshot.edges.length === 0)).toBe(true);
  });
});

describe('ROUND3 Module C — interrupted direction change', () => {
  it('a setDirection cut off mid-sentence does not apply, and content divergence stays 0', () => {
    for (const scenario of DIRECTION_SCENARIOS) {
      const { snapshot } = runScenarioFixed(scenario);
      // Both nodes land; the direction change (turn 1, un-heard) does not.
      expect(snapshot.nodes.map((n) => n.id).sort(), scenario.id).toEqual(['first-svc', 'second-svc']);
      expect(snapshot.direction, scenario.id).toBe('RIGHT');
    }
    // And the oracle agrees — divergence is 0 across the whole suite.
    expect(runAll(SCENARIOS).filter((r) => !r.baselineMode).every((r) => !r.divergent)).toBe(true);
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
