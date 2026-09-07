// Decides which language the agent speaks in, from AssemblyAI's per-turn
// language detection (MULTILINGUAL_AND_PRONUNCIATION.md §2.4).
//
// Hysteresis: a voice that flickers between languages is worse than one that is
// occasionally in the wrong language. Require N consecutive turns in a new
// language before switching. A misdetected single turn never flips the voice.
//
// Unsupported languages degrade, never fail: if detection returns a language
// with no Coda speaker, stay on the current voice — the caller has the agent
// say (in the current language) that it will continue in that language.
//
// Pure TypeScript — unit-tested with a synthetic sequence of detected codes.

import { SPEAKER_BY_LANG, TIMED_LANGUAGES, toCodaLang } from '../voices.ts';

export interface LanguageSwitch {
  /** Coda 3-letter code now in effect. */
  lang: string;
  speaker: string;
  /** True when this language has NO word timestamps — the commit gate degrades (§0). */
  degradedTiming: boolean;
}

export interface LanguageRouterOptions {
  /** Coda code to start in. Default 'eng'. */
  initial?: string;
  /** Consecutive turns in a new supported language before switching. Default 2. */
  hysteresis?: number;
}

export class LanguageRouter {
  private current: string;
  private hysteresis: number;
  private streakLang: string | null = null;
  private streakCount = 0;
  /** Set when detection saw a language Coda cannot speak — the caller announces it once. */
  private pendingUnsupported: string | null = null;

  constructor(opts: LanguageRouterOptions = {}) {
    this.current = opts.initial && SPEAKER_BY_LANG[opts.initial] ? opts.initial : 'eng';
    this.hysteresis = Math.max(1, opts.hysteresis ?? 2);
  }

  get currentLang(): string {
    return this.current;
  }

  get currentSpeaker(): string {
    return SPEAKER_BY_LANG[this.current]!;
  }

  get degradedTiming(): boolean {
    return !TIMED_LANGUAGES.has(this.current);
  }

  /** An unsupported language was detected and not yet announced — returns its raw code once, then clears. */
  takeUnsupported(): string | null {
    const u = this.pendingUnsupported;
    this.pendingUnsupported = null;
    return u;
  }

  /**
   * Feed one turn's detected language (whatever the STT reported — 2- or
   * 3-letter, with or without region). Returns a `LanguageSwitch` when the
   * active language actually changes, otherwise null.
   */
  observe(detected: string | null | undefined): LanguageSwitch | null {
    const coda = toCodaLang(detected);

    if (coda === null) {
      // Unsupported (or undetected). Don't touch the streak — a stray unknown
      // shouldn't reset progress toward a real switch — but flag it so the
      // agent can say it can't switch.
      if (detected && detected.trim()) this.pendingUnsupported = detected;
      return null;
    }

    if (coda === this.current) {
      this.streakLang = null;
      this.streakCount = 0;
      return null;
    }

    if (coda === this.streakLang) {
      this.streakCount += 1;
    } else {
      this.streakLang = coda;
      this.streakCount = 1;
    }

    if (this.streakCount >= this.hysteresis) {
      this.current = coda;
      this.streakLang = null;
      this.streakCount = 0;
      return {
        lang: coda,
        speaker: SPEAKER_BY_LANG[coda]!,
        degradedTiming: !TIMED_LANGUAGES.has(coda),
      };
    }
    return null;
  }
}
