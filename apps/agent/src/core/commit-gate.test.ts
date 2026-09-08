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

  // §3.3 — a respelled term must NOT trip the anchor mismatch flag
  it('normalises both sides through the lexicon: a component named "nginx" commits without anchor_mismatch', () => {
    const { canvas, ledger, gate } = build();
    gate.startGeneration();
    // The tool anchor is the real spelling; Rime echoes back the RESPELLED words.
    gate.stage(1, 0, 'nginx', addNode('nginx', 'nginx'));

    // "I'm adding engine ex." — what Rime actually spoke, post-lexicon.
    let i = 0;
    for (const w of ["I'm", ' adding', ' engine', ' ex.']) gate.onWord(1, word(w, i++));

    expect(canvas.nodeCount).toBe(1);
    const committed = ledger.all().find((e) => e.type === 'mutation_committed');
    expect(committed?.detail).not.toContain('anchor_mismatch');
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

  // F1 — catch-up commit at stage time
  it('commits a mutation immediately when its sentence was already delivered before it staged', () => {
    const { canvas, ledger, gate } = build();
    gate.startGeneration();

    // Sentence 0 is delivered while the (slow) tool is still working — the
    // staging buffer is empty when commitThroughSentence runs off onWord.
    let i = 0;
    for (const w of SENTENCE_1) gate.onWord(1, word(w, i++));
    expect(canvas.nodeCount).toBe(0);

    // The tool finally stages mutations[0]. It must not wait for onTurnComplete.
    gate.stage(1, 0, 'Redis', addNode('redis', 'Redis'));
    expect(canvas.nodeCount).toBe(1);

    const committed = ledger.all().filter((e) => e.type === 'mutation_committed');
    expect(committed).toHaveLength(1);
    expect(committed[0]?.detail).toContain('catchup');

    // A catch-up is not a new sentence delivery — only the one from onWord.
    const delivered = ledger.all().filter((e) => e.type === 'sentence_delivered');
    expect(delivered).toHaveLength(1);
  });

  it('does not catch-up commit a mutation whose sentence has not been delivered yet', () => {
    const { canvas, gate } = build();
    gate.startGeneration();

    // Only sentence 0 delivered; mutations[1] stages late but its sentence
    // (index 1) was never heard.
    let i = 0;
    for (const w of SENTENCE_1) gate.onWord(1, word(w, i++));
    gate.stage(1, 1, 'Mongo', addNode('mongo', 'Mongo'));

    expect(canvas.nodeCount).toBe(0);
  });

  // F5 — seal a generation on interruption
  it('refuses to stage into an interrupted generation and logs mutation_dropped, not mutation_staged', () => {
    const { canvas, ledger, gate } = build();
    gate.startGeneration();

    gate.onInterrupted(1);
    const result = gate.stage(1, 0, 'Redis', addNode('redis', 'Redis'));

    expect(result).toBeUndefined();
    expect(canvas.nodeCount).toBe(0);
    expect(ledger.all().some((e) => e.type === 'mutation_staged')).toBe(false);
    const dropped = ledger.all().filter((e) => e.type === 'mutation_dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.detail).toContain('after interruption');
  });

  // §3.3 — forming elements
  it('exposes staged addNode/addEdge as forming elements, and drops them once committed', () => {
    const { gate } = build();
    gate.startGeneration();
    gate.stage(1, 0, 'Redis', addNode('redis', 'Redis'));
    gate.stage(1, 1, 'API', { op: 'addEdge', edge: { id: 'api-redis', source: 'api', target: 'redis' } });

    const forming = gate.formingElements(1);
    expect(forming.map((f) => f.id).sort()).toEqual(['api-redis', 'redis']);
    expect(forming.find((f) => f.id === 'redis')).toMatchObject({
      element: 'node',
      label: 'Redis',
      anchorPhrase: 'Redis',
    });

    let i = 0;
    for (const w of SENTENCE_1) gate.onWord(1, word(w, i++)); // commits sentence 0 -> the node
    expect(gate.formingElements(1).map((f) => f.id)).toEqual(['api-redis']); // node gone, edge still forming
  });

  it('does not surface rename/remove/clear as forming elements (no pre-commit visual)', () => {
    const { gate } = build();
    gate.startGeneration();
    gate.stage(1, 0, 'clear', { op: 'clear' });
    gate.stage(1, 1, 'X', { op: 'removeNode', nodeId: 'x' });
    expect(gate.formingElements(1)).toEqual([]);
  });

  // B1 — orphan accounting + un-fence
  it('every staged mutation reaches a terminal state — committed or dropped, never orphaned', () => {
    const { gate } = build();
    gate.startGeneration();
    gate.stage(1, 0, 'Redis', addNode('redis', 'Redis'));
    gate.stage(1, 1, 'Mongo', addNode('mongo', 'Mongo'));

    let i = 0;
    for (const w of SENTENCE_1) gate.onWord(1, word(w, i++)); // commits Redis
    gate.onInterrupted(1); // drops Mongo

    expect(gate.orphanedMutationIds).toEqual([]);
  });

  /**
   * Live-observed 2026-09-08: a correction arrived so fast that the previous
   * generation never spoke a single word before being superseded. The SDK
   * only emits ConversationItemAdded (which is what normally drives
   * onInterrupted) when some text was actually forwarded — with zero words
   * ever delivered, that event never fires, so main.ts now calls
   * onInterrupted eagerly itself as soon as it sees `spokenText` is empty,
   * rather than waiting for an event that will never come. This is the
   * CommitGate-level half of that fix: onInterrupted must still resolve
   * cleanly — not just when interrupted mid-sentence (the test above), but
   * when NO word was ever delivered for the generation at all.
   */
  it('a generation interrupted before it ever spoke a word still resolves cleanly, not as an orphan', () => {
    const { gate } = build();
    gate.startGeneration();
    gate.stage(1, 0, 'Redis cache', addNode('redis', 'Redis cache'));

    // No onWord calls at all — the generation never spoke anything.
    gate.onInterrupted(1);

    expect(gate.orphanedMutationIds).toEqual([]);
  });

  it('unfence() reverses a seal so the generation can stage and commit again', () => {
    const { canvas, gate } = build();
    gate.startGeneration();

    gate.onInterrupted(1); // sealed
    expect(gate.stage(1, 0, 'Redis', addNode('redis', 'Redis'))).toBeUndefined();

    gate.unfence(1); // AgentFalseInterruption: it was never a real interruption
    const staged = gate.stage(1, 0, 'Redis', addNode('redis', 'Redis'));
    expect(staged).toBeDefined();

    let i = 0;
    for (const w of SENTENCE_1) gate.onWord(1, word(w, i++));
    expect(canvas.nodeCount).toBe(1);
    expect(gate.orphanedMutationIds).toEqual([]);
  });

  it('a fresh generation is not sealed by a previous generation being interrupted', () => {
    const { canvas, gate } = build();
    gate.startGeneration();
    gate.onInterrupted(1);

    // Generation 2 opens and behaves normally.
    gate.startGeneration();
    gate.stage(2, 0, 'Redis', addNode('redis', 'Redis'));
    let i = 0;
    for (const w of SENTENCE_1) gate.onWord(2, word(w, i++));

    expect(canvas.nodeCount).toBe(1);
  });
});
