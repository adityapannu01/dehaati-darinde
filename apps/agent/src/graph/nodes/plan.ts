import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { type CanvasStateT, getModel, MutationPlan, type MutationPlanT } from '../state.ts';

const PLAN_PROMPT = `You are the planning stage of Cartograph, a voice-controlled architecture-diagram assistant. Convert the user's instruction into an ordered list of diagram mutations.

Available tools and their exact argument names:
- addService: { label: string, kind: "service"|"datastore"|"queue"|"gateway"|"external" }
- connectServices: { sourceLabel: string, targetLabel: string, label?: string }
- replaceComponent: { targetLabel: string, newLabel: string, kind: "service"|"datastore"|"queue"|"gateway"|"external" }
- renameComponent: { targetLabel: string, newLabel: string }
- removeComponent: { targetLabel: string }

Rules:
- One mutation per distinct change the user asked for, in the order they mentioned them.
- "args" must use exactly the argument names listed above for that tool, as strings.
- "anchorPhrase" is the component name the mutation is about.
- "sentence" is exactly one short sentence narrating exactly this mutation, naming the
  component, and nothing else. Never combine two mutations into one sentence.
- If the instruction does not describe a diagram change, return an empty mutations array.

Current diagram:
`;

const EMPTY_PLAN: MutationPlanT = { mutations: [] };
const RETRY_REPLY = 'Sorry, could you say that again?';

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
