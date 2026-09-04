'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CanvasEdge, CanvasNode, NodeKind } from '@repo/protocol';
import { Background, Controls, type Edge, type Node, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { cn } from '@/lib/shadcn/utils';

const KIND_COLORS: Record<NodeKind, string> = {
  service: '#38bdf8',
  datastore: '#f59e0b',
  queue: '#a78bfa',
  gateway: '#34d399',
  external: '#94a3b8',
};

const HIGHLIGHT_MS = 1200;

interface ArchitectureCanvasProps {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  className?: string;
}

/**
 * Read-only render of the agent-owned canvas: nodesDraggable/nodesConnectable
 * are off on purpose. The server owns state, so a judge dragging a node here
 * must never be able to desynchronise the "state matches what was heard"
 * claim. Newly-committed nodes/edges get a brief highlight — that flash IS
 * the demo moment.
 */
export function ArchitectureCanvas({ nodes, edges, className }: ArchitectureCanvasProps) {
  const seenIds = useRef(new Set<string>());
  const [justArrived, setJustArrived] = useState<Set<string>>(new Set());

  useEffect(() => {
    const fresh = new Set<string>();
    for (const n of nodes) {
      if (!seenIds.current.has(n.id)) {
        seenIds.current.add(n.id);
        fresh.add(n.id);
      }
    }
    for (const e of edges) {
      if (!seenIds.current.has(e.id)) {
        seenIds.current.add(e.id);
        fresh.add(e.id);
      }
    }
    if (fresh.size === 0) return;
    setJustArrived(fresh);
    const timer = setTimeout(() => setJustArrived(new Set()), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [nodes, edges]);

  const flowNodes: Node[] = useMemo(
    () =>
      nodes.map((n) => {
        const color = KIND_COLORS[n.kind];
        return {
          id: n.id,
          position: { x: n.x, y: n.y },
          data: { label: n.label },
          style: {
            borderColor: color,
            borderWidth: 2,
            borderStyle: 'solid',
            borderRadius: 8,
            padding: 8,
            fontSize: 13,
            background: 'var(--card)',
            color: 'var(--card-foreground)',
            boxShadow: justArrived.has(n.id) ? `0 0 0 4px ${color}66` : undefined,
            transition: 'box-shadow 0.6s ease-out',
          },
        };
      }),
    [nodes, justArrived]
  );

  const flowEdges: Edge[] = useMemo(
    () =>
      edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        animated: justArrived.has(e.id),
      })),
    [edges, justArrived]
  );

  return (
    <div className={cn('h-full w-full', className)}>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
