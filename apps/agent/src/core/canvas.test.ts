import type { CanvasNode } from '@repo/protocol';
import { describe, expect, it } from 'vitest';
import { CanvasStore } from './canvas.ts';

function node(id: string, label: string): CanvasNode {
  return { id, label, kind: 'service', x: 0, y: 0 };
}

describe('CanvasStore', () => {
  it('addNode then snapshot returns it', () => {
    const store = new CanvasStore();
    store.apply({ op: 'addNode', node: node('redis', 'Redis') });
    const snap = store.snapshot(1);
    expect(snap.nodes).toHaveLength(1);
    expect(snap.nodes[0]?.label).toBe('Redis');
  });

  it('removeNode cascades edges touching it', () => {
    const store = new CanvasStore();
    store.apply({ op: 'addNode', node: node('api', 'API') });
    store.apply({ op: 'addNode', node: node('redis', 'Redis') });
    store.apply({
      op: 'addEdge',
      edge: { id: 'api-redis', source: 'api', target: 'redis' },
    });
    store.apply({ op: 'removeNode', nodeId: 'redis' });

    const snap = store.snapshot(1);
    expect(snap.nodes.map((n) => n.id)).toEqual(['api']);
    expect(snap.edges).toHaveLength(0);
  });

  it('replaceNode preserves id and edges while changing label/kind', () => {
    const store = new CanvasStore();
    store.apply({ op: 'addNode', node: node('api', 'API') });
    store.apply({ op: 'addNode', node: node('cache', 'Redis') });
    store.apply({
      op: 'addEdge',
      edge: { id: 'api-cache', source: 'api', target: 'cache' },
    });

    store.apply({ op: 'replaceNode', nodeId: 'cache', label: 'MongoDB', kind: 'datastore' });

    const snap = store.snapshot(1);
    const replaced = snap.nodes.find((n) => n.id === 'cache');
    expect(replaced?.label).toBe('MongoDB');
    expect(replaced?.kind).toBe('datastore');
    expect(snap.edges).toHaveLength(1);
    expect(snap.edges[0]?.id).toBe('api-cache');
  });

  it('undo reverses exactly the most recent mutation, and is a no-op on empty history', () => {
    const store = new CanvasStore();
    expect(store.canUndo).toBe(false);
    store.apply({ op: 'undo' }); // no-op, no throw
    expect(store.snapshot(0).nodes).toHaveLength(0);

    store.apply({ op: 'addNode', node: node('a', 'A') });
    store.apply({ op: 'addNode', node: node('b', 'B') });
    expect(store.canUndo).toBe(true);

    store.apply({ op: 'undo' });
    expect(store.snapshot(1).nodes.map((n) => n.id)).toEqual(['a']); // b reversed

    store.apply({ op: 'undo' });
    expect(store.snapshot(2).nodes).toHaveLength(0); // a reversed
    expect(store.canUndo).toBe(false);
  });

  it('undo restores edges and groups removed by a cascade', () => {
    const store = new CanvasStore();
    store.apply({ op: 'addNode', node: node('a', 'A') });
    store.apply({ op: 'addNode', node: node('b', 'B') });
    store.apply({ op: 'addEdge', edge: { id: 'a-b', source: 'a', target: 'b' } });
    store.apply({ op: 'addGroup', id: 'g', label: 'G', memberIds: ['a', 'b'] });

    store.apply({ op: 'removeNode', nodeId: 'a' }); // cascades edge + shrinks group
    expect(store.snapshot(1).edges).toHaveLength(0);

    store.apply({ op: 'undo' });
    const snap = store.snapshot(2);
    expect(snap.nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect(snap.edges).toHaveLength(1);
    expect(snap.groups[0]!.memberIds.sort()).toEqual(['a', 'b']);
  });

  it('toMermaid renders nodes, edges, async style, and subgraphs', () => {
    const store = new CanvasStore();
    store.apply({ op: 'addNode', node: node('api', 'API') });
    store.apply({ op: 'addNode', node: { ...node('q', 'Kafka'), kind: 'queue' } });
    store.apply({ op: 'addEdge', edge: { id: 'api-q', source: 'api', target: 'q', flow: 'async' } });
    store.apply({ op: 'addGroup', id: 'vpc', label: 'VPC', memberIds: ['api'] });

    const m = store.toMermaid();
    expect(m).toContain('flowchart LR');
    expect(m).toContain('subgraph');
    expect(m).toContain('"VPC"');
    expect(m).toContain('-.->'); // async edge
  });

  it('version strictly increases with every mutation', () => {
    const store = new CanvasStore();
    expect(store.currentVersion).toBe(0);
    store.apply({ op: 'addNode', node: node('a', 'A') });
    expect(store.currentVersion).toBe(1);
    store.apply({ op: 'addNode', node: node('b', 'B') });
    expect(store.currentVersion).toBe(2);
  });

  it('a mutated snapshot never aliases store state', () => {
    const store = new CanvasStore();
    store.apply({ op: 'addNode', node: node('a', 'A') });
    const snap = store.snapshot(1);
    const first = snap.nodes[0];
    if (!first) throw new Error('expected a node');
    first.label = 'mutated locally';

    const snap2 = store.snapshot(1);
    expect(snap2.nodes[0]?.label).toBe('A');
  });

  it('nextLayout advances deterministically with node count', () => {
    const store = new CanvasStore();
    const first = store.nextLayout();
    store.apply({ op: 'addNode', node: { ...node('a', 'A'), ...first } });
    const second = store.nextLayout();
    expect(second).not.toEqual(first);
  });

  it('B5: nextLayout never reuses a slot after a removal', () => {
    const store = new CanvasStore();
    const positions: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = store.nextLayout();
      positions.push(`${p.x},${p.y}`);
      store.apply({ op: 'addNode', node: { ...node(`n${i}`, `N${i}`), ...p } });
    }
    store.apply({ op: 'removeNode', nodeId: 'n1' });
    const next = store.nextLayout();
    expect(positions).not.toContain(`${next.x},${next.y}`);
  });

  it('B6: clear wipes every node and edge and resets the placement counter', () => {
    const store = new CanvasStore();
    const p0 = store.nextLayout();
    store.apply({ op: 'addNode', node: { ...node('api', 'API'), ...p0 } });
    store.apply({ op: 'addNode', node: node('redis', 'Redis') });
    store.apply({ op: 'addEdge', edge: { id: 'api-redis', source: 'api', target: 'redis' } });

    store.apply({ op: 'clear' });

    const snap = store.snapshot(1);
    expect(snap.nodes).toHaveLength(0);
    expect(snap.edges).toHaveLength(0);
    expect(store.currentVersion).toBeGreaterThan(0); // version still bumped
    // Placement counter reset: the next node lands back in the first slot.
    expect(store.nextLayout()).toEqual(p0);
  });

  it('summary is "(empty)" for a store with no nodes', () => {
    expect(new CanvasStore().summary()).toBe('(empty)');
  });

  // ROUND3 A1 — direction
  it('setDirection changes the diagram flow, is undoable, and clear resets it to RIGHT', () => {
    const store = new CanvasStore();
    expect(store.snapshot(0).direction).toBe('RIGHT');

    store.apply({ op: 'addNode', node: node('a', 'A') });
    store.apply({ op: 'setDirection', direction: 'DOWN' });
    expect(store.snapshot(1).direction).toBe('DOWN');

    store.apply({ op: 'undo' });
    expect(store.snapshot(2).direction).toBe('RIGHT'); // undo restores it

    store.apply({ op: 'setDirection', direction: 'LEFT' });
    store.apply({ op: 'clear' });
    expect(store.snapshot(3).direction).toBe('RIGHT'); // clear resets it
  });

  it('ROUND3 A4: a scoped setDirection sets one group\'s direction, resolved forgivingly', () => {
    const store = new CanvasStore();
    for (const id of ['w1', 'w2']) store.apply({ op: 'addNode', node: node(id, id) });
    store.apply({ op: 'addGroup', id: 'workers', label: 'Workers', memberIds: ['w1', 'w2'] });

    store.apply({ op: 'setDirection', direction: 'DOWN', scope: 'the workers' });
    expect(store.snapshot(1).groups[0]?.direction).toBe('DOWN');
    expect(store.snapshot(1).direction).toBe('RIGHT'); // whole-diagram direction untouched
  });

  it('ROUND3 A2: a node already in one group is dropped from a second addGroup', () => {
    const store = new CanvasStore();
    for (const id of ['a', 'b', 'c']) store.apply({ op: 'addNode', node: node(id, id) });
    store.apply({ op: 'addGroup', id: 'g1', label: 'G1', memberIds: ['a', 'b'] });
    store.apply({ op: 'addGroup', id: 'g2', label: 'G2', memberIds: ['b', 'c'] });

    const groups = store.snapshot(1).groups;
    expect(groups.find((g) => g.id === 'g1')?.memberIds.sort()).toEqual(['a', 'b']);
    expect(groups.find((g) => g.id === 'g2')?.memberIds).toEqual(['c']); // b already claimed
    expect(store.groupOfNode('b')).toBe('g1');
  });

  it('§3.2: addGroup boxes its members, tracks them, and drops when emptied', () => {
    const store = new CanvasStore();
    for (const id of ['a', 'b', 'c']) {
      store.apply({ op: 'addNode', node: { ...node(id, id.toUpperCase()), x: 100, y: 100 } });
    }
    store.apply({ op: 'addGroup', id: 'vpc', label: 'VPC', memberIds: ['a', 'b'] });

    let snap = store.snapshot(1);
    expect(snap.groups).toHaveLength(1);
    expect(snap.groups[0]).toMatchObject({ label: 'VPC', memberIds: ['a', 'b'] });
    expect(snap.groups[0]!.width).toBeGreaterThan(0);
    expect(store.summary()).toContain('boundary "VPC" contains: A, B');

    store.apply({ op: 'removeNode', nodeId: 'a' });
    snap = store.snapshot(2);
    expect(snap.groups[0]!.memberIds).toEqual(['b']);

    store.apply({ op: 'removeNode', nodeId: 'b' });
    expect(store.snapshot(3).groups).toHaveLength(0); // emptied -> gone
  });

  it('§3.2: addGroup ignores unknown member ids and no-ops if none exist', () => {
    const store = new CanvasStore();
    store.apply({ op: 'addNode', node: node('a', 'A') });
    store.apply({ op: 'addGroup', id: 'g', label: 'G', memberIds: ['a', 'ghost'] });
    expect(store.snapshot(1).groups[0]!.memberIds).toEqual(['a']);
    store.apply({ op: 'addGroup', id: 'g2', label: 'G2', memberIds: ['nope'] });
    expect(store.snapshot(2).groups).toHaveLength(1);
  });

  it('summary lists node labels/kinds and edges by resolved label', () => {
    const store = new CanvasStore();
    store.apply({ op: 'addNode', node: node('api', 'API Gateway') });
    store.apply({ op: 'addNode', node: { ...node('cache', 'Redis Cache'), kind: 'datastore' } });
    store.apply({ op: 'addEdge', edge: { id: 'api-cache', source: 'api', target: 'cache', label: 'reads/writes' } });

    const summary = store.summary();
    expect(summary).toContain('API Gateway (service)');
    expect(summary).toContain('Redis Cache (datastore)');
    expect(summary).toContain('API Gateway -> Redis Cache (reads/writes)');
  });

  describe('resolveId', () => {
    it('resolves an exact slug id (today\'s behaviour, unchanged)', () => {
      const store = new CanvasStore();
      store.apply({ op: 'addNode', node: node('api-gateway', 'API Gateway') });
      expect(store.resolveId('API Gateway')).toBe('api-gateway');
    });

    it('resolves a case-insensitive exact label match', () => {
      const store = new CanvasStore();
      store.apply({ op: 'addNode', node: node('api-gateway', 'API Gateway') });
      expect(store.resolveId('api gateway')).toBe('api-gateway');
    });

    it('resolves a paraphrase that is an unambiguous substring of the real label — the observed bug', () => {
      const store = new CanvasStore();
      store.apply({ op: 'addNode', node: node('api-gateway', 'API Gateway') });
      store.apply({ op: 'addNode', node: node('auth-service', 'auth service') });
      // Live log: "connect the gateway to the auth service" produced
      // sourceLabel "gateway" against a node actually labelled "API Gateway" —
      // slug("gateway") !== "api-gateway", so the edge silently dangled.
      expect(store.resolveId('gateway')).toBe('api-gateway');
      expect(store.resolveId('auth service')).toBe('auth-service');
    });

    it('resolves "the database" to the sole datastore node — no textual overlap with its real label', () => {
      const store = new CanvasStore();
      store.apply({ op: 'addNode', node: { ...node('postgres', 'Postgres'), kind: 'datastore' } });
      // Live log: targetLabel "database" against a node labelled "Postgres" —
      // no substring/token relationship at all; only the kind-noun path finds it.
      expect(store.resolveId('the database')).toBe('postgres');
      expect(store.resolveId('database')).toBe('postgres');
    });

    it('does not guess when a generic kind word is ambiguous between two nodes', () => {
      const store = new CanvasStore();
      store.apply({ op: 'addNode', node: { ...node('postgres', 'Postgres'), kind: 'datastore' } });
      store.apply({ op: 'addNode', node: { ...node('redis', 'Redis'), kind: 'datastore' } });
      expect(store.resolveId('the database')).toBe(slugOf('the database'));
    });

    it('does not guess when a substring match is ambiguous between two nodes', () => {
      const store = new CanvasStore();
      store.apply({ op: 'addNode', node: node('api-gateway', 'API Gateway') });
      store.apply({ op: 'addNode', node: node('gateway-health-check', 'Gateway Health Check') });
      expect(store.resolveId('gateway')).toBe(slugOf('gateway'));
    });

    it('falls back to slug(label) for a genuinely new/unknown reference', () => {
      const store = new CanvasStore();
      store.apply({ op: 'addNode', node: node('api-gateway', 'API Gateway') });
      expect(store.resolveId('a brand new service')).toBe(slugOf('a brand new service'));
    });
  });
});

function slugOf(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}
