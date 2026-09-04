import { tool } from '@livekit/agents';
import type { NodeKind } from '@repo/protocol';
import { z } from 'zod';
import type { CanvasStore } from '../core/canvas.ts';
import type { GenerationManager } from '../core/generation.ts';
import type { EventLedger } from '../core/ledger.ts';
import type { StagingBuffer } from '../core/staging.ts';
import { slowWork } from './slow.ts';

export interface CanvasToolsDeps {
  gm: GenerationManager;
  staging: StagingBuffer;
  ledger: EventLedger;
  canvas: CanvasStore;
  slowMs: number;
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
 * edits, and even those never touch the canvas directly; see StagingBuffer).
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

  const addService = tool({
    name: 'addService',
    description:
      'Add a new service, datastore, queue, gateway, or external system to the architecture diagram.',
    parameters: z.object({
      label: z.string().describe('The name of the component, e.g. "Redis Cache" or "API Gateway".'),
      kind: nodeKindSchema.describe('The category of component.'),
    }),
    execute: async ({ label, kind }, opts) => {
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
      const staged = deps.staging.stage(gen, nextSentenceIndex(gen), label, {
        op: 'addNode',
        node: { id: slug(label), label, kind: kind as NodeKind, x, y },
      });
      deps.ledger.push('mutation_staged', gen, staged.id);
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
      label: z.string().optional().describe('Optional label for the connection, e.g. "reads/writes".'),
    }),
    execute: async ({ sourceLabel, targetLabel, label }, opts) => {
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
      const sourceId = slug(sourceLabel);
      const targetId = slug(targetLabel);
      const staged = deps.staging.stage(gen, nextSentenceIndex(gen), targetLabel, {
        op: 'addEdge',
        edge: { id: `${sourceId}-${targetId}`, source: sourceId, target: targetId, label },
      });
      deps.ledger.push('mutation_staged', gen, staged.id);
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
    }),
    execute: async ({ targetLabel, newLabel, kind }, opts) => {
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
      const staged = deps.staging.stage(gen, nextSentenceIndex(gen), newLabel, {
        op: 'replaceNode',
        nodeId: slug(targetLabel),
        label: newLabel,
        kind: kind as NodeKind,
      });
      deps.ledger.push('mutation_staged', gen, staged.id);
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
    }),
    execute: async ({ targetLabel, newLabel }) => {
      const gen = deps.gm.currentId;
      if (!deps.gm.isCurrent(gen)) {
        deps.ledger.push('tool_stale_discarded', gen, `renameComponent(${targetLabel})`);
        return 'STALE_DISCARDED: this instruction was superseded. Do not mention this result.';
      }
      const staged = deps.staging.stage(gen, nextSentenceIndex(gen), newLabel, {
        op: 'renameNode',
        nodeId: slug(targetLabel),
        label: newLabel,
      });
      deps.ledger.push('mutation_staged', gen, staged.id);
      return `Staged: rename to ${newLabel} once you have said so.`;
    },
  });

  const removeComponent = tool({
    name: 'removeComponent',
    description: 'Remove a component and every connection touching it.',
    parameters: z.object({
      targetLabel: z.string().describe('The component to remove.'),
    }),
    execute: async ({ targetLabel }) => {
      const gen = deps.gm.currentId;
      if (!deps.gm.isCurrent(gen)) {
        deps.ledger.push('tool_stale_discarded', gen, `removeComponent(${targetLabel})`);
        return 'STALE_DISCARDED: this instruction was superseded. Do not mention this result.';
      }
      const staged = deps.staging.stage(gen, nextSentenceIndex(gen), targetLabel, {
        op: 'removeNode',
        nodeId: slug(targetLabel),
      });
      deps.ledger.push('mutation_staged', gen, staged.id);
      return `Staged: removal of ${targetLabel} once you have said so.`;
    },
  });

  const describeArchitecture = tool({
    name: 'describeArchitecture',
    description:
      'Read-only summary of the current architecture diagram (only committed, already-spoken components). Stages nothing.',
    execute: async () => {
      return deps.canvas.nodeCount === 0
        ? 'The diagram is currently empty.'
        : `The diagram currently has ${deps.canvas.nodeCount} component(s).`;
    },
  });

  return [
    addService,
    connectServices,
    replaceComponent,
    renameComponent,
    removeComponent,
    describeArchitecture,
  ];
}
