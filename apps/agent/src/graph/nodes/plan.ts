import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { type CanvasStateT, getModel, MutationPlan, type MutationPlanT } from '../state.ts';

const PLAN_PROMPT = `You are the planning stage of Cartograph, a voice-controlled architecture-diagram assistant. Convert the user's instruction into an ordered list of diagram mutations.

Available tools and their exact argument names:
- addService: { label: string, kind: "service"|"datastore"|"queue"|"gateway"|"external" }
- connectServices: { sourceLabel: string, targetLabel: string, label?: string, flow?: "sync"|"async" }
  ("async" for a queue / event / pub-sub link, drawn dashed; omit for a normal call)
- replaceComponent: { targetLabel: string, newLabel: string, kind: "service"|"datastore"|"queue"|"gateway"|"external" }
- renameComponent: { targetLabel: string, newLabel: string }
- removeComponent: { targetLabel: string }
- groupComponents: { label: string, memberLabels: string } — a boundary (VPC, trust boundary, domain) around 2+ existing components; memberLabels is a comma-separated list like "orders service, payments service"
- arrangeLayout: { direction: "RIGHT"|"DOWN"|"LEFT"|"UP", scope?: string } — change the diagram's flow direction ("make it top to bottom" -> DOWN). scope is a boundary name to reorient only that group. Moves things only; never adds/removes.
- undoLast: {} — reverse the single most recent committed change ("undo that", "take that back")
- clearCanvas: {} — wipes the whole diagram in one step ("clear the board", "start over", "wipe it")

Rules:
- One mutation per distinct change the user asked for, in the order they mentioned them.
- "args" must use exactly the argument names listed above for that tool, as strings.
  clearCanvas takes no args — use {}.
- A wipe is ONE mutation (clearCanvas), never one removeComponent per node. Its
  "anchorPhrase" is "clear" and its "sentence" is like "Clearing the board.".
- "anchorPhrase" is the component name the mutation is about.
- "sentence" is exactly one short sentence narrating exactly this mutation, naming the
  component, and nothing else. Never combine two mutations into one sentence.
- If the instruction does not describe a diagram change, return an empty mutations array.

Current diagram:
`;

const PROGRESSIVE_JSON_HINT = `

Respond with ONLY JSON matching this shape, no prose, no markdown fences:
{"mutations":[{"tool":"addService"|"connectServices"|"replaceComponent"|"renameComponent"|"removeComponent"|"groupComponents"|"arrangeLayout"|"undoLast"|"clearCanvas","args":{},"anchorPhrase":"","sentence":""}]}`;

export const EMPTY_PLAN: MutationPlanT = { mutations: [] };
export const RETRY_REPLY = 'Sorry, could you say that again?';

type Mutation = MutationPlanT['mutations'][number];

async function attemptPlan(
  model: ReturnType<typeof getModel>['model'],
  structuredMethod: ReturnType<typeof getModel>['structuredMethod'],
  messages: (SystemMessage | HumanMessage)[],
  signal: AbortSignal | undefined
): Promise<MutationPlanT> {
  const structured = model.withStructuredOutput<MutationPlanT>(MutationPlan, { method: structuredMethod });
  return structured.invoke(messages, signal ? { signal } : {});
}

/**
 * §3: the sentence<->mutation mapping the commit gate depends on, enforced by
 * a validated schema instead of a prompt request. Retries once on a malformed
 * response, then falls back to an empty plan rather than crashing the turn.
 */
export async function planNode(
  state: CanvasStateT,
  config: RunnableConfig
): Promise<Partial<CanvasStateT>> {
  const { model, structuredMethod } = getModel(config);
  const system = new SystemMessage(PLAN_PROMPT + (state.canvasSummary || '(empty)'));
  const messages = [system, new HumanMessage(state.userInput)];

  try {
    return { plan: await attemptPlan(model, structuredMethod, messages, config.signal) };
  } catch (firstError) {
    try {
      const retryMessages = [
        ...messages,
        new HumanMessage(
          `Your previous response did not match the required schema: ${(firstError as Error).message}. Respond again, strictly matching the schema.`
        ),
      ];
      return { plan: await attemptPlan(model, structuredMethod, retryMessages, config.signal) };
    } catch {
      return { plan: EMPTY_PLAN, reply: RETRY_REPLY };
    }
  }
}

/**
 * §4.1: the fix for TTFA on a canvas turn. `withStructuredOutput` (planNode,
 * above) cannot stream — nothing is speakable until the whole plan is valid.
 * This path instead asks for plain JSON and parses it progressively, so a
 * mutation's `sentence` can be spoken the instant *that* mutation is
 * complete, while later ones are still generating.
 *
 * Partials carry no schema guarantee — `onMutation` fires on data that has
 * not yet been zod-validated. The completed object *is* validated at the end
 * (`MutationPlan.safeParse`); if it fails after mutations have already been
 * spoken, there is nothing to un-say, so this returns an empty plan and lets
 * the caller log the failure rather than throwing.
 */
export async function planProgressive(
  state: CanvasStateT,
  config: RunnableConfig,
  onMutation: (mutation: Mutation, index: number) => void
): Promise<{ plan: MutationPlanT; valid: boolean }> {
  const { model } = getModel(config);
  const { JsonOutputParser } = await import('@langchain/core/output_parsers');
  const system = new SystemMessage(PLAN_PROMPT + (state.canvasSummary || '(empty)') + PROGRESSIVE_JSON_HINT);
  const messages = [system, new HumanMessage(state.userInput)];
  const chain = model.pipe(new JsonOutputParser<Partial<MutationPlanT>>());

  let emitted = 0;
  let last: Partial<MutationPlanT> | undefined;
  const emitThrough = (mutations: Partial<Mutation>[]) => {
    for (; emitted < mutations.length; emitted++) {
      const m = mutations[emitted];
      if (m) onMutation(m as Mutation, emitted);
    }
  };

  try {
    for await (const partial of await chain.stream(messages, config.signal ? { signal: config.signal } : {})) {
      last = partial;
      const mutations = partial.mutations ?? [];
      emitThrough(mutations.slice(0, -1)); // the last entry may still be streaming
    }
  } catch {
    return { plan: EMPTY_PLAN, valid: false };
  }

  const result = MutationPlan.safeParse(last);
  if (!result.success) return { plan: EMPTY_PLAN, valid: false };
  emitThrough(result.data.mutations); // catches the final mutation, now confirmed complete
  return { plan: result.data, valid: true };
}
