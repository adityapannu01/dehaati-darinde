import { describe, expect, it, vi } from 'vitest';
import { enrichComponent } from './enrich.ts';

describe('enrichComponent (§5.4 — the real slow tool)', () => {
  it('answers common infra terms from the bundled fixture with no network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await enrichComponent('Redis');
    expect(r.source).toBe('fixture');
    expect(r.summary).toContain('in-memory');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('normalises the label before the fixture lookup', async () => {
    expect((await enrichComponent('PostgreSQL')).source).toBe('fixture');
    expect((await enrichComponent('  kafka ')).source).toBe('fixture');
  });

  it('does not hit the network when live is false and there is no fixture', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await enrichComponent('SomeInternalService', { live: false });
    expect(r).toEqual({ summary: null, source: 'none' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('an already-aborted signal yields a graceful null, not a throw', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await enrichComponent('NonFixtureThing', { abortSignal: ac.signal, timeoutMs: 50 });
    expect(r.summary).toBeNull();
  });

  it('a fetch failure falls back to null rather than propagating', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const r = await enrichComponent('NonFixtureThing');
    expect(r).toEqual({ summary: null, source: 'none' });
    fetchSpy.mockRestore();
  });
});
