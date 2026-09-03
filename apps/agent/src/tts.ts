import { type tts as ttsTypes, inference } from '@livekit/agents';
import * as rime from '@livekit/agents-plugin-rime';

export type TTSProviderName = 'rime' | 'rime-plugin' | 'fishaudio';

export interface TTSSelection {
  tts: ttsTypes.TTS;
  /** Expressive markup only exists for cartesia/fishaudio/inworld/xai via inference.TTS. */
  supportsExpressive: boolean;
  describe: string;
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export function resolveTTSProvider(): TTSProviderName {
  const raw = env('TTS_PROVIDER', 'rime').toLowerCase();
  if (raw === 'rime' || raw === 'rime-plugin' || raw === 'fishaudio') return raw;
  throw new Error(
    `Unknown TTS_PROVIDER "${raw}". Expected one of: rime, rime-plugin, fishaudio.`,
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

export function createTTS(provider: TTSProviderName = resolveTTSProvider()): TTSSelection {
  const voice = env('RIME_VOICE', 'celeste');
  const model = env('RIME_MODEL', 'coda');

  switch (provider) {
    case 'rime': {
      const modelOptions = rimeSpeedOption(model);
      return {
        tts: new inference.TTS({
          model: `rime/${model}`,
          voice,
          language: env('RIME_LANGUAGE', 'en'),
          // RimeOptions: max_tokens | time_scale_factor | speed_alpha |
          // pause_between_brackets | phonemize_between_brackets |
          // inline_speed_alpha | no_text_normalization
          ...(modelOptions ? { modelOptions } : {}),
        }),
        supportsExpressive: false,
        describe: `LiveKit Inference rime/${model}:${voice}`,
      };
    }

    case 'rime-plugin': {
      const apiKey = process.env.RIME_API_KEY;
      if (!apiKey) {
        throw new Error(
          'TTS_PROVIDER=rime-plugin requires RIME_API_KEY in apps/agent/.env.local',
        );
      }
      return {
        tts: new rime.TTS({
          // Pass the key explicitly: the plugin otherwise snapshots
          // process.env.RIME_API_KEY at its own module-load time.
          apiKey,
          modelId: model,
          speaker: voice,
          // Plugin uses 3-letter codes: eng | spa | fra | ger
          lang: env('RIME_LANGUAGE', 'en') === 'en' ? 'eng' : env('RIME_LANGUAGE', 'eng'),
          // Required for streaming synthesis + word-level timestamps.
          useWebsocket: true,
          // NOTE: speedAlpha is ignored on coda (use timeScaleFactor there); and
          // timeScaleFactor throws on mistv2 (use speedAlpha there). Only sent if RIME_SPEED is set.
          ...rimePluginSpeedOption(model),
        }),
        supportsExpressive: false,
        describe: `Rime plugin ${model}:${voice} (ws)`,
      };
    }

    case 'fishaudio':
      return {
        tts: new inference.TTS({
          model: 'fishaudio/s2.1-pro',
          voice: env('FISHAUDIO_VOICE', 'fa4c9eb3dccc4806b382b40d61c6b10a'),
        }),
        supportsExpressive: true,
        describe: 'LiveKit Inference fishaudio/s2.1-pro',
      };
  }
}
