// Layout regression fixture (ROUND3 Module C).
//
//   "A fixed 12-node / 3-group graph, laid out in all four directions,
//    asserting: members inside their group box, no foreign node inside a group
//    box, no group overlap. Deterministic, no audio, fits the existing harness."
//
// This drives the REAL pipeline — `CanvasStore` mutations → `layoutCanvas` (ELK)
// → `applyLayout` → `snapshot()` — so it exercises the same hierarchical-ELK and
// `groupBoxes()` code paths that `relayout()` runs in `main.ts`, not a
// reimplementation. No LLM, no LiveKit, no audio; ELK is deterministic for a
// fixed graph, so the assertions are stable.
//
// Runnable directly: `pnpm --filter DD_agent layout-fixture`.
import type {
  CanvasGroup,
  CanvasNode,
  CanvasSnapshot,
  LayoutDirection,
  NodeKind,
} from '@repo/protocol';
import process from 'node:process';
import { CanvasStore } from '../core/canvas.ts';
import { layoutCanvas } from '../core/layout.ts';
import { NODE_HEIGHT, NODE_WIDTH } from '../core/node-metrics.ts';

export const DIRECTIONS: readonly LayoutDirection[] = ['RIGHT', 'DOWN', 'LEFT', 'UP'];

interface FixtureNode {
  id: string;
  label: string;
  kind: NodeKind;
  group?: string;
}

// 12 nodes, 3 boundaries, 1 deliberately ungrouped node (`s3`) that must never
// be swallowed by a box it does not belong to.
const NODES: FixtureNode[] = [
  { id: 'mobile', label: 'Mobile App', kind: 'external', group: 'edge' },
  { id: 'cdn', label: 'CDN', kind: 'service', group: 'edge' },
  { id: 'waf', label: 'WAF', kind: 'gateway', group: 'edge' },
  { id: 'gateway', label: 'API Gateway', kind: 'gateway', group: 'services' },
  { id: 'auth', label: 'Auth Service', kind: 'service', group: 'services' },
  { id: 'orders', label: 'Orders Service', kind: 'service', group: 'services' },
  { id: 'payments', label: 'Payments Service', kind: 'service', group: 'services' },
  { id: 'postgres', label: 'Postgres', kind: 'datastore', group: 'data' },
  { id: 'redis', label: 'Redis', kind: 'datastore', group: 'data' },
  { id: 'kafka', label: 'Kafka', kind: 'queue', group: 'data' },
  { id: 'clickhouse', label: 'ClickHouse', kind: 'datastore', group: 'data' },
  { id: 's3', label: 'S3 Archive', kind: 'external' }, // ungrouped on purpose
];

const EDGES: Array<[string, string]> = [
  ['mobile', 'cdn'],
  ['cdn', 'waf'],
  ['waf', 'gateway'],
  ['gateway', 'auth'],
  ['gateway', 'orders'],
  ['gateway', 'payments'],
  ['auth', 'redis'],
  ['orders', 'postgres'],
  ['orders', 'kafka'],
  ['payments', 'postgres'],
  ['kafka', 'clickhouse'],
  ['kafka', 's3'],
];

const GROUP_LABELS: Record<string, string> = {
  edge: 'Edge',
  services: 'Services VPC',
  data: 'Data Tier',
};

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function nodeRect(n: CanvasNode): Rect {
  return { x: n.x, y: n.y, width: NODE_WIDTH, height: NODE_HEIGHT };
}

function centre(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function pointInside(r: Rect, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

/** Strict rectangle overlap — touching edges (shared border) does not count. */
function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export interface DirectionCheck {
  direction: LayoutDirection;
  snapshot: CanvasSnapshot;
  violations: string[];
}

/** Build the fixture store once (mutations only — no layout yet). */
function buildStore(): CanvasStore {
  const store = new CanvasStore();
  for (const n of NODES) {
    store.apply({ op: 'addNode', node: { id: n.id, label: n.label, kind: n.kind, x: 0, y: 0 } });
  }
  EDGES.forEach(([source, target], i) => {
    store.apply({ op: 'addEdge', edge: { id: `e${i}`, source, target } });
  });
  for (const gid of ['edge', 'services', 'data']) {
    store.apply({
      op: 'addGroup',
      id: gid,
      label: GROUP_LABELS[gid]!,
      memberIds: NODES.filter((n) => n.group === gid).map((n) => n.id),
    });
  }
  return store;
}

/** Lay the fixture out in one direction and collect any invariant violations. */
export async function checkDirection(direction: LayoutDirection): Promise<DirectionCheck> {
  const store = buildStore();
  store.setInitialDirection(direction);
  // relayout() in main.ts does exactly this sequence.
  const snap0 = store.snapshot(0);
  const placements = await layoutCanvas(snap0.nodes, snap0.edges, snap0.groups, direction);
  store.applyLayout(placements);
  const snapshot = store.snapshot(0);

  const violations: string[] = [];
  const nodeById = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const membersByGroup = new Map<string, Set<string>>();
  for (const n of NODES) {
    if (!n.group) continue;
    if (!membersByGroup.has(n.group)) membersByGroup.set(n.group, new Set());
    membersByGroup.get(n.group)!.add(n.id);
  }

  if (snapshot.nodes.length !== 12)
    violations.push(`expected 12 placed nodes, got ${snapshot.nodes.length}`);
  if (snapshot.groups.length !== 3)
    violations.push(`expected 3 group boxes, got ${snapshot.groups.length}`);

  const boxes: Array<{ group: CanvasGroup; rect: Rect }> = snapshot.groups.map((g) => ({
    group: g,
    rect: { x: g.x, y: g.y, width: g.width, height: g.height },
  }));

  // 1. Every member sits fully inside its own group's derived box.
  for (const { group, rect } of boxes) {
    const members = membersByGroup.get(group.id) ?? new Set();
    for (const mid of members) {
      const node = nodeById.get(mid);
      if (!node) {
        violations.push(`${direction}: member ${mid} of ${group.id} was not placed`);
        continue;
      }
      if (!contains(rect, nodeRect(node))) {
        violations.push(`${direction}: ${mid} is not fully inside its own group box ${group.id}`);
      }
    }
  }

  // 2. No foreign node's centre falls inside a group box (A2's "the picture
  //    must not assert a node is in a VPC it isn't").
  for (const { group, rect } of boxes) {
    const members = membersByGroup.get(group.id) ?? new Set();
    for (const node of snapshot.nodes) {
      if (members.has(node.id)) continue;
      if (pointInside(rect, centre(nodeRect(node)))) {
        violations.push(`${direction}: foreign node ${node.id} sits inside group box ${group.id}`);
      }
    }
  }

  // 3. No two group boxes overlap.
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (overlaps(boxes[i]!.rect, boxes[j]!.rect)) {
        violations.push(
          `${direction}: group boxes ${boxes[i]!.group.id} and ${boxes[j]!.group.id} overlap`,
        );
      }
    }
  }

  return { direction, snapshot, violations };
}

export async function runFixture(): Promise<DirectionCheck[]> {
  return Promise.all(DIRECTIONS.map(checkDirection));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runFixture().then((checks) => {
    let bad = 0;
    for (const c of checks) {
      const box = (g: CanvasGroup) => `${g.label}: ${g.width}x${g.height}`;
      console.log(`\n${c.direction}`);
      console.log(`  groups: ${c.snapshot.groups.map(box).join(' | ')}`);
      if (c.violations.length === 0) {
        console.log('  OK — members boxed, no foreign node captured, no overlap');
      } else {
        bad += c.violations.length;
        for (const v of c.violations) console.log(`  VIOLATION: ${v}`);
      }
    }
    console.log(
      `\n${bad === 0 ? 'PASS' : `FAIL (${bad} violations)`} — 12 nodes, 3 groups, 4 directions`,
    );
    process.exit(bad === 0 ? 0 : 1);
  });
}
