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
});
