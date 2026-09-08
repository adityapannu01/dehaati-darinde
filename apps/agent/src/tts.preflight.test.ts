// PS p.5 ("Rime integration and build rules"): "Use a current production
// configuration. Choose a compatible model, voice, and language from Rime's
// live catalog, and test the exact combination used in the demo. Use the
// current catalog at submission time rather than copying a stale speaker list
// into the application."
//
// PS p.5 (eligibility): a submission is not judged if it "uses a model, voice,
// or language combination that fails the event preflight."
//
// RIME_MODEL/RIME_VOICE are committed defaults. This test fetches Rime's live
// catalog and fails if that exact combination has been retired or renamed.
//
// Network-dependent by design, so it SKIPS (never fails) when offline — a red
// test on a train is noise. Run it deliberately before submitting:
//   pnpm --filter DD_agent test tts.preflight
import { describe, expect, it } from 'vitest';
import { RIME_DEFAULTS } from './tts.ts';

const CATALOG_URL = 'https://users.rime.ai/data/voices/all-v2.json';

const { model: MODEL, voice: VOICE, language: LANG } = RIME_DEFAULTS;

/** The catalog nests voice names under model -> language. Tolerate 3- and 2-letter language keys. */
function voicesFor(catalog: unknown, model: string, lang: string): string[] {
  const root = catalog as Record<string, unknown>;
  const byLang = (root[model] ?? root[model[0]!.toUpperCase() + model.slice(1)]) as
    | Record<string, unknown>
    | undefined;
  if (!byLang) return [];
  const pool = (byLang[lang] ?? byLang[lang.slice(0, 2)]) as unknown[] | undefined;
  if (!Array.isArray(pool)) return [];
  return pool.map((v) => (typeof v === 'string' ? v : String((v as { name?: string }).name ?? '')));
}

describe('shipped Rime combination against the live catalog (PS p.5 preflight)', () => {
  it(`${MODEL}/${VOICE}/${LANG} is still in Rime's catalog`, async () => {
    let catalog: unknown;
    try {
      const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      catalog = await res.json();
    } catch (err) {
      console.warn(`[preflight] catalog unreachable, skipped: ${String(err)}`);
      return;
    }

    const names = voicesFor(catalog, MODEL, LANG);
    expect(
      names.length,
      `no ${MODEL} voices found for "${LANG}" — catalog shape may have changed`,
    ).toBeGreaterThan(0);
    expect(
      names,
      `"${VOICE}" is no longer a ${MODEL} voice for "${LANG}" — this would fail the event preflight`,
    ).toContain(VOICE);
  }, 15_000);
});
