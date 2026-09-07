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

export interface CanvasSnapshot {
  /** Monotonic; the browser drops any snapshot whose version is not greater than the last it rendered. */
  version: number;
  generation: number;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export type MutationOp =
  | { op: 'addNode'; node: CanvasNode }
  | { op: 'removeNode'; nodeId: string }
  | { op: 'renameNode'; nodeId: string; label: string }
  | { op: 'replaceNode'; nodeId: string; label: string; kind: NodeKind }
  | { op: 'addEdge'; edge: CanvasEdge }
  | { op: 'removeEdge'; edgeId: string }
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
  | 'graph_plan_invalid';

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
    };

export const CARTOGRAPH_TOPIC = 'cartograph';
