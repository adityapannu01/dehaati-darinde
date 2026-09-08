// Independently audits a REAL captured session log against the claim the
// whole project rests on: the canvas only ever shows what was actually
// heard. Every other check of this claim so far shares a weakness — the
// deterministic benchmark's oracle (oracle.ts) is independent of CommitGate,
// but only ever runs against synthetic, simulated scenarios; the live
// interruption tests we've done by hand check the SAME ledger the commit
// gate itself writes. Neither is a check against real session data using
// logic the commit gate doesn't own.
//
// This is: parse a real captured `pnpm dev` log, and for every mutation the
// ledger says was staged, independently decide — from nothing but the raw
// `[Cartograph] word:` stream and the ledger's own generation markers,
// never by importing commit-gate.ts or delivery.ts — whether the anchor
// phrase naming it was actually spoken before that generation ended. Compare
// the independent verdict against what the log says actually happened.
//
//   pnpm --filter DD_agent dev 2>&1 | tee /tmp/agent.log     # hold a real call
//   pnpm --filter DD_agent audit < /tmp/agent.log
//
// The only shared code with the production path is applyLexicon — a pure
// text-normalisation utility (Rime echoes back the post-respelling word,
// "engine ex" not "nginx"), not the commit/drop decision under audit.

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { applyLexicon } from '../core/lexicon.ts';

interface StagedRecord {
  id: string;
  generation: number;
  anchorPhrase: string;
}

export type Outcome = 'committed' | 'dropped';

interface ResolvedRecord {
  id: string;
  generation: number;
  outcome: Outcome;
  /** True when the ledger's own (warning-only) anchor-mismatch guard already flagged this commit. */
  loggedMismatch: boolean;
}

export interface AuditRow {
  id: string;
  generation: number;
  anchorPhrase: string;
  actual: Outcome;
  independent: Outcome;
  agree: boolean;
  loggedMismatch: boolean;
}

const STAGED_LINE = /\[ledger\] mutation_staged gen=(\d+) ([0-9a-f-]+) anchor="([^"]*)"/;
const COMMITTED_LINE = /\[ledger\] mutation_committed gen=(\d+) ([0-9a-f-]+)(?: \S+)?( anchor_mismatch)?/;
const DROPPED_LINE = /\[ledger\] mutation_dropped gen=(\d+) ([0-9a-f-]+)\b/;
const FIRST_AUDIO_LINE = /\[latency\] first_audio_frame gen=(\d+)/;
const WORD_LINE = /\[Cartograph\] word: "([^"]*)"/;

/**
 * Parses a captured log into: every staged mutation (id, generation, anchor),
 * every resolved outcome (id, generation, committed/dropped), and the
 * concatenated word stream actually delivered per generation — attributed by
 * tracking the most recent `first_audio_frame gen=N` marker, since individual
 * word lines don't carry a generation themselves.
 */
function parseLog(text: string): {
  staged: StagedRecord[];
  resolved: Map<string, ResolvedRecord>;
  wordsByGeneration: Map<number, string>;
} {
  const staged: StagedRecord[] = [];
  const resolved = new Map<string, ResolvedRecord>();
  const wordsByGeneration = new Map<number, string>();
  let currentWordGen: number | undefined;

  for (const line of text.split('\n')) {
    const first = line.match(FIRST_AUDIO_LINE);
    if (first) {
      currentWordGen = Number(first[1]);
      continue;
    }
    const word = line.match(WORD_LINE);
    if (word && currentWordGen !== undefined) {
      const prev = wordsByGeneration.get(currentWordGen) ?? '';
      wordsByGeneration.set(currentWordGen, `${prev} ${word[1]}`);
      continue;
    }
    const s = line.match(STAGED_LINE);
    if (s) {
      staged.push({ generation: Number(s[1]), id: s[2]!, anchorPhrase: s[3] ?? '' });
      continue;
    }
    const c = line.match(COMMITTED_LINE);
    if (c) {
      resolved.set(c[2]!, {
        id: c[2]!,
        generation: Number(c[1]),
        outcome: 'committed',
        loggedMismatch: c[3] !== undefined,
      });
      continue;
    }
    const d = line.match(DROPPED_LINE);
    if (d) {
      resolved.set(d[2]!, { id: d[2]!, generation: Number(d[1]), outcome: 'dropped', loggedMismatch: false });
    }
  }

  return { staged, resolved, wordsByGeneration };
}

/**
 * The independent verdict: was this anchor phrase actually present in the
 * words delivered for its generation, by the end of the captured session?
 * Deliberately coarse — a plain substring check on the complete word stream,
 * not the sentence-boundary/timing logic DeliveryTracker uses. If the
 * generation was interrupted, no further words for it exist in the log past
 * that point, so the concatenated text is naturally truncated there — an
 * interrupted anchor simply won't be found, without needing to model
 * interruption timing explicitly.
 */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function independentVerdict(anchorPhrase: string, wordsForGeneration: string): Outcome {
  const heard = normalizeWhitespace(applyLexicon(wordsForGeneration)).toLowerCase();
  const anchor = normalizeWhitespace(applyLexicon(anchorPhrase)).toLowerCase();
  return heard.includes(anchor) ? 'committed' : 'dropped';
}

export function auditSession(text: string): AuditRow[] {
  const { staged, resolved, wordsByGeneration } = parseLog(text);
  const rows: AuditRow[] = [];

  for (const s of staged) {
    const actualRecord = resolved.get(s.id);
    if (!actualRecord) continue; // never reached a terminal state in this capture window
    const words = wordsByGeneration.get(s.generation) ?? '';
    const independent = independentVerdict(s.anchorPhrase, words);
    rows.push({
      id: s.id,
      generation: s.generation,
      anchorPhrase: s.anchorPhrase,
      actual: actualRecord.outcome,
      independent,
      agree: independent === actualRecord.outcome,
      loggedMismatch: actualRecord.loggedMismatch,
    });
  }

  return rows;
}

function main(): void {
  const text = readFileSync(0, 'utf8');
  const rows = auditSession(text);

  if (rows.length === 0) {
    console.error('No staged+resolved mutation pairs found on stdin. Pipe a real agent worker log in.');
    process.exit(1);
  }

  console.log('| id | gen | anchor | actual | independent | agree | ledger already flagged mismatch |');
  console.log('|---|--:|---|---|---|---|---|');
  for (const r of rows) {
    console.log(
      `| ${r.id.slice(0, 8)} | ${r.generation} | ${r.anchorPhrase} | ${r.actual} | ${r.independent} | ${r.agree ? 'yes' : '**NO**'} | ${r.loggedMismatch ? 'yes' : ''} |`,
    );
  }

  const disagreements = rows.filter((r) => !r.agree);
  const unexpectedDisagreements = disagreements.filter((r) => !r.loggedMismatch);
  console.log('');
  console.log(`n=${rows.length} staged mutations audited independently of commit-gate.ts / delivery.ts.`);
  console.log(`Agreement: ${rows.length - disagreements.length}/${rows.length}.`);
  if (disagreements.length > 0) {
    console.log(
      `Disagreements: ${disagreements.length} (${unexpectedDisagreements.length} not already flagged by the ledger's own anchor_mismatch guard — investigate those).`,
    );
  }
}

// Runnable directly: `pnpm --filter DD_agent audit`.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
