import type { CanvasEdge, CanvasNode, CanvasSnapshot, MutationOp } from '@repo/protocol';

// The agent-side source of truth for the shared architecture diagram.
// Mutations only ever arrive here through CommitGate, once Rime has actually
// delivered the sentence describing them — see core/commit-gate.ts.

const LAYOUT_COLUMNS = 4;
const LAYOUT_SPACING = 220;

export class CanvasStore {
  private nodes = new Map<string, CanvasNode>();
  private edges = new Map<string, CanvasEdge>();
  private version = 0;
  // B5: placement index must only ever increment. Deriving it from nodes.size
  // meant that removing a node then adding one reused an occupied grid slot and
  // stacked two boxes exactly. Reset only by an explicit `clear`.
  private placements = 0;

  apply(m: MutationOp): void {
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
      case 'clear':
        this.nodes.clear();
        this.edges.clear();
        this.placements = 0;
        break;
    }
    this.version += 1;
  }

  /** Deep copy — never a live reference into the store. */
  snapshot(generation: number): CanvasSnapshot {
    return {
      version: this.version,
      generation,
      nodes: Array.from(this.nodes.values(), (n) => ({ ...n })),
      edges: Array.from(this.edges.values(), (e) => ({ ...e })),
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
    return lines.join('\n');
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  get currentVersion(): number {
    return this.version;
  }
}
