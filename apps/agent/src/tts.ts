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
  /**
   * Swap the Rime speaker + language for the next synthesis (§2.4). Only the
   * direct Coda plugin can do this; undefined on the other paths, which also
   * means multilingual is a no-op there. Call between turns, never mid-utterance.
   */
  updateLanguage?: (lang3: string, speaker: string) => void;
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

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

export function createTTS(provider: TTSProviderName = resolveTTSProvider()): TTSSelection {
  const voice = env('RIME_VOICE', 'celeste');
  const model = env('RIME_MODEL', 'coda');
  const language3 = env('RIME_LANGUAGE', 'eng');

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
        modelId: model,
        speaker: voice,
        lang: language3,
        // REQUIRED: without this, synthesis is non-streaming chunked and
        // alignedTranscript is false — the commit gate has nothing to key off.
        useWebsocket: true,
        // Log out-of-vocabulary words Rime had to guess at (§4.3). Default off —
        // it is a diagnostic for pronunciation-harness runs, not production.
        saveOovs: env('RIME_SAVE_OOVS', 'false').toLowerCase() === 'true',
        // NOTE: speedAlpha is ignored on coda (use timeScaleFactor there); and
        // timeScaleFactor throws on mistv2 (use speedAlpha there). Only sent if RIME_SPEED is set.
        ...rimePluginSpeedOption(model),
      });
      return {
        tts: rimeTts,
        supportsExpressive: false,
        hasWordTimestamps: true,
        describe: `Rime ${model}:${voice} (WebSocket, PCM 24kHz mono)`,
        updateLanguage: (lang3, speaker) => rimeTts.updateOptions({ lang: lang3, speaker }),
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
