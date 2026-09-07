// Hand-labelled addressivity fixture + confusion matrix (TECHNICAL_REVIEW.md §2.6).
//
//   "Measure it. Record one genuine 10-minute two-person architecture
//    discussion. Hand-label every utterance addressed / not addressed. Commit
//    it as a fixture and produce a confusion matrix. Do this EVEN IF the
//    classifier is mediocre — a measured mediocre number beats an unmeasured
//    good one."
//
// ⚠️ The transcript below is SYNTHETIC — a realistic two-engineer session
//   written by hand, not a real recording. Replace `TRANSCRIPT` with a
//   transcribed real discussion and re-run: `pnpm --filter DD_agent addressivity`.
//   The scoring code is what matters and does not change.

import { prefilterScore, type AddressivityContext } from '../core/addressivity.ts';

export interface LabelledUtterance {
  speaker: string;
  text: string;
  /** Ground truth: was this directed at the agent? */
  addressed: boolean;
  /** Ground truth: does it describe an architecture change? */
  salient: boolean;
  /** Context at this point. */
  agentAskedQuestion?: boolean;
  canvasVocabulary?: string[];
}

export const TRANSCRIPT: LabelledUtterance[] = [
  { speaker: 'alice', text: 'okay so the client hits our API gateway', addressed: true, salient: true },
  { speaker: 'agent', text: 'Adding an API gateway.', addressed: false, salient: false },
  { speaker: 'bob', text: 'wait is the gateway doing auth or is that separate', addressed: false, salient: false },
  { speaker: 'alice', text: 'separate, let me think', addressed: false, salient: false },
  { speaker: 'alice', text: 'Cartograph, add an auth service', addressed: true, salient: true, canvasVocabulary: ['API gateway'] },
  { speaker: 'agent', text: 'Adding an auth service.', addressed: false, salient: false },
  { speaker: 'bob', text: 'and the gateway calls that before routing anything', addressed: false, salient: true, canvasVocabulary: ['API gateway', 'auth service'] },
  { speaker: 'alice', text: 'right, connect the gateway to the auth service', addressed: true, salient: true, canvasVocabulary: ['API gateway', 'auth service'] },
  { speaker: 'agent', text: 'Should the orders service also talk to auth directly?', addressed: false, salient: false },
  { speaker: 'alice', text: 'no, everything goes through the gateway', addressed: true, salient: false, agentAskedQuestion: true },
  { speaker: 'bob', text: 'we probably want a Redis cache for sessions', addressed: false, salient: true },
  { speaker: 'alice', text: 'hmm maybe, not sure it is worth it yet', addressed: false, salient: false },
  { speaker: 'bob', text: 'yeah fair', addressed: false, salient: false },
  { speaker: 'alice', text: 'add an orders service and a payments service', addressed: true, salient: true },
  { speaker: 'agent', text: 'Adding an orders service. Now a payments service.', addressed: false, salient: false },
  { speaker: 'bob', text: 'does payments call an external provider like Stripe', addressed: false, salient: false },
  { speaker: 'alice', text: 'yes, connect payments to Stripe as an external system', addressed: true, salient: true, canvasVocabulary: ['orders service', 'payments service'] },
  { speaker: 'bob', text: 'and orders publishes an event when an order is placed', addressed: false, salient: true, canvasVocabulary: ['orders service', 'payments service'] },
  { speaker: 'alice', text: 'let us add a Kafka queue then', addressed: true, salient: true },
  { speaker: 'bob', text: "actually no, we're not using Kafka, use SQS", addressed: false, salient: true, canvasVocabulary: ['orders service'] },
  { speaker: 'alice', text: 'okay Cartograph, replace the Kafka queue with SQS', addressed: true, salient: true, canvasVocabulary: ['orders service', 'Kafka queue'] },
  { speaker: 'agent', text: 'Replacing the Kafka queue with SQS.', addressed: false, salient: false },
  { speaker: 'bob', text: 'looks good to me', addressed: false, salient: false },
  { speaker: 'alice', text: 'what have we got so far', addressed: true, salient: false, canvasVocabulary: ['API gateway', 'auth service', 'orders service', 'payments service', 'SQS'] },
  { speaker: 'bob', text: 'I think we are missing the database', addressed: false, salient: true },
  { speaker: 'alice', text: 'add a Postgres database and connect orders to it', addressed: true, salient: true },
];

export interface ConfusionMatrix {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}

export interface AxisReport {
  axis: 'addressed' | 'salient';
  threshold: number;
  matrix: ConfusionMatrix;
  precision: number;
  recall: number;
  f1: number;
}

function scoreOne(u: LabelledUtterance, prevTurns: LabelledUtterance[]): { addressed: number; salient: number } {
  if (u.speaker === 'agent') return { addressed: 0, salient: 0 };
  const ctx: AddressivityContext = {
    recent: prevTurns.slice(-8).map((p, i) => ({ speaker: p.speaker, text: p.text, atMs: i * 1000 })),
    agentAskedQuestion: u.agentAskedQuestion ?? false,
    canvasVocabulary: u.canvasVocabulary ?? [],
    threshold: 0.6,
  };
  const pre = prefilterScore(u.text, ctx);
  // No model in the fixture — use the prefilter's cautious fallback, same as shipped when offline.
  return pre ?? { addressed: 0.3, salient: 0.3 };
}

function f1(m: ConfusionMatrix): { precision: number; recall: number; f1: number } {
  const precision = m.tp + m.fp === 0 ? 1 : m.tp / (m.tp + m.fp);
  const recall = m.tp + m.fn === 0 ? 1 : m.tp / (m.tp + m.fn);
  const score = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1: score };
}

export function evaluate(thresholds: number[] = [0.5, 0.6, 0.7]): AxisReport[] {
  const humanTurns = TRANSCRIPT.filter((u) => u.speaker !== 'agent');
  const scored = humanTurns.map((u) => {
    const idx = TRANSCRIPT.indexOf(u);
    return { u, s: scoreOne(u, TRANSCRIPT.slice(0, idx)) };
  });

  const reports: AxisReport[] = [];
  for (const axis of ['addressed', 'salient'] as const) {
    for (const threshold of thresholds) {
      const m: ConfusionMatrix = { tp: 0, fp: 0, tn: 0, fn: 0 };
      for (const { u, s } of scored) {
        const predicted = s[axis] >= threshold;
        const actual = u[axis];
        if (predicted && actual) m.tp++;
        else if (predicted && !actual) m.fp++;
        else if (!predicted && !actual) m.tn++;
        else m.fn++;
      }
      reports.push({ axis, threshold, matrix: m, ...f1(m) });
    }
  }
  return reports;
}

export function formatReport(): string {
  const lines = [
    '# Addressivity confusion matrix (§2.6)',
    '',
    '⚠️ SYNTHETIC transcript (see bench/addressivity-fixture.ts header). Replace',
    'with a real recorded two-person session and re-run for a number to report.',
    '',
    `Utterances: ${TRANSCRIPT.filter((u) => u.speaker !== 'agent').length} human turns, prefilter only (no model).`,
    '',
    '| axis | τ | TP | FP | TN | FN | precision | recall | F1 |',
    '|---|--:|--:|--:|--:|--:|--:|--:|--:|',
  ];
  for (const r of evaluate()) {
    lines.push(
      `| ${r.axis} | ${r.threshold} | ${r.matrix.tp} | ${r.matrix.fp} | ${r.matrix.tn} | ${r.matrix.fn} | ${r.precision.toFixed(2)} | ${r.recall.toFixed(2)} | ${r.f1.toFixed(2)} |`
    );
  }
  lines.push('');
  lines.push('Reference points from published systems: ~2.1% false-trigger at τ=0.70;');
  lines.push('F1 degrades 0.98 (one speaker) → 0.91 (four speakers).');
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(formatReport());
}
