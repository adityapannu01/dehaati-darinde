import { describe, expect, it } from 'vitest';
import { AMBIENT_SCENARIOS, runAmbient } from './ambient.ts';

describe('ambient mode scenarios (§5.3)', () => {
  it('the safety invariant holds for every scenario — a ghost never reaches committed state on its own', () => {
    for (const scenario of AMBIENT_SCENARIOS) {
      const r = runAmbient(scenario);
      expect(r.invariantHeld, scenario.id).toBe(true);
    }
  });

  it('47 — an overheard proposal stays a ghost until confirmed, and never commits', () => {
    const r = runAmbient(AMBIENT_SCENARIOS.find((s) => s.id === 'ambient_proposal_needs_confirmation')!);
    expect(r.committedNodeIds).toEqual(['api-gateway']); // unchanged
    expect(r.ghosts.map((g) => g.label)).toEqual(['Redis cache']); // proposal exists
    expect(r.promotions).toBe(0);
  });

  it('47b — the same proposal, once addressed to the agent, does commit', () => {
    const r = runAmbient(AMBIENT_SCENARIOS.find((s) => s.id === 'ambient_proposal_then_confirmed')!);
    expect(r.committedNodeIds.sort()).toEqual(['api-gateway', 'redis-cache']);
    expect(r.ghosts).toHaveLength(0); // promoted, no longer a ghost
    expect(r.promotions).toBe(1);
  });

  it('48 — an overheard disagreement removes the ghost and leaves every committed node intact', () => {
    const r = runAmbient(
      AMBIENT_SCENARIOS.find((s) => s.id === 'ambient_disagreement_removes_ghost_not_node')!
    );
    expect(r.ghosts).toHaveLength(0); // Kafka ghost rejected
    // "the Orders Service is fine as it is" is a disagreement mentioning a
    // committed node — it must NOT remove it.
    expect(r.committedNodeIds.sort()).toEqual(['api-gateway', 'orders-service']);
    expect(r.invariantHeld).toBe(true);
  });
});
