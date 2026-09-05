import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { describe, expect, it } from 'vitest';
import { cartographGraph } from './index.ts';

// Stubbed models only — no network. A live check against the real gateway
// (both a canvas instruction and a plain question) was run by hand via
// probe-structured.ts during Task 1.2; this suite verifies the graph's own
// wiring (which branch each route takes) deterministically instead.
function fakeModel(routeAnswer: string, planOrReply: unknown): BaseChatModel {
  let calls = 0;
  return {
    invoke: async () => {
      calls += 1;
      return { content: calls === 1 ? routeAnswer : String(planOrReply) };
    },
    withStructuredOutput: () => ({
      invoke: async () => planOrReply,
    }),
  } as unknown as BaseChatModel;
}

describe('cartographGraph', () => {
  it('routes a canvas instruction to the planner and returns its plan', async () => {
    const plan = {
      mutations: [
        { tool: 'addService', args: { label: 'Redis Cache', kind: 'datastore' }, anchorPhrase: 'Redis Cache', sentence: "I'm adding a Redis Cache." },
      ],
    };
    const model = fakeModel('canvas', plan);

    const result = await cartographGraph.invoke(
      { userInput: 'Add a Redis cache.', history: [], canvasSummary: '(empty)' },
      { configurable: { model, structuredMethod: 'functionCalling' } }
    );

    expect(result.route).toBe('canvas');
    expect(result.plan?.mutations).toHaveLength(1);
  });

  it('routes a question to the chat node and returns its reply, with no plan', async () => {
    const model = fakeModel('chat', 'This diagram has three services.');

    const result = await cartographGraph.invoke(
      { userInput: 'What does this diagram show?', history: [], canvasSummary: '(empty)' },
      { configurable: { model, structuredMethod: 'functionCalling' } }
    );

    expect(result.route).toBe('chat');
    expect(result.reply).toBe('This diagram has three services.');
    expect(result.plan).toBeNull();
  });
});
