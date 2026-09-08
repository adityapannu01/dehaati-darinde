// Pronunciation lexicon — English infra-term respelling (RIME_EVIDENCE.md §4a).
//
// Coda has no inline phonemes (Mist v2 only, and Mist v2 has no word
// timestamps), so RESPELLING the text sent to Rime is the only lever. The
// respellings are applied at the ttsNode tap — after the model has produced
// correct text, before Rime sees it — so the transcript, the ledger and the
// canvas labels keep the real spelling.
//
// One vocabulary, `INFRA_KEYTERMS`, is the single source of truth: `RESPELLINGS`
// (the audio lever) and `bench/pronunciation/terms.ts` (the render fixture) both
// cover subsets of it, and `lexicon.test.ts` asserts neither drifts.
//
// Both sides of the commit gate's anchor check are normalised through
// `applyLexicon` (see commit-gate.ts), so respelling a term never trips the
// anchor_mismatch flag.

/**
 * Every infrastructure name this product has to say or hear. Feeds the STT
 * `keyterms_prompt` (recognition bias, §3.5) and anchors the pronunciation
 * harness. Add a term here first; the harness will flag whether it needs a
 * `RESPELLINGS` entry.
 */
export const INFRA_KEYTERMS: readonly string[] = [
  'nginx',
  'nginx-ingress',
  'etcd',
  'Kubernetes',
  'k8s',
  'PostgreSQL',
  'Postgres',
  'Redis',
  'Kafka',
  'RabbitMQ',
  'NATS',
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
  'MariaDB',
  'MinIO',
  'Envoy',
  'Istio',
  'Traefik',
  'HAProxy',
  'Prometheus',
  'Grafana',
  'Terraform',
  'Consul',
  'Vault',
  'Keycloak',
  'WebRTC',
  'WebSocket',
  'S3',
  'EC2',
  'IAM',
  'VPC',
  'CDN',
  'WAF',
  'SQS',
  'ORM',
  'CLI',
  'YAML',
  'mTLS',
  'CI/CD',
];

/**
 * `term` → what to send Rime instead. Seeded from the pronunciation harness
 * (`pnpm --filter DD_agent pronunciation`), NOT guessed: an entry is here only
 * where a respelling clearly beat the raw form by ear in
 * `bench/pronunciation/REPORT.md`. `caseSensitive` is for the acronyms whose
 * lower-cased form is a real English word ("iam", "s3x"…).
 */
interface Respelling {
  term: string;
  say: string;
  caseSensitive?: boolean;
}

const RESPELLINGS: readonly Respelling[] = [
  // Longest / most specific first — the regexes are applied in order.
  { term: 'nginx-ingress', say: 'engine ex ingress' },
  { term: 'nginx', say: 'engine ex' },
  { term: 'k8s', say: 'kubernetes' },
  { term: 'etcd', say: 'et see dee' },
  { term: 'PostgreSQL', say: 'Postgres Q L' },
  { term: 'gRPC', say: 'gee R P C' },
  { term: 'GraphQL', say: 'Graph Q L' },
  { term: 'JWT', say: 'J W T' },
  { term: 'OAuth', say: 'oh-auth' },
  { term: 'OIDC', say: 'O I D C' },
  // Traefik is pronounced "traffic" — a documented fact, not an ear call
  // (promoted from a REPORT.md `?` row).
  { term: 'Traefik', say: 'traffic' },
  { term: 'HAProxy', say: 'H A proxy' },
  { term: 'WebRTC', say: 'Web R T C' },
  { term: 'YAML', say: 'yammel' },
  { term: 'S3', say: 'S three', caseSensitive: true },
  { term: 'EC2', say: 'E C two', caseSensitive: true },
  { term: 'IAM', say: 'I A M', caseSensitive: true },
  { term: 'mTLS', say: 'mutual T L S', caseSensitive: true },
  { term: 'VPC', say: 'V P C' },
  { term: 'CDN', say: 'C D N' },
  { term: 'CI/CD', say: 'C I C D' },
];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** [pattern, replacement], derived from RESPELLINGS. Global; case-insensitive unless the entry says otherwise. */
export const LEXICON: ReadonlyArray<readonly [RegExp, string]> = RESPELLINGS.map(
  ({ term, say, caseSensitive }) =>
    [new RegExp(`\\b${escapeRe(term)}\\b`, caseSensitive ? 'g' : 'gi'), say] as const,
);

/** The canonical terms that have a shipped respelling — for the harness + the drift test. */
export const RESPELLED_TERMS: readonly string[] = RESPELLINGS.map((r) => r.term);

/**
 * Apply the lexicon to a run of text. Idempotent — running it on already-
 * respelled text is a no-op (an entry never matches its own replacement).
 */
export function applyLexicon(text: string): string {
  return LEXICON.reduce((s, [re, sub]) => s.replace(re, sub), text);
}
