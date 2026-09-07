// Language → Coda speaker map (MULTILINGUAL_AND_PRONUNCIATION.md §2.3).
//
// Generated once from Rime's machine-readable catalogs
// (users.rime.ai/data/voices/{all-v2,voice_details}.json) — committed, never
// fetched at runtime. Coda serves 9 languages; a voice serves exactly one, so
// every language needs its own speaker.
//
// Voices are chosen for timbre continuity, not at random: `celeste` (the
// English default) is Female / Young Adult, and every other pick is the
// closest Female / Young Adult Coda voice for that language (Arabic has only
// Adult females). The agent still sounds like a different person on a switch —
// no Coda voice crosses languages — but matched demographics make it read as
// "the same character in another language" rather than a handoff to a stranger.
// This trades against an "expressive & persistent voice identity" — see the
// README.
//
// §0 spike result: Coda returns word-level timestamps ONLY for English. For
// every other language the commit gate degrades to onTurnComplete granularity
// (no per-sentence gating) — see LanguageRouter and the README matrix.

/** Rime 3-letter language code → Coda speaker. Only languages we actually configured. */
export const SPEAKER_BY_LANG: Record<string, string> = {
  eng: 'celeste', // tested, judged path — word timestamps verified
  hin: 'nadi', // tested — Female, Young Adult
  spa: 'brisa',
  fra: 'aurelie',
  ger: 'lorelei',
  ita: 'livia',
  jpn: 'akatsuki',
  por: 'estela',
  ara: 'layla', // Female, Adult (no Young Adult Arabic Coda voice)
};

/** The 9 Coda languages, for the README disclosure. `eng` + `hin` are tested. */
export const CODA_LANGUAGES = ['eng', 'hin', 'spa', 'fra', 'ger', 'ita', 'jpn', 'por', 'ara'] as const;
export const TESTED_LANGUAGES = new Set(['eng', 'hin']);

/** Word-level timestamps only work for English (§0 spike) — so only English gets per-sentence gating. */
export const TIMED_LANGUAGES = new Set(['eng']);

/** STT (AssemblyAI) reports ISO 2-letter; the Rime plugin wants 3-letter. */
export const TWO_TO_THREE: Record<string, string> = {
  en: 'eng',
  hi: 'hin',
  es: 'spa',
  fr: 'fra',
  de: 'ger',
  it: 'ita',
  ja: 'jpn',
  pt: 'por',
  ar: 'ara',
};

/** Human name for a 3-letter code — for ledger lines and the agent's own "I'll continue in X" line. */
export const LANG_NAME: Record<string, string> = {
  eng: 'English',
  hin: 'Hindi',
  spa: 'Spanish',
  fra: 'French',
  ger: 'German',
  ita: 'Italian',
  jpn: 'Japanese',
  por: 'Portuguese',
  ara: 'Arabic',
};

/** Normalise whatever the STT reports (2- or 3-letter, with/without region) to a Coda 3-letter code, or null. */
export function toCodaLang(reported: string | null | undefined): string | null {
  if (!reported) return null;
  const base = reported.toLowerCase().split(/[-_]/)[0]!;
  if (SPEAKER_BY_LANG[base]) return base; // already 3-letter
  const three = TWO_TO_THREE[base];
  return three && SPEAKER_BY_LANG[three] ? three : null;
}
