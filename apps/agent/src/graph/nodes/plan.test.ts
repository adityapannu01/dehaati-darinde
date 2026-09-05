import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { describe, expect, it } from 'vitest';
import type { CanvasStateT } from '../state.ts';
import { planNode } from './plan.ts';

function stateWith(userInput: string): CanvasStateT {
  return { userInput, history: [], canvasSummary: '(empty)', route: 'canvas', plan: null, reply: '' };
}

/** Narrow stub matching only the surface planNode actually calls. */
function fakeStructuredModel(responses: Array<unknown | Error>): BaseChatModel {
  const queue = [...responses];
  return {
    withStructuredOutput: () => ({
      invoke: async () => {
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    }),
  } as unknown as BaseChatModel;
}

describe('planNode', () => {
  it('returns an ordered, schema-valid plan for a two-mutation instruction', async () => {
    const twoMutationPlan = {
      mutations: [
        {
          tool: 'addService',
          args: { label: 'Redis Cache', kind: 'datastore' },
          anchorPhrase: 'Redis Cache',
          sentence: "I'm adding a Redis Cache.",
        },
        {
          tool: 'connectServices',
          args: { sourceLabel: 'Redis Cache', targetLabel: 'API Gateway' },
          anchorPhrase: 'API Gateway',
          sentence: "I'm connecting the Redis Cache to the API Gateway.",
        },
      ],
    };
    const model = fakeStructuredModel([twoMutationPlan]);

    const result = await planNode(
      stateWith('Add a Redis cache and connect it to the API gateway.'),
      { configurable: { model, structuredMethod: 'functionCalling' } }
    );

    expect(result.plan?.mutations).toHaveLength(2);
    expect(result.plan?.mutations[0]?.sentence).toContain('Redis Cache');
    expect(result.plan?.mutations[1]?.sentence).toContain('API Gateway');
    expect(result.reply).toBeUndefined();
  });

  it('retries once on a malformed first response, then returns the retry plan', async () => {
    const validPlan = {
      mutations: [
        { tool: 'removeComponent', args: { targetLabel: 'Queue' }, anchorPhrase: 'Queue', sentence: "I'm removing the Queue." },
      ],
    };
    const model = fakeStructuredModel([new Error('bad json'), validPlan]);

    const result = await planNode(stateWith('Remove the queue.'), {
      configurable: { model, structuredMethod: 'functionCalling' },
    });

    expect(result.plan?.mutations).toHaveLength(1);
    expect(result.reply).toBeUndefined();
  });

  it('falls back to an empty plan and a spoken retry prompt when both attempts fail', async () => {
    const model = fakeStructuredModel([new Error('bad json'), new Error('still bad')]);

    const result = await planNode(stateWith('Do something confusing.'), {
      configurable: { model, structuredMethod: 'functionCalling' },
    });

    expect(result.plan?.mutations).toEqual([]);
    expect(result.reply).toBe('Sorry, could you say that again?');
  });
});
