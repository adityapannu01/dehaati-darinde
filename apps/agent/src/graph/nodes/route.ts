import type { RunnableConfig } from '@langchain/core/runnables';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { type CanvasStateT, getModel } from '../state.ts';

const ROUTE_PROMPT = `Classify the user's message as exactly one word: "canvas" or "chat".

"canvas" — the user wants to add, remove, rename, replace, or connect a
component on the architecture diagram, wipe the whole board, or restructure /
reorient / flip the layout (e.g. "add a Redis cache", "connect that to the
gateway", "swap Redis for MongoDB", "remove the queue", "clear the board",
"let's start over", "make it top to bottom", "flip it horizontal").

"chat" — anything else: greetings, questions about the diagram, small talk,
requests unrelated to editing the diagram.

Respond with exactly one word: canvas or chat. Nothing else.`;

/**
 * One cheap classification on the critical path of every single turn, so it
 * has to be tiny: does this turn change the diagram, or not? Keeps chitchat
 * off the expensive structured-planning path.
 */
export async function routeNode(
  state: CanvasStateT,
  config: RunnableConfig
): Promise<Partial<CanvasStateT>> {
  const { model } = getModel(config);
  const result = await model.invoke(
    [new SystemMessage(ROUTE_PROMPT), new HumanMessage(state.userInput)],
    config.signal ? { signal: config.signal } : {}
  );
  const text = String(result.content).trim().toLowerCase();
  return { route: text.includes('canvas') ? 'canvas' : 'chat' };
}
