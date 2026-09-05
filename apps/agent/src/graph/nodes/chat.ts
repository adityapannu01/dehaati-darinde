import type { RunnableConfig } from '@langchain/core/runnables';
import { type CanvasStateT, getModel } from '../state.ts';

/**
 * The fast path: a plain completion, no structured output, no tools. Keeps
 * TTFA respectable on the common turn — chitchat and questions never touch
 * the (slower) structured planner.
 *
 * `state.history` already ends with the current user turn (it's the full
 * ChatContext converted by toLangChainMessages, persona included) — the
 * model sees it, nothing gets appended twice.
 */
export async function chatNode(
  state: CanvasStateT,
  config: RunnableConfig
): Promise<Partial<CanvasStateT>> {
  const { model } = getModel(config);
  const result = await model.invoke(state.history, config.signal ? { signal: config.signal } : {});
  return { reply: typeof result.content === 'string' ? result.content : String(result.content) };
}

/**
 * §4.2: token-by-token variant of the same fast path, for when the caller
 * can forward chunks straight to TTS instead of waiting for the full reply.
 */
export async function* chatStream(state: CanvasStateT, config: RunnableConfig): AsyncGenerator<string> {
  const { model } = getModel(config);
  const stream = await model.stream(state.history, config.signal ? { signal: config.signal } : {});
  for await (const chunk of stream) {
    if (typeof chunk.content === 'string' && chunk.content) yield chunk.content;
  }
}
