import type { MutationOp } from '@repo/protocol';
import { describe, expect, it } from 'vitest';
import { CanvasStore } from './canvas.ts';
import { CommitGate } from './commit-gate.ts';
import { EventLedger } from './ledger.ts';
import { StagingBuffer } from './staging.ts';

function addNode(id: string, label: string): MutationOp {
  return { op: 'addNode', node: { id, label, kind: 'service', x: 0, y: 0 } };
}

function word(text: string, i: number) {
  return { text, startTime: i, endTime: i + 0.4 };
}

// Sentence 0: "Adding Redis." (2 words)
const SENTENCE_1 = ['Adding', ' Redis.'];

function build(baselineMode = false) {
  const canvas = new CanvasStore();
  const staging = new StagingBuffer();
  const ledger = new EventLedger();
  const gate = new CommitGate({ canvas, staging, ledger, baselineMode });
  return { canvas, staging, ledger, gate };
}

describe('CommitGate', () => {
  it('commits only the mutations covered by delivered sentences, drops the rest on interruption', () => {
    const { canvas, gate } = build();
    gate.startGeneration();

    gate.stage(1, 0, 'Redis', addNode('redis', 'Redis'));
    gate.stage(1, 1, 'Mongo', addNode('mongo', 'Mongo'));
    gate.stage(1, 2, 'Postgres', addNode('postgres', 'Postgres'));

    // Deliver sentence 0 only (2 words), leave the rest un-delivered.
    let i = 0;
    for (const w of SENTENCE_1) gate.onWord(1, word(w, i++));

    expect(canvas.nodeCount).toBe(1);

    gate.onInterrupted(1);

    expect(canvas.nodeCount).toBe(1); // still just the first one
  });

  it('onTurnComplete commits everything still pending (uninterrupted path)', () => {
    const { canvas, gate } = build();
    gate.startGeneration();

    gate.stage(1, 0, 'Redis', addNode('redis', 'Redis'));
    gate.stage(1, 1, 'Mongo', addNode('mongo', 'Mongo'));
    gate.stage(1, 2, 'Postgres', addNode('postgres', 'Postgres'));

    let i = 0;
    for (const w of SENTENCE_1) gate.onWord(1, word(w, i++));
    expect(canvas.nodeCount).toBe(1);

    gate.onTurnComplete(1);

    expect(canvas.nodeCount).toBe(3);
  });

  it('baselineMode: true commits everything immediately at stage time, even when the stream is cut', () => {
    const { canvas, gate } = build(true);
    gate.startGeneration();

    gate.stage(1, 0, 'Redis', addNode('redis', 'Redis'));
    gate.stage(1, 1, 'Mongo', addNode('mongo', 'Mongo'));
    gate.stage(1, 2, 'Postgres', addNode('postgres', 'Postgres'));

    expect(canvas.nodeCount).toBe(3); // already committed, no words ever delivered

    gate.onInterrupted(1); // no-op in baseline mode; nothing to drop

    expect(canvas.nodeCount).toBe(3);
  });

  it('flags an anchor mismatch on the ledger without blocking the commit', () => {
    const { canvas, ledger, gate } = build();
    gate.startGeneration();

    // anchorPhrase "Kafka" never actually gets spoken in the delivered sentence.
    gate.stage(1, 0, 'Kafka', addNode('kafka', 'Kafka'));

    let i = 0;
    for (const w of SENTENCE_1) gate.onWord(1, word(w, i++)); // says "Adding Redis." not Kafka

    expect(canvas.nodeCount).toBe(1); // still committed
    const committedEvent = ledger.all().find((e) => e.type === 'mutation_committed');
    expect(committedEvent?.detail).toContain('anchor_mismatch');
  });

  it('does not flag a mismatch when the anchor phrase was actually said', () => {
    const { ledger, gate } = build();
    gate.startGeneration();
    gate.stage(1, 0, 'Redis', addNode('redis', 'Redis'));

    let i = 0;
    for (const w of SENTENCE_1) gate.onWord(1, word(w, i++));

    const committedEvent = ledger.all().find((e) => e.type === 'mutation_committed');
    expect(committedEvent?.detail).not.toContain('anchor_mismatch');
  });

  it('pendingText is the generated text beyond what has been spoken', () => {
    const { gate } = build();
    gate.startGeneration();
    gate.onGeneratedChunk("Adding Redis. Now wiring it to the gateway.");

    let i = 0;
    for (const w of SENTENCE_1) gate.onWord(1, word(w, i++)); // only "Adding Redis." spoken so far

    expect(gate.spokenText).toBe('Adding Redis.');
    expect(gate.pendingText).toBe('Now wiring it to the gateway.');
  });

  it('pendingText is empty when the spoken prefix does not match the generated text', () => {
    const { gate } = build();
    gate.startGeneration();
    gate.onGeneratedChunk('Something completely different.');

    let i = 0;
    for (const w of SENTENCE_1) gate.onWord(1, word(w, i++));

    expect(gate.pendingText).toBe('');
  });

  it('startGeneration() resets the generated-text accumulator', () => {
    const { gate } = build();
    gate.startGeneration();
    gate.onGeneratedChunk('Leftover from generation 1.');
    gate.startGeneration();
    expect(gate.pendingText).toBe('');
  });
});
