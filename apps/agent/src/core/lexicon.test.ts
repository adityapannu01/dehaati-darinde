import { describe, expect, it } from 'vitest';
import { applyLexicon, INFRA_KEYTERMS, LEXICON, RESPELLED_TERMS } from './lexicon.ts';

describe('applyLexicon (§3.2)', () => {
  it('respells the terms Coda mangles', () => {
    expect(applyLexicon('adding nginx here')).toBe('adding engine ex here');
    expect(applyLexicon('a PostgreSQL database')).toBe('a Postgres Q L database');
    expect(applyLexicon('connect via gRPC')).toBe('connect via gee R P C');
    expect(applyLexicon('an S3 bucket')).toBe('an S three bucket');
    expect(applyLexicon('the k8s cluster')).toBe('the kubernetes cluster');
    expect(applyLexicon('put Traefik in front')).toBe('put traffic in front');
  });

  it('is idempotent — running it on already-respelled text changes nothing', () => {
    for (const [, sub] of LEXICON) {
      expect(applyLexicon(sub), sub).toBe(sub);
    }
    const twice = applyLexicon(applyLexicon('nginx and PostgreSQL and S3'));
    expect(twice).toBe(applyLexicon('nginx and PostgreSQL and S3'));
  });

  it('only touches whole words', () => {
    expect(applyLexicon('unginxed')).toBe('unginxed');
    expect(applyLexicon('S3X')).toBe('S3X');
  });

  it('leaves ordinary text alone', () => {
    expect(applyLexicon('connect the orders service to the payments service')).toBe(
      'connect the orders service to the payments service'
    );
  });

  it('every keyterm is a plain string with no regex metacharacters', () => {
    for (const t of INFRA_KEYTERMS) {
      expect(typeof t).toBe('string');
      expect(t).not.toMatch(/[\\^$*+?()[\]{}|]/);
    }
  });

  // #9 — one vocabulary. Every shipped respelling has to name a known keyterm,
  // or the STT bias list and the audio lever have silently drifted apart.
  it('every shipped respelling targets a term in INFRA_KEYTERMS', () => {
    const known = new Set(INFRA_KEYTERMS.map((t) => t.toLowerCase()));
    for (const term of RESPELLED_TERMS) {
      expect(known.has(term.toLowerCase()), `${term} respelled but not an INFRA_KEYTERM`).toBe(true);
    }
  });
});
