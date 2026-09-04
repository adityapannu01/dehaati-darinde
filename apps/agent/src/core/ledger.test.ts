import { describe, expect, it } from 'vitest';
import { EventLedger } from './ledger.ts';

describe('EventLedger', () => {
  it('seq is monotonically increasing', () => {
    const ledger = new EventLedger();
    const e1 = ledger.push('generation_started', 1);
    const e2 = ledger.push('tool_started', 1, 'addService(Redis)');
    expect(e2.seq).toBe(e1.seq + 1);
  });

  it('since(seq) returns only events after that seq', () => {
    const ledger = new EventLedger();
    ledger.push('generation_started', 1);
    const cut = ledger.push('tool_started', 1).seq;
    ledger.push('tool_completed', 1);
    ledger.push('mutation_staged', 1);
    expect(ledger.since(cut).map((e) => e.type)).toEqual(['tool_completed', 'mutation_staged']);
  });

  it('caps at capacity without throwing, dropping the oldest', () => {
    const ledger = new EventLedger({ capacity: 3 });
    for (let i = 0; i < 10; i++) ledger.push('tool_started', 1, String(i));
    const all = ledger.all();
    expect(all).toHaveLength(3);
    expect(all[0]?.detail).toBe('7');
    expect(all[2]?.detail).toBe('9');
    // seq keeps counting even though old entries were evicted.
    expect(all[2]?.seq).toBe(10);
  });

  it('calls onPush for every pushed event', () => {
    const pushed: string[] = [];
    const ledger = new EventLedger({ onPush: (e) => pushed.push(e.type) });
    ledger.push('generation_started', 1);
    ledger.push('generation_cancelled', 1);
    expect(pushed).toEqual(['generation_started', 'generation_cancelled']);
  });

  it('setOnPush attaches/replaces the hook after construction', () => {
    const pushed: string[] = [];
    const ledger = new EventLedger();
    ledger.push('generation_started', 1); // before any hook is attached
    ledger.setOnPush((e) => pushed.push(e.type));
    ledger.push('generation_cancelled', 1);
    ledger.setOnPush(undefined);
    ledger.push('tool_started', 1);
    expect(pushed).toEqual(['generation_cancelled']);
  });
});
