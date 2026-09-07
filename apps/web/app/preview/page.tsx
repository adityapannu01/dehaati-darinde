'use client';

// Dev-only visual preview of the ArchitectureCanvas renderer with mock data —
// no LiveKit, no mic. Exercises icons, node kinds, edge semantics (sync/async/
// bidirectional/labels), a group boundary, "forming" nodes and ambient
// "ghost" proposals. Open http://localhost:3000/preview  (add ?sketch=1 for
// the rough.js borders).

import { useEffect, useState } from 'react';
import type { CanvasEdge, CanvasGroup, CanvasNode, GhostElement } from '@repo/protocol';
import { ArchitectureCanvas } from '@/components/cartograph/architecture-canvas';
import type { FormingState } from '@/hooks/use-cartograph';

const ALL_NODES: CanvasNode[] = [
  { id: 'react-frontend', label: 'React Frontend', kind: 'service', x: 0, y: 120 },
  { id: 'load-balancer', label: 'Load Balancer', kind: 'gateway', x: 240, y: 120 },
  { id: 'api-gateway', label: 'API Gateway', kind: 'gateway', x: 480, y: 120 },
  { id: 'auth-service', label: 'Auth Service', kind: 'service', x: 720, y: 20 },
  { id: 'orders-service', label: 'Orders Service', kind: 'service', x: 720, y: 140 },
  { id: 'payments-service', label: 'Payments Service', kind: 'service', x: 720, y: 260 },
  { id: 'redis-cache', label: 'Redis Cache', kind: 'datastore', x: 980, y: 60 },
  { id: 'postgres', label: 'Postgres', kind: 'datastore', x: 980, y: 200 },
  { id: 'kafka', label: 'Kafka', kind: 'queue', x: 980, y: 320 },
  { id: 'stripe', label: 'Stripe', kind: 'external', x: 1220, y: 260 },
];

const ALL_EDGES: CanvasEdge[] = [
  { id: 'react-frontend-load-balancer', source: 'react-frontend', target: 'load-balancer' },
  { id: 'load-balancer-api-gateway', source: 'load-balancer', target: 'api-gateway' },
  { id: 'api-gateway-auth-service', source: 'api-gateway', target: 'auth-service', label: 'JWT' },
  { id: 'api-gateway-orders-service', source: 'api-gateway', target: 'orders-service', label: 'gRPC' },
  { id: 'orders-service-payments-service', source: 'orders-service', target: 'payments-service' },
  { id: 'orders-service-redis-cache', source: 'orders-service', target: 'redis-cache', label: 'reads/writes', bidirectional: true },
  { id: 'orders-service-postgres', source: 'orders-service', target: 'postgres' },
  { id: 'orders-service-kafka', source: 'orders-service', target: 'kafka', label: 'order.placed', flow: 'async' },
  { id: 'payments-service-stripe', source: 'payments-service', target: 'stripe', label: 'HTTPS' },
];

const GROUPS: CanvasGroup[] = [
  {
    id: 'services-vpc',
    label: 'Services VPC',
    memberIds: ['auth-service', 'orders-service', 'payments-service'],
    x: 690,
    y: -20,
    width: 220,
    height: 340,
  },
];

const GHOSTS: GhostElement[] = [
  {
    id: 'ghost-cdn',
    element: 'node',
    label: 'CloudFront CDN',
    kind: 'gateway',
    proposedBy: 'engineer-b',
    confidence: 0.7,
    expiresAt: Date.now() + 60_000,
  },
];

export default function PreviewPage() {
  // Reveal nodes one at a time so the layered layout / entrance animations are
  // visible, then show a "forming" node and a ghost.
  const [count, setCount] = useState(3);
  const [showForming, setShowForming] = useState(false);
  const [showGhost, setShowGhost] = useState(false);

  useEffect(() => {
    if (count >= ALL_NODES.length) {
      const t1 = setTimeout(() => setShowForming(true), 900);
      const t2 = setTimeout(() => setShowGhost(true), 2200);
      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
      };
    }
    const t = setTimeout(() => setCount((c) => c + 1), 700);
    return () => clearTimeout(t);
  }, [count]);

  const nodes = ALL_NODES.slice(0, count);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = ALL_EDGES.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  const groups = count >= ALL_NODES.length ? GROUPS : [];
  const forming: FormingState[] = showForming
    ? [{ id: 'elasticsearch', element: 'node', label: 'Elasticsearch', kind: 'datastore', anchorPhrase: 'elasticsearch', named: true }]
    : [];
  const ghosts = showGhost ? GHOSTS : [];

  return (
    <main className="bg-background fixed inset-0">
      <div className="text-muted-foreground bg-card/80 fixed top-3 left-3 z-50 rounded border px-2 py-1 font-mono text-[11px] backdrop-blur">
        renderer preview — {count}/{ALL_NODES.length} nodes
        {showForming ? ' · +forming' : ''}
        {showGhost ? ' · +ghost' : ''} · <a className="underline" href="/preview?sketch=1">sketch</a>
      </div>
      <ArchitectureCanvas
        nodes={nodes}
        edges={edges}
        groups={groups}
        forming={forming}
        ghosts={ghosts}
        className="absolute inset-0"
      />
    </main>
  );
}
