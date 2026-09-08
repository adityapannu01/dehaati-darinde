import { describe, expect, it } from 'vitest';
import { auditSession } from './audit-session.ts';

/** Builds a minimal, realistic slice of a captured agent log for one generation. */
function fixture(lines: string[]): string {
  return lines.join('\n');
}

describe('auditSession', () => {
  it('agrees when an anchor phrase was genuinely heard before it committed', () => {
    const text = fixture([
      '[ledger] mutation_staged gen=2 aaaaaaaa-0000-0000-0000-000000000001 anchor="API Gateway"',
      '[latency] first_audio_frame gen=2 t=1000',
      '[Cartograph] word: "I " start=0 end=0.1',
      '[Cartograph] word: "am " start=0.1 end=0.2',
      '[Cartograph] word: "adding " start=0.2 end=0.3',
      '[Cartograph] word: "the " start=0.3 end=0.4',
      '[Cartograph] word: "API " start=0.4 end=0.5',
      '[Cartograph] word: "Gateway. " start=0.5 end=0.6',
      '[ledger] mutation_committed gen=2 aaaaaaaa-0000-0000-0000-000000000001 delivery',
    ]);

    const rows = auditSession(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actual: 'committed', independent: 'committed', agree: true });
  });

  it('agrees when a mutation was dropped and its anchor never appears in what was actually spoken', () => {
    const text = fixture([
      '[ledger] mutation_staged gen=3 bbbbbbbb-0000-0000-0000-000000000002 anchor="Redis cache"',
      '[latency] first_audio_frame gen=3 t=1000',
      '[Cartograph] word: "I " start=0 end=0.1',
      '[Cartograph] word: "am " start=0.1 end=0.2',
      // interrupted before "Redis cache" was ever said
      '[ledger] mutation_dropped gen=3 bbbbbbbb-0000-0000-0000-000000000002',
    ]);

    const rows = auditSession(text);
    expect(rows[0]).toMatchObject({ actual: 'dropped', independent: 'dropped', agree: true });
  });

  it('matches through the pronunciation lexicon — Rime echoes the respelled word, not the anchor as written', () => {
    const text = fixture([
      '[ledger] mutation_staged gen=4 cccccccc-0000-0000-0000-000000000003 anchor="nginx"',
      '[latency] first_audio_frame gen=4 t=1000',
      '[Cartograph] word: "Adding " start=0 end=0.1',
      '[Cartograph] word: "engine " start=0.1 end=0.2',
      '[Cartograph] word: "ex. " start=0.2 end=0.3',
      '[ledger] mutation_committed gen=4 cccccccc-0000-0000-0000-000000000003 delivery',
    ]);

    const rows = auditSession(text);
    expect(rows[0]).toMatchObject({ actual: 'committed', independent: 'committed', agree: true });
  });

  it('surfaces a genuine disagreement not already flagged by the ledger anchor_mismatch guard', () => {
    // The ledger says committed, but the words for this generation never
    // actually contain the anchor — a real divergence this audit exists to catch.
    const text = fixture([
      '[ledger] mutation_staged gen=5 dddddddd-0000-0000-0000-000000000004 anchor="Postgres database"',
      '[latency] first_audio_frame gen=5 t=1000',
      '[Cartograph] word: "Adding " start=0 end=0.1',
      '[Cartograph] word: "a " start=0.1 end=0.2',
      '[Cartograph] word: "cache. " start=0.2 end=0.3',
      '[ledger] mutation_committed gen=5 dddddddd-0000-0000-0000-000000000004 delivery',
    ]);

    const rows = auditSession(text);
    expect(rows[0]).toMatchObject({
      actual: 'committed',
      independent: 'dropped',
      agree: false,
      loggedMismatch: false,
    });
  });

  it('a logged anchor_mismatch is carried through so an expected divergence reads differently from an unexpected one', () => {
    const text = fixture([
      '[ledger] mutation_staged gen=6 eeeeeeee-0000-0000-0000-000000000005 anchor="OAuth service"',
      '[latency] first_audio_frame gen=6 t=1000',
      '[Cartograph] word: "Adding " start=0 end=0.1',
      '[Cartograph] word: "an " start=0.1 end=0.2',
      '[Cartograph] word: "oh-auth " start=0.2 end=0.3',
      '[Cartograph] word: "thing. " start=0.3 end=0.4',
      '[ledger] mutation_committed gen=6 eeeeeeee-0000-0000-0000-000000000005 delivery anchor_mismatch',
    ]);

    const rows = auditSession(text);
    expect(rows[0]?.loggedMismatch).toBe(true);
  });

  it('ignores a staged mutation that never reached a terminal state in the captured window', () => {
    const text = fixture([
      '[ledger] mutation_staged gen=7 ffffffff-0000-0000-0000-000000000006 anchor="Kafka"',
      '[latency] first_audio_frame gen=7 t=1000',
      '[Cartograph] word: "Adding " start=0 end=0.1',
      // log capture ends here — no resolution
    ]);

    expect(auditSession(text)).toHaveLength(0);
  });
});
