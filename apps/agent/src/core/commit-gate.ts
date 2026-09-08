import type { FormingElement, MutationOp, StagedMutation } from '@repo/protocol';
import type { CanvasStore } from './canvas.ts';
import { applyLexicon } from './lexicon.ts';
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
  // The generation the generatedText accumulator currently belongs to. A tail
  // TTS-input chunk from a superseded generation must not append to the new
  // one's buffer (B1 fix a, display side).
  private generatedTextGen = 0;
  // Generations fenced by an interruption. A slow tool that passed its own
  // gm.isCurrent() check a beat before the interruption landed can still reach
  // stage() afterwards; staging it would buffer a mutation that can never
  // commit and log a misleading mutation_staged for a dead generation.
  private sealed = new Set<number>();
  // Every mutation id ever staged, and every one that reached a terminal state
  // (committed or dropped). A staged id that never reaches `resolvedIds` is a
  // silent orphan — the exact B1 failure mode. `orphanedMutationIds` turns
  // "silent orphaning is impossible" into an assertion the tests enforce.
  private stagedIds = new Set<string>();
  private resolvedIds = new Set<string>();

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
    this.stagedIds.add(staged.id);
    // The anchor phrase goes into the ledger detail (not just the id) so a
    // captured session log is self-sufficient for an independent, offline
    // audit of "was this actually heard before it committed" — see
    // bench/audit-session.ts, which never imports this file.
    this.ledger.push('mutation_staged', generation, `${staged.id} anchor="${anchorPhrase}"`);

    if (this.baselineMode) {
      // Naive mode: no commit gate. The mutation lands immediately, whether
      // or not the sentence describing it is ever actually spoken.
      this.staging.commitThrough(generation, sentenceIndex, (m) => this.canvas.apply(m));
      this.resolvedIds.add(staged.id);
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

  /**
   * Un-seal a generation that main.ts fenced on a suspected interruption which
   * LiveKit then classified as false (`AgentFalseInterruption`). The agent's
   * paused speech is resuming, so its remaining sentences must be allowed to
   * commit their still-staged mutations (B1 fix b).
   */
  unfence(generation: number): void {
    this.sealed.delete(generation);
  }

  /** Staged mutation ids that never reached a terminal state — must always be empty. */
  get orphanedMutationIds(): string[] {
    return [...this.stagedIds].filter((id) => !this.resolvedIds.has(id));
  }

  /**
   * Additive elements staged for `generation` but not yet committed — the
   * browser renders these as "forming" while their sentence is spoken (§3.3).
   * Only addNode/addEdge are shown; a rename/replace/remove/clear has no
   * meaningful pre-commit visual.
   */
  formingElements(generation: number): FormingElement[] {
    const out: FormingElement[] = [];
    for (const staged of this.staging.pendingFor(generation)) {
      const m = staged.mutation;
      if (m.op === 'addNode') {
        out.push({
          id: m.node.id,
          element: 'node',
          label: m.node.label,
          kind: m.node.kind,
          anchorPhrase: staged.anchorPhrase,
        });
      } else if (m.op === 'addEdge') {
        out.push({
          id: m.edge.id,
          element: 'edge',
          label: m.edge.label ?? '',
          source: m.edge.source,
          target: m.edge.target,
          anchorPhrase: staged.anchorPhrase,
        });
      }
    }
    return out;
  }

  /**
   * Feed a chunk off the TTS-input tap (see canvas-agent.ts's ttsNode override).
   * `generation` is captured when the tts stream opened, so a late chunk from a
   * superseded turn resets rather than corrupts the new turn's buffer.
   */
  onGeneratedChunk(text: string, generation?: number): void {
    if (generation !== undefined && generation !== this.generatedTextGen) {
      this.generatedTextGen = generation;
      this.generatedText = '';
    }
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
      this.resolvedIds.add(item.id);
      this.ledger.push('mutation_dropped', generation, item.id);
    }
    this.pruneAccounting();
  }

  /**
   * Bound the orphan-accounting sets over a long session. Only prune ids that
   * have already resolved — an unresolved staged id is either legitimately
   * in-flight or a bug we want the assertion to catch, never something to
   * quietly forget.
   */
  private pruneAccounting(): void {
    if (this.stagedIds.size <= 256) return;
    for (const id of this.stagedIds) {
      if (this.stagedIds.size <= 128) break;
      if (this.resolvedIds.has(id)) {
        this.stagedIds.delete(id);
        this.resolvedIds.delete(id);
      }
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
    // §3.3: normalise BOTH sides through the pronunciation lexicon before
    // comparing. Rime echoes back the words it actually spoke — i.e. the
    // post-respelling text ("engine ex", not "nginx") — so without this every
    // commit of a respelled component would be flagged anchor_mismatch.
    const heard = applyLexicon(this.tracker.deliveredText).toLowerCase();
    for (const item of committed) {
      this.resolvedIds.add(item.id);
      // Mismatch guard: never blocks a commit, just flags it for the ledger.
      const matched = heard.includes(applyLexicon(item.anchorPhrase).toLowerCase());
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
