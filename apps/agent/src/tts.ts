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

export function createTTS(provider: TTSProviderName = resolveTTSProvider()): TTSSelection {
  const voice = env('RIME_VOICE', 'celeste');
  const model = env('RIME_MODEL', 'coda');

  switch (provider) {
    case 'rime':
      return {
        tts: new inference.TTS({
          model: `rime/${model}`,
          voice,
          language: env('RIME_LANGUAGE', 'en'),
          // RimeOptions: max_tokens | time_scale_factor | speed_alpha |
          // pause_between_brackets | phonemize_between_brackets |
          // inline_speed_alpha | no_text_normalization
          modelOptions: { speed_alpha: 1.0 },
        }),
        supportsExpressive: false,
        describe: `LiveKit Inference rime/${model}:${voice}`,
      };

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
          // NOTE: speedAlpha is ignored on coda; use timeScaleFactor there.
          ...(model === 'coda' ? { timeScaleFactor: 1.0 } : { speedAlpha: 1.0 }),
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
