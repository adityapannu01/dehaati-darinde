import { describe, expect, it } from 'vitest';
import { median, transcriptMatches, wavFromFrames } from './run.ts';

describe('median', () => {
  it('returns the middle value of an odd-length sorted set', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('returns the upper-middle value of an even-length set (matches the harness convention, not strict statistical median)', () => {
    expect(median([10, 20, 30, 40])).toBe(30);
  });

  it('handles a single sample', () => {
    expect(median([42])).toBe(42);
  });

  it('is order-independent', () => {
    const xs = [50, 10, 40, 20, 30];
    expect(median([...xs])).toBe(median([...xs].reverse()));
  });

  it('returns 0 for an empty set rather than throwing', () => {
    expect(median([])).toBe(0);
  });
});

describe('transcriptMatches', () => {
  it('matches an exact re-transcription of the canonical term', () => {
    expect(transcriptMatches('Postgres', 'Postgres')).toBe(true);
  });

  it('is case-insensitive and punctuation-insensitive', () => {
    expect(transcriptMatches("It's Postgres!", 'Postgres')).toBe(true);
  });

  it('matches a partial/substring re-transcription (e.g. STT drops a suffix)', () => {
    expect(transcriptMatches('I said postgres', 'PostgreSQL')).toBe(true);
  });

  it('fails when the transcript is unrelated to the canonical term', () => {
    expect(transcriptMatches('completely different words', 'PostgreSQL')).toBe(false);
  });

  it('fails on an empty transcript (e.g. a zero-frame synthesis)', () => {
    expect(transcriptMatches('', 'Redis')).toBe(false);
  });
});

describe('wavFromFrames', () => {
  function fakeFrame(samples: number[], sampleRate = 24000, channels = 1) {
    const data = new Int16Array(samples);
    return { data, sampleRate, channels } as unknown as import('@livekit/rtc-node').AudioFrame;
  }

  it('produces a valid RIFF/WAVE header sized to the concatenated PCM data', () => {
    const frames = [fakeFrame([1, 2, 3, 4]), fakeFrame([5, 6])];
    const wav = wavFromFrames(frames);

    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    // 6 int16 samples * 2 bytes = 12 bytes of PCM data.
    const pcmLength = wav.readUInt32LE(40);
    expect(pcmLength).toBe(12);
    expect(wav.length).toBe(44 + 12);
  });

  it('falls back to 24kHz mono defaults for an empty frame list rather than throwing', () => {
    const wav = wavFromFrames([]);
    expect(wav.readUInt32LE(24)).toBe(24000); // sample rate
    expect(wav.readUInt16LE(22)).toBe(1); // channels
    expect(wav.readUInt32LE(40)).toBe(0); // pcm length
  });

  it('encodes the sample rate and channel count from the first frame', () => {
    const wav = wavFromFrames([fakeFrame([1, 2], 16000, 2)]);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(22)).toBe(2);
  });
});
