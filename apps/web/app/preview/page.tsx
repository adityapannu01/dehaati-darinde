'use client';

// Dev-only visual preview of the renderer + the REAL agent-side layout
// (CanvasStore + layoutCanvas, both pure TS / elkjs — they run in the browser
// too). No LiveKit, no mic. Exercises: 4 flow directions (?dir=DOWN etc),
// hierarchical groups (A2), direction-aware handles (A3), icons, edge
// semantics, forming nodes, ghosts. ?sketch=1 for the rough.js borders.

import { useEffect, useMemo, useState } from 'react';
import type { CanvasEdge, CanvasNode, GhostElement, LayoutDirection, MutationOp } from '@repo/protocol';
import { CanvasStore } from '../../../agent/src/core/canvas';
import { layoutCanvas } from '../../../agent/src/core/layout';
import { ArchitectureCanvas } from '@/components/cartograph/architecture-canvas';
import type { FormingState } from '@/hooks/use-cartograph';

// A 13-node, 3-group reference diagram (Module C fixture, shown live).
const NODES: Array<[string, CanvasNode['kind']]> = [
  ['React Frontend', 'service'],
  ['Load Balancer', 'gateway'],
  ['API Gateway', 'gateway'],
  ['Auth Service', 'service'],
  ['Orders Service', 'service'],
  ['Payments Service', 'service'],
  ['Worker A', 'service'],
  ['Worker B', 'service'],
  ['Redis Cache', 'datastore'],
  ['Postgres', 'datastore'],
  ['Kafka', 'queue'],
  ['Stripe', 'external'],
  ['CloudWatch', 'external'],
];
const EDGES: Array<[string, string, Partial<CanvasEdge>]> = [
  ['react-frontend', 'load-balancer', {}],
  ['load-balancer', 'api-gateway', {}],
  ['api-gateway', 'auth-service', { label: 'JWT' }],
  ['api-gateway', 'orders-service', { label: 'gRPC' }],
  ['orders-service', 'payments-service', {}],
  ['orders-service', 'redis-cache', { label: 'reads/writes', bidirectional: true }],
  ['orders-service', 'postgres', {}],
  ['orders-service', 'kafka', { label: 'order.placed', flow: 'async' }],
  ['kafka', 'worker-a', { flow: 'async' }],
  ['kafka', 'worker-b', { flow: 'async' }],
  ['payments-service', 'stripe', { label: 'HTTPS' }],
  ['worker-a', 'cloudwatch', { flow: 'async' }],
];
const GROUPS: Array<[string, string[], LayoutDirection?]> = [
  ['Services VPC', ['auth-service', 'orders-service', 'payments-service']],
  ['Workers', ['worker-a', 'worker-b'], 'DOWN'],
  ['Data', ['redis-cache', 'postgres']],
];
const GHOSTS: GhostElement[] = [
  { id: 'ghost-cdn', element: 'node', label: 'CloudFront CDN', kind: 'gateway', proposedBy: 'engineer-b', confidence: 0.7, expiresAt: Date.now() + 60_000 },
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const DIRECTIONS: LayoutDirection[] = ['RIGHT', 'DOWN', 'LEFT', 'UP'];

export default function PreviewPage() {
  const [count, setCount] = useState(4);
  const [dir, setDir] = useState<LayoutDirection>('RIGHT');
  const [store, setStore] = useState(() => new CanvasStore());
  const [, force] = useState(0);

  // Reveal nodes/edges/groups incrementally, then relayout via real ELK.
  useEffect(() => {
    const s = new CanvasStore();
    if (dir !== 'RIGHT') s.setInitialDirection(dir);
    const ops: MutationOp[] = [];
    for (const [label, kind] of NODES.slice(0, count)) {
      ops.push({ op: 'addNode', node: { id: slug(label), label, kind, x: 0, y: 0 } });
    }
    const present = new Set(NODES.slice(0, count).map(([l]) => slug(l)));
    for (const [src, tgt, extra] of EDGES) {
      if (present.has(src) && present.has(tgt)) ops.push({ op: 'addEdge', edge: { id: `${src}-${tgt}`, source: src, target: tgt, ...extra } });
    }
    if (count >= NODES.length) {
      for (const [label, members, gdir] of GROUPS) {
        ops.push({ op: 'addGroup', id: slug(label), label, memberIds: members });
        if (gdir) ops.push({ op: 'setDirection', direction: gdir, scope: slug(label) });
      }
    }
    for (const op of ops) s.apply(op);
    setStore(s);

    const snap = s.snapshot(0);
    void layoutCanvas(snap.nodes, snap.edges, snap.groups, snap.direction).then((placements) => {
      if (s.applyLayout(placements)) force((n) => n + 1);
    });

    if (count < NODES.length) {
      const t = setTimeout(() => setCount((c) => c + 1), 550);
      return () => clearTimeout(t);
    }
  }, [count, dir]);

  const snap = store.snapshot(0);
  const forming: FormingState[] = useMemo(
    () =>
      count >= NODES.length
        ? [{ id: 'elasticsearch', element: 'node', label: 'Elasticsearch', kind: 'datastore', anchorPhrase: 'elasticsearch', named: true }]
        : [],
    [count]
  );

  return (
    <main className="bg-background fixed inset-0">
      <div className="text-muted-foreground bg-card/80 fixed top-3 left-3 z-50 flex gap-2 rounded border px-2 py-1 font-mono text-[11px] backdrop-blur">
        <span>
          {count}/{NODES.length} nodes · {snap.groups.length} groups
        </span>
        {DIRECTIONS.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDir(d)}
            className={dir === d ? 'text-foreground underline' : 'hover:text-foreground'}
          >
            {d}
          </button>
        ))}
        <a className="underline" href={`/preview?sketch=1`}>
          sketch
        </a>
      </div>
      <ArchitectureCanvas
        nodes={snap.nodes}
        edges={snap.edges}
        groups={snap.groups}
        direction={snap.direction}
        forming={forming}
        ghosts={count >= NODES.length ? GHOSTS : []}
        className="absolute inset-0"
      />
    </main>
  );
}
