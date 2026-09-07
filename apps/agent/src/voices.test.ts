import { describe, expect, it } from 'vitest';
import {
  CODA_LANGUAGES,
  SPEAKER_BY_LANG,
  TESTED_LANGUAGES,
  TIMED_LANGUAGES,
  toCodaLang,
} from './voices.ts';

describe('voices map (§2.3)', () => {
  it('every Coda language has a speaker', () => {
    for (const lang of CODA_LANGUAGES) {
      expect(SPEAKER_BY_LANG[lang], lang).toBeTypeOf('string');
    }
  });

  it('English and Hindi are the tested languages; only English has word timestamps (§0)', () => {
    expect([...TESTED_LANGUAGES].sort()).toEqual(['eng', 'hin']);
    expect([...TIMED_LANGUAGES]).toEqual(['eng']);
  });

  it('the English default stays celeste (the judged voice)', () => {
    expect(SPEAKER_BY_LANG.eng).toBe('celeste');
  });
});

describe('toCodaLang', () => {
  it('maps 2-letter ISO codes to Coda 3-letter', () => {
    expect(toCodaLang('en')).toBe('eng');
    expect(toCodaLang('hi')).toBe('hin');
    expect(toCodaLang('ja')).toBe('jpn');
  });

  it('passes through valid 3-letter codes', () => {
    expect(toCodaLang('hin')).toBe('hin');
    expect(toCodaLang('spa')).toBe('spa');
  });

  it('strips a region suffix', () => {
    expect(toCodaLang('hi-IN')).toBe('hin');
    expect(toCodaLang('pt_BR')).toBe('por');
  });

  it('returns null for languages Coda cannot speak, and for junk', () => {
    expect(toCodaLang('ko')).toBeNull(); // Korean
    expect(toCodaLang('zh')).toBeNull(); // Chinese — not a Coda language
    expect(toCodaLang('')).toBeNull();
    expect(toCodaLang(null)).toBeNull();
    expect(toCodaLang(undefined)).toBeNull();
  });
});
