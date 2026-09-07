// Agent-side graph layout (TECHNICAL_REVIEW.md B4). The fixed 4-column grid in
// nextLayout() ignored the edges entirely — a gateway fanning out to five
// services drew as a queue of boxes with every edge crossing the grid
// diagonally, carrying no structural information.
//
// ELK's `layered` algorithm gives left-to-right (or top-down) layering with
// orthogonal edge routing — the right-angled-bus look an architecture diagram
// should have. Runs here, not in the browser, so the agent stays the sole
// owner of node positions (load-bearing for the "state matches what was heard"
// claim — the browser is a pure renderer).

import ELK from 'elkjs/lib/elk.bundled.js';
import type { CanvasEdge, CanvasNode } from '@repo/protocol';

export type LayoutDirection = 'RIGHT' | 'DOWN';

// Must match the renderer's node box (architecture-canvas.tsx) closely enough
// that ELK's spacing looks right — exact pixel parity isn't required.
const NODE_WIDTH = 160;
const NODE_HEIGHT = 46;

const elk = new ELK();

const BASE_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.spacing.nodeNodeBetweenLayers': '90',
  'elk.spacing.nodeNode': '44',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
};

export interface Placement {
  x: number;
  y: number;
}

/**
 * Compute a layered placement for every node. Deterministic for a given graph.
 * Edges with a missing endpoint are dropped before layout — ELK throws on a
 * dangling edge, and the canvas can briefly hold one mid-commit.
 */
export async function layoutCanvas(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  direction: LayoutDirection = 'RIGHT',
): Promise<Map<string, Placement>> {
  const placements = new Map<string, Placement>();
  if (nodes.length === 0) return placements;

  const ids = new Set(nodes.map((n) => n.id));
  const graph = {
    id: 'root',
    layoutOptions: { ...BASE_OPTIONS, 'elk.direction': direction },
    children: nodes.map((n) => ({ id: n.id, width: NODE_WIDTH, height: NODE_HEIGHT })),
    edges: edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };

  const result = await elk.layout(graph);
  for (const child of result.children ?? []) {
    if (typeof child.x === 'number' && typeof child.y === 'number') {
      placements.set(child.id, { x: Math.round(child.x), y: Math.round(child.y) });
    }
  }
  return placements;
}
