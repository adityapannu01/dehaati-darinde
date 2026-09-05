import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { describe, expect, it } from 'vitest';
import type { CanvasStateT } from '../state.ts';
import { planNode, planProgressive } from './plan.ts';

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

/** Narrow stub matching only `model.pipe(parser).stream(...)`, yielding progressively-growing partials. */
function fakeStreamingModel(partials: unknown[]): BaseChatModel {
  return {
    pipe: () => ({
      stream: async () =>
        (async function* () {
          for (const p of partials) yield p;
        })(),
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

describe('planProgressive', () => {
  it('emits each mutation as soon as the next one starts streaming, then the last at stream end', async () => {
    const partials = [
      { mutations: [{ tool: 'addService', args: { label: 'Redis' } }] }, // 1st still streaming
      {
        mutations: [
          { tool: 'addService', args: { label: 'Redis Cache' }, anchorPhrase: 'Redis Cache', sentence: "I'm adding a Redis Cache." },
          { tool: 'connectServices', args: {} }, // 2nd now starts, so the 1st is confirmed complete
        ],
      },
      {
        mutations: [
          { tool: 'addService', args: { label: 'Redis Cache' }, anchorPhrase: 'Redis Cache', sentence: "I'm adding a Redis Cache." },
          {
            tool: 'connectServices',
            args: { sourceLabel: 'Redis Cache', targetLabel: 'API Gateway' },
            anchorPhrase: 'API Gateway',
            sentence: "I'm connecting the Redis Cache to the API Gateway.",
          },
        ],
      },
    ];
    const model = fakeStreamingModel(partials);
    const emitted: Array<{ index: number; sentence: string }> = [];

    const result = await planProgressive(
      stateWith('Add a Redis cache and connect it to the API gateway.'),
      { configurable: { model, structuredMethod: 'functionCalling' } },
      (m, index) => emitted.push({ index, sentence: m.sentence })
    );

    // The 1st mutation must be emitted while the 2nd is still generating —
    // i.e. before the stream reaches its final, fully-complete partial.
    expect(emitted[0]).toEqual({ index: 0, sentence: "I'm adding a Redis Cache." });
    expect(emitted[1]).toEqual({ index: 1, sentence: "I'm connecting the Redis Cache to the API Gateway." });
    expect(emitted).toHaveLength(2);
    expect(result.valid).toBe(true);
    expect(result.plan.mutations).toHaveLength(2);
  });

  it('never emits the same mutation twice', async () => {
    const partials = [
      { mutations: [{ tool: 'removeComponent', args: { targetLabel: 'Queue' }, anchorPhrase: 'Queue', sentence: 'Removing the Queue.' }] },
      { mutations: [{ tool: 'removeComponent', args: { targetLabel: 'Queue' }, anchorPhrase: 'Queue', sentence: 'Removing the Queue.' }] },
    ];
    const model = fakeStreamingModel(partials);
    const emitted: number[] = [];

    await planProgressive(stateWith('Remove the queue.'), { configurable: { model, structuredMethod: 'functionCalling' } }, (_m, index) =>
      emitted.push(index)
    );

    expect(emitted).toEqual([0]);
  });

  it('returns an invalid, empty result when the final object fails schema validation', async () => {
    const partials = [{ mutations: [{ tool: 'not-a-real-tool', args: {} }] }];
    const model = fakeStreamingModel(partials);

    const result = await planProgressive(stateWith('Do something confusing.'), { configurable: { model, structuredMethod: 'functionCalling' } }, () => {
      throw new Error('should not emit an invalid mutation');
    });

    expect(result.valid).toBe(false);
    expect(result.plan.mutations).toEqual([]);
  });
});
