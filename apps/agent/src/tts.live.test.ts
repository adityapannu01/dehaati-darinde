// PS p.5 ("Rime integration and build rules"): "Use a current production
// configuration. Choose a compatible model, voice, and language from Rime's live
// catalog... Use the current catalog at submission time rather than copying a
// stale speaker list into the application."
//
// `RIME_DEFAULTS` in tts.ts is the model/voice/language the event preflight
// validates. It is a small, single combination (the product is English-only —
// see RIME_EVIDENCE.md §4a) rather than a hardcoded 9-language speaker map, but
// it is still a committed snapshot of a live catalog. This test keeps it honest:
// it fetches Rime's catalog and fails if `coda`/`celeste`/`eng` has been retired
// or renamed. The pronunciation harness reads the same `RIME_DEFAULTS`, so it
// cannot drift.
//
// Network-dependent by design, so it SKIPS (never fails) when offline — a red
// test in an airport is noise. Run it deliberately before submitting:
//   pnpm --filter DD_agent test tts.live
import { describe, expect, it } from 'vitest';
import { RIME_DEFAULTS } from './tts.ts';

const CATALOG_URL = 'https://users.rime.ai/data/voices/all-v2.json';

/** The catalog is { <model>: { <lang>: string[] } }. Tolerate 3- or 2-letter language keys. */
function voicesFor(catalog: unknown, model: string, lang: string): string[] {
  const root = catalog as Record<string, unknown>;
  const byLang = root[model] as Record<string, unknown> | undefined;
  if (!byLang) return [];
  const pool = (byLang[lang] ?? byLang[lang.slice(0, 2)]) as unknown[] | undefined;
  if (!Array.isArray(pool)) return [];
  return pool.map((v) => (typeof v === 'string' ? v : String((v as { name?: string }).name ?? '')));
}

describe("the shipped Rime config against Rime's live catalog (PS p.5 preflight)", () => {
  it('RIME_DEFAULTS (coda / celeste / eng) still exists in the catalog', async () => {
    let catalog: unknown;
    try {
      const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      catalog = await res.json();
    } catch (err) {
      // Offline or catalog unreachable: skip, don't fail.
      console.warn(`[tts.live] Rime catalog unreachable, skipped: ${String(err)}`);
      return;
    }

    const names = voicesFor(catalog, RIME_DEFAULTS.model, RIME_DEFAULTS.language);
    expect(
      names,
      `Rime catalog has no "${RIME_DEFAULTS.model}" voices for "${RIME_DEFAULTS.language}"`,
    ).not.toEqual([]);
    expect(
      names,
      `"${RIME_DEFAULTS.voice}" is no longer in Rime's catalog for ${RIME_DEFAULTS.model}/${RIME_DEFAULTS.language} — this would fail the event preflight (catalog has: ${names.slice(0, 8).join(', ')}…)`,
    ).toContain(RIME_DEFAULTS.voice);
  }, 15_000);
});
