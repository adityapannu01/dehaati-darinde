import { describe, expect, it } from 'vitest';
import { INFRA_KEYTERMS } from '../../core/lexicon.ts';
import { DELIVERY_FIXTURES, TERMS } from './terms.ts';

// #9 — the pronunciation fixture and the STT keyterm list must not drift apart.
describe('pronunciation fixture vs INFRA_KEYTERMS', () => {
  it('every fixture term is a known keyterm', () => {
    const known = new Set(INFRA_KEYTERMS.map((t) => t.toLowerCase()));
    for (const t of TERMS) {
      expect(
        known.has(t.canonical.toLowerCase()),
        `${t.canonical} in the harness but not INFRA_KEYTERMS`,
      ).toBe(true);
    }
  });

  it('ids are unique across term and delivery fixtures', () => {
    const ids = [...TERMS.map((t) => t.id), ...DELIVERY_FIXTURES.map((d) => d.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers all four PS categories beyond domain vocabulary', () => {
    const cats = new Set(DELIVERY_FIXTURES.map((d) => d.category));
    for (const c of ['number', 'identifier', 'address', 'punctuation', 'filler', 'false-start']) {
      expect(cats.has(c as never), c).toBe(true);
    }
  });
});
