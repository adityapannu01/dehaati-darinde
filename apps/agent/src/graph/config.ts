// Env resolution for the LangGraph kill switch (LANGGRAPH_PLAN.md Task 0.2).
// Pure, no @livekit/agents / no LangChain imports — same discipline as tts.ts.

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export type LLMEngineName = 'direct' | 'graph';

/** 'direct' = today's inference.LLM via Agent.create; 'graph' = LangGraph via CanvasAgent.llmNode. */
export function resolveLLMEngine(): LLMEngineName {
  const raw = env('LLM_ENGINE', 'direct').toLowerCase();
  if (raw === 'direct' || raw === 'graph') return raw;
  throw new Error(`Unknown LLM_ENGINE "${raw}". Expected one of: direct, graph.`);
}

/** Model id on LiveKit Inference the graph's nodes plan/chat/route with. Only read when LLM_ENGINE=graph. */
export function resolveGraphModel(): string {
  return env('GRAPH_LLM_MODEL', 'google/gemma-4-31b-it');
}

export type StructuredMethod = 'jsonSchema' | 'functionCalling' | 'jsonMode';

/** Which withStructuredOutput() method the gateway+model combination actually supports — see graph/probe-structured.ts. */
export function resolveStructuredMethod(): StructuredMethod {
  const raw = env('GRAPH_STRUCTURED_METHOD', 'functionCalling');
  if (raw === 'jsonSchema' || raw === 'functionCalling' || raw === 'jsonMode') return raw;
  throw new Error(
    `Unknown GRAPH_STRUCTURED_METHOD "${raw}". Expected one of: jsonSchema, functionCalling, jsonMode.`
  );
}
