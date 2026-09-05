import { FakeListChatModel } from '@langchain/core/utils/testing';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import type { CanvasStateT } from '../state.ts';
import { chatNode } from './chat.ts';

describe('chatNode', () => {
  it('returns the model text as reply and never populates plan', async () => {
    const model = new FakeListChatModel({ responses: ['Sure, this diagram has three services.'] });
    const state: CanvasStateT = {
      userInput: 'What does this diagram show?',
      history: [new SystemMessage('You are Cartograph.'), new HumanMessage('What does this diagram show?')],
      canvasSummary: '',
      route: 'chat',
      plan: null,
      reply: '',
    };

    const result = await chatNode(state, { configurable: { model, structuredMethod: 'functionCalling' } });

    expect(result.reply).toBe('Sure, this diagram has three services.');
    expect(result.plan).toBeUndefined();
  });
});
