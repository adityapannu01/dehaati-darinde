import type { CanvasSnapshot, MutationOp } from '@repo/protocol';
import { CanvasStore } from '../core/canvas.ts';
import { CommitGate } from '../core/commit-gate.ts';
import { GenerationManager } from '../core/generation.ts';
import { EventLedger } from '../core/ledger.ts';
import { StagingBuffer } from '../core/staging.ts';
import { type CanvasDiff, deriveExpectedCanvas, diff, isDiffEmpty } from './oracle.ts';
import { OUT_OF_ORDER_SCENARIO, SCENARIOS, type Scenario } from './scenarios.ts';
import { isBackchannel } from '../core/turn-taking.ts';

export interface ScenarioResult {
  scenarioId: string;
  baselineMode: boolean;
  actual: CanvasSnapshot;
  diff: CanvasDiff;
  /** Mutations present on the canvas that the Oracle says should never have landed. */
  staleCount: number;
  divergent: boolean;
  /** Staged mutations that never reached a terminal state — the B1 silent-orphan failure. Always 0. */
  orphanCount: number;
}

export interface RunOptions {
  baselineMode: boolean;
  /**
   * Reproduce the pre-B1 bug: fence on EVERY final transcript, backchannels
   * included. Used only by the regression test that proves scenario 46 has
   * teeth — the shipped engine never does this.
   */
  legacyFenceEveryTranscript?: boolean;
}

function wordFor(sentenceLabel: string): { text: string; startTime: number; endTime: number } {
  return { text: `${sentenceLabel}.`, startTime: 0, endTime: 1 };
}

interface RunOutcome {
  snapshot: CanvasSnapshot;
  orphanCount: number;
}

/** Drives the core engine only — no LiveKit, no audio, no network, no LLM. */
function runScenario(scenario: Scenario, opts: RunOptions): RunOutcome {
  const { baselineMode, legacyFenceEveryTranscript = false } = opts;
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
      // A backchannel arrives after `backchannelAfterSentence` sentences are
      // heard. main.ts routes every final transcript through isBackchannel
      // before the fence; the runner mirrors that decision exactly. `gen.id` is
      // still passed to onWord below (B1 fix a: words carry the stream-open
      // generation), so gen N's tail sentences commit gen N's staged mutations
      // even if the buggy path rolled the counter.
      if (turn.backchannelAfterSentence === s) {
        const transcript = 'mm-hmm';
        if (legacyFenceEveryTranscript || !isBackchannel(transcript)) {
          gm.cancelCurrent();
          gm.start(transcript);
          commitGate.startGeneration();
        }
      }
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
      // main.ts commits the uninterrupted turn against gm.currentId — NOT the
      // captured generation. A spurious mid-turn roll (the pre-B1 bug) leaves
      // gm.currentId pointing at the wrong generation, so the tail mutation is
      // never flushed and orphans silently. The runner mirrors that exactly.
      commitGate.onTurnComplete(gm.currentId);
    }
  }

  return { snapshot: canvas.snapshot(gm.currentId), orphanCount: commitGate.orphanedMutationIds.length };
}

export function runAll(scenarios: Scenario[] = SCENARIOS): ScenarioResult[] {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const expected = deriveExpectedCanvas(scenario);
    for (const baselineMode of [false, true]) {
      const { snapshot: actual, orphanCount } = runScenario(scenario, { baselineMode });
      const d = diff(expected, actual);
      results.push({
        scenarioId: scenario.id,
        baselineMode,
        actual,
        diff: d,
        staleCount: d.extraNodeIds.length + d.extraEdgeIds.length,
        divergent: !isDiffEmpty(d),
        orphanCount,
      });
    }
  }
  return results;
}

/** Regression harness for scenario 46 — runs one scenario with the legacy always-fence bug. */
export function runScenarioLegacy(scenario: Scenario): RunOutcome {
  return runScenario(scenario, { baselineMode: false, legacyFenceEveryTranscript: true });
}

export function runScenarioFixed(scenario: Scenario): RunOutcome {
  return runScenario(scenario, { baselineMode: false });
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
