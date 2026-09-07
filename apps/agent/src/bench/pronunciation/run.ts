// Renders every fixture term (§4.3) through the SHIPPED judged path — the Rime
// `coda:celeste` WebSocket plugin — in two spellings, writes a WAV per clip,
// captures any OOV report Rime returns (saveOovs), and emits REPORT.md.
//
//   RIME_API_KEY=... pnpm --filter DD_agent pronunciation
//
// Needs the key and network. Deterministic inputs, non-deterministic audio —
// the point is the saved clips + the wording table, not a pass/fail number.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { initializeLogger } from '@livekit/agents';
import * as rime from '@livekit/agents-plugin-rime';
import type { AudioFrame } from '@livekit/rtc-node';
import { TERMS } from './terms.ts';

initializeLogger({ pretty: false, level: 'warn' });

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIPS_DIR = join(HERE, 'clips');

function wavFromFrames(frames: AudioFrame[]): Buffer {
  const sampleRate = frames[0]?.sampleRate ?? 24000;
  const channels = frames[0]?.channels ?? 1;
  const pcm = Buffer.concat(frames.map((f) => Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength)));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

interface ClipResult {
  file: string;
  ms: number;
  frames: number;
  words: number;
  timedWords: string[];
}

async function synth(tts: rime.TTS, text: string, outFile: string): Promise<ClipResult> {
  const frames: AudioFrame[] = [];
  const timedWords: string[] = [];
  // The shipped path is the WebSocket streaming plugin, so drive it the same
  // way the agent does — .stream() + pushText + flush + endInput — not the
  // one-shot synthesize() (which the plugin only allows with useWebsocket=false).
  const stream = tts.stream();
  stream.pushText(text);
  stream.flush();
  stream.endInput();
  for await (const audio of stream) {
    if (typeof audio === 'symbol' || !(audio as { frame?: AudioFrame }).frame) continue;
    frames.push((audio as { frame: AudioFrame }).frame);
    const seg = (audio as unknown as { segmentId?: string }).segmentId;
    if (seg) timedWords.push(seg);
  }
  stream.close();
  const wav = wavFromFrames(frames);
  await writeFile(outFile, wav);
  const ms = frames.reduce((sum, f) => sum + (f.samplesPerChannel / f.sampleRate) * 1000, 0);
  return { file: outFile, ms: Math.round(ms), frames: frames.length, words: timedWords.length, timedWords };
}

async function main(): Promise<void> {
  const apiKey = process.env.RIME_API_KEY;
  if (!apiKey) {
    console.error('RIME_API_KEY required (apps/agent/.env.local). Aborting.');
    process.exit(1);
  }
  await mkdir(CLIPS_DIR, { recursive: true });

  const tts = new rime.TTS({
    apiKey,
    modelId: 'coda',
    speaker: 'celeste',
    lang: 'eng',
    useWebsocket: true,
    saveOovs: true,
  });

  const rows: string[] = [
    '| term | canonical | spelling A (plain) | dur A | spelling B (respelled) | dur B |',
    '|---|---|---|--:|---|--:|',
  ];

  for (const term of TERMS) {
    process.stderr.write(`  ${term.id} ... `);
    const a = await synth(tts, `This is ${term.plain}.`, join(CLIPS_DIR, `${term.id}.a.wav`));
    let bCell = '_(no variant)_';
    let bDur = '';
    if (term.respelled) {
      const b = await synth(tts, `This is ${term.respelled}.`, join(CLIPS_DIR, `${term.id}.b.wav`));
      bCell = `\`${term.respelled}\` → ${term.id}.b.wav`;
      bDur = `${b.ms} ms`;
    }
    rows.push(
      `| ${term.id} | ${term.canonical} | \`${term.plain}\` → ${term.id}.a.wav | ${a.ms} ms | ${bCell} | ${bDur} |`,
    );
    process.stderr.write('ok\n');
  }

  const report = [
    '# Rime pronunciation harness (§4.3)',
    '',
    `Rendered ${TERMS.length} infrastructure terms through the shipped judged path:`,
    '**Rime `coda` / speaker `celeste` / `eng` / WebSocket plugin**, `saveOovs: true`.',
    'Model and voice are held constant — the only variable is the submitted text.',
    'Clips are in [`clips/`](./clips). Listen to `<term>.a.wav` (what the LLM says by',
    'default) against `<term>.b.wav` (a respelled attempt) and keep whichever wins.',
    '',
    'Coda exposes no inline phonemes, so respelling the submitted text is the only',
    'lever — see the repo README "Rime depth" section. Where spelling B is clearly',
    'better, the fix is a term-substitution pass on the LLM output before TTS, or a',
    'Rime dictionary submission for that word.',
    '',
    ...rows,
    '',
    '## OOV words',
    '',
    'With `saveOovs: true` the Rime API logs the words it had to guess at. Check the',
    'agent worker log for `oov` entries after a real session, or the Rime dashboard —',
    'that list is the definitive fixture set for which terms need a dictionary entry.',
    '',
    `_Generated by \`pnpm --filter DD_agent pronunciation\` on ${new Date().toISOString().slice(0, 10)}._`,
    '',
  ].join('\n');

  await writeFile(join(HERE, 'REPORT.md'), report);
  console.log(`\nWrote ${TERMS.length * 1} + variants clips to ${CLIPS_DIR}`);
  console.log(`Wrote ${join(HERE, 'REPORT.md')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
