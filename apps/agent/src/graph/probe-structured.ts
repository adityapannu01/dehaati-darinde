// Throwaway probe (LANGGRAPH_PLAN.md Task 1.2): does LiveKit Inference forward
// structured-output requests to google/gemma-4-31b-it, and does Gemma honour
// them? This is the load-bearing unverified assumption of the whole plan —
// a plain completion (Task 1.1) succeeds even if this fails, so it has to be
// tested separately, before any graph code is written.
//
// Run with: node --env-file=.env.local src/graph/probe-structured.ts
import process from 'node:process';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { makeModel } from './model.ts';

const MutationPlan = z.object({
  mutations: z.array(
    z.object({
      tool: z.enum([
        'addService',
        'connectServices',
        'replaceComponent',
        'renameComponent',
        'removeComponent',
      ]),
      args: z.record(z.string(), z.string()),
      anchorPhrase: z.string(),
      sentence: z.string(),
    })
  ),
});

const PROMPT = 'Add a Redis cache and connect it to the API gateway.';

async function tryStructuredMethods() {
  for (const method of ['jsonSchema', 'functionCalling', 'jsonMode'] as const) {
    try {
      const model = await makeModel();
      const out = await model
        .withStructuredOutput(MutationPlan, { method })
        .invoke([new HumanMessage(PROMPT)]);
      console.log(method, 'OK', JSON.stringify(out));
    } catch (e) {
      console.log(method, 'FAILED', (e as Error).message);
    }
  }
}

async function tryProgressive() {
  try {
    const { JsonOutputParser } = await import('@langchain/core/output_parsers');
    const model = await makeModel();
    const chain = model.pipe(new JsonOutputParser());
    const prompt = [
      new HumanMessage(
        `${PROMPT}\n\nRespond with ONLY JSON matching this shape, no prose:\n` +
          '{"mutations":[{"tool":"addService"|"connectServices"|"replaceComponent"|"renameComponent"|"removeComponent","args":{},"anchorPhrase":"","sentence":""}]}'
      ),
    ];
    let last: unknown;
    for await (const partial of await chain.stream(prompt)) {
      last = partial;
    }
    console.log('progressive', 'OK', JSON.stringify(last));
    const parsed = MutationPlan.safeParse(last);
    console.log('progressive zod validation:', parsed.success ? 'PASS' : `FAIL ${JSON.stringify(parsed.error?.issues)}`);
  } catch (e) {
    console.log('progressive', 'FAILED', (e as Error).message);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await tryStructuredMethods();
  await tryProgressive();
}
