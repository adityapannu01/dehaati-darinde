import type { CanvasSnapshot } from '@repo/protocol';
import { CanvasStore } from '../core/canvas.ts';
import type { Scenario } from './scenarios.ts';

export interface CanvasDiff {
  missingNodeIds: string[]; // expected but not in actual
  extraNodeIds: string[]; // in actual but not expected (stale/leaked)
  missingEdgeIds: string[];
  extraEdgeIds: string[];
}

/**
 * Independently derives the canvas a listener would have drawn from the
 * HEARD transcript alone — walking only `deliveredSentences` per turn, never
 * `lateArrival`, and never consulting CommitGate/StagingBuffer. Deliberately
 * does not share implementation with the engine under test: an oracle that
 * reuses CommitGate's logic proves nothing.
 */
export function deriveExpectedCanvas(scenario: Scenario): CanvasSnapshot {
  const canvas = new CanvasStore();
  for (const turn of scenario.turns) {
    const heard = turn.mutations.slice(0, turn.deliveredSentences);
    for (const { mutation } of heard) canvas.apply(mutation);
  }
  return canvas.snapshot(scenario.turns.length);
}

export function diff(expected: CanvasSnapshot, actual: CanvasSnapshot): CanvasDiff {
  // ROUND3 A1: the diff is over CONTENT — which nodes and edges exist. Flow
  // direction (`snapshot.direction`) and group boxes are PRESENTATION and are
  // deliberately not compared. Adding direction here would make the divergence
  // metric mean two things at once. A `setDirection` mutation still goes
  // through the commit gate — it just doesn't enter this content comparison.
  const expectedNodeIds = new Set(expected.nodes.map((n) => n.id));
  const actualNodeIds = new Set(actual.nodes.map((n) => n.id));
  const expectedEdgeIds = new Set(expected.edges.map((e) => e.id));
  const actualEdgeIds = new Set(actual.edges.map((e) => e.id));

  return {
    missingNodeIds: [...expectedNodeIds].filter((id) => !actualNodeIds.has(id)),
    extraNodeIds: [...actualNodeIds].filter((id) => !expectedNodeIds.has(id)),
    missingEdgeIds: [...expectedEdgeIds].filter((id) => !actualEdgeIds.has(id)),
    extraEdgeIds: [...actualEdgeIds].filter((id) => !expectedEdgeIds.has(id)),
  };
}

export function isDiffEmpty(d: CanvasDiff): boolean {
  return (
    d.missingNodeIds.length === 0 &&
    d.extraNodeIds.length === 0 &&
    d.missingEdgeIds.length === 0 &&
    d.extraEdgeIds.length === 0
  );
}
