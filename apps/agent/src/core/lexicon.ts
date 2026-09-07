// Pronunciation lexicon (MULTILINGUAL_AND_PRONUNCIATION.md §3.2).
//
// Coda has no inline phonemes (Mist v2 only, and Mist v2 has no word
// timestamps), so RESPELLING the text sent to Rime is the only lever. This
// list is applied at the ttsNode tap — after the model has produced correct
// text, before Rime sees it — so the transcript, the ledger and the canvas
// labels keep the real spelling.
//
// Entries are seeded from the pronunciation harness (`pnpm --filter DD_agent
// pronunciation` + `saveOovs`), NOT guessed: where a respelling clearly beat
// the raw form in bench/pronunciation/REPORT.md, it is here.
//
// Both sides of the commit gate's anchor check are normalised through this
// same list (see commit-gate.ts), so respelling a term never trips the
// anchor_mismatch flag.

/** [pattern, replacement]. Patterns are global + case-insensitive. Order matters — longest/most-specific first. */
export const LEXICON: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bnginx\b/gi, 'engine ex'],
  [/\bk8s\b/gi, 'kubernetes'],
  [/\betcd\b/gi, 'et see dee'],
  [/\bPostgreSQL\b/gi, 'Postgres Q L'],
  [/\bgRPC\b/gi, 'gee R P C'],
  [/\bGraphQL\b/gi, 'Graph Q L'],
  [/\bJWT\b/gi, 'J W T'],
  [/\bOAuth\b/gi, 'oh-auth'],
  [/\bOIDC\b/gi, 'O I D C'],
  [/\bS3\b/g, 'S three'],
  [/\bEC2\b/g, 'E C two'],
  [/\bIAM\b/g, 'I A M'],
  [/\bVPC\b/gi, 'V P C'],
  [/\bCDN\b/gi, 'C D N'],
  [/\bWebRTC\b/gi, 'Web R T C'],
  [/\bYAML\b/gi, 'yammel'],
  [/\bnginx-ingress\b/gi, 'engine ex ingress'],
  [/\bhaproxy\b/gi, 'H A proxy'],
  [/\bmTLS\b/g, 'mutual T L S'],
  [/\bCI\/CD\b/gi, 'C I C D'],
];

/**
 * Apply the lexicon to a run of text. Idempotent — running it on already-
 * respelled text is a no-op (an entry never matches its own replacement).
 */
export function applyLexicon(text: string): string {
  return LEXICON.reduce((s, [re, sub]) => s.replace(re, sub), text);
}

/** Just the raw terms — feeds the STT `keyterms_prompt` so recognition biases toward them too (§3.5). */
export const INFRA_KEYTERMS: readonly string[] = [
  'nginx',
  'etcd',
  'Kubernetes',
  'PostgreSQL',
  'Postgres',
  'Redis',
  'Kafka',
  'RabbitMQ',
  'gRPC',
  'GraphQL',
  'JWT',
  'OAuth',
  'OIDC',
  'DynamoDB',
  'ClickHouse',
  'Elasticsearch',
  'Cassandra',
  'Memcached',
  'MongoDB',
  'Envoy',
  'Istio',
  'Traefik',
  'HAProxy',
  'Prometheus',
  'Grafana',
  'Terraform',
  'WebRTC',
  'WebSocket',
];
