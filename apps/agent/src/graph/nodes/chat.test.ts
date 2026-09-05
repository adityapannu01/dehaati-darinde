import { FakeListChatModel } from '@langchain/core/utils/testing';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import type { CanvasStateT } from '../state.ts';
import { chatNode, chatStream } from './chat.ts';

function stateWith(userInput: string): CanvasStateT {
  return {
    userInput,
    history: [new SystemMessage('You are Cartograph.'), new HumanMessage(userInput)],
    canvasSummary: '',
    route: 'chat',
    plan: null,
    reply: '',
  };
}

describe('chatNode', () => {
  it('returns the model text as reply and never populates plan', async () => {
    const model = new FakeListChatModel({ responses: ['Sure, this diagram has three services.'] });

    const result = await chatNode(stateWith('What does this diagram show?'), {
      configurable: { model, structuredMethod: 'functionCalling' },
    });

    expect(result.reply).toBe('Sure, this diagram has three services.');
    expect(result.plan).toBeUndefined();
  });
});

describe('chatStream', () => {
  it('yields the reply as one or more chunks whose concatenation is the full text', async () => {
    const model = new FakeListChatModel({ responses: ['Sure, this diagram has three services.'] });

    const chunks: string[] = [];
    for await (const chunk of chatStream(stateWith('What does this diagram show?'), {
      configurable: { model, structuredMethod: 'functionCalling' },
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join('')).toBe('Sure, this diagram has three services.');
    expect(chunks.length).toBeGreaterThan(0);
  });
});
