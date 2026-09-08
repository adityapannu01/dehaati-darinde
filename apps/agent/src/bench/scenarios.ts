import type { MutationOp } from '@repo/protocol';

/**
 * One user turn within a scenario. `mutations` are what the LLM proposed,
 * in tool-call/sentence order (array index === sentenceIndex). `deliveredSentences`
 * is how many of those sentences were actually confirmed spoken (by TTS word
 * timestamps) before the turn either completed normally or was interrupted —
 * this is ground truth the Oracle (oracle.ts) uses independently of whatever
 * CommitGate decides.
 */
export interface ScenarioTurn {
  mutations: { anchorPhrase: string; mutation: MutationOp }[];
  deliveredSentences: number;
  interrupted: boolean;
  /**
   * A mutation from a tool call that resolves AFTER this turn was already
   * fenced by an interruption — models a "stale tool result" (brainstorm's
   * deliberately slow tool). Its sentence, by construction, was never
   * delivered, so the Oracle never includes it either.
   */
  lateArrival?: { anchorPhrase: string; mutation: MutationOp } | undefined;
  /**
   * The user emits a backchannel ("mm-hmm") after this many of the turn's
   * sentences have been heard. Adaptive interruption keeps the agent talking;
   * the B1 fence must NOT roll the generation. The turn then finishes normally
   * and every mutation up to `deliveredSentences` must still commit — nothing
   * orphaned (TECHNICAL_REVIEW.md B1, scenario 46).
   */
  backchannelAfterSentence?: number | undefined;
}

export type InterruptPoint =
  | 'during_llm'
  | 'during_tool'
  | 'during_speech_s1'
  | 'during_speech_s2'
  | 'none';

export interface Scenario {
  id: string;
  /** Descriptive only in this synchronous harness — real delay is measured live (see bench/live-latency.md). */
  toolDelayMs: number;
  interruptAt: InterruptPoint;
  corrections: number;
  turns: ScenarioTurn[];
}

function addNode(id: string, label: string): MutationOp {
  return { op: 'addNode', node: { id, label, kind: 'service', x: 0, y: 0 } };
}

function addEdge(id: string, source: string, target: string): MutationOp {
  return { op: 'addEdge', edge: { id, source, target } };
}

/** A "wait, change my mind" cycle: propose a component + a connection, interrupt after only the component is heard. */
function correctionTurn(n: number): ScenarioTurn {
  const nodeId = `svc-${n}`;
  return {
    mutations: [
      { anchorPhrase: `svc${n}`, mutation: addNode(nodeId, `svc${n}`) },
      { anchorPhrase: `svc${n}`, mutation: addEdge(`edge-${n}`, 'api', nodeId) },
    ],
    deliveredSentences: 1, // only the addNode sentence was heard before the user cut in
    interrupted: true,
  };
}

function finalTurn(interruptAt: InterruptPoint): ScenarioTurn {
  const node = { anchorPhrase: 'final', mutation: addNode('final-svc', 'final') };
  const edge = { anchorPhrase: 'final', mutation: addEdge('final-edge', 'api', 'final-svc') };

  switch (interruptAt) {
    case 'none':
      return { mutations: [node, edge], deliveredSentences: 2, interrupted: false };
    case 'during_llm':
      // Interrupted before the LLM even finished deciding on tool calls: nothing was ever staged.
      return { mutations: [], deliveredSentences: 0, interrupted: true };
    case 'during_tool':
      // The node's sentence is heard; the edge's tool call is still resolving when the
      // interrupt fences the generation, so it arrives late.
      return { mutations: [node], deliveredSentences: 1, interrupted: true, lateArrival: edge };
    case 'during_speech_s1':
      // Both mutations staged, but the interrupt lands before the FIRST sentence finishes.
      return { mutations: [node, edge], deliveredSentences: 0, interrupted: true };
    case 'during_speech_s2':
      // First sentence heard, interrupt lands during the second.
      return { mutations: [node, edge], deliveredSentences: 1, interrupted: true };
  }
}

const TOOL_DELAYS_MS = [1000, 3000, 5000];
const INTERRUPT_POINTS: InterruptPoint[] = [
  'during_llm',
  'during_tool',
  'during_speech_s1',
  'during_speech_s2',
  'none',
];
const CORRECTION_COUNTS = [1, 2, 3];

/**
 * The generated matrix: toolDelay x interruptAt x corrections. Every scenario
 * is `corrections - 1` correction cycles (each always interrupted) followed
 * by one final turn shaped by `interruptAt`. Built parametrically rather than
 * hand-authored one-by-one, so correctness follows from `correctionTurn` /
 * `finalTurn` being right once, not from getting ~45 scripts right individually.
 */
function generateMatrix(): Scenario[] {
  const scenarios: Scenario[] = [];
  for (const toolDelayMs of TOOL_DELAYS_MS) {
    for (const interruptAt of INTERRUPT_POINTS) {
      for (const corrections of CORRECTION_COUNTS) {
        const turns: ScenarioTurn[] = [];
        for (let i = 1; i < corrections; i++) turns.push(correctionTurn(i));
        turns.push(finalTurn(interruptAt));
        scenarios.push({
          id: `delay${toolDelayMs}_${interruptAt}_corr${corrections}`,
          toolDelayMs,
          interruptAt,
          corrections,
          turns,
        });
      }
    }
  }
  return scenarios;
}

/**
 * Brainstorm §20's explicit out-of-order case: three turns (41, 42, 43 in the
 * brainstorm's numbering — here, three sequential generations), each
 * interrupted with a late tool result, but the late results resolve in the
 * order 1 -> 3 -> 2 (i.e. gen 2's result is the last to arrive, well after
 * gen 3 already opened and closed). Only generation 3's result may land —
 * everything from 1 and 2 must be discarded, regardless of arrival order.
 *
 * This can't be expressed as independent sequential turns (each turn's
 * lateArrival normally resolves immediately after that turn), so it's
 * modelled as its own scripted scenario with an explicit resolution order.
 */
export interface OutOfOrderScenario {
  id: string;
  turnCount: 3;
  /** Index (0,1,2) into the turns, in the order their late tool results actually arrive. */
  resolutionOrder: [number, number, number];
}

export const OUT_OF_ORDER_SCENARIO: OutOfOrderScenario = {
  id: 'triple_interruption_out_of_order',
  turnCount: 3,
  resolutionOrder: [0, 2, 1], // gen1's result arrives, then gen3's, then gen2's (last, and stale)
};

/**
 * Scenario 46 (TECHNICAL_REVIEW.md B1): a backchannel lands mid-narration.
 * The agent keeps talking and finishes the turn; every described mutation must
 * still commit. Runs at each tool delay so the backchannel can interleave with
 * an in-flight staging call, not just a settled one.
 */
function backchannelScenario(toolDelayMs: number): Scenario {
  const cache = { anchorPhrase: 'cache', mutation: addNode('cache-svc', 'cache') };
  const edge = { anchorPhrase: 'cache', mutation: addEdge('cache-edge', 'api', 'cache-svc') };
  return {
    id: `delay${toolDelayMs}_backchannel_mid_narration`,
    toolDelayMs,
    interruptAt: 'none',
    corrections: 1,
    turns: [
      {
        mutations: [cache, edge],
        deliveredSentences: 2,
        interrupted: false,
        backchannelAfterSentence: 1,
      },
    ],
  };
}

export const BACKCHANNEL_SCENARIOS: Scenario[] = TOOL_DELAYS_MS.map(backchannelScenario);

/**
 * ROUND3 Module C: a `setDirection` mutation is a narrated, gated change like
 * any other. Staged then interrupted before its sentence is heard -> it must
 * not apply. `setDirection` adds no nodes/edges, so content divergence stays
 * 0.0% either way — which also proves direction is correctly OUTSIDE the
 * oracle's content comparison (bench/oracle.ts).
 *
 * Turn 1: add a node + change direction; only the node's sentence is heard,
 * then interrupted. Turn 2 (uninterrupted) adds another node.
 */
function directionScenario(toolDelayMs: number): Scenario {
  return {
    id: `delay${toolDelayMs}_direction_change_interrupted`,
    toolDelayMs,
    interruptAt: 'during_speech_s2',
    corrections: 1,
    turns: [
      {
        mutations: [
          { anchorPhrase: 'first', mutation: addNode('first-svc', 'first') },
          { anchorPhrase: 'top to bottom', mutation: { op: 'setDirection', direction: 'DOWN' } },
        ],
        deliveredSentences: 1, // node heard; the "top to bottom" sentence is cut off
        interrupted: true,
      },
      {
        mutations: [{ anchorPhrase: 'second', mutation: addNode('second-svc', 'second') }],
        deliveredSentences: 1,
        interrupted: false,
      },
    ],
  };
}

export const DIRECTION_SCENARIOS: Scenario[] = TOOL_DELAYS_MS.map(directionScenario);

export const SCENARIOS: Scenario[] = [
  ...generateMatrix(),
  ...BACKCHANNEL_SCENARIOS,
  ...DIRECTION_SCENARIOS,
];
