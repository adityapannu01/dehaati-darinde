// Types crossing the agent <-> browser boundary for Cartograph.
// The agent owns canvas state; the browser is a pure renderer of these messages.

export type NodeKind = 'service' | 'datastore' | 'queue' | 'gateway' | 'external';

export interface CanvasNode {
  id: string;
  label: string;
  kind: NodeKind;
  x: number;
  y: number;
}

/** How a connection behaves — drives the stroke style in the renderer. */
export type EdgeFlow = 'sync' | 'async';

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  label?: string | undefined;
  /** 'async' renders dashed (a queue/event edge); 'sync' (default) renders solid. */
  flow?: EdgeFlow | undefined;
  /** true renders arrowheads at both ends. */
  bidirectional?: boolean | undefined;
}

/** The direction the layered layout flows. Maps 1:1 to ELK's `elk.direction`. */
export type LayoutDirection = 'RIGHT' | 'DOWN' | 'LEFT' | 'UP';

/**
 * A boundary drawn around a set of nodes — a VPC, a trust boundary, a bounded
 * context (§3.2). Its box is derived from its members' positions by the agent,
 * never authored.
 */
export interface CanvasGroup {
  id: string;
  label: string;
  memberIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  /** ROUND3 A4: per-group flow direction; inherits the diagram's when unset. */
  direction?: LayoutDirection | undefined;
}

export interface CanvasSnapshot {
  /** Monotonic; the browser drops any snapshot whose version is not greater than the last it rendered. */
  version: number;
  generation: number;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  groups: CanvasGroup[];
  /** ROUND3 A1: the direction the diagram flows — presentation, never part of the oracle's content diff. */
  direction: LayoutDirection;
}

export type MutationOp =
  | { op: 'addNode'; node: CanvasNode }
  | { op: 'removeNode'; nodeId: string }
  | { op: 'renameNode'; nodeId: string; label: string }
  | { op: 'replaceNode'; nodeId: string; label: string; kind: NodeKind }
  | { op: 'addEdge'; edge: CanvasEdge }
  | { op: 'removeEdge'; edgeId: string }
  /** Draw a boundary around existing components (§3.2). */
  | { op: 'addGroup'; id: string; label: string; memberIds: string[] }
  /** ROUND3 A1/A4: change the flow direction of the whole diagram, or of one group (scope). */
  | { op: 'setDirection'; direction: LayoutDirection; scope?: string | undefined }
  /** Reverse the most recent committed mutation (undo-by-voice). No-op if nothing to undo. */
  | { op: 'undo' }
  /** Wipe every node and edge in a single atomic step (see clearCanvas tool). */
  | { op: 'clear' };

export interface StagedMutation {
  id: string;
  generation: number;
  /** Which sentence of the reply describes this mutation (0-indexed, in tool-call order). */
  sentenceIndex: number;
  /** e.g. "MongoDB" — used only as a mismatch guard, never to block a commit. */
  anchorPhrase: string;
  mutation: MutationOp;
}

export type LedgerEventType =
  | 'generation_started'
  | 'generation_cancelled'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_aborted'
  | 'tool_stale_discarded'
  | 'speech_started'
  | 'speech_interrupted'
  | 'sentence_delivered'
  | 'mutation_staged'
  | 'mutation_committed'
  | 'mutation_dropped'
  /** LLM_ENGINE=graph only — see apps/agent/src/graph. */
  | 'graph_route'
  | 'graph_plan'
  | 'graph_plan_invalid'
  /** ADDRESSIVITY=true only — see apps/agent/src/core/addressivity.ts + proposals.ts (§2). */
  | 'utterance_scored'
  | 'proposal_created'
  | 'proposal_promoted'
  | 'proposal_rejected'
  | 'proposal_expired'
  /** ROUND3 A1 — the diagram's flow direction changed (narrated, gated, undoable). */
  | 'direction_changed';

export interface LedgerEvent {
  seq: number;
  /** Date.now() */
  t: number;
  generation: number;
  type: LedgerEventType;
  detail?: string | undefined;
}

/** A node/edge that is staged but not yet committed — the browser draws it as "forming". */
export interface FormingElement {
  id: string;
  /** 'node' carries label/kind; 'edge' carries source/target. */
  element: 'node' | 'edge';
  label: string;
  kind?: NodeKind | undefined;
  source?: string | undefined;
  target?: string | undefined;
  /** The phrase in the describing sentence this element is named by — used to time the reveal. */
  anchorPhrase: string;
}

/**
 * A proposal inferred from *overheard* engineer speech (§2.4). A ghost never
 * enters committed canvas state; it is promoted only when a human confirms it
 * or the agent narrates it aloud, and removed by disagreement, explicit
 * rejection, or a timeout. Safety invariant: overheard speech can only ever
 * create or destroy proposals — committed state is changed only by addressed
 * speech.
 */
export interface GhostElement {
  id: string;
  element: 'node' | 'edge';
  label: string;
  kind?: NodeKind | undefined;
  source?: string | undefined;
  target?: string | undefined;
  /** Participant identity whose speech proposed this. */
  proposedBy: string;
  /** Classifier salience score in [0,1] at creation. */
  confidence: number;
  /** Date.now() when it will auto-expire if not promoted. */
  expiresAt: number;
}

export type ServerMessage =
  | { kind: 'snapshot'; snapshot: CanvasSnapshot }
  | { kind: 'events'; events: LedgerEvent[] }
  /**
   * Elements the agent has staged for the current generation but not yet
   * committed. The browser renders them translucent/forming so a node appears
   * *as its sentence is spoken*, then solidifies when the snapshot commits it.
   * An empty list clears all forming elements (interruption, turn end).
   */
  | { kind: 'staging'; generation: number; elements: FormingElement[] }
  /**
   * One word Rime actually delivered, with its aligned timestamps (§3.3). The
   * word-level timing the direct WebSocket plugin gives us, forwarded to the
   * browser so the label reveal can finish exactly as the word is said.
   */
  | { kind: 'word'; generation: number; text: string; startTime?: number | undefined; endTime?: number | undefined }
  /** §3.4: a text export (Mermaid) the user can copy — shown in a panel, never spoken. */
  | { kind: 'export'; format: 'mermaid'; content: string }
  /**
   * ADDRESSIVITY=true only (§2.4). The current set of ambient proposals. The
   * browser renders these dashed + extra-faint (fainter than a "forming" node)
   * with a "proposed by X" affordance. An empty list clears them.
   */
  | { kind: 'ghosts'; ghosts: GhostElement[] }
  | {
      kind: 'status';
      generation: number;
      ttsProvider: string;
      /** 'direct' = a single inference.LLM call; 'graph' = LangGraph planning/routing — see apps/agent/src/graph. */
      llmEngine: string;
      baselineMode: boolean;
      speaking: boolean;
      toolRunning: boolean;
      heardText: string;
      /** Every word actually delivered as audio so far, incl. an in-flight sentence. */
      spokenText: string;
      /** Generated text beyond spokenText — not yet heard. Empty, never wrong, if the two can't be reconciled. */
      pendingText: string;
      /** §2: ambient meeting mode state, when ADDRESSIVITY is on. */
      addressivity?:
        | { enabled: true; threshold: number; ghostCount: number }
        | { enabled: false }
        | undefined;
    };

export const CARTOGRAPH_TOPIC = 'cartograph';
