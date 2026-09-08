// Renders the pronunciation + controlled-delivery fixtures through the SHIPPED
// judged path — the Rime `coda:celeste` WebSocket plugin — and writes WAV clips
// + REPORT.md. Covers every category the PS names: domain vocabulary (TERMS),
// numbers / codes / identifiers / addresses and the delivery cases —
// punctuation, fillers, false starts (DELIVERY_FIXTURES) — plus a speed sweep.
//
//   pnpm --filter DD_agent pronunciation      (reads RIME_API_KEY from .env.local)
//
// Needs the key and network. The audio is non-deterministic, so this produces
// no pass/fail number — the deliverable is the saved clips + the wording table.
// Verdicts are a HUMAN pass: listen to `<id>.a.wav` vs `<id>.c.wav`, then fill
// `verdicts.json` (`{"<id>": {"verdict": "a|b|c|fix", "note": "..."}}`). It is
// merged into REPORT.md and survives re-runs.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import dotenv from 'dotenv';
import { initializeLogger } from '@livekit/agents';
import * as rime from '@livekit/agents-plugin-rime';
import type { AudioFrame } from '@livekit/rtc-node';
import { applyLexicon } from '../../core/lexicon.ts';
import { RIME_DEFAULTS } from '../../tts.ts';
import { DELIVERY_FIXTURES, SPEED_SWEEP, TERMS } from './terms.ts';

dotenv.config({ path: 'apps/agent/.env.local' });
dotenv.config({ path: '.env.local' });
initializeLogger({ pretty: false, level: 'warn' });

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIPS_DIR = join(HERE, 'clips');

function wavFromFrames(frames: AudioFrame[]): Buffer {
  const sampleRate = frames[0]?.sampleRate ?? 24000;
  const channels = frames[0]?.channels ?? 1;
  const pcm = Buffer.concat(
    frames.map((f) => Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength)),
  );
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

async function synth(tts: rime.TTS, text: string, outFile: string): Promise<{ ms: number }> {
  const frames: AudioFrame[] = [];
  const stream = tts.stream();
  stream.pushText(text);
  stream.flush();
  stream.endInput();
  for await (const audio of stream) {
    if (typeof audio === 'symbol' || !(audio as { frame?: AudioFrame }).frame) continue;
    frames.push((audio as { frame: AudioFrame }).frame);
  }
  stream.close();
  await writeFile(outFile, wavFromFrames(frames));
  const ms = frames.reduce((sum, f) => sum + (f.samplesPerChannel / f.sampleRate) * 1000, 0);
  return { ms: Math.round(ms) };
}

interface Verdict {
  verdict: 'a' | 'b' | 'c' | 'fix' | '';
  note?: string;
}

async function loadVerdicts(): Promise<Record<string, Verdict>> {
  try {
    return JSON.parse(await readFile(join(HERE, 'verdicts.json'), 'utf8')) as Record<string, Verdict>;
  } catch {
    return {};
  }
}

function verdictCell(v: Verdict | undefined): string {
  if (!v || !v.verdict) return '_(listen)_';
  const label: Record<string, string> = {
    a: 'plain ok',
    b: 'respell',
    c: 'lexicon',
    fix: '⚠ still wrong',
  };
  return v.note ? `**${label[v.verdict]}** — ${v.note}` : `**${label[v.verdict]}**`;
}

async function main(): Promise<void> {
  const apiKey = process.env.RIME_API_KEY;
  if (!apiKey) {
    console.error('RIME_API_KEY required (apps/agent/.env.local). Aborting.');
    process.exit(1);
  }
  await mkdir(CLIPS_DIR, { recursive: true });
  const verdicts = await loadVerdicts();

  const base = {
    apiKey,
    baseURL: RIME_DEFAULTS.baseURL,
    modelId: RIME_DEFAULTS.model,
    speaker: RIME_DEFAULTS.voice,
    lang: RIME_DEFAULTS.language,
    useWebsocket: true,
  } as const;
  const tts = new rime.TTS(base);

  // --- 1. Domain vocabulary: A plain / B candidate respelling / C shipped lexicon ---
  const termRows: string[] = [
    '| term | A: plain | dur | B: candidate | dur | C: shipped lexicon | dur | verdict |',
    '|---|---|--:|---|--:|---|--:|---|',
  ];
  for (const term of TERMS) {
    process.stderr.write(`  ${term.id} ... `);
    const a = await synth(tts, `This is ${term.plain}.`, join(CLIPS_DIR, `${term.id}.a.wav`));
    let bCell = '—';
    let bDur = '';
    if (term.respelled) {
      const b = await synth(tts, `This is ${term.respelled}.`, join(CLIPS_DIR, `${term.id}.b.wav`));
      bCell = `\`${term.respelled}\``;
      bDur = `${b.ms}`;
    }
    const lex = applyLexicon(`This is ${term.plain}.`);
    const changed = lex !== `This is ${term.plain}.`;
    let cCell = '_(no lexicon entry)_';
    let cDur = '';
    if (changed) {
      const c = await synth(tts, lex, join(CLIPS_DIR, `${term.id}.c.wav`));
      cCell = `\`${lex.replace(/^This is |\.$/g, '')}\``;
      cDur = `${c.ms}`;
    }
    termRows.push(
      `| ${term.canonical} | \`${term.plain}\` | ${a.ms} | ${bCell} | ${bDur} | ${cCell} | ${cDur} | ${verdictCell(verdicts[term.id])} |`,
    );
    process.stderr.write('ok\n');
  }

  // --- 2. Numbers / codes / identifiers / addresses + delivery cases ---
  const deliveryRows: string[] = [
    '| id | category | naive ("before") | persona form ("after") | listen for | verdict |',
    '|---|---|---|---|---|---|',
  ];
  for (const f of DELIVERY_FIXTURES) {
    process.stderr.write(`  ${f.id} ... `);
    if (f.naive) await synth(tts, f.naive, join(CLIPS_DIR, `${f.id}.naive.wav`));
    await synth(tts, f.text, join(CLIPS_DIR, `${f.id}.persona.wav`));
    deliveryRows.push(
      `| \`${f.id}\` | ${f.category} | ${f.naive ? `\`${f.naive}\`` : '—'} | \`${f.text}\` | ${f.listenFor} | ${verdictCell(verdicts[f.id])} |`,
    );
    process.stderr.write('ok\n');
  }

  // --- 3. Speed sweep (timeScaleFactor works on Coda; >1 is slower) ---
  const speedRows: string[] = ['| factor | dur (ms) | verdict |', '|--:|--:|---|'];
  for (const factor of SPEED_SWEEP.factors) {
    process.stderr.write(`  speed ${factor} ... `);
    const speedTts = new rime.TTS({ ...base, timeScaleFactor: factor });
    const r = await synth(speedTts, SPEED_SWEEP.text, join(CLIPS_DIR, `speed-${factor}.wav`));
    speedRows.push(`| ${factor} | ${r.ms} | ${verdictCell(verdicts[`speed-${factor}`])} |`);
    process.stderr.write('ok\n');
  }

  const report = [
    '# Rime pronunciation & controlled-delivery harness',
    '',
    `Everything rendered through the **shipped judged path** — Rime \`${RIME_DEFAULTS.model}\` /`,
    `speaker \`${RIME_DEFAULTS.voice}\` / \`${RIME_DEFAULTS.language}\` / WebSocket plugin,`,
    'region `us-west-2`. Model and voice held constant; the only lever is the submitted',
    'text — Coda has **no inline phonemes** (Mist v2 only) and its text normalisation',
    'cannot be turned off (`noTextNormalization` is not forwarded for `coda` by',
    '`@livekit/agents-plugin-rime@1.7.1` — verified in `modelParams()`).',
    '',
    '**Verdicts are a human pass.** Listen to the clip pair, then edit `verdicts.json` and',
    're-run — the tables below merge it. `_(listen)_` = not yet judged.',
    '',
    '## 1. Domain vocabulary',
    '',
    '- **A** — `This is <term>.` verbatim, what a naive prompt sends → `<id>.a.wav`',
    '- **B** — a hand-picked candidate respelling (`terms.ts`) → `<id>.b.wav`',
    '- **C** — exactly what the shipped `ttsNode` tap sends Rime (`applyLexicon`, `core/lexicon.ts`) → `<id>.c.wav`',
    '',
    ...termRows,
    '',
    '## 2. Numbers, codes, identifiers, addresses + delivery',
    '',
    'The persona (`agent.ts`, "Writing for the ear") tells the LLM to phrase these as words,',
    'not digits/symbols — Coda normalisation is unpredictable and cannot be disabled. Each',
    'row: `<id>.naive.wav` (what a naive prompt emits) vs `<id>.persona.wav` (the rule).',
    '',
    ...deliveryRows,
    '',
    '## 3. Speed',
    '',
    `Same sentence — _"${SPEED_SWEEP.text}"_ — at three \`timeScaleFactor\` values`,
    '(`RIME_SPEED` env in production; >1 = slower on Coda). Clips: `speed-<factor>.wav`.',
    'Per-word slow-down (`inlineSpeedAlpha`) is **not** available on Coda — the plugin gates',
    'it behind `modelId.includes("mist")`.',
    '',
    ...speedRows,
    '',
    '## OOV reporting — checked, not available',
    '',
    'The Rime `ws3` streaming endpoint returns no out-of-vocabulary report. Verified',
    'directly: `save_oovs=true` / `saveOovs=true` on the `ws3` URL yields only `chunk` /',
    '`timestamps` / `done` frames, and `@livekit/agents-plugin-rime@1.7.1` never forwards',
    "`saveOovs` anyway. So which terms Rime guessed at is judged here by ear (A vs C), not",
    "from a provider list. Rime's account dashboard may surface OOVs for a real session;",
    'that is the only other source.',
    '',
    `_Generated by \`pnpm --filter DD_agent pronunciation\` on ${new Date().toISOString().slice(0, 10)}._`,
    '',
  ].join('\n');

  await writeFile(join(HERE, 'REPORT.md'), report);
  console.log(`\nWrote clips to ${CLIPS_DIR}`);
  console.log(`Wrote ${join(HERE, 'REPORT.md')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
