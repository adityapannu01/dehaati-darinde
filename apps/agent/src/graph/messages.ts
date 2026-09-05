import type { llm as llmTypes } from '@livekit/agents';
import { AIMessage, type BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';

function safeParseArgs(args: string): Record<string, unknown> {
  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Converts the FULL ChatContext (history + tool calls + tool results) to
 * LangChain messages — not just the last message, or the graph forgets the
 * previous turn and can't reason about what it just did. Mirrors LiveKit's
 * own Python adapter, which does the same full-context mapping.
 *
 * Pure function over ChatContext; the only @livekit/agents import is a type,
 * so this file needs no network and no LiveKit runtime to test.
 */
export function toLangChainMessages(
  chatCtx: llmTypes.ChatContext,
  persona: string
): BaseMessage[] {
  const out: BaseMessage[] = [new SystemMessage(persona)];
  for (const item of chatCtx.items) {
    switch (item.type) {
      case 'message': {
        const text = item.textContent ?? '';
        if (item.role === 'user') out.push(new HumanMessage(text));
        else if (item.role === 'assistant') out.push(new AIMessage(text));
        else out.push(new SystemMessage(text));
        break;
      }
      case 'function_call':
        out.push(
          new AIMessage({
            content: '',
            tool_calls: [{ id: item.callId, name: item.name, args: safeParseArgs(item.args) }],
          })
        );
        break;
      case 'function_call_output':
        out.push(new ToolMessage({ tool_call_id: item.callId, content: item.output }));
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * LiveKit re-invokes llmNode after it executes the tool calls emitted on the
 * previous step (maxToolSteps defaults to 3) — true exactly when the most
 * recent item is a tool result. A naive adapter re-plans from scratch here
 * and re-emits the same mutations up to four times per turn.
 */
export function isPostToolStep(chatCtx: llmTypes.ChatContext): boolean {
  return chatCtx.items.at(-1)?.type === 'function_call_output';
}

/** The most recent user utterance — the `userInput` the router/planner classify and plan against. */
export function lastUserText(chatCtx: llmTypes.ChatContext): string {
  for (let i = chatCtx.items.length - 1; i >= 0; i--) {
    const item = chatCtx.items[i];
    if (item?.type === 'message' && item.role === 'user') return item.textContent ?? '';
  }
  return '';
}
