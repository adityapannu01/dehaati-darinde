'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type {
  CanvasEdge,
  CanvasGroup,
  CanvasNode,
  GhostElement,
  LayoutDirection,
  NodeKind,
} from '@repo/protocol';
import type { FormingState } from '@/hooks/use-cartograph';
import {
  Background,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  Handle,
  MarkerType,
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
import { Icon } from '@iconify/react';
import { iconForLabel } from '@/lib/cartograph/icon-for-label';
import { SketchRect, useSketchMode } from '@/components/cartograph/sketch';
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

// ROUND3 A5: kind in a SECOND channel — silhouette, not just hue — so a dense
// diagram is scannable. Pure CSS: border-radius + clip-path, no dependency.
const KIND_SHAPE: Record<NodeKind, { borderRadius: string; clipPath?: string; dashed?: boolean }> = {
  service: { borderRadius: '8px' },
  // barrel / cylinder hint — tall side radii read as a database
  datastore: { borderRadius: '4px / 14px' },
  // notched leading edge — a message queue
  queue: {
    borderRadius: '3px',
    clipPath: 'polygon(0 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 0 100%)',
  },
  // chamfered hexagon — a gateway / boundary crossing
  gateway: {
    borderRadius: '2px',
    clipPath: 'polygon(10px 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 10px 100%, 0 50%)',
  },
  // dashed + softer — something outside the system
  external: { borderRadius: '8px', dashed: true },
};

const HIGHLIGHT_MS = 1200;
const REMOVE_GRACE_MS = DUR.slow * 1000;

interface CartographNodeData extends Record<string, unknown> {
  label: string;
  kind: NodeKind;
  justArrived: boolean;
  /** Soft-deleted: still rendered so its exit animation can play, no longer in the incoming props. */
  removing: boolean;
  /** §3.3: staged but not yet committed — drawn translucent/dashed while its sentence is spoken. */
  forming: boolean;
  /** §3.3: a delivered word has matched this element's anchor phrase. */
  named: boolean;
  /** §2.4: an ambient proposal overheard from the room — fainter still, never committed. */
  ghost: boolean;
  /** §2.4: which participant proposed this ghost. */
  proposedBy?: string;
}

/**
 * Position stays owned by xyflow (the `position` field on the Node object);
 * this component only ever animates opacity/scale/filter/colour. Animating
 * position in both places produces fighting transforms.
 */
function CartographNodeView({ data }: NodeProps<Node<CartographNodeData>>) {
  const color = KIND_COLORS[data.kind];
  const icon = useMemo(() => iconForLabel(data.label), [data.label]);
  const prevLabel = useRef(data.label);
  const [justReplaced, setJustReplaced] = useState(false);

  // §3.4: opt-in rough.js border.
  const sketch = useSketchMode();
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!sketch || !boxRef.current) return;
    const el = boxRef.current;
    const ro = new ResizeObserver(() => setSize({ w: el.offsetWidth, h: el.offsetHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [sketch]);

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

  // §3.3 / §2.4: a forming node is faint until a delivered word names it; a
  // ghost (ambient proposal) is fainter still. Both go fully solid only when
  // committed.
  const targetOpacity = data.removing
    ? 0
    : data.ghost
      ? 0.34
      : data.forming
        ? data.named
          ? 0.82
          : 0.4
        : 1;

  const strokeColor = data.removing
    ? 'var(--state-stale)'
    : data.ghost || (data.forming && !data.named)
      ? 'var(--muted-foreground)'
      : color;
  const shape = KIND_SHAPE[data.kind];
  // clip-path eats the border, so a clipped kind gets its colour from a tinted
  // fill + a same-colour inset shadow instead of a stroke.
  const clipped = !sketch && !!shape.clipPath;

  return (
    <motion.div
      ref={boxRef}
      initial={{ scale: 0.92, opacity: 0 }}
      animate={
        data.removing
          ? { scale: 0.9, opacity: 0, filter: 'blur(8px)' }
          : { scale: data.forming && !data.named ? 0.96 : 1, opacity: targetOpacity, filter: 'blur(0px)' }
      }
      transition={data.removing ? { duration: DUR.slow } : SPRING}
      title={data.ghost && data.proposedBy ? `proposed by ${data.proposedBy}` : undefined}
      style={{
        position: 'relative',
        clipPath: clipped ? shape.clipPath : undefined,
        borderColor: sketch || clipped ? 'transparent' : strokeColor,
        borderWidth: 2,
        borderStyle:
          !sketch && !clipped && (data.forming || data.ghost || shape.dashed) ? 'dashed' : 'solid',
        borderRadius: shape.borderRadius,
        padding: clipped ? '6px 16px' : '6px 10px',
        fontSize: 13,
        background: clipped
          ? `color-mix(in oklch, ${strokeColor} 22%, var(--card))`
          : shape.dashed
            ? `color-mix(in oklch, ${strokeColor} 6%, var(--card))`
            : 'var(--card)',
        color: 'var(--card-foreground)',
        boxShadow: [
          clipped ? `inset 0 0 0 2px color-mix(in oklch, ${strokeColor} 55%, transparent)` : '',
          data.justArrived && !data.removing
            ? `0 0 0 4px color-mix(in oklch, ${color} 40%, transparent)`
            : '',
        ]
          .filter(Boolean)
          .join(', ') || undefined,
        transition: 'box-shadow 0.6s ease-out, border-color 0.4s ease-out',
      }}
    >
      {sketch && size.w > 0 && (
        <SketchRect width={size.w} height={size.h} color={strokeColor} seed={data.label} />
      )}
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
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          {icon && (
            <Icon
              icon={icon}
              width={15}
              height={15}
              style={{ flexShrink: 0 }}
              // A missing/unknown icon just renders nothing — the kind border colour still reads.
              onError={() => undefined}
            />
          )}
          {data.label}
        </motion.span>
      </AnimatePresence>
    </motion.div>
  );
}

interface CartographGroupData extends Record<string, unknown> {
  label: string;
  width: number;
  height: number;
}

/**
 * §3.2: a labelled boundary (VPC, trust boundary, bounded context). Sits behind
 * its members, non-interactive; the agent owns its box (derived from member
 * positions), so it just renders what it's given.
 */
function CartographGroupView({ data }: NodeProps<Node<CartographGroupData>>) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: DUR.base }}
      style={{
        width: data.width,
        height: data.height,
        border: '1.5px dashed var(--muted-foreground)',
        borderRadius: 12,
        background: 'color-mix(in oklch, var(--muted-foreground) 6%, transparent)',
        pointerEvents: 'none',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: -9,
          left: 12,
          padding: '0 6px',
          fontSize: 10,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--muted-foreground)',
          background: 'var(--background)',
        }}
      >
        {data.label}
      </span>
    </motion.div>
  );
}

const nodeTypes = { cartographNode: CartographNodeView, cartographGroup: CartographGroupView };

interface CartographEdgeData extends Record<string, unknown> {
  flow?: 'sync' | 'async';
  bidirectional?: boolean;
}

/**
 * Draws the connection on rather than just showing it — stroke-dashoffset
 * animates from the path's own length to 0 once, then settles to a static
 * stroke. A screen full of permanently-animating edges would be noise; a
 * new one being wired up as you watch is the point.
 *
 * Edge semantics (§3.2): `flow: 'async'` settles to a dashed stroke (a
 * queue/event link); `bidirectional` adds a start arrowhead.
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
  data,
  markerEnd,
  markerStart,
}: EdgeProps) {
  const flow = (data as CartographEdgeData | undefined)?.flow;
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

  // While drawing on: one dash the length of the path, offset animating to 0.
  // Once drawn: solid for a sync edge, a repeating dash pattern for async.
  const strokeStyle: React.CSSProperties =
    length === null
      ? { opacity: 0 }
      : !drawn
        ? {
            strokeDasharray: length,
            strokeDashoffset: length,
            transition: `stroke-dashoffset ${DUR.slow}s ease-out`,
          }
        : flow === 'async'
          ? { strokeDasharray: '6 5', strokeDashoffset: 0, transition: `stroke-dashoffset ${DUR.slow}s ease-out` }
          : { strokeDasharray: length, strokeDashoffset: 0, transition: `stroke-dashoffset ${DUR.slow}s ease-out` };

  return (
    <>
      <path
        ref={pathRef}
        id={id}
        d={path}
        fill="none"
        stroke="var(--muted-foreground)"
        strokeWidth={1.5}
        markerEnd={markerEnd}
        markerStart={markerStart}
        style={strokeStyle}
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

// ROUND3 A3: which side of a node its edges attach to, per flow direction.
// Reuses the four <Handle>s CartographNodeView already renders.
const HANDLES: Record<LayoutDirection, { source: Position; target: Position }> = {
  RIGHT: { source: Position.Right, target: Position.Left },
  LEFT: { source: Position.Left, target: Position.Right },
  DOWN: { source: Position.Bottom, target: Position.Top },
  UP: { source: Position.Top, target: Position.Bottom },
};

interface ArchitectureCanvasProps {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** §3.2: boundaries drawn around sets of nodes. */
  groups?: CanvasGroup[];
  /** ROUND3 A1: the diagram's flow direction. */
  direction?: LayoutDirection;
  /** §3.3: staged-but-uncommitted elements, drawn "forming". */
  forming?: FormingState[];
  /** §2.4: ambient proposals overheard from the room, drawn "ghost". */
  ghosts?: GhostElement[];
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

function ArchitectureCanvasInner({
  nodes,
  edges,
  groups = [],
  direction = 'RIGHT',
  forming = [],
  ghosts = [],
  className,
}: ArchitectureCanvasProps) {
  const handles = HANDLES[direction];
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

  const committedIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
  const formingNodes = useMemo(
    () => forming.filter((f) => f.element === 'node' && !committedIds.has(f.id)),
    [forming, committedIds]
  );

  const flowNodes: Node[] = useMemo(() => {
    // §3.2: groups first so they render behind every component.
    const groupLayer: Node[] = groups.map((g) => ({
      id: `group-${g.id}`,
      type: 'cartographGroup',
      position: { x: g.x, y: g.y },
      data: { label: g.label, width: g.width, height: g.height },
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: -1,
    }));
    const live: Node<CartographNodeData>[] = nodes.map((n) => ({
      id: n.id,
      type: 'cartographNode',
      position: { x: n.x, y: n.y },
      sourcePosition: handles.source,
      targetPosition: handles.target,
      data: {
        label: n.label,
        kind: n.kind,
        justArrived: justArrived.has(n.id),
        removing: false,
        forming: false,
        named: false,
        ghost: false,
      },
    }));
    const exiting: Node<CartographNodeData>[] = removingNodes.map((n) => ({
      id: n.id,
      type: 'cartographNode',
      position: { x: n.x, y: n.y },
      sourcePosition: handles.source,
      targetPosition: handles.target,
      data: {
        label: n.label,
        kind: n.kind,
        justArrived: false,
        removing: true,
        forming: false,
        named: false,
        ghost: false,
      },
    }));
    // §3.3: forming nodes spawn in a row above the committed graph; when they
    // commit they get an ELK position and the CSS transform transition glides
    // them into place.
    const formingRow: Node<CartographNodeData>[] = formingNodes.map((f, i) => ({
      id: f.id,
      type: 'cartographNode',
      position: { x: i * 190, y: -140 },
      sourcePosition: handles.source,
      targetPosition: handles.target,
      data: {
        label: f.label,
        kind: f.kind ?? 'service',
        justArrived: false,
        removing: false,
        forming: true,
        named: f.named,
        ghost: false,
      },
    }));
    // §2.4: ambient proposals sit in a row BELOW the committed graph, so a
    // "forming" node (in progress, above) and a "ghost" (a colleague's idea,
    // below) read as distinct states.
    const ghostRow: Node<CartographNodeData>[] = ghosts
      .filter((g) => g.element === 'node' && !committedIds.has(g.id))
      .map((g, i) => ({
        id: g.id,
        type: 'cartographNode',
        position: { x: i * 190, y: 220 + Math.max(0, ...nodes.map((n) => n.y)) },
        sourcePosition: handles.source,
        targetPosition: handles.target,
        data: {
          label: g.label,
          kind: g.kind ?? 'service',
          justArrived: false,
          removing: false,
          forming: false,
          named: false,
          ghost: true,
          proposedBy: g.proposedBy,
        },
      }));
    return [...groupLayer, ...live, ...exiting, ...formingRow, ...ghostRow];
  }, [nodes, groups, justArrived, removingNodes, formingNodes, ghosts, committedIds]);

  const flowEdges: Edge[] = useMemo(
    () =>
      edges.map((e) => ({
        id: e.id,
        type: 'cartographEdge',
        source: e.source,
        target: e.target,
        label: e.label,
        data: { flow: e.flow, bidirectional: e.bidirectional },
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: 'var(--muted-foreground)' },
        ...(e.bidirectional
          ? {
              markerStart: {
                type: MarkerType.ArrowClosed,
                width: 16,
                height: 16,
                color: 'var(--muted-foreground)',
              },
            }
          : {}),
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
    () => nodes.map((n) => `${n.id}:${n.x},${n.y}`).join('|') + `#${edges.length}#${direction}`,
    [nodes, edges.length, direction]
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
