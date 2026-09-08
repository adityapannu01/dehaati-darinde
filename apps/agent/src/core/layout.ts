// Agent-side graph layout (TECHNICAL_REVIEW.md B4, ROUND3 A1/A2/A4).
//
// ELK's `layered` algorithm gives directional layering with orthogonal edge
// routing — the right-angled-bus look an architecture diagram should have. Runs
// here, not in the browser, so the agent stays the sole owner of node positions
// (load-bearing for the "state matches what was heard" claim).
//
// A2: groups are real ELK containers (a child node that has children), so ELK
// clusters their members instead of scattering them. `groupBoxes()` in
// canvas.ts still derives the boundary rectangle from the (now genuinely
// clustered) member positions — ELK owns positions, groupBoxes owns the box.

import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { CanvasEdge, CanvasGroup, CanvasNode, LayoutDirection } from '@repo/protocol';
import { NODE_HEIGHT, NODE_WIDTH } from './node-metrics.ts';

export type { LayoutDirection };

// Kept in sync with GROUP_PADDING (28) + the 14px label allowance in canvas.ts.
const GROUP_PADDING = '[top=34,left=24,bottom=24,right=24]';

const elk = new ELK();

const BASE_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.spacing.nodeNodeBetweenLayers': '90',
  'elk.spacing.nodeNode': '44',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  // A2: without this ELK refuses to route edges that cross a group boundary,
  // and most architecture edges do.
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
};

export interface Placement {
  x: number;
  y: number;
}

/** Flatten ELK's parent-relative child coordinates into absolute placements. */
function collect(container: ElkNode, offsetX: number, offsetY: number, out: Map<string, Placement>): void {
  for (const child of container.children ?? []) {
    const x = offsetX + (child.x ?? 0);
    const y = offsetY + (child.y ?? 0);
    if (child.children && child.children.length > 0) {
      collect(child, x, y, out); // a group container — recurse, don't place it
    } else {
      out.set(child.id, { x: Math.round(x), y: Math.round(y) });
    }
  }
}

/**
 * Compute a layered placement for every node, clustering grouped nodes inside
 * their container. Deterministic for a given graph. Edges with a missing
 * endpoint are dropped (ELK throws on a dangling edge, and the canvas can
 * briefly hold one mid-commit).
 */
export async function layoutCanvas(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  groups: readonly CanvasGroup[] = [],
  direction: LayoutDirection = 'RIGHT',
): Promise<Map<string, Placement>> {
  const placements = new Map<string, Placement>();
  if (nodes.length === 0) return placements;

  const ids = new Set(nodes.map((n) => n.id));
  // First membership wins if a node somehow appears in two groups (canvas.ts
  // already prevents this, but layout stays defensive so ELK never sees a dupe).
  const claimed = new Set<string>();
  const groupChildren = new Map<string, ElkNode[]>();
  for (const g of groups) {
    const members: ElkNode[] = [];
    for (const mid of g.memberIds) {
      if (!ids.has(mid) || claimed.has(mid)) continue;
      claimed.add(mid);
      members.push({ id: mid, width: NODE_WIDTH, height: NODE_HEIGHT });
    }
    if (members.length > 0) groupChildren.set(g.id, members);
  }

  const rootChildren: ElkNode[] = [];
  for (const g of groups) {
    const members = groupChildren.get(g.id);
    if (!members) continue;
    rootChildren.push({
      id: `group:${g.id}`,
      layoutOptions: {
        'elk.padding': GROUP_PADDING,
        // A4: a group can flow its own way; unset -> inherits the root.
        ...(g.direction ? { 'elk.direction': g.direction } : {}),
      },
      children: members,
    });
  }
  for (const n of nodes) {
    if (!claimed.has(n.id)) rootChildren.push({ id: n.id, width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: { ...BASE_OPTIONS, 'elk.direction': direction },
    children: rootChildren,
    edges: edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };

  const result = await elk.layout(graph);
  collect(result, 0, 0, placements);
  return placements;
}
