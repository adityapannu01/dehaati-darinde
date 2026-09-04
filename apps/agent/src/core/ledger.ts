import type { LedgerEvent, LedgerEventType } from '@repo/protocol';

const DEFAULT_CAPACITY = 500;

/** Ring buffer of ledger events, driving the browser's live event stream. */
export class EventLedger {
  private events: LedgerEvent[] = [];
  private seq = 0;
  private capacity: number;
  private onPush: ((event: LedgerEvent) => void) | undefined;

  constructor(opts?: { capacity?: number; onPush?: (event: LedgerEvent) => void }) {
    this.capacity = opts?.capacity ?? DEFAULT_CAPACITY;
    this.onPush = opts?.onPush;
  }

  /** Attach or replace the push hook after construction (e.g. once the transport is ready). */
  setOnPush(onPush: ((event: LedgerEvent) => void) | undefined): void {
    this.onPush = onPush;
  }

  push(type: LedgerEventType, generation: number, detail?: string): LedgerEvent {
    this.seq += 1;
    const event: LedgerEvent = {
      seq: this.seq,
      t: Date.now(),
      generation,
      type,
      detail,
    };
    this.events.push(event);
    if (this.events.length > this.capacity) {
      this.events.shift();
    }
    this.onPush?.(event);
    return event;
  }

  /** Every event with seq > `seq`, in order. */
  since(seq: number): LedgerEvent[] {
    return this.events.filter((e) => e.seq > seq);
  }

  all(): readonly LedgerEvent[] {
    return this.events;
  }
}
