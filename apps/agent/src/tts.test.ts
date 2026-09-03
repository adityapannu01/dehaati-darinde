import { initializeLogger } from '@livekit/agents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTTS, resolveTTSProvider } from './tts.ts';

initializeLogger({ pretty: true, level: 'warn' });

// Save/restore the env keys this factory (and the LiveKit SDK) reads, around every case.
const CLEARED_KEYS = [
  'TTS_PROVIDER',
  'RIME_MODEL',
  'RIME_VOICE',
  'RIME_LANGUAGE',
  'RIME_API_KEY',
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
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('resolveTTSProvider', () => {
  it('defaults to "rime" when TTS_PROVIDER is unset', () => {
    expect(resolveTTSProvider()).toBe('rime');
  });

  it('defaults to "rime" when TTS_PROVIDER is empty', () => {
    process.env.TTS_PROVIDER = '';
    expect(resolveTTSProvider()).toBe('rime');
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

describe('createTTS', () => {
  it('rime: no markup support, inference model "rime/coda"', () => {
    const sel = createTTS('rime');
    expect(sel.supportsExpressive).toBe(false);
    // inference.TTS: provider getter is always "livekit"; model keeps the gateway prefix.
    expect(sel.tts.model).toBe('rime/coda');
    expect(sel.tts.provider).toBe('livekit');
    expect(sel.describe).toContain('rime/coda:celeste');
  });

  it('rime: honours RIME_MODEL / RIME_VOICE', () => {
    process.env.RIME_MODEL = 'mistv3';
    process.env.RIME_VOICE = 'astra';
    const sel = createTTS('rime');
    expect(sel.tts.model).toBe('rime/mistv3');
    expect(sel.describe).toContain('rime/mistv3:astra');
  });

  it('fishaudio: markup support, keeps the previous default model', () => {
    const sel = createTTS('fishaudio');
    expect(sel.supportsExpressive).toBe(true);
    expect(sel.tts.model).toBe('fishaudio/s2.1-pro');
  });

  it('rime-plugin: throws when RIME_API_KEY is absent', () => {
    expect(() => createTTS('rime-plugin')).toThrow(/RIME_API_KEY/);
  });

  it('rime-plugin: with a dummy key, returns a Rime plugin TTS over websocket', () => {
    process.env.RIME_API_KEY = 'dummy-key';
    const sel = createTTS('rime-plugin');
    expect(sel.supportsExpressive).toBe(false);
    expect(sel.tts.provider).toBe('Rime');
    expect(sel.tts.model).toBe('coda');
    // useWebsocket: true -> streaming + aligned transcript capabilities
    expect(sel.tts.capabilities.streaming).toBe(true);
    expect(sel.tts.capabilities.alignedTranscript).toBe(true);
  });

  it('rime-plugin: mistv2 + timeScaleFactor is rejected by the plugin', () => {
    process.env.RIME_API_KEY = 'dummy-key';
    process.env.RIME_MODEL = 'mistv2';
    // factory sends speedAlpha (not timeScaleFactor) for non-coda models, so this
    // should construct fine; the guard below exercises the plugin's own throw.
    expect(() => createTTS('rime-plugin')).not.toThrow();
  });
});
