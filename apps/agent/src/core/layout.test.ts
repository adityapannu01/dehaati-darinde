import type { CanvasEdge, CanvasGroup, CanvasNode } from '@repo/protocol';
import { describe, expect, it } from 'vitest';
import { layoutCanvas } from './layout.ts';

function node(id: string): CanvasNode {
  return { id, label: id, kind: 'service', x: 0, y: 0 };
}
function group(id: string, memberIds: string[], direction?: CanvasGroup['direction']): CanvasGroup {
  return { id, label: id, memberIds, x: 0, y: 0, width: 0, height: 0, direction };
}
/** Bounding box of a set of placed ids. */
function bbox(p: Map<string, { x: number; y: number }>, ids: string[]) {
  const pts = ids.map((id) => p.get(id)!).filter(Boolean);
  return {
    minX: Math.min(...pts.map((q) => q.x)),
    minY: Math.min(...pts.map((q) => q.y)),
    maxX: Math.max(...pts.map((q) => q.x)),
    maxY: Math.max(...pts.map((q) => q.y)),
  };
}

describe('layoutCanvas (B4 — ELK layered)', () => {
  it('returns nothing for an empty graph', async () => {
    expect((await layoutCanvas([], [])).size).toBe(0);
  });

  it('places every node and never overlaps two of them', async () => {
    const nodes = ['a', 'b', 'c', 'd', 'e'].map(node);
    const edges: CanvasEdge[] = [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'a', target: 'c' },
      { id: 'e3', source: 'a', target: 'd' },
      { id: 'e4', source: 'a', target: 'e' },
    ];
    const p = await layoutCanvas(nodes, edges);
    expect(p.size).toBe(5);
    const coords = [...p.values()].map((c) => `${c.x},${c.y}`);
    expect(new Set(coords).size).toBe(coords.length);
  });

  it('ignores an edge with a missing endpoint instead of throwing', async () => {
    const p = await layoutCanvas([node('a'), node('b')], [
      { id: 'dangling', source: 'a', target: 'ghost' },
      { id: 'ok', source: 'a', target: 'b' },
    ]);
    expect(p.size).toBe(2);
  });

  it('is deterministic for the same graph', async () => {
    const nodes = ['a', 'b', 'c'].map(node);
    const edges: CanvasEdge[] = [{ id: 'e1', source: 'a', target: 'b' }];
    const first = await layoutCanvas(nodes, edges);
    const second = await layoutCanvas(nodes, edges);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  // ROUND3 A1 — all four directions
  it('lays a chain out in every direction', async () => {
    const nodes = ['a', 'b', 'c'].map(node);
    const edges: CanvasEdge[] = [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' },
    ];
    const R = await layoutCanvas(nodes, edges, [], 'RIGHT');
    expect(R.get('c')!.x).toBeGreaterThan(R.get('a')!.x);

    const L = await layoutCanvas(nodes, edges, [], 'LEFT');
    expect(L.get('c')!.x).toBeLessThan(L.get('a')!.x);

    const D = await layoutCanvas(nodes, edges, [], 'DOWN');
    expect(D.get('c')!.y).toBeGreaterThan(D.get('a')!.y);

    const U = await layoutCanvas(nodes, edges, [], 'UP');
    expect(U.get('c')!.y).toBeLessThan(U.get('a')!.y);
  });

  // ROUND3 A2 — hierarchical groups
  it('positions a group\'s members inside its derived box, and no foreign node inside it', async () => {
    const nodes = ['gw', 'auth', 'orders', 'db', 'cache'].map(node);
    const edges: CanvasEdge[] = [
      { id: 'e1', source: 'gw', target: 'auth' },
      { id: 'e2', source: 'gw', target: 'orders' },
      { id: 'e3', source: 'orders', target: 'db' },
      { id: 'e4', source: 'orders', target: 'cache' },
    ];
    const groups = [group('vpc', ['auth', 'orders'])];
    const p = await layoutCanvas(nodes, edges, groups, 'RIGHT');

    const box = bbox(p, ['auth', 'orders']);
    // Every non-member node's top-left is outside the members' bounding box.
    for (const id of ['gw', 'db', 'cache']) {
      const q = p.get(id)!;
      const inside = q.x >= box.minX && q.x <= box.maxX && q.y >= box.minY && q.y <= box.maxY;
      expect(inside, `${id} should not sit inside the vpc box`).toBe(false);
    }
  });

  it('two groups produce non-overlapping member clusters', async () => {
    const nodes = ['a', 'b', 'c', 'd', 'src'].map(node);
    const edges: CanvasEdge[] = [
      { id: 'e1', source: 'src', target: 'a' },
      { id: 'e2', source: 'src', target: 'c' },
      { id: 'e3', source: 'a', target: 'b' },
      { id: 'e4', source: 'c', target: 'd' },
    ];
    const groups = [group('g1', ['a', 'b']), group('g2', ['c', 'd'])];
    const p = await layoutCanvas(nodes, edges, groups);
    const b1 = bbox(p, ['a', 'b']);
    const b2 = bbox(p, ['c', 'd']);
    const overlap = b1.minX < b2.maxX && b2.minX < b1.maxX && b1.minY < b2.maxY && b2.minY < b1.maxY;
    expect(overlap).toBe(false);
  });

  it('routes an edge that crosses a group boundary (INCLUDE_CHILDREN)', async () => {
    const nodes = ['a', 'b', 'ext'].map(node);
    const edges: CanvasEdge[] = [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'ext' }, // crosses out of the group
    ];
    const groups = [group('g', ['a', 'b'])];
    const p = await layoutCanvas(nodes, edges, groups);
    expect(p.size).toBe(3); // did not throw; all placed
    expect(p.get('ext')!.x).toBeGreaterThan(p.get('b')!.x);
  });

  it('a node claimed by two groups goes to the first only (never crashes ELK)', async () => {
    const nodes = ['a', 'b', 'c'].map(node);
    const edges: CanvasEdge[] = [{ id: 'e1', source: 'a', target: 'b' }];
    const groups = [group('g1', ['a', 'b']), group('g2', ['b', 'c'])];
    const p = await layoutCanvas(nodes, edges, groups);
    expect(p.size).toBe(3);
  });
});
