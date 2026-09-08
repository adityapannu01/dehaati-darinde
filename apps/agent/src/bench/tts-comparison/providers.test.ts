import { initializeLogger } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import { buildProviders } from './providers.ts';

// The Rime plugin's TTS constructor touches the LiveKit Agents logger, which
// throws if nothing has called initializeLogger() yet in this process.
initializeLogger({ pretty: false, level: 'silent' });

// inference.TTS (Cartesia/Fish Audio) requires ambient LiveKit Inference
// gateway credentials to construct at all, even before ever connecting —
// fake values are enough since this test only exercises construction.
process.env.LIVEKIT_API_KEY ??= 'fake-livekit-key';
process.env.LIVEKIT_API_SECRET ??= 'fake-livekit-secret';

describe('buildProviders', () => {
  it('returns exactly the three providers this comparison is scoped to: Rime, Cartesia, Fish Audio', () => {
    const providers = buildProviders('fake-rime-key');
    expect(providers.map((p) => p.id)).toEqual(['rime', 'cartesia', 'fishaudio']);
  });

  it('discloses a non-empty config for every provider, for the reproducibility requirement', () => {
    const providers = buildProviders('fake-rime-key');
    for (const p of providers) {
      expect(Object.keys(p.config).length).toBeGreaterThan(0);
      expect(p.config.provider).toBeTruthy();
      expect(p.describe).toBeTruthy();
    }
  });

  it('each provider is independently constructible via its factory', () => {
    const providers = buildProviders('fake-rime-key');
    for (const p of providers) {
      expect(() => p.make()).not.toThrow();
    }
  });

  it('only the Rime provider is wired with the supplied API key (the other two ride the shared Inference gateway credentials)', () => {
    const providers = buildProviders('fake-rime-key');
    const rime = providers.find((p) => p.id === 'rime')!;
    expect(rime.config.provider).toBe('Rime');
    const others = providers.filter((p) => p.id !== 'rime');
    for (const p of others) {
      expect(p.config.transport).toBe('LiveKit Inference gateway');
    }
  });
});
