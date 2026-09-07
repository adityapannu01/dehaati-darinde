// §2.6 layer 2: the small-model classifier the addressivity prefilter falls
// back to when it isn't sure. One structured call, ~100-200 ms, on the same
// LiveKit Inference model/billing as the rest of the graph — no new secret,
// nothing trained.
//
// Exposed as a plain `(utterance, ctx) => Promise<AddressivityScore>` so
// core/addressivity.ts stays LiveKit-free and unit-testable; main.ts injects
// this when LLM_ENGINE=graph (or ADDRESSIVITY forces it on).

import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { AddressivityContext, AddressivityScore } from '../../core/addressivity.ts';
import { makeModel } from '../model.ts';

const SCHEMA = z.object({
  addressed: z.number().min(0).max(1),
  salient: z.number().min(0).max(1),
  stance: z.enum(['agree', 'disagree', 'neutral']),
});

const PROMPT = `You classify one utterance from a live architecture discussion on two independent axes.

addressed (0..1): is this directed at the voice agent "Cartograph" (a command or a direct answer to its question), or is it one engineer talking to another? Thinking out loud counts as NOT addressed.
salient (0..1): does it describe a change to the architecture diagram (a component, a connection, a rename, a removal)?
stance: is the speaker agreeing with, disagreeing with, or neutral about a proposal on the table?

The last few seconds of conversation matter — "make that Postgres" is a command if the agent just asked, and chit-chat if two people are debating. Respond with ONLY the JSON object, no prose.`;

export function makeAddressModel(
  model = 'google/gemma-4-31b-it'
): (utterance: string, ctx: AddressivityContext) => Promise<AddressivityScore> {
  return async (utterance, ctx) => {
    const llm = (await makeModel(model)).withStructuredOutput(SCHEMA, { method: 'functionCalling' });
    const contextLines = [
      ctx.agentRecentlySaid ? `agent just said: "${ctx.agentRecentlySaid}"` : 'agent has been quiet',
      ctx.agentAskedQuestion ? 'the agent asked a question' : 'the agent did not ask a question',
      `on the diagram: ${ctx.canvasVocabulary.join(', ') || '(empty)'}`,
      'recent turns:',
      ...ctx.recent.map((u) => `  ${u.speaker}: ${u.text}`),
      `utterance to classify: "${utterance}"`,
    ].join('\n');
    const out = await llm.invoke([new SystemMessage(PROMPT), new HumanMessage(contextLines)]);
    return {
      addressed: out.addressed,
      salient: out.salient,
      stance: out.stance,
      by: 'model',
      reasons: ['structured classifier'],
    };
  };
}
