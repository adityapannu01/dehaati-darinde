import { tool } from '@livekit/agents';
import type { NodeKind, ServerMessage } from '@repo/protocol';
import { z } from 'zod';
import type { CanvasStore } from '../core/canvas.ts';
import type { CommitGate } from '../core/commit-gate.ts';
import type { GenerationManager } from '../core/generation.ts';
import type { EventLedger } from '../core/ledger.ts';
import { enrichComponent } from './enrich.ts';
import { slowWork } from './slow.ts';

export interface CanvasToolsDeps {
  gm: GenerationManager;
  commitGate: CommitGate;
  ledger: EventLedger;
  canvas: CanvasStore;
  slowMs: number;
  /** Push a message straight to the browser (e.g. a Mermaid export panel). Optional — absent in the benchmark. */
  publish?: (msg: ServerMessage) => void;
}

function slug(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

const nodeKindSchema = z.enum(['service', 'datastore', 'queue', 'gateway', 'external']);

/**
 * Builds the read-only/reversible tools the agent can call to edit the
 * canvas (brainstorm §26: no purchases, deletes, or emails — only diagram
 * edits, and even those never touch the canvas directly; CommitGate.stage() is what the tools call).
 *
 * Every mutating tool follows the same fencing contract:
 *   1. snapshot the generation the call belongs to
 *   2. (addService / connectServices / replaceComponent only) wait out the
 *      artificial delay, abortable via opts.abortSignal
 *   3. re-check gm.isCurrent(gen) — the fence that survives a cancellation
 *      that failed to actually stop the await
 *   4. only then stage the mutation; it still won't reach the canvas until
 *      CommitGate confirms the sentence describing it was delivered
 */
export function createCanvasTools(deps: CanvasToolsDeps) {
  const sentenceCounters = new Map<number, number>();
  const nextSentenceIndex = (generation: number): number => {
    const n = sentenceCounters.get(generation) ?? 0;
    sentenceCounters.set(generation, n + 1);
    return n;
  };

  // The graph planner (LLM_ENGINE=graph) knows the true sentence<->mutation
  // pairing and passes it in; tools then execute concurrently without the
  // per-generation counter mis-assigning indices in tool-completion order
  // rather than spoken order. On the direct path this is always absent and
  // the counter (the only ordering signal there — the model's own call
  // order) takes over.
  const sentenceIndexParam = z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Internal ordering index supplied by the planner. Do not invent a value; leave it unset.');
  const resolveSentenceIndex = (generation: number, supplied: number | undefined): number =>
    supplied ?? nextSentenceIndex(generation);

  const addService = tool({
    name: 'addService',
    description:
      'Add a new service, datastore, queue, gateway, or external system to the architecture diagram.',
    parameters: z.object({
      label: z.string().describe('The name of the component, e.g. "Redis Cache" or "API Gateway".'),
      kind: nodeKindSchema.describe('The category of component.'),
      sentenceIndex: sentenceIndexParam,
    }),
    execute: async ({ label, kind, sentenceIndex }, opts) => {
      const gen = deps.gm.currentId;
      deps.ledger.push('tool_started', gen, `addService(${label})`);
      try {
        await slowWork(deps.slowMs, opts.abortSignal);
      } catch {
        deps.ledger.push('tool_aborted', gen, `addService(${label})`);
        return 'ABORTED';
      }
      if (!deps.gm.isCurrent(gen)) {
        deps.ledger.push('tool_stale_discarded', gen, `addService(${label})`);
        return 'STALE_DISCARDED: this instruction was superseded. Do not mention this result.';
      }
      const { x, y } = deps.canvas.nextLayout();
      deps.commitGate.stage(gen, resolveSentenceIndex(gen, sentenceIndex), label, {
        op: 'addNode',
        node: { id: slug(label), label, kind: kind as NodeKind, x, y },
      });
      deps.ledger.push('tool_completed', gen, `addService(${label})`);
      return `Staged: ${label} will appear once you have said so.`;
    },
  });

  const connectServices = tool({
    name: 'connectServices',
    description: 'Draw a connection between two existing components on the diagram.',
    parameters: z.object({
      sourceLabel: z.string().describe('The component the connection starts from.'),
      targetLabel: z.string().describe('The component the connection points to.'),
      label: z.string().optional().describe('Optional label for the connection, e.g. "reads/writes", "gRPC", "publishes".'),
      flow: z
        .enum(['sync', 'async'])
        .optional()
        .describe('"async" for a queue/event/pub-sub connection (drawn dashed); "sync" (default) for a request/response call.'),
      bidirectional: z
        .boolean()
        .optional()
        .describe('true if data flows both ways (drawn with arrowheads at both ends).'),
      sentenceIndex: sentenceIndexParam,
    }),
    execute: async ({ sourceLabel, targetLabel, label, flow, bidirectional, sentenceIndex }, opts) => {
      const gen = deps.gm.currentId;
      const anchor = `${sourceLabel} -> ${targetLabel}`;
      deps.ledger.push('tool_started', gen, `connectServices(${anchor})`);
      try {
        await slowWork(deps.slowMs, opts.abortSignal);
      } catch {
        deps.ledger.push('tool_aborted', gen, `connectServices(${anchor})`);
        return 'ABORTED';
      }
      if (!deps.gm.isCurrent(gen)) {
        deps.ledger.push('tool_stale_discarded', gen, `connectServices(${anchor})`);
        return 'STALE_DISCARDED: this instruction was superseded. Do not mention this result.';
      }
      // Resolve against the actual canvas, not a blind slug of whatever the
      // LLM said — see CanvasStore.resolveId for why ("gateway" needs to find
      // the node labelled "API Gateway").
      const sourceId = deps.canvas.resolveId(sourceLabel);
      const targetId = deps.canvas.resolveId(targetLabel);
      deps.commitGate.stage(gen, resolveSentenceIndex(gen, sentenceIndex), targetLabel, {
        op: 'addEdge',
        edge: {
          id: `${sourceId}-${targetId}`,
          source: sourceId,
          target: targetId,
          label,
          ...(flow ? { flow: flow as 'sync' | 'async' } : {}),
          ...(bidirectional ? { bidirectional: true } : {}),
        },
      });
      deps.ledger.push('tool_completed', gen, `connectServices(${anchor})`);
      return `Staged: connection ${anchor} will appear once you have said so.`;
    },
  });

  const replaceComponent = tool({
    name: 'replaceComponent',
    description:
      'Replace an existing component with a different one, preserving its connections (e.g. swap Redis for MongoDB).',
    parameters: z.object({
      targetLabel: z.string().describe('The existing component to replace.'),
      newLabel: z.string().describe('The new name for the component.'),
      kind: nodeKindSchema.describe('The category of the replacement component.'),
      sentenceIndex: sentenceIndexParam,
    }),
    execute: async ({ targetLabel, newLabel, kind, sentenceIndex }, opts) => {
      const gen = deps.gm.currentId;
      const anchor = `${targetLabel} -> ${newLabel}`;
      deps.ledger.push('tool_started', gen, `replaceComponent(${anchor})`);
      try {
        await slowWork(deps.slowMs, opts.abortSignal);
      } catch {
        deps.ledger.push('tool_aborted', gen, `replaceComponent(${anchor})`);
        return 'ABORTED';
      }
      if (!deps.gm.isCurrent(gen)) {
        deps.ledger.push('tool_stale_discarded', gen, `replaceComponent(${anchor})`);
        return 'STALE_DISCARDED: this instruction was superseded. Do not mention this result.';
      }
      deps.commitGate.stage(gen, resolveSentenceIndex(gen, sentenceIndex), newLabel, {
        op: 'replaceNode',
        nodeId: deps.canvas.resolveId(targetLabel),
        label: newLabel,
        kind: kind as NodeKind,
      });
      deps.ledger.push('tool_completed', gen, `replaceComponent(${anchor})`);
      return `Staged: ${targetLabel} will become ${newLabel} once you have said so.`;
    },
  });

  // renameComponent / removeComponent get no artificial delay (only addService,
  // connectServices, replaceComponent do, per the plan), but keep the same
  // fencing check so a generation cancelled between LLM decision and tool
  // execution still can't stage anything.
  const renameComponent = tool({
    name: 'renameComponent',
    description: "Rename an existing component without changing its kind or connections.",
    parameters: z.object({
      targetLabel: z.string().describe('The existing component to rename.'),
      newLabel: z.string().describe('The new name.'),
      sentenceIndex: sentenceIndexParam,
    }),
    execute: async ({ targetLabel, newLabel, sentenceIndex }) => {
      const gen = deps.gm.currentId;
      if (!deps.gm.isCurrent(gen)) {
        deps.ledger.push('tool_stale_discarded', gen, `renameComponent(${targetLabel})`);
        return 'STALE_DISCARDED: this instruction was superseded. Do not mention this result.';
      }
      deps.commitGate.stage(gen, resolveSentenceIndex(gen, sentenceIndex), newLabel, {
        op: 'renameNode',
        nodeId: deps.canvas.resolveId(targetLabel),
        label: newLabel,
      });
      return `Staged: rename to ${newLabel} once you have said so.`;
    },
  });

  const removeComponent = tool({
    name: 'removeComponent',
    description: 'Remove a component and every connection touching it.',
    parameters: z.object({
      targetLabel: z.string().describe('The component to remove.'),
      sentenceIndex: sentenceIndexParam,
    }),
    execute: async ({ targetLabel, sentenceIndex }) => {
      const gen = deps.gm.currentId;
      if (!deps.gm.isCurrent(gen)) {
        deps.ledger.push('tool_stale_discarded', gen, `removeComponent(${targetLabel})`);
        return 'STALE_DISCARDED: this instruction was superseded. Do not mention this result.';
      }
      deps.commitGate.stage(gen, resolveSentenceIndex(gen, sentenceIndex), targetLabel, {
        op: 'removeNode',
        nodeId: deps.canvas.resolveId(targetLabel),
      });
      return `Staged: removal of ${targetLabel} once you have said so.`;
    },
  });

  const groupComponents = tool({
    name: 'groupComponents',
    description:
      'Draw a labelled boundary around two or more existing components — a VPC, a trust boundary, a bounded context, a subsystem. The box tracks its members automatically.',
    parameters: z.object({
      label: z.string().describe('The boundary name, e.g. "VPC", "Payments domain", "DMZ".'),
      // Array on the direct path; a "a, b and c" string on the graph path (its
      // args are all strings). Both are accepted.
      memberLabels: z
        .union([z.array(z.string()), z.string()])
        .describe('The existing components inside the boundary (2 or more).'),
      sentenceIndex: sentenceIndexParam,
    }),
    execute: async ({ label, memberLabels, sentenceIndex }) => {
      const gen = deps.gm.currentId;
      if (!deps.gm.isCurrent(gen)) {
        deps.ledger.push('tool_stale_discarded', gen, `groupComponents(${label})`);
        return 'STALE_DISCARDED: this instruction was superseded. Do not mention this result.';
      }
      const members = Array.isArray(memberLabels)
        ? memberLabels
        : memberLabels.split(/\s*,\s*|\s+and\s+/).filter(Boolean);
      deps.commitGate.stage(gen, resolveSentenceIndex(gen, sentenceIndex), label, {
        op: 'addGroup',
        id: slug(label),
        label,
        memberIds: members.map((m) => deps.canvas.resolveId(m)),
      });
      deps.ledger.push('tool_completed', gen, `groupComponents(${label})`);
      return `Staged: a "${label}" boundary around ${members.join(', ')} once you have said so.`;
    },
  });

  const arrangeLayout = tool({
    name: 'arrangeLayout',
    description:
      'Change the direction the diagram flows: left-to-right, top-to-bottom, right-to-left, or bottom-to-top. Use when the user asks to restructure, rearrange, flip, reorient, or change how the diagram is laid out. Optionally scope it to one boundary. Does not add, remove, or change any component.',
    parameters: z.object({
      direction: z
        .enum(['RIGHT', 'DOWN', 'LEFT', 'UP'])
        .describe(
          'RIGHT = left-to-right, DOWN = top-to-bottom, LEFT = right-to-left, UP = bottom-to-top.',
        ),
      scope: z
        .string()
        .optional()
        .describe('A boundary name to reorient only that group. Omit to reorient the whole diagram.'),
      sentenceIndex: sentenceIndexParam,
    }),
    execute: async ({ direction, scope, sentenceIndex }) => {
      const gen = deps.gm.currentId;
      if (!deps.gm.isCurrent(gen)) {
        deps.ledger.push('tool_stale_discarded', gen, 'arrangeLayout');
        return 'STALE_DISCARDED: this instruction was superseded. Do not mention this result.';
      }
      const anchor = scope ?? 'layout';
      deps.commitGate.stage(gen, resolveSentenceIndex(gen, sentenceIndex), anchor, {
        op: 'setDirection',
        direction: direction as 'RIGHT' | 'DOWN' | 'LEFT' | 'UP',
        ...(scope ? { scope } : {}),
      });
      deps.ledger.push('tool_completed', gen, `arrangeLayout(${direction}${scope ? ` @${scope}` : ''})`);
      return `Staged: the diagram will flow ${direction.toLowerCase()}${scope ? ` inside ${scope}` : ''} once you have said so.`;
    },
  });

  const undoLast = tool({
    name: 'undoLast',
    description:
      'Reverse the single most recent committed change to the diagram. Use for "undo that", "no wait, take that back", "revert". Interesting precisely because you can only ever undo what the user actually heard commit.',
    parameters: z.object({ sentenceIndex: sentenceIndexParam }),
    execute: async ({ sentenceIndex }) => {
      const gen = deps.gm.currentId;
      if (!deps.gm.isCurrent(gen)) {
        deps.ledger.push('tool_stale_discarded', gen, 'undoLast');
        return 'STALE_DISCARDED: this instruction was superseded. Do not mention this result.';
      }
      if (!deps.canvas.canUndo) return 'There is nothing to undo yet.';
      deps.commitGate.stage(gen, resolveSentenceIndex(gen, sentenceIndex), 'undo', { op: 'undo' });
      deps.ledger.push('tool_completed', gen, 'undoLast');
      return 'Staged: the last change will be reversed once you have said so.';
    },
  });

  const clearCanvas = tool({
    name: 'clearCanvas',
    description:
      'Wipe the entire diagram — every component and every connection — in one atomic step. Use for "clear the board", "wipe it", "start over", "let\'s begin again". Narrate it as a SINGLE sentence, e.g. "Clearing the board." — the whole wipe is one change, not one per node.',
    parameters: z.object({ sentenceIndex: sentenceIndexParam }),
    execute: async ({ sentenceIndex }) => {
      const gen = deps.gm.currentId;
      if (!deps.gm.isCurrent(gen)) {
        deps.ledger.push('tool_stale_discarded', gen, 'clearCanvas');
        return 'STALE_DISCARDED: this instruction was superseded. Do not mention this result.';
      }
      // One op, gated on one sentence: interrupt mid-"Clearing the board." and
      // the wipe never lands, exactly like any other staged mutation.
      deps.commitGate.stage(gen, resolveSentenceIndex(gen, sentenceIndex), 'clear', { op: 'clear' });
      deps.ledger.push('tool_completed', gen, 'clearCanvas');
      return 'Staged: the board will clear once you have said so.';
    },
  });

  const explainComponent = tool({
    name: 'explainComponent',
    description:
      'Get a one-line description of a well-known technology on the diagram, to answer "what is X" or "what does X do". Read-only — stages nothing.',
    parameters: z.object({
      label: z.string().describe('The component to explain, e.g. "Redis", "Envoy".'),
    }),
    // A REAL slow tool (§5.4): fixture-first, then a bounded live fetch. The
    // fence still protects it — an interruption aborts the fetch mid-flight.
    execute: async ({ label }, opts) => {
      const gen = deps.gm.currentId;
      deps.ledger.push('tool_started', gen, `explainComponent(${label})`);
      const { summary, source } = await enrichComponent(label, {
        abortSignal: opts.abortSignal,
        live: process.env.COMPONENT_LOOKUP !== 'fixture',
      });
      if (!deps.gm.isCurrent(gen)) {
        deps.ledger.push('tool_stale_discarded', gen, `explainComponent(${label})`);
        return 'STALE_DISCARDED: this instruction was superseded. Do not mention this result.';
      }
      deps.ledger.push('tool_completed', gen, `explainComponent(${label}) [${source}]`);
      return summary ? `${label}: ${summary}` : `I do not have a description for ${label}.`;
    },
  });

  const exportDiagram = tool({
    name: 'exportDiagram',
    description:
      'Produce a Mermaid text export of the current diagram and show it in a copyable panel on screen. Use for "export this", "give me the mermaid", "let me take this away". Do not read the export aloud — just say it is on screen.',
    execute: async () => {
      if (deps.canvas.nodeCount === 0) return 'The diagram is empty — nothing to export yet.';
      const content = deps.canvas.toMermaid();
      deps.publish?.({ kind: 'export', format: 'mermaid', content });
      return 'Done — the Mermaid export is in a panel on screen for you to copy.';
    },
  });

  const describeArchitecture = tool({
    name: 'describeArchitecture',
    description:
      'Read-only summary of the current architecture diagram — every committed (already-spoken) component and connection, by name. Call this before answering "what do we have so far?" or before a bulk edit, instead of guessing from memory. Stages nothing.',
    // B7: return the real structure (labels, kinds, edges), not a bare count.
    // CanvasStore.summary() already renders exactly the compact form a model
    // needs; the model paraphrases it into a spoken sentence.
    execute: async () =>
      deps.canvas.nodeCount === 0 ? 'The diagram is currently empty.' : deps.canvas.summary(),
  });

  return [
    addService,
    connectServices,
    replaceComponent,
    renameComponent,
    removeComponent,
    groupComponents,
    arrangeLayout,
    undoLast,
    clearCanvas,
    explainComponent,
    exportDiagram,
    describeArchitecture,
  ];
}
