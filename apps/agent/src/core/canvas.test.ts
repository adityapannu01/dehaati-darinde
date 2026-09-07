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
});
