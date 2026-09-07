'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { CanvasEdge, CanvasNode, NodeKind } from '@repo/protocol';
import {
  Background,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useReducedMotion } from 'motion/react';
import { DUR, SPRING } from '@/lib/motion';
import { cn } from '@/lib/shadcn/utils';

// Kind -> hue, sourced from the theme (styles/globals.css --kind-*) so the
// canvas, HUD, and any future surface stay in sync with one definition.
const KIND_COLORS: Record<NodeKind, string> = {
  service: 'var(--kind-service)',
  datastore: 'var(--kind-datastore)',
  queue: 'var(--kind-queue)',
  gateway: 'var(--kind-gateway)',
  external: 'var(--kind-external)',
};

const HIGHLIGHT_MS = 1200;
const REMOVE_GRACE_MS = DUR.slow * 1000;

interface CartographNodeData extends Record<string, unknown> {
  label: string;
  kind: NodeKind;
  justArrived: boolean;
  /** Soft-deleted: still rendered so its exit animation can play, no longer in the incoming props. */
  removing: boolean;
}

/**
 * Position stays owned by xyflow (the `position` field on the Node object);
 * this component only ever animates opacity/scale/filter/colour. Animating
 * position in both places produces fighting transforms.
 */
function CartographNodeView({ data }: NodeProps<Node<CartographNodeData>>) {
  const color = KIND_COLORS[data.kind];
  const prevLabel = useRef(data.label);
  const [justReplaced, setJustReplaced] = useState(false);

  useEffect(() => {
    if (prevLabel.current === data.label) return;
    prevLabel.current = data.label;
    setJustReplaced(true);
    const timer = setTimeout(() => setJustReplaced(false), DUR.slow * 1000);
    return () => clearTimeout(timer);
  }, [data.label]);

  // Read-only diagram: handles exist only so xyflow can anchor edges to a
  // concrete point on each side. They're not interactive and near-invisible.
  const handleStyle = {
    width: 6,
    height: 6,
    background: color,
    border: 'none',
    opacity: 0.35,
  } as const;

  return (
    <motion.div
      initial={{ scale: 0.92, opacity: 0 }}
      animate={
        data.removing
          ? { scale: 0.9, opacity: 0, filter: 'blur(8px)' }
          : { scale: 1, opacity: 1, filter: 'blur(0px)' }
      }
      transition={data.removing ? { duration: DUR.slow } : SPRING}
      style={{
        borderColor: data.removing ? 'var(--state-stale)' : color,
        borderWidth: 2,
        borderStyle: 'solid',
        borderRadius: 8,
        padding: '6px 10px',
        fontSize: 13,
        background: 'var(--card)',
        color: 'var(--card-foreground)',
        boxShadow:
          data.justArrived && !data.removing
            ? `0 0 0 4px color-mix(in oklch, ${color} 40%, transparent)`
            : undefined,
        transition: 'box-shadow 0.6s ease-out',
      }}
    >
      <Handle type="target" position={Position.Left} style={handleStyle} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={handleStyle} isConnectable={false} />
      <Handle
        type="target"
        position={Position.Top}
        id="t"
        style={handleStyle}
        isConnectable={false}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="b"
        style={handleStyle}
        isConnectable={false}
      />
      <AnimatePresence mode="wait">
        <motion.span
          key={data.label}
          initial={justReplaced ? { opacity: 0, y: -4 } : false}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ duration: DUR.base }}
        >
          {data.label}
        </motion.span>
      </AnimatePresence>
    </motion.div>
  );
}

const nodeTypes = { cartographNode: CartographNodeView };

/**
 * Draws the connection on rather than just showing it — stroke-dashoffset
 * animates from the path's own length to 0 once, then settles to a static
 * stroke. A screen full of permanently-animating edges would be noise; a
 * new one being wired up as you watch is the point.
 */
function CartographEdgeView({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  label,
}: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const pathRef = useRef<SVGPathElement>(null);
  const [length, setLength] = useState<number | null>(null);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const el = pathRef.current;
    if (!el) return;
    setLength(el.getTotalLength());
    const raf = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(raf);
    // Only re-measure/redraw if this edge's own geometry actually changes —
    // not on every unrelated parent re-render.
  }, [path]);

  return (
    <>
      <path
        ref={pathRef}
        id={id}
        d={path}
        fill="none"
        stroke="var(--muted-foreground)"
        strokeWidth={1.5}
        style={
          length !== null
            ? {
                strokeDasharray: length,
                strokeDashoffset: drawn ? 0 : length,
                transition: `stroke-dashoffset ${DUR.slow}s ease-out`,
              }
            : { opacity: 0 }
        }
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              opacity: drawn ? 1 : 0,
              transition: `opacity ${DUR.base}s ease-out`,
            }}
            className="bg-card/90 text-muted-foreground rounded px-1.5 py-0.5 text-[10px]"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { cartographEdge: CartographEdgeView };

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
 *
 * Wrapped in a ReactFlowProvider so the inner component can call useReactFlow()
 * for imperative fitView (B3).
 */
export function ArchitectureCanvas(props: ArchitectureCanvasProps) {
  return (
    <ReactFlowProvider>
      <ArchitectureCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function ArchitectureCanvasInner({ nodes, edges, className }: ArchitectureCanvasProps) {
  // Ids currently on screen (present or mid-exit) — NOT permanently-growing,
  // so a node removed and later re-added under the same id flashes again.
  const seenIds = useRef(new Set<string>());
  const [justArrived, setJustArrived] = useState<Set<string>>(new Set());
  // Nodes xyflow should still render even though they've left `nodes` props,
  // so their exit animation has time to play before they're actually gone.
  const [removingNodes, setRemovingNodes] = useState<CanvasNode[]>([]);
  const removalTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const prevNodesRef = useRef<CanvasNode[]>([]);

  useEffect(() => {
    const currentIds = new Set(nodes.map((n) => n.id));
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

    // Anything that was on screen and just dropped out of `nodes` starts its exit.
    for (const prev of prevNodesRef.current) {
      if (currentIds.has(prev.id) || removalTimers.current.has(prev.id)) continue;
      seenIds.current.delete(prev.id); // re-adding this id later should flash again
      setRemovingNodes((r) => [...r, prev]);
      const timer = setTimeout(() => {
        setRemovingNodes((r) => r.filter((n) => n.id !== prev.id));
        removalTimers.current.delete(prev.id);
      }, REMOVE_GRACE_MS);
      removalTimers.current.set(prev.id, timer);
    }
    prevNodesRef.current = nodes;

    if (fresh.size === 0) return;
    setJustArrived(fresh);
    const timer = setTimeout(() => setJustArrived(new Set()), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [nodes, edges]);

  useEffect(() => {
    const timers = removalTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
    };
  }, []);

  const flowNodes: Node[] = useMemo(() => {
    const live: Node<CartographNodeData>[] = nodes.map((n) => ({
      id: n.id,
      type: 'cartographNode',
      position: { x: n.x, y: n.y },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: { label: n.label, kind: n.kind, justArrived: justArrived.has(n.id), removing: false },
    }));
    const exiting: Node<CartographNodeData>[] = removingNodes.map((n) => ({
      id: n.id,
      type: 'cartographNode',
      position: { x: n.x, y: n.y },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: { label: n.label, kind: n.kind, justArrived: false, removing: true },
    }));
    return [...live, ...exiting];
  }, [nodes, justArrived, removingNodes]);

  const flowEdges: Edge[] = useMemo(
    () =>
      edges.map((e) => ({
        id: e.id,
        type: 'cartographEdge',
        source: e.source,
        target: e.target,
        label: e.label,
      })),
    [edges]
  );

  // B3: the `fitView` prop only frames the viewport on the initial (empty)
  // mount. Re-fit imperatively whenever the graph's bounds change — a new node,
  // a new edge, OR the agent's layered layout (B4) repositioning existing nodes
  // — so nothing is ever left off-screen. The animated glide reads as the
  // diagram growing; honour prefers-reduced-motion, as the rest of the app does.
  const { fitView } = useReactFlow();
  const prefersReducedMotion = useReducedMotion();
  const boundsKey = useMemo(
    () => nodes.map((n) => `${n.id}:${n.x},${n.y}`).join('|') + `#${edges.length}`,
    [nodes, edges.length]
  );
  useEffect(() => {
    if (nodes.length === 0) return;
    // Let the node-position CSS transition (globals.css) start first so the
    // camera tracks the moving nodes rather than jumping ahead of them.
    const id = setTimeout(() => {
      void fitView({ padding: 0.2, duration: prefersReducedMotion ? 0 : 450, maxZoom: 1.2 });
    }, 60);
    return () => clearTimeout(id);
  }, [boundsKey, nodes.length, fitView, prefersReducedMotion]);

  return (
    <div className={cn('h-full w-full', className)}>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
