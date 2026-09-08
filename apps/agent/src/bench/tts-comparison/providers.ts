// Provider configs for the comparative TTS evaluation. Rime is the shipped
// judged path; the two alternatives are picked to match the PS's own named
// examples (FishAudio, Cartesia) and to need zero new credentials — both run
// through the LiveKit Inference gateway on the same LIVEKIT_API_KEY/SECRET
// already used for STT/LLM elsewhere in this repo.
//
// Model/voice IDs verified current (not deprecated/retired) against LiveKit's
// docs at build time: 'cartesia/sonic-2' and every ElevenLabs model were
// retired, which is why this picks 'cartesia/sonic-3' and FishAudio instead
// of an ElevenLabs comparator.

import { type tts as ttsTypes, inference } from '@livekit/agents';
import * as rime from '@livekit/agents-plugin-rime';

export interface ProviderConfig {
  id: string;
  /** Human-readable, for the REPORT.md table — not used in filenames (those stay blind-safe). */
  describe: string;
  make: () => ttsTypes.TTS;
  /** Exact config disclosed in the report, per the PS's reproducibility requirement. */
  config: Record<string, string | boolean>;
}

export function buildProviders(rimeApiKey: string): ProviderConfig[] {
  return [
    {
      id: 'rime',
      describe: 'Rime coda:celeste — direct WebSocket plugin (the shipped judged path)',
      make: () =>
        new rime.TTS({
          apiKey: rimeApiKey,
          modelId: 'coda',
          speaker: 'celeste',
          lang: 'eng',
          useWebsocket: true,
        }),
      config: {
        provider: 'Rime',
        model: 'coda',
        voice: 'celeste',
        transport: '@livekit/agents-plugin-rime (direct WebSocket)',
        endpoint: 'wss://users-ws.rime.ai/ws3',
        audioFormat: 'PCM 24kHz mono',
      },
    },
    {
      id: 'cartesia',
      describe: 'Cartesia sonic-3 (voice: Blake) — LiveKit Inference gateway, add_timestamps=true',
      make: () =>
        new inference.TTS({
          model: 'cartesia/sonic-3',
          voice: 'a167e0f3-df7e-4d52-a9c3-f949145efdab',
          modelOptions: { add_timestamps: true },
        }),
      config: {
        provider: 'Cartesia',
        model: 'sonic-3',
        voice: 'a167e0f3-df7e-4d52-a9c3-f949145efdab (Blake)',
        transport: 'LiveKit Inference gateway',
        modelOptions: 'add_timestamps=true',
      },
    },
    {
      id: 'fishaudio',
      describe: 'Fish Audio s2.1-pro (voice: Adrian) — LiveKit Inference gateway',
      make: () =>
        new inference.TTS({
          model: 'fishaudio/s2.1-pro',
          voice: 'bf322df2096a46f18c579d0baa36f41d',
        }),
      config: {
        provider: 'Fish Audio',
        model: 's2.1-pro',
        voice: 'bf322df2096a46f18c579d0baa36f41d (Adrian)',
        transport: 'LiveKit Inference gateway',
      },
    },
  ];
}
