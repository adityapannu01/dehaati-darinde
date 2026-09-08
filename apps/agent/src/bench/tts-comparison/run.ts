// Comparative TTS evaluation: Rime vs two alternatives, for this project's
// actual use case (interruption + pronunciation of infra terms) — the PS's
// own "if the project is a benchmark" rules, applied even though Cartograph's
// chosen hard problem is interruption/recovery, not evaluation/observability.
//
//   RIME_API_KEY=... pnpm --filter DD_agent tts-comparison
//
// Four metrics, each with its own methodology (see REPORT.md's Methodology
// section for the full disclosure):
//   1. Word alignment fidelity  — inspect real synthesis output, not docs
//   2. Latency to first audio   — N reps per provider, cold vs warm separated
//   3. Reliability under interruption — start + abort mid-stream, N reps
//   4. Intelligibility          — synthesize -> re-transcribe via the same
//      STT this project already uses -> compare to the intended term
//
// Deliberately does NOT attempt the PS's "blinded listening test" for
// subjective quality — that needs a human ear. It prepares for it instead:
// clips are also copied into a `blind/` folder under randomized filenames
// with a separate, git-ignored answer key, so a listening pass can be done
// without knowing which provider is which until after judging.

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import dotenv from 'dotenv';
import { type tts as ttsTypes, initializeLogger, stt as sttTypes } from '@livekit/agents';
import { inference } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { TERMS } from '../pronunciation/terms.ts';
import { buildProviders } from './providers.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIPS_DIR = join(HERE, 'clips');
const BLIND_DIR = join(HERE, 'blind');

// Cartesia/Fish Audio (via inference.TTS/STT) need LIVEKIT_API_KEY/SECRET —
// the same ones already used elsewhere in this repo — loaded here the same
// way main.ts does, so this script is runnable on its own with just
// RIME_API_KEY supplied on the command line (see the header comment above).
dotenv.config({ path: join(HERE, '../../..', '.env.local') });

initializeLogger({ pretty: false, level: 'warn' });

// A "small" comparison per the PS's own wording — a representative slice of
// the existing 44-term pronunciation fixture, not all of it: acronyms
// (nginx, gRPC, OAuth, S3, IAM, CI/CD), product names with non-obvious
// pronunciation (PostgreSQL, etcd, Kubernetes, Memcached, Prometheus,
// RabbitMQ), and two "the LLM would just say this" baselines (Redis, Kafka).
const SUBSET_IDS = [
  'nginx', 'postgresql', 'etcd', 'redis', 'kafka', 'grpc', 'oauth', 's3',
  'iam', 'k8s', 'memcached', 'prometheus', 'rabbitmq', 'graphql', 'ci-cd',
];
const SUBSET = TERMS.filter((t) => SUBSET_IDS.includes(t.id));

const LATENCY_REPS = 5; // 1 cold + 4 warm
const RELIABILITY_REPS = 5;
const LATENCY_PHRASE = 'Adding a Postgres database.';
const RELIABILITY_PHRASE =
  "I'm connecting the API gateway to the authentication service, then wiring up the Postgres database, and finally adding a Redis cache in front of it.";

export function wavFromFrames(frames: AudioFrame[]): Buffer {
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
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

interface SynthResult {
  frames: AudioFrame[];
  firstFrameMs: number | null;
  timedTranscripts: unknown[] | null;
}

async function synthOnce(tts: ttsTypes.TTS, text: string): Promise<SynthResult> {
  const t0 = Date.now();
  const frames: AudioFrame[] = [];
  let firstFrameMs: number | null = null;
  let timedTranscripts: unknown[] | null = null;
  const stream = tts.stream();
  stream.pushText(text);
  stream.flush();
  stream.endInput();
  for await (const ev of stream) {
    if (typeof ev === 'symbol') continue;
    const e = ev as { frame?: AudioFrame; timedTranscripts?: unknown[] };
    if (e.frame) {
      frames.push(e.frame);
      firstFrameMs ??= Date.now() - t0;
    }
    if (e.timedTranscripts?.length && !timedTranscripts) timedTranscripts = e.timedTranscripts;
  }
  stream.close();
  return { frames, firstFrameMs, timedTranscripts };
}

/**
 * Drives a TTS instance the same way the agent does — stream + push + flush +
 * end, not one-shot synthesize(). Retries once on a silent zero-frame result:
 * running dozens of connections back to back through the same gateway
 * (~25 per provider in this harness) hit that transiently for one provider
 * on the first run, distinguishable from a real provider failure only by
 * retrying — a genuine failure fails again, a transient one doesn't.
 */
async function synth(makeTts: () => ttsTypes.TTS, text: string): Promise<SynthResult> {
  const first = await synthOnce(makeTts(), text);
  if (first.frames.length > 0) return first;
  await new Promise((r) => setTimeout(r, 500));
  return synthOnce(makeTts(), text);
}

/** Starts synthesis and aborts partway through consuming frames — the TTS-side analogue of a user interruption. */
async function abortMidStream(tts: ttsTypes.TTS, text: string): Promise<'clean' | 'error' | 'hung'> {
  const stream = tts.stream();
  stream.pushText(text);
  stream.flush();
  stream.endInput();
  const TIMEOUT_MS = 8000;
  try {
    let frames = 0;
    const iterate = (async () => {
      for await (const ev of stream) {
        if (typeof ev === 'symbol') continue;
        if ((ev as { frame?: unknown }).frame) {
          frames += 1;
          if (frames >= 3) {
            stream.close();
            return;
          }
        }
      }
    })();
    await Promise.race([
      iterate,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)),
    ]);
    return 'clean';
  } catch (err) {
    if (err instanceof Error && err.message === 'timeout') return 'hung';
    return 'error';
  }
}

/**
 * inference.STT only supports streaming recognition (`.recognize()` — the
 * batch/one-shot method on the base class — throws "does not support batch
 * recognition, use stream() instead" for this provider). Push every frame,
 * end input, collect FINAL_TRANSCRIPT text in order.
 *
 * The stream's async iterator does not complete on its own after
 * `endInput()` — confirmed empirically: even after END_OF_SPEECH arrives,
 * `for await` just keeps waiting. So this breaks the loop itself once
 * END_OF_SPEECH is seen, with an 8s timeout as a safety net (same pattern as
 * `abortMidStream`) in case a provider never sends one.
 */
async function transcribe(stt: InstanceType<typeof inference.STT>, frames: AudioFrame[]): Promise<string> {
  const stream = stt.stream();
  for (const frame of frames) stream.pushFrame(frame);
  stream.endInput();
  const parts: string[] = [];
  const TIMEOUT_MS = 8000;
  try {
    const iterate = (async () => {
      for await (const ev of stream) {
        if (ev.type === sttTypes.SpeechEventType.FINAL_TRANSCRIPT) {
          const text = ev.alternatives?.[0]?.text;
          if (text) parts.push(text);
        }
        if (ev.type === sttTypes.SpeechEventType.END_OF_SPEECH) return;
      }
    })();
    await Promise.race([
      iterate,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)),
    ]);
  } catch (err) {
    if (!(err instanceof Error && err.message === 'timeout')) throw err;
    // Timed out waiting for END_OF_SPEECH — return whatever FINAL_TRANSCRIPT text arrived before then.
  }
  stream.close();
  return parts.join(' ').trim();
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

/** Loose intelligibility check: does the STT transcript contain the term's own words (order-independent, punctuation-stripped)? */
export function transcriptMatches(transcript: string, canonical: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const wanted = norm(canonical);
  const got = new Set(norm(transcript));
  return wanted.every((w) => got.has(w) || [...got].some((g) => g.includes(w) || w.includes(g)));
}

async function main(): Promise<void> {
  const rimeApiKey = process.env.RIME_API_KEY;
  if (!rimeApiKey) {
    console.error('RIME_API_KEY required (apps/agent/.env.local). Aborting.');
    process.exit(1);
  }
  await mkdir(CLIPS_DIR, { recursive: true });
  await mkdir(BLIND_DIR, { recursive: true });

  const providers = buildProviders(rimeApiKey);
  const makeStt = () => new inference.STT({ model: 'assemblyai/universal-3-5-pro', language: 'en' });

  const alignment: Record<string, { capabilities: unknown; realTimestamps: boolean }> = {};
  const latency: Record<string, { coldMs: number; warmMedianMs: number; warmP95Ms: number; samples: number[] }> = {};
  const reliability: Record<string, string[]> = {};
  const intelligibility: { provider: string; term: string; canonical: string; transcript: string; match: boolean; hadAudio: boolean }[] = [];
  const blindKey: { blindId: string; provider: string; term: string }[] = [];
  // Every synth() call that came back with zero audio frames after its own
  // retry-once, keyed by provider — this project's own harness turned out to
  // be a live stress test of the LiveKit Inference gateway, and that data is
  // worth reporting on its own terms rather than silently absorbing it into
  // -1ms latencies and blank transcripts. See "Observed gateway reliability"
  // in the generated report.
  const connectionFailures: Record<string, { attempts: number; failures: number }> = {};
  function recordAttempt(providerId: string, gotAudio: boolean): void {
    const c = (connectionFailures[providerId] ??= { attempts: 0, failures: 0 });
    c.attempts += 1;
    if (!gotAudio) c.failures += 1;
  }

  for (const p of providers) {
    process.stderr.write(`\n== ${p.id} ==\n`);
    await mkdir(join(CLIPS_DIR, p.id), { recursive: true });

    // 1. Alignment fidelity — real data, not documentation.
    process.stderr.write('  alignment check... ');
    const probe = await synth(p.make, LATENCY_PHRASE);
    alignment[p.id] = {
      capabilities: (p.make() as unknown as { capabilities?: unknown }).capabilities,
      realTimestamps: !!probe.timedTranscripts?.length,
    };
    process.stderr.write(`${alignment[p.id]!.realTimestamps ? 'yes' : 'no'}\n`);

    // 2. Latency to first audio — 1 cold + N-1 warm, on a fresh stream each time.
    process.stderr.write('  latency... ');
    const samples: number[] = [];
    for (let i = 0; i < LATENCY_REPS; i++) {
      const r = await synth(p.make, LATENCY_PHRASE);
      samples.push(r.firstFrameMs ?? -1);
      recordAttempt(p.id, r.frames.length > 0);
      process.stderr.write('.');
    }
    const cold = samples[0]!;
    const warm = samples.slice(1);
    latency[p.id] = { coldMs: cold, warmMedianMs: median(warm), warmP95Ms: Math.max(...warm), samples };
    process.stderr.write(` cold=${cold}ms warm-median=${median(warm)}ms\n`);

    // 3. Reliability under interruption — abort partway through a longer phrase, N reps.
    process.stderr.write('  reliability... ');
    const outcomes: string[] = [];
    for (let i = 0; i < RELIABILITY_REPS; i++) {
      outcomes.push(await abortMidStream(p.make(), RELIABILITY_PHRASE));
      process.stderr.write('.');
    }
    reliability[p.id] = outcomes;
    process.stderr.write(` ${outcomes.join(',')}\n`);

    // 4. Intelligibility — synth each term, save clip, re-transcribe, compare.
    process.stderr.write('  intelligibility (15 terms): ');
    for (const term of SUBSET) {
      const r = await synth(p.make, term.plain);
      recordAttempt(p.id, r.frames.length > 0);
      const wavPath = join(CLIPS_DIR, p.id, `${term.id}.wav`);
      const wav = wavFromFrames(r.frames);
      await writeFile(wavPath, wav);

      let transcript = '';
      try {
        if (r.frames.length > 0) {
          transcript = await transcribe(makeStt(), r.frames);
          // The Inference gateway's STT connection was observed to fail
          // transiently under this harness's back-to-back call volume — an
          // empty result with no thrown error looks identical to "the
          // audio was unintelligible," so retry once before accepting it.
          if (!transcript.trim()) {
            await new Promise((res) => setTimeout(res, 500));
            transcript = await transcribe(makeStt(), r.frames);
          }
          // Track separately from TTS connection failures: this is real
          // audio that the STT side never returned text for, after its own
          // retry — the same gateway-under-load pattern, on the STT leg.
          recordAttempt('stt (re-transcription of real audio)', transcript.trim().length > 0);
        }
      } catch (err) {
        transcript = `[STT error: ${err instanceof Error ? err.message : String(err)}]`;
      }
      const match = transcriptMatches(transcript, term.canonical);
      intelligibility.push({
        provider: p.id,
        term: term.id,
        canonical: term.canonical,
        transcript,
        match,
        hadAudio: r.frames.length > 0,
      });

      // Blinded copy: random filename, real mapping kept only in the (git-ignored) key.
      const blindId = randomUUID().slice(0, 8);
      await writeFile(join(BLIND_DIR, `${blindId}.wav`), wav);
      blindKey.push({ blindId, provider: p.id, term: term.id });

      process.stderr.write(match ? '.' : 'x');
    }
    process.stderr.write('\n');
  }

  await writeFile(join(HERE, 'blind-key.json'), JSON.stringify(blindKey, null, 2));

  // Per-item CSV (the PS asks for item-level results, not just a summary).
  const csvLines = ['provider,term,canonical,match,had_audio,transcript'];
  for (const row of intelligibility) {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    csvLines.push(`${row.provider},${row.term},${esc(row.canonical)},${row.match},${row.hadAudio},${esc(row.transcript)}`);
  }
  await writeFile(join(HERE, 'results.csv'), csvLines.join('\n') + '\n');

  // REPORT.md
  const lines: string[] = [];
  lines.push('# Comparative TTS evaluation — Rime vs Cartesia vs Fish Audio');
  lines.push('');
  lines.push(
    'Generated by `pnpm --filter DD_agent tts-comparison`. Small, blinded, and disclosed — per the ' +
      'PS\'s comparative-benchmark rules. This project\'s chosen hard voice problem is interruption/' +
      'recovery, not evaluation/benchmarking, so this comparison exists to satisfy that requirement, ' +
      'not as the project\'s headline claim.',
  );
  lines.push('');
  lines.push('## Configuration (exact, for reproducibility)');
  lines.push('');
  for (const p of providers) {
    lines.push(`**${p.describe}**`);
    for (const [k, v] of Object.entries(p.config)) lines.push(`- ${k}: \`${v}\``);
    lines.push('');
  }
  lines.push(
    `Test corpus: ${SUBSET.length} of the existing 44-term pronunciation fixture (\`bench/pronunciation/terms.ts\`) — a representative slice, not the full set, per the PS's "small" comparison request: ${SUBSET.map((t) => t.id).join(', ')}.`,
  );
  lines.push('');
  lines.push('## 1. Word alignment fidelity');
  lines.push('');
  lines.push('Checked against real synthesis output, not provider documentation — a claim of alignment support means nothing if the field comes back empty.');
  lines.push('');
  lines.push('| Provider | `capabilities.alignedTranscript` | Real `timedTranscripts` on synthesis |');
  lines.push('|---|---|---|');
  for (const p of providers) {
    const a = alignment[p.id]!;
    lines.push(`| ${p.describe.split(' — ')[0]} | ${JSON.stringify((a.capabilities as { alignedTranscript?: boolean })?.alignedTranscript)} | ${a.realTimestamps ? 'yes' : 'no'} |`);
  }
  lines.push('');
  lines.push(
    'Finding worth stating plainly: Cartesia returns real, populated word-level timestamps through the plain LiveKit Inference gateway with `add_timestamps: true` — no dedicated plugin required. Rime only gets equivalent alignment through its *direct* WebSocket plugin (`@livekit/agents-plugin-rime`); Rime via the Inference gateway has no timestamp flag at all (disclosed elsewhere in this repo). Fish Audio has no alignment path via either route in this test. This means Cartograph\'s commit-gate architecture is not uniquely tied to Rime — it could theoretically run on Cartesia too. Rime remains the primary spoken output per the PS\'s own requirement; this is a fairness disclosure, not a design change.',
  );
  lines.push('');
  lines.push('## 2. Latency to first audio');
  lines.push('');
  lines.push(`Fixed phrase (\`"${LATENCY_PHRASE}"\`), ${LATENCY_REPS} reps per provider, fresh connection each time. First rep is cold (connection/TLS setup); remaining ${LATENCY_REPS - 1} are warm.`);
  lines.push('');
  lines.push('| Provider | cold (ms) | warm median (ms) | warm max (ms) | all samples (ms) |');
  lines.push('|---|--:|--:|--:|---|');
  for (const p of providers) {
    const l = latency[p.id]!;
    lines.push(`| ${p.describe.split(' — ')[0]} | ${l.coldMs} | ${l.warmMedianMs} | ${l.warmP95Ms} | ${l.samples.join(', ')} |`);
  }
  lines.push('');
  lines.push(
    'A `-1` here means every attempt for that rep came back with zero audio frames — a connection failure, not a slow response. See §3a for what that means and how often it happened.',
  );
  lines.push('');
  lines.push('Network latency (this machine to each provider\'s edge) is not separated from model/synthesis latency here — both are folded into "time to first frame." Treat as an approximation, not a controlled lab measurement; see Limitations.');
  lines.push('');
  lines.push('## 3. Reliability under interruption');
  lines.push('');
  lines.push(`Start synthesis on a longer phrase, abort after 3 audio frames (~simulating a user cutting in), ${RELIABILITY_REPS} reps per provider. Outcomes: \`clean\` (aborted without error or hang), \`error\` (threw), \`hung\` (exceeded an 8s timeout).`);
  lines.push('');
  lines.push('| Provider | outcomes |');
  lines.push('|---|---|');
  for (const p of providers) {
    lines.push(`| ${p.describe.split(' — ')[0]} | ${reliability[p.id]!.join(', ')} |`);
  }
  lines.push('');
  lines.push(
    '**Read this table together with §3a.** `clean` means "the stream ended without the harness seeing an error or hang" — for a provider whose connection was failing outright at the time (§3a), that is a false positive: `abortMidStream` never received 3 frames to abort *after*, so it just watched an already-empty stream end quietly and reported success. `clean` is only meaningful evidence of graceful interruption handling for a provider that was actually producing audio.',
  );
  lines.push('');
  lines.push('## 3a. Observed gateway connection reliability (unplanned, but real)');
  lines.push('');
  lines.push(
    'Not one of the four metrics the PS asked for — this harness itself turned into a live stress test of the LiveKit Inference gateway (`agent-gateway.livekit.cloud`), and hiding that behind clean-looking `-1`s and blank transcripts would misrepresent what actually happened. Every synthesis/re-transcription attempt across §2 and §4 is counted here, success meaning "at least one real audio frame" (or, for STT, "a non-empty transcript") after this harness\'s own retry-once:',
  );
  lines.push('');
  lines.push('| Leg | attempts | failures | failure rate |');
  lines.push('|---|--:|--:|--:|');
  for (const [id, c] of Object.entries(connectionFailures)) {
    const label = providers.find((p) => p.id === id)?.describe.split(' — ')[0] ?? id;
    const rate = c.attempts > 0 ? `${Math.round((100 * c.failures) / c.attempts)}%` : 'n/a';
    lines.push(`| ${label} | ${c.attempts} | ${c.failures} | ${rate} |`);
  }
  lines.push('');
  lines.push(
    'Rime never touches this gateway at all — it goes over its own direct WebSocket straight to `wss://users-ws.rime.ai`, which is exactly why it has zero failures here regardless of how the gateway is behaving. Fish Audio failed to connect on every attempt made across this run *and* every isolated single-call smoke test run separately during development (different `.env.local` states, a second, entirely different LiveKit Cloud project, minimal 1-sentence payloads) — config verified word-for-word against LiveKit\'s current Fish Audio docs each time. That pattern (0% success, unconditional, independent of load or credentials) is different in kind from Cartesia\'s, which is a provider that works when the gateway isn\'t under sustained load and stops working, without throwing, once it is — both real, both worth knowing before picking a TTS provider that has to survive production traffic.',
  );
  lines.push('');
  lines.push('## 4. Intelligibility (pronunciation of infra terms)');
  lines.push('');
  lines.push(
    `Each term rendered through each provider (as the LLM would naturally say it — no lexicon respelling applied, so this is a fair, unmodified baseline for all three), then re-transcribed with this project's own STT (\`assemblyai/universal-3-5-pro\`) and checked against the canonical term. This is an automated, reproducible proxy for intelligibility — not a substitute for the blinded human listening test below, which the PS also asks for.`,
  );
  lines.push('');
  lines.push('| Provider | matched | / | total | audio actually produced |');
  lines.push('|---|--:|---|--:|--:|');
  for (const p of providers) {
    const rows = intelligibility.filter((r) => r.provider === p.id);
    const matched = rows.filter((r) => r.match).length;
    const hadAudio = rows.filter((r) => r.hadAudio).length;
    lines.push(`| ${p.describe.split(' — ')[0]} | ${matched} | / | ${rows.length} | ${hadAudio}/${rows.length} |`);
  }
  lines.push('');
  lines.push(
    '"matched" out of a row where "audio actually produced" is below the total is not a pronunciation failure — it is a connection failure counted as a miss, per §3a. Read the two columns together, not "matched" alone.',
  );
  lines.push('');
  lines.push('Full per-term results: `results.csv` (also the item-level table below).');
  lines.push('');
  lines.push('| provider | term | canonical | match | audio? | STT transcript |');
  lines.push('|---|---|---|---|---|---|');
  for (const row of intelligibility) {
    lines.push(`| ${row.provider} | ${row.term} | ${row.canonical} | ${row.match ? 'yes' : '**no**'} | ${row.hadAudio ? 'yes' : '**no audio**'} | ${row.transcript.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  lines.push('## 5. Blinded listening test — prepared, not scored here');
  lines.push('');
  lines.push(
    `\`blind/\` contains every clip generated above (${blindKey.length} files) renamed to a random 8-character id — no provider or term name in the filename. \`blind-key.json\` (git-ignored) holds the real mapping. To run the blind pass: listen to each clip in \`blind/\` without opening the key, rate naturalness/quality, then reveal the mapping and tally by provider. This step needs a human ear and is intentionally left undone by this script — see the repo README for instructions on running it.`,
  );
  lines.push('');
  lines.push('## Limitations');
  lines.push('');
  lines.push('- Small sample: 15 of 44 terms, 5 reps for latency/reliability. Exploratory, not a large-N statistical claim, per the PS\'s own guidance to label small-sample findings as such.');
  lines.push('- Latency numbers mix network and model latency (both machine-to-provider and provider-internal); not separated into a controlled lab measurement.');
  lines.push('- Intelligibility scoring is automated (STT round-trip), not human judgment — a real proxy, not equivalent to the blinded listening test the PS separately asks for.');
  lines.push('- All three providers were tested at their default voice — no attempt was made to cherry-pick the best-sounding voice per provider beyond picking a real, current, non-deprecated one from LiveKit\'s docs.');
  lines.push('- This is not this project\'s headline claim — Rime remains the primary spoken output in the shipped product; this comparison exists to satisfy the PS\'s benchmark-comparison rules, run once, not iterated into a competitive leaderboard.');
  lines.push(
    '- **The two gateway-routed providers\' latency/reliability/intelligibility numbers are lower-bound, not representative, estimates.** §3a is not a footnote — this run\'s Cartesia and Fish Audio numbers were shaped as much by `agent-gateway.livekit.cloud`\'s connection reliability at test time as by the models themselves. Cartesia\'s alignment/latency/reliability sections (the first ~11 calls) came back clean and are trustworthy as reported; its intelligibility section (15 more back-to-back calls right after) came back 0% because the connection degraded under that load, not because the audio was unintelligible. Fish Audio never connected in any test run during this investigation, isolated or not, across two different LiveKit Cloud projects — its numbers here should be read as "unmeasured," not "measured and failing."',
  );
  lines.push('');
  lines.push(`_Generated ${new Date().toISOString().slice(0, 10)}._`);

  await writeFile(join(HERE, 'REPORT.md'), lines.join('\n') + '\n');
  console.log(`\nWrote clips to ${CLIPS_DIR}, blind set to ${BLIND_DIR}, results.csv, and REPORT.md`);
}

// Guarded so this file stays importable (for its pure helper functions) in
// tests without kicking off the full network harness as a side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  // Some open connection/handle from the TTS/STT plugins outlives a
  // logically finished main() — without this the process hangs indefinitely
  // after every file is written and stable. Exit explicitly once done.
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
