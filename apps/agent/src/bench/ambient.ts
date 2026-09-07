// Ambient-mode scenarios (TECHNICAL_REVIEW.md §5.3, scenarios 47 & 48).
//
// Deterministic, no audio, no LLM, no LiveKit — same property as the rest of
// the benchmark. Drives ProposalStore + the addressivity prefilter + CommitGate
// together and checks the §2.4 safety invariant mechanically:
//
//   overheard speech can only ever CREATE or DESTROY proposals;
//   committed canvas state is changed only by ADDRESSED speech.

import type { GhostElement } from '@repo/protocol';
import { CanvasStore } from '../core/canvas.ts';
import { CommitGate } from '../core/commit-gate.ts';
import { EventLedger } from '../core/ledger.ts';
import { GenerationManager } from '../core/generation.ts';
import { StagingBuffer } from '../core/staging.ts';
import { ProposalStore } from '../core/proposals.ts';
import {
  type AddressivityContext,
  type AddressivityScore,
  prefilterScore,
  route,
} from '../core/addressivity.ts';

export interface AmbientStep {
  speaker: string;
  text: string;
  /** A node this utterance is "about", if the operator scripted one (mirrors what a salience→plan step would extract). */
  about?: { element: 'node'; label: string } | undefined;
}

export interface AmbientScenario {
  id: string;
  threshold: number;
  /** Nodes already committed on the canvas before the ambient chatter starts. */
  committed: string[];
  steps: AmbientStep[];
}

export interface AmbientResult {
  scenarioId: string;
  committedNodeIds: string[];
  ghosts: GhostElement[];
  promotions: number;
  /** True iff no ghost ever reached the committed canvas without an addressed confirmation. */
  invariantHeld: boolean;
}

function slug(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
}

/** Run one ambient scenario against the real core modules. */
export function runAmbient(scenario: AmbientScenario): AmbientResult {
  const canvas = new CanvasStore();
  const staging = new StagingBuffer();
  const ledger = new EventLedger();
  const gm = new GenerationManager();
  const commitGate = new CommitGate({ canvas, staging, ledger });
  const proposals = new ProposalStore();

  for (const label of scenario.committed) {
    canvas.apply({ op: 'addNode', node: { id: slug(label), label, kind: 'service', x: 0, y: 0 } });
  }
  const committedBefore = new Set(canvas.snapshot(0).nodes.map((n) => n.id));

  const recent: AddressivityContext['recent'] = [];
  let promotions = 0;
  let invariantHeld = true;

  for (const step of scenario.steps) {
    recent.push({ speaker: step.speaker, text: step.text, atMs: recent.length * 1000 });
    const ctx: AddressivityContext = {
      recent: recent.slice(-8),
      agentAskedQuestion: false,
      canvasVocabulary: canvas.snapshot(0).nodes.map((n) => n.label),
      threshold: scenario.threshold,
    };

    const score = prefilterOrCautious(step.text, ctx);
    const { speak, draw } = route(score, scenario.threshold);

    if (score.stance === 'disagree') {
      proposals.rejectMatching(step.text);
    }

    if (step.about && draw && !speak) {
      // Not addressed + salient -> silent ghost proposal.
      proposals.propose({
        element: 'node',
        label: step.about.label,
        proposedBy: step.speaker,
        confidence: score.salient,
      });
    }

    if (step.about && draw && speak) {
      // Addressed + salient -> this is the commit path. Promote any matching
      // ghost (or create+promote), stage through the gate, and "hear" the
      // confirming sentence.
      const matching = proposals.list().find((g) => g.label.toLowerCase() === step.about!.label.toLowerCase());
      const gen = gm.start(step.text);
      commitGate.startGeneration();
      const mutation = matching
        ? proposals.promote(matching.id)!
        : ({
            op: 'addNode' as const,
            node: { id: slug(step.about.label), label: step.about.label, kind: 'service' as const, x: 0, y: 0 },
          });
      commitGate.stage(gen.id, 0, step.about.label, mutation);
      commitGate.onWord(gen.id, { text: `${step.about.label}.`, startTime: 0, endTime: 1 });
      commitGate.onTurnComplete(gen.id);
      promotions += 1;
    }
  }

  const committedAfter = canvas.snapshot(0).nodes.map((n) => n.id);
  const ghosts = proposals.list();

  // Invariant 1: every committed node was either there before, or was added on
  // an addressed (speak) turn — never silently by a ghost.
  const ghostLabels = new Set(ghosts.map((g) => slug(g.label)));
  for (const id of committedAfter) {
    if (!committedBefore.has(id) && ghostLabels.has(id)) invariantHeld = false;
  }
  // Invariant 2: nothing that was committed before was removed (a disagreement
  // can only touch ghosts).
  for (const id of committedBefore) {
    if (!committedAfter.includes(id)) invariantHeld = false;
  }

  return { scenarioId: scenario.id, committedNodeIds: committedAfter, ghosts, promotions, invariantHeld };
}

// classifyUtterance is async by signature (the model path); the synchronous
// harness calls the prefilter directly with the same cautious fallback.
function prefilterOrCautious(text: string, ctx: AddressivityContext): AddressivityScore {
  const pre = prefilterScore(text, ctx);
  if (pre) return pre;
  return { addressed: 0.3, salient: 0.3, stance: 'neutral', by: 'prefilter', reasons: ['cautious'] };
}

export const AMBIENT_SCENARIOS: AmbientScenario[] = [
  {
    // 47 — an overheard proposal never commits without an addressed confirmation.
    id: 'ambient_proposal_needs_confirmation',
    threshold: 0.6,
    committed: ['API Gateway'],
    steps: [
      { speaker: 'alice', text: 'I think we need a Redis cache in front of the database', about: { element: 'node', label: 'Redis cache' } },
      { speaker: 'bob', text: 'yeah maybe, not sure yet' },
      { speaker: 'alice', text: 'anyway what were you saying about auth' },
    ],
  },
  {
    // 47b — the same proposal, later confirmed TO the agent, does commit.
    id: 'ambient_proposal_then_confirmed',
    threshold: 0.6,
    committed: ['API Gateway'],
    steps: [
      { speaker: 'alice', text: 'we should probably have a Redis cache here', about: { element: 'node', label: 'Redis cache' } },
      { speaker: 'bob', text: 'agreed' },
      { speaker: 'alice', text: 'Cartograph, add the Redis cache', about: { element: 'node', label: 'Redis cache' } },
    ],
  },
  {
    // 48 — an overheard disagreement removes a ghost, never a committed node.
    id: 'ambient_disagreement_removes_ghost_not_node',
    threshold: 0.6,
    committed: ['API Gateway', 'Orders Service'],
    steps: [
      { speaker: 'alice', text: 'maybe put a Kafka queue between them', about: { element: 'node', label: 'Kafka queue' } },
      { speaker: 'bob', text: "no, we're not using Kafka for this" },
      { speaker: 'bob', text: 'and honestly the Orders Service is fine as it is' },
    ],
  },
];
