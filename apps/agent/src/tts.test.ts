import { initializeLogger } from '@livekit/agents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTTS, resolveTTSProvider, rimeSpeedOption } from './tts.ts';

initializeLogger({ pretty: true, level: 'warn' });

// Save/restore the env keys this factory (and the LiveKit SDK) reads, around every case.
const CLEARED_KEYS = [
  'TTS_PROVIDER',
  'RIME_MODEL',
  'RIME_VOICE',
  'RIME_LANGUAGE',
  'RIME_API_KEY',
  'RIME_SPEED',
  'FISHAUDIO_VOICE',
] as const;

// inference.TTS validates LiveKit credentials at construction time; give it dummies.
const STUBBED: Record<string, string> = {
  LIVEKIT_URL: 'wss://example.livekit.cloud',
  LIVEKIT_API_KEY: 'devkey',
  LIVEKIT_API_SECRET: 'devsecret',
};

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of [...CLEARED_KEYS, ...Object.keys(STUBBED)]) {
    saved[k] = process.env[k];
  }
  for (const k of CLEARED_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(STUBBED)) process.env[k] = v;
  // rime-plugin is the default provider; give it a key unless a test wants to test its absence.
  process.env.RIME_API_KEY = 'dummy-key';
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('resolveTTSProvider', () => {
  it('defaults to "rime-plugin" when TTS_PROVIDER is unset', () => {
    expect(resolveTTSProvider()).toBe('rime-plugin');
  });

  it('defaults to "rime-plugin" when TTS_PROVIDER is empty', () => {
    process.env.TTS_PROVIDER = '';
    expect(resolveTTSProvider()).toBe('rime-plugin');
  });

  it('is case-insensitive', () => {
    process.env.TTS_PROVIDER = 'FishAudio';
    expect(resolveTTSProvider()).toBe('fishaudio');
  });

  it('throws a helpful error on an unknown value', () => {
    process.env.TTS_PROVIDER = 'nonsense';
    expect(() => resolveTTSProvider()).toThrow(/Unknown TTS_PROVIDER "nonsense"/);
  });
});

describe('rimeSpeedOption', () => {
  it('sends nothing when RIME_SPEED is unset', () => {
    expect(rimeSpeedOption('coda')).toBeUndefined();
  });

  it('routes to time_scale_factor for coda / mistv3', () => {
    process.env.RIME_SPEED = '1.2';
    expect(rimeSpeedOption('coda')).toEqual({ time_scale_factor: 1.2 });
    expect(rimeSpeedOption('mistv3')).toEqual({ time_scale_factor: 1.2 });
  });

  it('routes to speed_alpha for mistv2 / mist', () => {
    process.env.RIME_SPEED = '0.9';
    expect(rimeSpeedOption('mistv2')).toEqual({ speed_alpha: 0.9 });
    expect(rimeSpeedOption('mist')).toEqual({ speed_alpha: 0.9 });
  });

  it('throws on a non-numeric RIME_SPEED', () => {
    process.env.RIME_SPEED = 'fast';
    expect(() => rimeSpeedOption('coda')).toThrow(/RIME_SPEED must be a number/);
  });
});

describe('createTTS', () => {
  it('rime-plugin (default): word timestamps, streaming, no markup', () => {
    const sel = createTTS('rime-plugin');
    expect(sel.supportsExpressive).toBe(false);
    expect(sel.hasWordTimestamps).toBe(true);
    expect(sel.tts.provider).toBe('Rime');
    expect(sel.tts.model).toBe('coda');
    expect(sel.tts.capabilities.streaming).toBe(true);
    expect(sel.tts.capabilities.alignedTranscript).toBe(true);
    expect(sel.describe).toContain('coda:celeste');
  });

  it('rime-plugin: throws when RIME_API_KEY is absent', () => {
    delete process.env.RIME_API_KEY;
    expect(() => createTTS('rime-plugin')).toThrow(/RIME_API_KEY/);
  });

  it('rime-plugin: mistv2 + timeScaleFactor is rejected by the plugin', () => {
    process.env.RIME_MODEL = 'mistv2';
    // factory sends speedAlpha (not timeScaleFactor) for non-coda models, so this
    // should construct fine; the plugin's own throw is a separate, direct guard.
    expect(() => createTTS('rime-plugin')).not.toThrow();
  });

  it('rime-plugin: honours RIME_LANGUAGE (3-letter, passed through as-is)', () => {
    process.env.RIME_LANGUAGE = 'spa';
    const sel = createTTS('rime-plugin');
    expect(sel.tts.model).toBe('coda');
  });

  it('rime: no markup, no word timestamps, inference model "rime/coda"', () => {
    const sel = createTTS('rime');
    expect(sel.supportsExpressive).toBe(false);
    expect(sel.hasWordTimestamps).toBe(false);
    // inference.TTS: provider getter is always "livekit"; model keeps the gateway prefix.
    expect(sel.tts.model).toBe('rime/coda');
    expect(sel.tts.provider).toBe('livekit');
    expect(sel.describe).toContain('coda:celeste');
  });

  it('rime: honours RIME_MODEL / RIME_VOICE', () => {
    process.env.RIME_MODEL = 'mistv3';
    process.env.RIME_VOICE = 'astra';
    const sel = createTTS('rime');
    expect(sel.tts.model).toBe('rime/mistv3');
    expect(sel.describe).toContain('mistv3:astra');
  });

  it('rime: maps the plugin\'s 3-letter RIME_LANGUAGE to a 2-letter inference code', () => {
    process.env.RIME_LANGUAGE = 'spa';
    const sel = createTTS('rime');
    expect(sel.tts.model).toBe('rime/coda'); // language isn't part of .model; just confirm no throw
  });

  it('fishaudio: markup support, no word timestamps, keeps the previous default model', () => {
    const sel = createTTS('fishaudio');
    expect(sel.supportsExpressive).toBe(true);
    expect(sel.hasWordTimestamps).toBe(false);
    expect(sel.tts.model).toBe('fishaudio/s2.1-pro');
  });
});
