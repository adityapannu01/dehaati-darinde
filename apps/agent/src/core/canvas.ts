import type {
  CanvasEdge,
  CanvasGroup,
  CanvasNode,
  CanvasSnapshot,
  LayoutDirection,
  MutationOp,
  NodeKind,
} from '@repo/protocol';
import { NODE_HEIGHT, NODE_WIDTH } from './node-metrics.ts';

// The agent-side source of truth for the shared architecture diagram.
// Mutations only ever arrive here through CommitGate, once Rime has actually
// delivered the sentence describing them — see core/commit-gate.ts.

const LAYOUT_COLUMNS = 4;
const LAYOUT_SPACING = 220;
// Padding between a group boundary and its outermost members (§3.2).
const GROUP_PADDING = 28;

function slug(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

function normalize(label: string): string {
  return label.trim().toLowerCase();
}

// A spoken generic noun resolves to a node's kind when the label itself
// doesn't overlap the node's actual name at all ("the database" -> Postgres
// has zero shared substring/tokens with "postgres" — this is the only path
// that catches it). Only applied when it uniquely picks one node.
const GENERIC_KIND_WORDS: Record<string, NodeKind> = {
  database: 'datastore',
  datastore: 'datastore',
  db: 'datastore',
  cache: 'datastore',
  service: 'service',
  gateway: 'gateway',
  queue: 'queue',
  topic: 'queue',
  broker: 'queue',
};

type StoredGroup = Omit<CanvasGroup, 'x' | 'y' | 'width' | 'height'>;

export class CanvasStore {
  private nodes = new Map<string, CanvasNode>();
  private edges = new Map<string, CanvasEdge>();
  private groups = new Map<string, StoredGroup>();
  // ROUND3 A1: the diagram's flow direction. A narrated, history-worthy change
  // (unlike applyLayout's repositioning, which nobody asked for).
  private direction: LayoutDirection = 'RIGHT';
  private version = 0;
  // B5: placement index must only ever increment. Deriving it from nodes.size
  // meant that removing a node then adding one reused an occupied grid slot and
  // stacked two boxes exactly. Reset only by an explicit `clear`.
  private placements = 0;
  // Bounded state history for undo-by-voice. Each entry is the full node/edge/
  // group state *before* a mutation — "undo" restores the most recent. Layout
  // repositioning (applyLayout) is not history-worthy, so it's excluded.
  private history: {
    nodes: [string, CanvasNode][];
    edges: [string, CanvasEdge][];
    groups: [string, StoredGroup][];
    direction: LayoutDirection;
    placements: number;
  }[] = [];
  private static readonly HISTORY_LIMIT = 30;

  private pushHistory(): void {
    this.history.push({
      nodes: [...this.nodes].map(([k, v]) => [k, { ...v }]),
      edges: [...this.edges].map(([k, v]) => [k, { ...v }]),
      groups: [...this.groups].map(([k, v]) => [k, { ...v, memberIds: [...v.memberIds] }]),
      direction: this.direction,
      placements: this.placements,
    });
    if (this.history.length > CanvasStore.HISTORY_LIMIT) this.history.shift();
  }

  apply(m: MutationOp): void {
    if (m.op !== 'undo') this.pushHistory();
    switch (m.op) {
      case 'addNode':
        this.nodes.set(m.node.id, { ...m.node });
        break;
      case 'removeNode': {
        this.nodes.delete(m.nodeId);
        // Cascade: an edge touching a deleted node can never be rendered.
        for (const [edgeId, edge] of this.edges) {
          if (edge.source === m.nodeId || edge.target === m.nodeId) {
            this.edges.delete(edgeId);
          }
        }
        // Drop it from any group; drop groups left empty.
        for (const [gid, g] of this.groups) {
          const members = g.memberIds.filter((id) => id !== m.nodeId);
          if (members.length === 0) this.groups.delete(gid);
          else this.groups.set(gid, { ...g, memberIds: members });
        }
        break;
      }
      case 'renameNode': {
        const node = this.nodes.get(m.nodeId);
        if (node) node.label = m.label;
        break;
      }
      case 'replaceNode': {
        // Keep the id (and therefore its edges) — only label/kind change.
        // This is what makes "swap Redis for MongoDB" preserve the wiring.
        const node = this.nodes.get(m.nodeId);
        if (node) {
          node.label = m.label;
          node.kind = m.kind;
        }
        break;
      }
      case 'addEdge':
        this.edges.set(m.edge.id, { ...m.edge });
        break;
      case 'removeEdge':
        this.edges.delete(m.edgeId);
        break;
      case 'addGroup': {
        // A2 edge case: ELK's tree can't put a node in two containers. First
        // group wins — members already claimed by another group are dropped
        // from this one (the tool result says so).
        const alreadyGrouped = new Set(
          [...this.groups.values()].flatMap((g) => g.memberIds),
        );
        const memberIds = m.memberIds.filter(
          (id) => this.nodes.has(id) && !alreadyGrouped.has(id),
        );
        if (memberIds.length > 0) this.groups.set(m.id, { id: m.id, label: m.label, memberIds });
        break;
      }
      case 'setDirection': {
        if (m.scope) {
          const g = this.groups.get(this.resolveGroupId(m.scope));
          if (g) g.direction = m.direction;
        } else {
          this.direction = m.direction;
        }
        break;
      }
      case 'undo': {
        const prev = this.history.pop();
        if (!prev) break; // nothing to undo — a no-op, not an error
        this.nodes = new Map(prev.nodes);
        this.edges = new Map(prev.edges);
        this.groups = new Map(prev.groups);
        this.direction = prev.direction;
        this.placements = prev.placements;
        break;
      }
      case 'clear':
        this.nodes.clear();
        this.edges.clear();
        this.groups.clear();
        this.direction = 'RIGHT';
        this.placements = 0;
        break;
    }
    this.version += 1;
  }

  get currentDirection(): LayoutDirection {
    return this.direction;
  }

  /** Set the starting direction (from LAYOUT_DIRECTION) without a history entry — nobody narrated it. */
  setInitialDirection(direction: LayoutDirection): void {
    this.direction = direction;
  }

  /** The group a node belongs to, or undefined. */
  groupOfNode(nodeId: string): string | undefined {
    for (const [gid, g] of this.groups) if (g.memberIds.includes(nodeId)) return gid;
    return undefined;
  }

  /** Forgiving group-label → id resolution, same spirit as resolveId for nodes (A4 scope). */
  resolveGroupId(label: string): string {
    const needle = normalize(label);
    for (const [gid, g] of this.groups) {
      if (normalize(g.label) === needle || gid === label) return gid;
    }
    const partial = [...this.groups.entries()].filter(([, g]) => {
      const hay = normalize(g.label);
      return hay.includes(needle) || needle.includes(hay);
    });
    return partial.length === 1 ? partial[0]![0] : slug(label);
  }

  /** True when there is at least one committed mutation that `undo` could reverse. */
  get canUndo(): boolean {
    return this.history.length > 0;
  }

  /**
   * Resolve a spoken label to an existing node's id. Tools that reference an
   * EXISTING component (connectServices, renameComponent, removeComponent,
   * replaceComponent, groupComponents) call this instead of hashing the label
   * themselves. The LLM routinely paraphrases — "connect the gateway to the
   * auth service" for a node actually labelled "API Gateway", or "the
   * database" for one labelled "Postgres" — and a naive slug() of the
   * paraphrase silently misses: the mutation stages, "succeeds", and produces
   * a dangling reference that never renders. No error, no signal, just a
   * component that looks connected in the transcript and isn't on screen.
   *
   * Resolution order, first unambiguous hit wins:
   *   1. exact id (today's behaviour — the fast, fully backward-compatible path)
   *   2. exact label match, case-insensitive
   *   3. an unambiguous substring match, either direction
   *   4. a generic kind noun ("the database") when exactly one node has that kind
   *   5. an unambiguous best-token-overlap match
   * Falls back to slug(label) — i.e. today's behaviour — when nothing
   * resolves or a match is ambiguous, so a genuinely novel reference fails
   * exactly as before rather than guessing wrong.
   */
  resolveId(label: string): string {
    const id = slug(label);
    if (this.nodes.has(id)) return id;

    const needle = normalize(label);
    for (const [nodeId, n] of this.nodes) {
      if (normalize(n.label) === needle) return nodeId;
    }

    const substringMatches = [...this.nodes.entries()].filter(([, n]) => {
      const hay = normalize(n.label);
      return hay.includes(needle) || needle.includes(hay);
    });
    if (substringMatches.length === 1) return substringMatches[0]![0];

    const bareWord = needle.replace(/^(the|a|an)\s+/, '').trim();
    const kind = GENERIC_KIND_WORDS[bareWord];
    if (kind) {
      const kindMatches = [...this.nodes.values()].filter((n) => n.kind === kind);
      if (kindMatches.length === 1) return kindMatches[0]!.id;
    }

    const needleTokens = new Set(needle.split(/\s+/).filter(Boolean));
    let bestScore = 0;
    let bestMatches: string[] = [];
    for (const [nodeId, n] of this.nodes) {
      const overlap = normalize(n.label)
        .split(/\s+/)
        .filter((t) => needleTokens.has(t)).length;
      if (overlap === 0) continue;
      if (overlap > bestScore) {
        bestScore = overlap;
        bestMatches = [nodeId];
      } else if (overlap === bestScore) {
        bestMatches.push(nodeId);
      }
    }
    if (bestMatches.length === 1) return bestMatches[0]!;

    return id; // no unambiguous match — preserve old (failing) behaviour
  }

  /** Group boxes derived from current member positions — never authored. */
  private groupBoxes(): CanvasGroup[] {
    const out: CanvasGroup[] = [];
    for (const g of this.groups.values()) {
      const members = g.memberIds.map((id) => this.nodes.get(id)).filter((n): n is CanvasNode => !!n);
      if (members.length === 0) continue;
      const minX = Math.min(...members.map((n) => n.x)) - GROUP_PADDING;
      const minY = Math.min(...members.map((n) => n.y)) - GROUP_PADDING - 14; // room for the label
      const maxX = Math.max(...members.map((n) => n.x + NODE_WIDTH)) + GROUP_PADDING;
      const maxY = Math.max(...members.map((n) => n.y + NODE_HEIGHT)) + GROUP_PADDING;
      out.push({ ...g, x: minX, y: minY, width: maxX - minX, height: maxY - minY });
    }
    return out;
  }

  /**
   * Apply an ELK-computed placement (see core/layout.ts). Returns true if any
   * position actually moved, so the caller only re-publishes on a real change.
   * Unknown ids are ignored — the graph can shift between layout request and
   * result.
   */
  applyLayout(placements: Map<string, { x: number; y: number }>): boolean {
    let moved = false;
    for (const [id, pos] of placements) {
      const node = this.nodes.get(id);
      if (!node) continue;
      if (node.x !== pos.x || node.y !== pos.y) {
        node.x = pos.x;
        node.y = pos.y;
        moved = true;
      }
    }
    if (moved) this.version += 1;
    return moved;
  }

  /** Deep copy — never a live reference into the store. */
  snapshot(generation: number): CanvasSnapshot {
    return {
      version: this.version,
      generation,
      nodes: Array.from(this.nodes.values(), (n) => ({ ...n })),
      edges: Array.from(this.edges.values(), (e) => ({ ...e })),
      groups: this.groupBoxes(),
      direction: this.direction,
    };
  }

  /**
   * Deterministic grid position for the next node, from a monotonic placement
   * counter (B5 — never `nodes.size`, which collides after a removal). Never
   * ask the LLM for coordinates: it wastes tokens, adds latency, and produces
   * garbage layouts.
   */
  nextLayout(): { x: number; y: number } {
    const index = this.placements;
    this.placements += 1;
    const col = index % LAYOUT_COLUMNS;
    const row = Math.floor(index / LAYOUT_COLUMNS);
    return { x: col * LAYOUT_SPACING, y: row * LAYOUT_SPACING };
  }

  /**
   * Compact text rendering for the LangGraph planner (labels + edges, no
   * ids/coordinates it doesn't need) so it can resolve "the cache" to a real
   * node without spending tokens on layout data.
   */
  summary(): string {
    if (this.nodes.size === 0) return '(empty)';
    const lines = Array.from(this.nodes.values(), (n) => `- ${n.label} (${n.kind})`);
    for (const e of this.edges.values()) {
      const source = this.nodes.get(e.source)?.label ?? e.source;
      const target = this.nodes.get(e.target)?.label ?? e.target;
      lines.push(`- ${source} -> ${target}${e.label ? ` (${e.label})` : ''}`);
    }
    for (const g of this.groups.values()) {
      const members = g.memberIds.map((id) => this.nodes.get(id)?.label ?? id);
      lines.push(`- boundary "${g.label}" contains: ${members.join(', ')}`);
    }
    return lines.join('\n');
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  get currentVersion(): number {
    return this.version;
  }

  /**
   * Mermaid `flowchart` source for the current diagram — an export the user can
   * paste elsewhere (§3.4: Mermaid is a fine export target, just not a
   * renderer, because it re-renders the whole graph on every change).
   */
  toMermaid(): string {
    if (this.nodes.size === 0) return 'flowchart LR\n  %% (empty)';
    const safe = (id: string) => `n_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;
    const lines = ['flowchart LR'];
    for (const [gid, g] of this.groups) {
      lines.push(`  subgraph g_${safe(gid)}["${g.label}"]`);
      for (const id of g.memberIds) {
        const n = this.nodes.get(id);
        if (n) lines.push(`    ${safe(id)}["${n.label}"]`);
      }
      lines.push('  end');
    }
    const grouped = new Set([...this.groups.values()].flatMap((g) => g.memberIds));
    for (const [id, n] of this.nodes) {
      if (!grouped.has(id)) lines.push(`  ${safe(id)}["${n.label}"]`);
    }
    for (const e of this.edges.values()) {
      if (!this.nodes.has(e.source) || !this.nodes.has(e.target)) continue;
      const arrow = e.flow === 'async' ? '-. ' : '-- ';
      const tail = e.flow === 'async' ? ' .->' : '-->';
      const mid = e.label ? `${arrow}${e.label}${tail}` : e.flow === 'async' ? '-.->' : '-->';
      lines.push(`  ${safe(e.source)} ${mid} ${safe(e.target)}`);
    }
    return lines.join('\n');
  }
}
