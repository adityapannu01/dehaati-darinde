import { describe, expect, it } from 'vitest';
import { ProposalStore } from './proposals.ts';

describe('ProposalStore (§2.4)', () => {
  it('creates a ghost and lists it', () => {
    const s = new ProposalStore();
    const g = s.propose({ element: 'node', label: 'Redis cache', proposedBy: 'alice', confidence: 0.7 });
    expect(s.list()).toHaveLength(1);
    expect(g.label).toBe('Redis cache');
    expect(g.proposedBy).toBe('alice');
  });

  it('a near-duplicate refreshes the existing ghost instead of adding a second', () => {
    const s = new ProposalStore();
    const a = s.propose({ element: 'node', label: 'Redis', proposedBy: 'alice', confidence: 0.6 });
    const b = s.propose({ element: 'node', label: 'redis', proposedBy: 'bob', confidence: 0.8 });
    expect(s.list()).toHaveLength(1);
    expect(a.id).toBe(b.id);
    expect(b.confidence).toBe(0.8);
  });

  it('promote() removes the ghost and returns a stage-able mutation, never a direct write', () => {
    const s = new ProposalStore();
    const g = s.propose({ element: 'node', label: 'Kafka queue', proposedBy: 'alice', confidence: 0.7 });
    const mut = s.promote(g.id);
    expect(mut).toEqual({
      op: 'addNode',
      node: { id: 'kafka-queue', label: 'Kafka queue', kind: 'service', x: 0, y: 0 },
    });
    expect(s.list()).toHaveLength(0);
  });

  it('rejectMatching removes only ghosts the disagreement names', () => {
    const s = new ProposalStore();
    s.propose({ element: 'node', label: 'Kafka', proposedBy: 'alice', confidence: 0.7 });
    s.propose({ element: 'node', label: 'Redis', proposedBy: 'alice', confidence: 0.7 });
    const removed = s.rejectMatching("no, we're not using Kafka");
    expect(removed.map((g) => g.label)).toEqual(['Kafka']);
    expect(s.list().map((g) => g.label)).toEqual(['Redis']);
  });

  it('expire() drops ghosts past their TTL', () => {
    let now = 1_000;
    const s = new ProposalStore({ ttlMs: 100, now: () => now });
    s.propose({ element: 'node', label: 'Redis', proposedBy: 'alice', confidence: 0.7 });
    now = 1_050;
    expect(s.expire()).toHaveLength(0);
    now = 1_200;
    expect(s.expire()).toHaveLength(1);
    expect(s.list()).toHaveLength(0);
  });
});
