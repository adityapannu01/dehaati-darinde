import { type tts as ttsTypes, inference } from '@livekit/agents';
import * as rime from '@livekit/agents-plugin-rime';

export type TTSProviderName = 'rime-plugin' | 'rime' | 'fishaudio';

export interface TTSSelection {
  tts: ttsTypes.TTS;
  /** Expressive markup only exists for cartesia/fishaudio/inworld/xai via inference.TTS. */
  supportsExpressive: boolean;
  /** Word-level timestamps — required by the commit gate. Only the WebSocket plugin has them. */
  hasWordTimestamps: boolean;
  /** Shown in the UI: the active speech provider must be observable, not just documented. */
  describe: string;
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

/**
 * The shipped Rime configuration — model, voice, language, region. This is the
 * combination the event preflight validates against Rime's live catalog
 * (PS p.5), so it is a single exported constant that `createTTS` reads and
 * `tts.live.test.ts` checks. Override any of them via the matching env var
 * for a deploy; the tested and demoed path is these defaults.
 */
export const RIME_DEFAULTS = {
  model: 'coda',
  voice: 'celeste',
  language: 'eng',
  /** US West (us-west-2). US East is `wss://users-east-ws.rime.ai`; Rime has no APAC region. */
  baseURL: 'wss://users-ws.rime.ai',
} as const;

export function resolveTTSProvider(): TTSProviderName {
  const raw = env('TTS_PROVIDER', 'rime-plugin').toLowerCase();
  if (raw === 'rime-plugin' || raw === 'rime' || raw === 'fishaudio') return raw;
  throw new Error(
    `Unknown TTS_PROVIDER "${raw}". Expected one of: rime-plugin, rime, fishaudio.`,
  );
}

/**
 * Rime's speed knob has two different names depending on the model, and the
 * LiveKit Inference gateway *rejects* the wrong one (coda + `speed_alpha` fails
 * mid-call with an opaque error). `coda` / `mistv3` use `time_scale_factor`;
 * `mistv2` / `mist` use `speed_alpha`. Values >1 slow down, <1 speed up.
 * Returns `undefined` (send nothing) unless RIME_SPEED is set, since 1.0 is a no-op.
 */
export function rimeSpeedOption(model: string): Record<string, number> | undefined {
  const raw = process.env.RIME_SPEED;
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`RIME_SPEED must be a number, got "${raw}".`);
  }
  const key = model === 'mistv2' || model === 'mist' ? 'speed_alpha' : 'time_scale_factor';
  return { [key]: value };
}

/** Same idea as `rimeSpeedOption`, but with the direct plugin's camelCase option names. */
function rimePluginSpeedOption(model: string): Record<string, number> {
  const raw = process.env.RIME_SPEED;
  if (raw === undefined || raw === '') return {};
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`RIME_SPEED must be a number, got "${raw}".`);
  }
  const key = model === 'mistv2' || model === 'mist' ? 'speedAlpha' : 'timeScaleFactor';
  return { [key]: value };
}

// The plugin uses 3-letter codes (RIME_LANGUAGE's native format); the Inference
// gateway wants 2-letter ISO codes. Map the ones the plugin's DefaultLanguages covers.
const THREE_TO_TWO_LETTER: Record<string, string> = { eng: 'en', spa: 'es', fra: 'fr', ger: 'de' };

/** Human-readable Rime region for the `describe` string / HUD, from the WS origin. */
function rimeRegion(baseURL: string): string {
  if (baseURL.includes('users-east-ws')) return 'us-east-1';
  if (baseURL.includes('users-ws.rime.ai')) return 'us-west-2';
  return baseURL;
}

export function createTTS(provider: TTSProviderName = resolveTTSProvider()): TTSSelection {
  const voice = env('RIME_VOICE', RIME_DEFAULTS.voice);
  const model = env('RIME_MODEL', RIME_DEFAULTS.model);
  const language3 = env('RIME_LANGUAGE', RIME_DEFAULTS.language);
  // Rime WebSocket region (Item 3 / PS p.5 disclosure). The plugin appends
  // `/ws3?...` itself, so this is the origin only.
  const baseURL = env('RIME_BASE_URL', RIME_DEFAULTS.baseURL);

  switch (provider) {
    case 'rime-plugin': {
      const apiKey = process.env.RIME_API_KEY;
      if (!apiKey) {
        throw new Error(
          'TTS_PROVIDER=rime-plugin requires RIME_API_KEY in apps/agent/.env.local',
        );
      }
      const rimeTts = new rime.TTS({
        // Pass the key explicitly: the plugin otherwise snapshots
        // process.env.RIME_API_KEY at its own module-load time.
        apiKey,
        baseURL,
        modelId: model,
        speaker: voice,
        lang: language3,
        // REQUIRED: without this, synthesis is non-streaming chunked and
        // alignedTranscript is false — the commit gate has nothing to key off.
        useWebsocket: true,
        // Log out-of-vocabulary words Rime had to guess at (§4.3). Default off —
        // it is a diagnostic for pronunciation-harness runs, not production.
        saveOovs: env('RIME_SAVE_OOVS', 'false').toLowerCase() === 'true',
        // reduceLatency is NOT set here, deliberately, after checking:
        // @livekit/agents-plugin-rime@1.7.1's modelParams() only forwards
        // reduceLatency into the wire request when modelId is 'mistv2' — for
        // 'coda' it's silently dropped, on both the WebSocket URL and the HTTP
        // payload builder. Mist v2 has no word-level timestamps, which the
        // commit gate requires, so switching models to reach this option isn't
        // an option either. Recorded as an investigated-and-closed lever
        // rather than left unexplored — see RIME_EVIDENCE.md.
        // NOTE: speedAlpha is ignored on coda (use timeScaleFactor there); and
        // timeScaleFactor throws on mistv2 (use speedAlpha there). Only sent if RIME_SPEED is set.
        ...rimePluginSpeedOption(model),
      });
      return {
        tts: rimeTts,
        supportsExpressive: false,
        hasWordTimestamps: true,
        describe: `Rime ${model}:${voice} (WebSocket, PCM 24kHz mono, ${rimeRegion(baseURL)})`,
      };
    }

    case 'rime': {
      const modelOptions = rimeSpeedOption(model);
      return {
        tts: new inference.TTS({
          model: `rime/${model}`,
          voice,
          language: THREE_TO_TWO_LETTER[language3] ?? language3,
          // RimeOptions: max_tokens | time_scale_factor | speed_alpha |
          // pause_between_brackets | phonemize_between_brackets |
          // inline_speed_alpha | no_text_normalization
          ...(modelOptions ? { modelOptions } : {}),
        }),
        supportsExpressive: false,
        hasWordTimestamps: false,
        describe: `Rime ${model}:${voice} (LiveKit Inference — no word timestamps)`,
      };
    }

    case 'fishaudio':
      return {
        tts: new inference.TTS({
          model: 'fishaudio/s2.1-pro',
          voice: env('FISHAUDIO_VOICE', 'fa4c9eb3dccc4806b382b40d61c6b10a'),
        }),
        supportsExpressive: true,
        hasWordTimestamps: false,
        describe: 'Fish Audio s2.1-pro (pre-Rime baseline)',
      };
  }
}
