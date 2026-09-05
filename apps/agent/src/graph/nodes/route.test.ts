import { FakeListChatModel } from '@langchain/core/utils/testing';
import { describe, expect, it } from 'vitest';
import type { CanvasStateT } from '../state.ts';
import { routeNode } from './route.ts';

function stateWith(userInput: string): CanvasStateT {
  return { userInput, history: [], canvasSummary: '', route: 'chat', plan: null, reply: '' };
}

async function route(userInput: string, response: string) {
  const model = new FakeListChatModel({ responses: [response] });
  const result = await routeNode(stateWith(userInput), { configurable: { model, structuredMethod: 'functionCalling' } });
  return result.route;
}

describe('routeNode', () => {
  const canvasUtterances = [
    'Add a Redis cache.',
    'Connect that to the gateway.',
    'Swap Redis for MongoDB.',
    'Remove the queue.',
    'Rename the database to primary-db.',
    'Add a load balancer in front of the API.',
    'Connect the cache to the database.',
    'Delete the cache node.',
    'Replace the queue with Kafka.',
    'Add a CDN.',
  ];

  const chatUtterances = [
    'Hi there.',
    'What does this diagram show?',
    "What's the weather like?",
    'Thanks, that looks good.',
    'Can you explain what a cache is?',
    'How are you doing today?',
  ];

  it.each(canvasUtterances)('classifies "%s" as canvas', async (utterance) => {
    expect(await route(utterance, 'canvas')).toBe('canvas');
  });

  it.each(chatUtterances)('classifies "%s" as chat', async (utterance) => {
    expect(await route(utterance, 'chat')).toBe('chat');
  });

  it('tolerates extra words around the classification', async () => {
    expect(await route('Add a Redis cache.', 'The answer is: canvas')).toBe('canvas');
  });

  it('defaults to chat on an ambiguous response', async () => {
    expect(await route('Hi there.', 'unsure')).toBe('chat');
  });
});
