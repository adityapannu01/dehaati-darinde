import { Annotation } from '@langchain/langgraph';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import type { StructuredMethod } from './config.ts';

// §3: the sentence<->mutation mapping the commit gate depends on, enforced by
// a validated schema instead of a prompt request. Each mutation carries the
// exact sentence narrating it, so llmNode can emit them in lockstep —
// sentence, tool call, sentence, tool call — deterministically, in code.
export const MutationPlan = z.object({
  mutations: z.array(
    z.object({
      tool: z.enum([
        'addService',
        'connectServices',
        'replaceComponent',
        'renameComponent',
        'removeComponent',
        'groupComponents',
        'arrangeLayout',
        'undoLast',
        'clearCanvas',
      ]),
      args: z.record(z.string(), z.string()),
      /** The component name — feeds the existing anchor-phrase mismatch guard in CommitGate. */
      anchorPhrase: z.string(),
      /** Exactly one sentence, narrating exactly this mutation, nothing else. */
      sentence: z.string(),
    })
  ),
});
export type MutationPlanT = z.infer<typeof MutationPlan>;

// Injected via RunnableConfig.configurable — never constructed inside a node,
// so nodes can be unit-tested with a stubbed model and no network (§2.7).
export interface GraphConfigurable {
  model: BaseChatModel;
  structuredMethod: StructuredMethod;
}

export function getModel(config: RunnableConfig): GraphConfigurable {
  const c = config.configurable as Partial<GraphConfigurable> | undefined;
  if (!c?.model) throw new Error('graph: no model in config.configurable');
  return { model: c.model, structuredMethod: c.structuredMethod ?? 'jsonSchema' };
}

export const CanvasState = Annotation.Root({
  userInput: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  history: Annotation<BaseMessage[]>({ reducer: (_, b) => b, default: () => [] }),
  /** Compact text rendering of the current CanvasStore (labels + edges, no ids/coords) so the planner can resolve "the cache" to a real node. */
  canvasSummary: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  route: Annotation<'canvas' | 'chat'>({ reducer: (_, b) => b, default: () => 'chat' }),
  plan: Annotation<MutationPlanT | null>({ reducer: (_, b) => b, default: () => null }),
  reply: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
});
export type CanvasStateT = typeof CanvasState.State;
