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

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  label?: string | undefined;
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
  | { op: 'removeEdge'; edgeId: string };

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
  | 'mutation_dropped';

export interface LedgerEvent {
  seq: number;
  /** Date.now() */
  t: number;
  generation: number;
  type: LedgerEventType;
  detail?: string | undefined;
}

export type ServerMessage =
  | { kind: 'snapshot'; snapshot: CanvasSnapshot }
  | { kind: 'events'; events: LedgerEvent[] }
  | {
      kind: 'status';
      generation: number;
      ttsProvider: string;
      baselineMode: boolean;
      speaking: boolean;
      toolRunning: boolean;
      heardText: string;
    };

export const CARTOGRAPH_TOPIC = 'cartograph';
