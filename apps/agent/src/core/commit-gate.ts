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

export class CommitGate {
  private canvas: CanvasStore;
  private staging: StagingBuffer;
  private ledger: EventLedger;
  private baselineMode: boolean;
  private tracker = new DeliveryTracker();
  // Text tapped off the TTS input side (CanvasAgent.ttsNode) — ahead of audio,
  // unlike tracker.spokenText which only advances as words are actually heard.
  private generatedText = '';

  constructor(opts: CommitGateOptions) {
    this.canvas = opts.canvas;
    this.staging = opts.staging;
    this.ledger = opts.ledger;
    this.baselineMode = opts.baselineMode ?? false;
  }

  /** Tools call this instead of StagingBuffer.stage() directly. */
  stage(
    generation: number,
    sentenceIndex: number,
    anchorPhrase: string,
    mutation: MutationOp,
  ): StagedMutation {
    const staged = this.staging.stage(generation, sentenceIndex, anchorPhrase, mutation);
    this.ledger.push('mutation_staged', generation, staged.id);
    if (this.baselineMode) {
      // Naive mode: no commit gate. The mutation lands immediately, whether
      // or not the sentence describing it is ever actually spoken.
      this.staging.commitThrough(generation, sentenceIndex, (m) => this.canvas.apply(m));
      this.ledger.push('mutation_committed', generation, staged.id);
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
      this.commitThroughSentence(generation, after - 1);
    }
  }

  /** The reply finished uninterrupted: commit anything still pending (covers a final sentence whose terminal punctuation the TTS elided). */
  onTurnComplete(generation: number): void {
    if (this.baselineMode) return;
    const pending = this.staging.pendingFor(generation);
    if (pending.length === 0) return;
    const maxSentenceIndex = Math.max(...pending.map((p) => p.sentenceIndex));
    this.commitThroughSentence(generation, maxSentenceIndex);
  }

  /** The user cut the agent off. Never commit here — drop whatever wasn't already committed. */
  onInterrupted(generation: number): void {
    if (this.baselineMode) return;
    const dropped = this.staging.dropAll(generation);
    for (const item of dropped) {
      this.ledger.push('mutation_dropped', generation, item.id);
    }
  }

  private commitThroughSentence(generation: number, throughSentenceIndex: number): void {
    const committed = this.staging.commitThrough(generation, throughSentenceIndex, (m) =>
      this.canvas.apply(m),
    );
    const heard = this.tracker.deliveredText.toLowerCase();
    for (const item of committed) {
      // Mismatch guard: never blocks a commit, just flags it for the ledger.
      const matched = heard.includes(item.anchorPhrase.toLowerCase());
      this.ledger.push('mutation_committed', generation, matched ? item.id : `${item.id} anchor_mismatch`);
    }
    this.ledger.push('sentence_delivered', generation, String(throughSentenceIndex + 1));
  }
}
