import type { CanvasEdge, CanvasGroup, CanvasNode, CanvasSnapshot, MutationOp } from '@repo/protocol';

// The agent-side source of truth for the shared architecture diagram.
// Mutations only ever arrive here through CommitGate, once Rime has actually
// delivered the sentence describing them — see core/commit-gate.ts.

const LAYOUT_COLUMNS = 4;
const LAYOUT_SPACING = 220;
// Padding between a group boundary and its outermost members (§3.2).
const GROUP_PADDING = 28;
const NODE_W = 160;
const NODE_H = 46;

export class CanvasStore {
  private nodes = new Map<string, CanvasNode>();
  private edges = new Map<string, CanvasEdge>();
  private groups = new Map<string, Omit<CanvasGroup, 'x' | 'y' | 'width' | 'height'>>();
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
    groups: [string, Omit<CanvasGroup, 'x' | 'y' | 'width' | 'height'>][];
    placements: number;
  }[] = [];
  private static readonly HISTORY_LIMIT = 30;

  private pushHistory(): void {
    this.history.push({
      nodes: [...this.nodes].map(([k, v]) => [k, { ...v }]),
      edges: [...this.edges].map(([k, v]) => [k, { ...v }]),
      groups: [...this.groups].map(([k, v]) => [k, { ...v, memberIds: [...v.memberIds] }]),
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
        const memberIds = m.memberIds.filter((id) => this.nodes.has(id));
        if (memberIds.length > 0) this.groups.set(m.id, { id: m.id, label: m.label, memberIds });
        break;
      }
      case 'undo': {
        const prev = this.history.pop();
        if (!prev) break; // nothing to undo — a no-op, not an error
        this.nodes = new Map(prev.nodes);
        this.edges = new Map(prev.edges);
        this.groups = new Map(prev.groups);
        this.placements = prev.placements;
        break;
      }
      case 'clear':
        this.nodes.clear();
        this.edges.clear();
        this.groups.clear();
        this.placements = 0;
        break;
    }
    this.version += 1;
  }

  /** True when there is at least one committed mutation that `undo` could reverse. */
  get canUndo(): boolean {
    return this.history.length > 0;
  }

  /** Group boxes derived from current member positions — never authored. */
  private groupBoxes(): CanvasGroup[] {
    const out: CanvasGroup[] = [];
    for (const g of this.groups.values()) {
      const members = g.memberIds.map((id) => this.nodes.get(id)).filter((n): n is CanvasNode => !!n);
      if (members.length === 0) continue;
      const minX = Math.min(...members.map((n) => n.x)) - GROUP_PADDING;
      const minY = Math.min(...members.map((n) => n.y)) - GROUP_PADDING - 14; // room for the label
      const maxX = Math.max(...members.map((n) => n.x + NODE_W)) + GROUP_PADDING;
      const maxY = Math.max(...members.map((n) => n.y + NODE_H)) + GROUP_PADDING;
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
