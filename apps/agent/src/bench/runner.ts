import type { CanvasSnapshot, MutationOp } from '@repo/protocol';
import { CanvasStore } from '../core/canvas.ts';
import { CommitGate } from '../core/commit-gate.ts';
import { GenerationManager } from '../core/generation.ts';
import { EventLedger } from '../core/ledger.ts';
import { StagingBuffer } from '../core/staging.ts';
import { type CanvasDiff, deriveExpectedCanvas, diff, isDiffEmpty } from './oracle.ts';
import { OUT_OF_ORDER_SCENARIO, SCENARIOS, type Scenario } from './scenarios.ts';

export interface ScenarioResult {
  scenarioId: string;
  baselineMode: boolean;
  actual: CanvasSnapshot;
  diff: CanvasDiff;
  /** Mutations present on the canvas that the Oracle says should never have landed. */
  staleCount: number;
  divergent: boolean;
}

function wordFor(sentenceLabel: string): { text: string; startTime: number; endTime: number } {
  return { text: `${sentenceLabel}.`, startTime: 0, endTime: 1 };
}

/** Drives the core engine only — no LiveKit, no audio, no network, no LLM. */
function runScenario(scenario: Scenario, baselineMode: boolean): CanvasSnapshot {
  const canvas = new CanvasStore();
  const staging = new StagingBuffer();
  const ledger = new EventLedger();
  const gm = new GenerationManager({ baselineMode });
  const commitGate = new CommitGate({ canvas, staging, ledger, baselineMode });

  for (const turn of scenario.turns) {
    gm.cancelCurrent();
    const gen = gm.start('scenario turn');
    commitGate.startGeneration();

    turn.mutations.forEach(({ anchorPhrase, mutation }, i) => {
      commitGate.stage(gen.id, i, anchorPhrase, mutation);
    });

    for (let s = 0; s < turn.deliveredSentences; s++) {
      commitGate.onWord(gen.id, wordFor(`sentence${s}`));
    }

    if (turn.interrupted) {
      commitGate.onInterrupted(gen.id);
      if (turn.lateArrival) {
        // Mirrors what a real tool does before ever calling commitGate.stage():
        // check the fence itself. A stale result is silently discarded.
        if (gm.isCurrent(gen.id)) {
          commitGate.stage(
            gen.id,
            turn.mutations.length,
            turn.lateArrival.anchorPhrase,
            turn.lateArrival.mutation,
          );
        }
      }
    } else {
      commitGate.onTurnComplete(gen.id);
    }
  }

  return canvas.snapshot(gm.currentId);
}

export function runAll(scenarios: Scenario[] = SCENARIOS): ScenarioResult[] {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const expected = deriveExpectedCanvas(scenario);
    for (const baselineMode of [false, true]) {
      const actual = runScenario(scenario, baselineMode);
      const d = diff(expected, actual);
      results.push({
        scenarioId: scenario.id,
        baselineMode,
        actual,
        diff: d,
        staleCount: d.extraNodeIds.length + d.extraEdgeIds.length,
        divergent: !isDiffEmpty(d),
      });
    }
  }
  return results;
}

export interface OutOfOrderResult {
  baselineMode: boolean;
  landedNodeIds: string[];
  /** true iff exactly the most-recent still-current generation's result landed. */
  correct: boolean;
}

/**
 * Brainstorm §20: three generations open back-to-back (each superseding the
 * last before its own tool result arrives), then results resolve in the
 * order 1 -> 3 -> 2. Only generation 3's result should land — it's the only
 * one still current at the moment its result actually resolves, regardless
 * of physical arrival order.
 */
export function runOutOfOrderScenario(baselineMode: boolean): OutOfOrderResult {
  const canvas = new CanvasStore();
  const staging = new StagingBuffer();
  const ledger = new EventLedger();
  const gm = new GenerationManager({ baselineMode });
  const commitGate = new CommitGate({ canvas, staging, ledger, baselineMode });

  const results: { genId: number; mutation: MutationOp }[] = [];
  for (let n = 1; n <= OUT_OF_ORDER_SCENARIO.turnCount; n++) {
    gm.cancelCurrent();
    const gen = gm.start(`turn ${n}`);
    commitGate.startGeneration();
    results.push({
      genId: gen.id,
      mutation: {
        op: 'addNode',
        node: { id: `gen-${n}`, label: `gen${n}`, kind: 'service', x: 0, y: 0 },
      },
    });
  }

  for (const idx of OUT_OF_ORDER_SCENARIO.resolutionOrder) {
    const { genId, mutation } = results[idx] as { genId: number; mutation: MutationOp };
    if (gm.isCurrent(genId)) {
      commitGate.stage(genId, 0, `gen${idx + 1}`, mutation);
      // The result arriving IS this generation's whole turn — nothing else is
      // pending for it, so flush it onto the canvas now that it's confirmed current.
      commitGate.onTurnComplete(genId);
    }
  }

  const landedNodeIds = canvas.snapshot(gm.currentId).nodes.map((n) => n.id);
  // Correct behaviour is *only* generation 3's node landing. In baselineMode,
  // isCurrent() always returns true, so all three stale results land instead —
  // that gap is exactly what this scenario is built to demonstrate.
  const correct = landedNodeIds.length === 1 && landedNodeIds[0] === 'gen-3';

  return { baselineMode, landedNodeIds, correct };
}
