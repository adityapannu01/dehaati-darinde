import type { CanvasEdge, CanvasNode } from '@repo/protocol';
import { describe, expect, it } from 'vitest';
import { layoutCanvas } from './layout.ts';

function node(id: string): CanvasNode {
  return { id, label: id, kind: 'service', x: 0, y: 0 };
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
    expect(new Set(coords).size).toBe(coords.length); // all distinct
  });

  it('lays a chain out left-to-right: each downstream node is further right', async () => {
    const nodes = ['a', 'b', 'c'].map(node);
    const edges: CanvasEdge[] = [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' },
    ];
    const p = await layoutCanvas(nodes, edges, 'RIGHT');
    const ax = p.get('a')!.x;
    const bx = p.get('b')!.x;
    const cx = p.get('c')!.x;
    expect(bx).toBeGreaterThan(ax);
    expect(cx).toBeGreaterThan(bx);
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
});
