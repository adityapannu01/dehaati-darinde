import { llm } from '@livekit/agents';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { isPostToolStep, lastUserText, toLangChainMessages } from './messages.ts';

function buildChatCtx(): llm.ChatContext {
  return new llm.ChatContext([
    new llm.ChatMessage({ role: 'user', content: 'Add a Redis cache.' }),
    new llm.ChatMessage({ role: 'assistant', content: "I'm adding a Redis cache." }),
    new llm.FunctionCall({ callId: 'call-1', name: 'addService', args: '{"label":"Redis"}' }),
    new llm.FunctionCallOutput({ callId: 'call-1', output: 'Staged: Redis.', isError: false }),
  ]);
}

describe('toLangChainMessages', () => {
  it('maps a user message, an assistant message, a function_call, and its output', () => {
    const messages = toLangChainMessages(buildChatCtx(), 'You are Cartograph.');

    expect(messages).toHaveLength(5); // persona + 4 items
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect(messages[0]?.content).toBe('You are Cartograph.');

    expect(messages[1]).toBeInstanceOf(HumanMessage);
    expect(messages[1]?.content).toBe('Add a Redis cache.');

    expect(messages[2]).toBeInstanceOf(AIMessage);
    expect(messages[2]?.content).toBe("I'm adding a Redis cache.");

    const toolCallMsg = messages[3] as AIMessage;
    expect(toolCallMsg).toBeInstanceOf(AIMessage);
    expect(toolCallMsg.tool_calls).toEqual([
      { id: 'call-1', name: 'addService', args: { label: 'Redis' } },
    ]);

    expect(messages[4]).toBeInstanceOf(ToolMessage);
    expect((messages[4] as ToolMessage).tool_call_id).toBe('call-1');
    expect(messages[4]?.content).toBe('Staged: Redis.');
  });

  it('tolerates malformed function_call args JSON without throwing', () => {
    const ctx = new llm.ChatContext([
      new llm.FunctionCall({ callId: 'call-2', name: 'addService', args: 'not json' }),
    ]);
    expect(() => toLangChainMessages(ctx, 'persona')).not.toThrow();
    const msg = toLangChainMessages(ctx, 'persona')[1] as AIMessage;
    expect(msg.tool_calls?.[0]?.args).toEqual({});
  });
});

describe('isPostToolStep', () => {
  it('is true when the last item is a function_call_output', () => {
    expect(isPostToolStep(buildChatCtx())).toBe(true);
  });

  it('is false for a fresh user turn', () => {
    const ctx = new llm.ChatContext([new llm.ChatMessage({ role: 'user', content: 'Hi' })]);
    expect(isPostToolStep(ctx)).toBe(false);
  });

  it('is false for an empty context', () => {
    expect(isPostToolStep(llm.ChatContext.empty())).toBe(false);
  });
});

describe('lastUserText', () => {
  it('returns the most recent user message, ignoring later assistant/tool items', () => {
    expect(lastUserText(buildChatCtx())).toBe('Add a Redis cache.');
  });

  it('returns the empty string when there is no user message', () => {
    expect(lastUserText(llm.ChatContext.empty())).toBe('');
  });
});
