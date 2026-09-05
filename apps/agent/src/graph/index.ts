import { END, START, StateGraph } from '@langchain/langgraph';
import { chatNode } from './nodes/chat.ts';
import { planNode } from './nodes/plan.ts';
import { routeNode } from './nodes/route.ts';
import { CanvasState } from './state.ts';

// Explicit StateGraph, never createReactAgent (LANGGRAPH_PLAN.md §0.3) — the
// graph only ever emits mutations for llmNode to hand to LiveKit's tool
// executor; it never calls a canvas tool itself.
// Node names must not collide with any CanvasState field name (LangGraph
// treats a node name and a state channel as the same namespace) — 'route'
// and 'plan' are both state fields, so the nodes that populate them are
// named 'router' and 'planner'.
export const cartographGraph = new StateGraph(CanvasState)
  .addNode('router', routeNode)
  .addNode('planner', planNode)
  .addNode('chat', chatNode)
  .addEdge(START, 'router')
  .addConditionalEdges('router', (s) => s.route, { canvas: 'planner', chat: 'chat' })
  .addEdge('planner', END)
  .addEdge('chat', END)
  .compile();
