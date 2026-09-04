import { randomUUID } from 'node:crypto';
import type { MutationOp, StagedMutation } from '@repo/protocol';

// Tools never mutate the canvas directly — they stage a mutation here, keyed
// by generation. A staged mutation only reaches CanvasStore once CommitGate
// has confirmed Rime actually delivered the sentence describing it.
export class StagingBuffer {
  private buffers = new Map<number, StagedMutation[]>();

  stage(
    generation: number,
    sentenceIndex: number,
    anchorPhrase: string,
    mutation: MutationOp,
  ): StagedMutation {
    const staged: StagedMutation = {
      id: randomUUID(),
      generation,
      sentenceIndex,
      anchorPhrase,
      mutation,
    };
    const list = this.buffers.get(generation) ?? [];
    list.push(staged);
    this.buffers.set(generation, list);
    return staged;
  }

  /** In staging order. */
  pendingFor(generation: number): StagedMutation[] {
    return [...(this.buffers.get(generation) ?? [])];
  }

  /** Pops and applies every pending mutation for `generation` whose sentenceIndex <= sentenceIndex. */
  commitThrough(
    generation: number,
    sentenceIndex: number,
    apply: (mutation: MutationOp) => void,
  ): StagedMutation[] {
    const list = this.buffers.get(generation) ?? [];
    const committed: StagedMutation[] = [];
    const remaining: StagedMutation[] = [];
    for (const item of list) {
      if (item.sentenceIndex <= sentenceIndex) {
        committed.push(item);
      } else {
        remaining.push(item);
      }
    }
    this.buffers.set(generation, remaining);
    for (const item of committed) apply(item.mutation);
    return committed;
  }

  /** Discards everything still pending for `generation`, returning what was dropped. */
  dropAll(generation: number): StagedMutation[] {
    const list = this.buffers.get(generation) ?? [];
    this.buffers.delete(generation);
    return list;
  }
}
