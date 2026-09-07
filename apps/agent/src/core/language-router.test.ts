import { describe, expect, it } from 'vitest';
import { LanguageRouter } from './language-router.ts';

describe('LanguageRouter (§2.4)', () => {
  it('starts in English with no degraded timing', () => {
    const r = new LanguageRouter();
    expect(r.currentLang).toBe('eng');
    expect(r.currentSpeaker).toBe('celeste');
    expect(r.degradedTiming).toBe(false);
  });

  it('does not switch on a single turn — hysteresis is 2', () => {
    const r = new LanguageRouter();
    expect(r.observe('hi')).toBeNull(); // one Hindi turn
    expect(r.currentLang).toBe('eng');
  });

  it('switches after two consecutive turns in the new language', () => {
    const r = new LanguageRouter();
    r.observe('hi');
    const sw = r.observe('hi');
    expect(sw).toEqual({ lang: 'hin', speaker: 'nadi', degradedTiming: true });
    expect(r.currentLang).toBe('hin');
    expect(r.degradedTiming).toBe(true); // Hindi has no word timestamps (§0)
  });

  it('a single misdetected turn between same-language turns resets the streak', () => {
    const r = new LanguageRouter();
    r.observe('hi'); // 1
    r.observe('fr'); // different -> streak resets to French=1
    expect(r.observe('hi')).toBeNull(); // Hindi=1 again, not 2
    expect(r.currentLang).toBe('eng');
  });

  it('accepts 3-letter codes and codes with a region suffix', () => {
    const r = new LanguageRouter();
    r.observe('hin');
    expect(r.observe('hi-IN')?.lang).toBe('hin');
  });

  it('an unsupported language never switches and is surfaced once', () => {
    const r = new LanguageRouter();
    expect(r.observe('ko')).toBeNull(); // Korean — not a Coda language
    expect(r.observe('ko')).toBeNull();
    expect(r.currentLang).toBe('eng');
    expect(r.takeUnsupported()).toBe('ko');
    expect(r.takeUnsupported()).toBeNull(); // cleared
  });

  it('switching back to English clears degraded timing', () => {
    const r = new LanguageRouter({ initial: 'hin' });
    expect(r.degradedTiming).toBe(true);
    r.observe('en');
    r.observe('en');
    expect(r.currentLang).toBe('eng');
    expect(r.degradedTiming).toBe(false);
  });

  it('null / empty detection is ignored', () => {
    const r = new LanguageRouter();
    expect(r.observe(null)).toBeNull();
    expect(r.observe('')).toBeNull();
    expect(r.takeUnsupported()).toBeNull();
  });
});
