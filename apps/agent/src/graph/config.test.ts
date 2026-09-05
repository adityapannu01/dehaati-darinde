import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveGraphModel,
  resolveLLMEngine,
  resolveStructuredMethod,
} from './config.ts';

const KEYS = ['LLM_ENGINE', 'GRAPH_LLM_MODEL', 'GRAPH_STRUCTURED_METHOD'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolveLLMEngine', () => {
  it('defaults to "direct" when unset', () => {
    expect(resolveLLMEngine()).toBe('direct');
  });

  it('defaults to "direct" when empty', () => {
    process.env.LLM_ENGINE = '';
    expect(resolveLLMEngine()).toBe('direct');
  });

  it('is case-insensitive', () => {
    process.env.LLM_ENGINE = 'GRAPH';
    expect(resolveLLMEngine()).toBe('graph');
  });

  it('throws a clear startup error on an unknown value', () => {
    process.env.LLM_ENGINE = 'nonsense';
    expect(() => resolveLLMEngine()).toThrow(/Unknown LLM_ENGINE "nonsense"/);
  });
});

describe('resolveGraphModel', () => {
  it('defaults to the same model direct mode uses', () => {
    expect(resolveGraphModel()).toBe('google/gemma-4-31b-it');
  });

  it('honours GRAPH_LLM_MODEL', () => {
    process.env.GRAPH_LLM_MODEL = 'openai/gpt-5.4-mini';
    expect(resolveGraphModel()).toBe('openai/gpt-5.4-mini');
  });
});

describe('resolveStructuredMethod', () => {
  it('defaults to functionCalling (the only method that works against gemma-4-31b-it via LiveKit Inference — see probe-structured.ts)', () => {
    expect(resolveStructuredMethod()).toBe('functionCalling');
  });

  it('accepts the other two documented methods', () => {
    process.env.GRAPH_STRUCTURED_METHOD = 'jsonSchema';
    expect(resolveStructuredMethod()).toBe('jsonSchema');
    process.env.GRAPH_STRUCTURED_METHOD = 'jsonMode';
    expect(resolveStructuredMethod()).toBe('jsonMode');
  });

  it('throws on an unknown value', () => {
    process.env.GRAPH_STRUCTURED_METHOD = 'yaml';
    expect(() => resolveStructuredMethod()).toThrow(/Unknown GRAPH_STRUCTURED_METHOD "yaml"/);
  });
});
