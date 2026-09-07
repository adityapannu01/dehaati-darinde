import type { MutationOp, StagedMutation } from '@repo/protocol';
import type { CanvasStore } from './canvas.ts';
import { DeliveryTracker, type SpokenWord } from './delivery.ts';
import type { EventLedger } from './ledger.ts';
import type { StagingBuffer } from './staging.ts';

export interface CommitGateOptions {
  canvas: CanvasStore;
  staging: StagingBuffer;
  ledger: EventLedger;
  /** true = disable the commit gate: mutations land the instant they're staged. */
  baselineMode?: boolean;
}

/**
 * The signature feature: a staged mutation reaches the canvas only once Rime
 * has actually delivered the sentence describing it. Tools call `stage()`
 * here (instead of touching StagingBuffer directly) so baselineMode has one
 * place to live: skip the gate entirely and commit at stage time.
 */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Why a batch of mutations committed — recorded in the ledger for debugging and the demo. */
type CommitReason = 'delivery' | 'catchup' | 'turn_end';

export class CommitGate {
  private canvas: CanvasStore;
  private staging: StagingBuffer;
  private ledger: EventLedger;
  private baselineMode: boolean;
  private tracker = new DeliveryTracker();
  // Text tapped off the TTS input side (CanvasAgent.ttsNode) — ahead of audio,
  // unlike tracker.spokenText which only advances as words are actually heard.
  private generatedText = '';
  // Generations fenced by an interruption. A slow tool that passed its own
  // gm.isCurrent() check a beat before the interruption landed can still reach
  // stage() afterwards; staging it would buffer a mutation that can never
  // commit and log a misleading mutation_staged for a dead generation.
  private sealed = new Set<number>();

  constructor(opts: CommitGateOptions) {
    this.canvas = opts.canvas;
    this.staging = opts.staging;
    this.ledger = opts.ledger;
    this.baselineMode = opts.baselineMode ?? false;
  }

  /**
   * Tools call this instead of StagingBuffer.stage() directly. Returns the
   * staged mutation, or `undefined` when the generation has been sealed by an
   * interruption (F5) — nothing is buffered in that case.
   */
  stage(
    generation: number,
    sentenceIndex: number,
    anchorPhrase: string,
    mutation: MutationOp,
  ): StagedMutation | undefined {
    if (!this.baselineMode && this.sealed.has(generation)) {
      // The interruption already fenced this generation. Don't buffer (it
      // could never commit — the tracker's been reset) and don't emit a
      // mutation_staged for a cancelled generation: that just looks wrong in
      // the ledger the demo reads from.
      this.ledger.push('mutation_dropped', generation, 'staged after interruption');
      return undefined;
    }

    const staged = this.staging.stage(generation, sentenceIndex, anchorPhrase, mutation);
    this.ledger.push('mutation_staged', generation, staged.id);

    if (this.baselineMode) {
      // Naive mode: no commit gate. The mutation lands immediately, whether
      // or not the sentence describing it is ever actually spoken.
      this.staging.commitThrough(generation, sentenceIndex, (m) => this.canvas.apply(m));
      this.ledger.push('mutation_committed', generation, staged.id);
      return staged;
    }

    // Catch-up commit (F1). A slow tool can call stage() after the sentence
    // describing its mutation has *already* been delivered — without this the
    // mutation waits for onTurnComplete and the canvas fills in one batch at
    // the end of the turn. The commit rule is "the sentence was heard AND the
    // generation is current"; the sentenceCount proves the first and the
    // caller fence-checked gm.isCurrent(gen) immediately before calling us, so
    // this is the same legal commit, just triggered from the other side of
    // the race.
    if (this.tracker.sentenceCount > sentenceIndex) {
      this.commitThroughSentence(generation, sentenceIndex, 'catchup');
    }
    return staged;
  }

  /** Call once per new generation, before its speech starts. */
  startGeneration(): void {
    this.tracker.reset();
    this.generatedText = '';
  }

  /** Feed a chunk off the TTS-input tap (see canvas-agent.ts's ttsNode override). */
  onGeneratedChunk(text: string): void {
    this.generatedText += text;
  }

  /** Everything confirmed delivered so far in the current generation — shown in the HUD. */
  get heardText(): string {
    return this.tracker.deliveredText;
  }

  /** Everything actually spoken, including an in-flight unterminated sentence — for display only. */
  get spokenText(): string {
    return this.tracker.spokenText;
  }

  /**
   * Generated text beyond what's been spoken — "not yet heard". Never
   * claims text that doesn't actually match what's coming: if the generated
   * accumulator doesn't start with the spoken prefix (a resync glitch,
   * stream reordering, whatever), this returns '' rather than guess. Showing
   * nothing is correct; showing the wrong ghost text is a false claim on screen.
   */
  get pendingText(): string {
    const generated = normalizeWhitespace(this.generatedText);
    const spoken = normalizeWhitespace(this.tracker.spokenText);
    if (!generated.startsWith(spoken)) return '';
    return generated.slice(spoken.length).trimStart();
  }

  /** Feed a word off the transcription stream tap (see canvas-agent.ts). */
  onWord(generation: number, word: SpokenWord): void {
    if (this.baselineMode) return;
    const before = this.tracker.sentenceCount;
    const after = this.tracker.push(word);
    if (after > before) {
      this.commitThroughSentence(generation, after - 1, 'delivery');
    }
  }

  /** The reply finished uninterrupted: commit anything still pending (covers a final sentence whose terminal punctuation the TTS elided). */
  onTurnComplete(generation: number): void {
    if (this.baselineMode) return;
    const pending = this.staging.pendingFor(generation);
    if (pending.length === 0) return;
    const maxSentenceIndex = Math.max(...pending.map((p) => p.sentenceIndex));
    this.commitThroughSentence(generation, maxSentenceIndex, 'turn_end');
  }

  /** The user cut the agent off. Never commit here — drop whatever wasn't already committed. */
  onInterrupted(generation: number): void {
    if (this.baselineMode) return;
    this.sealed.add(generation);
    // Bound the set across a long session without dropping a seal that could
    // still matter — a handful of generations is far more than any
    // interrupt-to-stage window spans, and pruning here (the only place it
    // grows) is immune to the UserInputTranscribed/ConversationItemAdded
    // ordering caveat that a prune in startGeneration() would race.
    while (this.sealed.size > 8) {
      const oldest = this.sealed.values().next().value;
      if (oldest === undefined) break;
      this.sealed.delete(oldest);
    }
    const dropped = this.staging.dropAll(generation);
    for (const item of dropped) {
      this.ledger.push('mutation_dropped', generation, item.id);
    }
  }

  private commitThroughSentence(
    generation: number,
    throughSentenceIndex: number,
    reason: CommitReason,
  ): void {
    const committed = this.staging.commitThrough(generation, throughSentenceIndex, (m) =>
      this.canvas.apply(m),
    );
    const heard = this.tracker.deliveredText.toLowerCase();
    for (const item of committed) {
      // Mismatch guard: never blocks a commit, just flags it for the ledger.
      const matched = heard.includes(item.anchorPhrase.toLowerCase());
      this.ledger.push(
        'mutation_committed',
        generation,
        `${item.id} ${reason}${matched ? '' : ' anchor_mismatch'}`,
      );
    }
    // A catch-up commit fires because a mutation showed up late, not because a
    // new sentence was delivered — claiming one here would double-count and
    // corrupt the ledger the demo reads from.
    if (reason !== 'catchup') {
      this.ledger.push('sentence_delivered', generation, String(throughSentenceIndex + 1));
    }
  }
}
