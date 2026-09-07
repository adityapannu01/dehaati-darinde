import { describe, expect, it } from 'vitest';
import { GenerationManager } from './generation.ts';

describe('GenerationManager', () => {
  it('assigns ids starting from 1 and increasing', () => {
    const gm = new GenerationManager();
    const g1 = gm.start('add a redis cache');
    const g2 = gm.start('now add postgres');
    expect(g1.id).toBe(1);
    expect(g2.id).toBe(2);
  });

  it('isCurrent is true for the newest generation and false for older ones', () => {
    const gm = new GenerationManager();
    const g1 = gm.start('first');
    const g2 = gm.start('second');
    expect(gm.isCurrent(g2.id)).toBe(true);
    expect(gm.isCurrent(g1.id)).toBe(false);
  });

  it('cancelCurrent fires the abort signal and fences that generation', () => {
    const gm = new GenerationManager();
    const g1 = gm.start('first');
    let aborted = false;
    g1.abort.signal.addEventListener('abort', () => {
      aborted = true;
    });

    gm.cancelCurrent();

    expect(aborted).toBe(true);
    expect(g1.status).toBe('cancelled');
    expect(g1.cancelledAt).toBeTypeOf('number');
    expect(gm.isCurrent(g1.id)).toBe(false);

    const g2 = gm.start('second');
    expect(g2.id).toBe(2);
    expect(gm.isCurrent(g2.id)).toBe(true);
  });

  it('cancelled generations stay retrievable with status "cancelled"', () => {
    const gm = new GenerationManager();
    const g1 = gm.start('first');
    gm.cancelCurrent();
    expect(gm.get(g1.id)?.status).toBe('cancelled');
    expect(gm.history()).toHaveLength(1);
  });

  it('complete() marks an active generation completed and leaves others untouched', () => {
    const gm = new GenerationManager();
    const g1 = gm.start('first');
    gm.complete(g1.id);
    expect(gm.get(g1.id)?.status).toBe('completed');
  });

  it('cancelCurrent on an already-cancelled generation is a no-op', () => {
    const gm = new GenerationManager();
    const g1 = gm.start('first');
    gm.cancelCurrent();
    const cancelledAt = gm.get(g1.id)?.cancelledAt;
    gm.cancelCurrent();
    expect(gm.get(g1.id)?.cancelledAt).toBe(cancelledAt);
  });

  it('baselineMode: true makes every generation report as current, even stale ones', () => {
    const gm = new GenerationManager({ baselineMode: true });
    const g1 = gm.start('first');
    gm.start('second');
    expect(gm.isCurrent(g1.id)).toBe(true);
  });

  it('currentId is 0 before any generation has started', () => {
    const gm = new GenerationManager();
    expect(gm.currentId).toBe(0);
  });

  // B1 fix (b) — AgentFalseInterruption recovery
  it('restore() un-cancels the most recent generation with a fresh abort signal', () => {
    const gm = new GenerationManager();
    const g1 = gm.start('first');
    gm.cancelCurrent();
    const staleSignal = g1.abort.signal;

    expect(gm.restore(g1.id)).toBe(true);
    expect(gm.isCurrent(g1.id)).toBe(true);
    expect(gm.get(g1.id)?.status).toBe('active');
    expect(gm.get(g1.id)?.cancelledAt).toBeUndefined();
    expect(gm.get(g1.id)?.abort.signal).not.toBe(staleSignal);
    expect(gm.get(g1.id)?.abort.signal.aborted).toBe(false);
  });

  it('restore() refuses once a genuinely newer generation has started', () => {
    const gm = new GenerationManager();
    const g1 = gm.start('first');
    gm.cancelCurrent();
    const g2 = gm.start('second — a real new turn');

    expect(gm.restore(g1.id)).toBe(false);
    expect(gm.isCurrent(g2.id)).toBe(true);
    expect(gm.isCurrent(g1.id)).toBe(false);
  });

  it('restore() on an unknown id is a no-op returning false', () => {
    const gm = new GenerationManager();
    gm.start('first');
    expect(gm.restore(999)).toBe(false);
  });
});
