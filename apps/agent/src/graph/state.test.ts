import { describe, expect, it } from 'vitest';
import { MutationPlan } from './state.ts';

describe('MutationPlan', () => {
  it('accepts a well-formed plan', () => {
    const result = MutationPlan.safeParse({
      mutations: [
        {
          tool: 'addService',
          args: { label: 'Redis', kind: 'datastore' },
          anchorPhrase: 'Redis',
          sentence: "I'm adding a Redis cache.",
        },
        {
          tool: 'connectServices',
          args: { sourceLabel: 'API Gateway', targetLabel: 'Redis' },
          anchorPhrase: 'Redis',
          sentence: 'Now connecting it to the API gateway.',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty mutation list (chitchat-adjacent canvas turns)', () => {
    expect(MutationPlan.safeParse({ mutations: [] }).success).toBe(true);
  });

  it('rejects an unknown tool name', () => {
    const result = MutationPlan.safeParse({
      mutations: [{ tool: 'deleteEverything', args: {}, anchorPhrase: 'x', sentence: 'x' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a mutation missing a required field', () => {
    const result = MutationPlan.safeParse({
      mutations: [{ tool: 'addService', args: {}, anchorPhrase: 'Redis' }], // no sentence
    });
    expect(result.success).toBe(false);
  });

  it('rejects args values that are not strings', () => {
    const result = MutationPlan.safeParse({
      mutations: [
        { tool: 'addService', args: { count: 3 }, anchorPhrase: 'Redis', sentence: 'x' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-object payload entirely', () => {
    expect(MutationPlan.safeParse('not a plan').success).toBe(false);
    expect(MutationPlan.safeParse(null).success).toBe(false);
  });
});
