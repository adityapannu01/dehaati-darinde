// Infrastructure vocabulary Rime has to say for this product to work, with at
// least two spellings per term (§4.3). The model (coda) and voice (celeste) are
// fixed — the shipped judged path — so the only lever is the submitted text.
//
// `plain` is what the LLM would naturally emit. `respelled` is the fallback the
// README's "remaining levers" list allows: respelling in the submitted text
// (coda has no inline phonemes, so this is the mechanism). The harness renders
// both and saves both clips so the difference is audible, not asserted.

export interface PronunciationTerm {
  /** Stable id — also the clip filename stem. */
  id: string;
  /** How it appears on the canvas / in the transcript. */
  canonical: string;
  /** What the LLM says by default. */
  plain: string;
  /** Respelled attempt at a cleaner rendering, or null if `plain` is already fine to test. */
  respelled: string | null;
  note?: string;
}

/**
 * The other categories the PS names alongside "domain vocabulary" — numbers,
 * codes, identifiers, addresses — plus the delivery cases it calls out
 * (punctuation, fillers, false starts). One clip pair each; the point is a
 * human listening and confirming the persona's word-form rules (agent.ts
 * "Writing for the ear") actually hold against Rime's Coda text normalisation,
 * which cannot be turned off (see REPORT.md / RIME_EVIDENCE.md §4a).
 */
export interface DeliveryFixture {
  id: string;
  category: 'number' | 'identifier' | 'address' | 'punctuation' | 'filler' | 'false-start';
  /** Rendered verbatim — written the way the persona says to phrase it. */
  text: string;
  /** What a naive prompt would have emitted instead. null if N/A. */
  naive: string | null;
  listenFor: string;
}

export const DELIVERY_FIXTURES: DeliveryFixture[] = [
  {
    id: 'port-number',
    category: 'number',
    text: 'The gateway listens on port eighty eighty.',
    naive: 'The gateway listens on port 8080.',
    listenFor: '"8080" — "eight thousand eighty", digit-by-digit, or a clean "eighty eighty"',
  },
  {
    id: 'version-string',
    category: 'identifier',
    text: 'Deploy version two point one point three.',
    naive: 'Deploy version 2.1.3.',
    listenFor: 'whether "2.1.3" is read as a date, a decimal, or three numbers',
  },
  {
    id: 'replica-count',
    category: 'number',
    text: 'Scale the workers to three replicas.',
    naive: 'Scale the workers to 3 replicas.',
    listenFor: 'a bare digit "3" — usually fine, the control case',
  },
  {
    id: 'percentage',
    category: 'number',
    text: 'The SLO is ninety nine point nine percent.',
    naive: 'The SLO is 99.9% availability.',
    listenFor: '"%" and the decimal — does "99.9" survive normalisation',
  },
  {
    id: 'region-code',
    category: 'identifier',
    text: 'Run it in US East one.',
    naive: 'Run it in us-east-1.',
    listenFor: '"us-east-1" — hyphens as pauses, "1" swallowed, or spelled letter-by-letter',
  },
  {
    id: 'ip-address',
    category: 'address',
    text: 'The database is at ten dot zero dot zero dot one.',
    naive: 'The database is at 10.0.0.1.',
    listenFor: 'four octets vs "ten point zero zero one" / one decimal number',
  },
  {
    id: 'cidr',
    category: 'address',
    text: 'The VPC subnet is a slash sixteen.',
    naive: 'The VPC subnet is 10.0.0.0/16.',
    listenFor: 'whether "/16" is intelligible at all — the persona rewrites it',
  },
  {
    id: 'port-range',
    category: 'number',
    text: 'Open ports thirty thousand to thirty two thousand seven hundred.',
    naive: 'Open ports 30000-32767.',
    listenFor: 'a hyphenated numeric range — almost always mangled, hence the rewrite',
  },
  {
    id: 'comma-vs-period',
    category: 'punctuation',
    text: 'Adding a Redis cache, then wiring it to the gateway.',
    naive: 'Adding a Redis cache. Then wiring it to the gateway.',
    listenFor: 'comma = short pause + held pitch; period = full stop + falling pitch',
  },
  {
    id: 'em-dash',
    category: 'punctuation',
    text: 'That is a queue — Kafka, specifically.',
    naive: 'That is a queue (Kafka, specifically).',
    listenFor: 'em-dash prosody vs a parenthetical; does Rime pause on "—"',
  },
  {
    id: 'opening-filler',
    category: 'filler',
    text: 'Okay, adding the auth service now.',
    naive: 'Adding the auth service now.',
    listenFor: 'a single "Okay," lead-in — natural, or clipped/robotic',
  },
  {
    id: 'false-start',
    category: 'false-start',
    text: 'Adding a Redis cache. Actually, make that Memcached.',
    naive: 'Adding a Redis — no wait, a Memcached — cache.',
    listenFor: 'the clean two-sentence self-correction should sound deliberate, not confused',
  },
  {
    id: 'repeated-word',
    category: 'punctuation',
    text: 'The gateway routes to the orders service and the payments service.',
    naive: 'The gateway routes to the orders service and payments service.',
    listenFor: 'the deliberate repeated "service" — emphatic, or a stutter',
  },
];

/** #6 — the same sentence at three speeds. `timeScaleFactor` >1 is slower on Coda. */
export const SPEED_SWEEP = {
  text: 'The API gateway routes requests to the auth service and the orders service.',
  factors: [0.9, 1.0, 1.15] as const,
};

export const TERMS: PronunciationTerm[] = [
  { id: 'nginx', canonical: 'nginx', plain: 'nginx', respelled: 'engine X' },
  { id: 'postgresql', canonical: 'PostgreSQL', plain: 'PostgreSQL', respelled: 'Postgres Q L' },
  { id: 'postgres', canonical: 'Postgres', plain: 'Postgres', respelled: 'post-gress' },
  { id: 'etcd', canonical: 'etcd', plain: 'etcd', respelled: 'et-cee-dee' },
  { id: 'redis', canonical: 'Redis', plain: 'Redis', respelled: 'red-iss' },
  { id: 'kafka', canonical: 'Kafka', plain: 'Kafka', respelled: null },
  { id: 'grpc', canonical: 'gRPC', plain: 'gRPC', respelled: 'g R P C' },
  { id: 'graphql', canonical: 'GraphQL', plain: 'GraphQL', respelled: 'graph Q L' },
  { id: 'jwt', canonical: 'JWT', plain: 'JWT', respelled: 'J W T' },
  { id: 'oauth', canonical: 'OAuth', plain: 'OAuth', respelled: 'oh-auth' },
  { id: 'oidc', canonical: 'OIDC', plain: 'OIDC', respelled: 'O I D C' },
  { id: 's3', canonical: 'S3', plain: 'S3', respelled: 'S three' },
  { id: 'ec2', canonical: 'EC2', plain: 'EC2', respelled: 'E C two' },
  { id: 'iam', canonical: 'IAM', plain: 'IAM', respelled: 'I A M' },
  { id: 'vpc', canonical: 'VPC', plain: 'VPC', respelled: 'V P C' },
  { id: 'cdn', canonical: 'CDN', plain: 'CDN', respelled: 'C D N' },
  { id: 'k8s', canonical: 'k8s', plain: 'k8s', respelled: 'Kubernetes' },
  { id: 'kubernetes', canonical: 'Kubernetes', plain: 'Kubernetes', respelled: 'koo-ber-net-eez' },
  { id: 'istio', canonical: 'Istio', plain: 'Istio', respelled: 'ist-ee-oh' },
  { id: 'envoy', canonical: 'Envoy', plain: 'Envoy', respelled: null },
  { id: 'traefik', canonical: 'Traefik', plain: 'Traefik', respelled: 'traffic' },
  { id: 'haproxy', canonical: 'HAProxy', plain: 'HAProxy', respelled: 'H A proxy' },
  { id: 'nats', canonical: 'NATS', plain: 'NATS', respelled: 'nats' },
  { id: 'rabbitmq', canonical: 'RabbitMQ', plain: 'RabbitMQ', respelled: 'Rabbit M Q' },
  { id: 'sqs', canonical: 'SQS', plain: 'SQS', respelled: 'S Q S' },
  { id: 'dynamodb', canonical: 'DynamoDB', plain: 'DynamoDB', respelled: 'Dynamo D B' },
  { id: 'clickhouse', canonical: 'ClickHouse', plain: 'ClickHouse', respelled: 'Click House' },
  { id: 'elasticsearch', canonical: 'Elasticsearch', plain: 'Elasticsearch', respelled: 'Elastic Search' },
  { id: 'minio', canonical: 'MinIO', plain: 'MinIO', respelled: 'min-I-O' },
  { id: 'cassandra', canonical: 'Cassandra', plain: 'Cassandra', respelled: null },
  { id: 'memcached', canonical: 'Memcached', plain: 'Memcached', respelled: 'mem-cash-dee' },
  { id: 'mongodb', canonical: 'MongoDB', plain: 'MongoDB', respelled: 'Mongo D B' },
  { id: 'mariadb', canonical: 'MariaDB', plain: 'MariaDB', respelled: 'Maria D B' },
  { id: 'keycloak', canonical: 'Keycloak', plain: 'Keycloak', respelled: 'Key Cloak' },
  { id: 'vault', canonical: 'Vault', plain: 'Vault', respelled: null },
  { id: 'consul', canonical: 'Consul', plain: 'Consul', respelled: null },
  { id: 'prometheus', canonical: 'Prometheus', plain: 'Prometheus', respelled: 'pro-mee-thee-us' },
  { id: 'grafana', canonical: 'Grafana', plain: 'Grafana', respelled: 'gra-fah-na' },
  { id: 'terraform', canonical: 'Terraform', plain: 'Terraform', respelled: null },
  { id: 'webrtc', canonical: 'WebRTC', plain: 'WebRTC', respelled: 'Web R T C' },
  { id: 'websocket', canonical: 'WebSocket', plain: 'WebSocket', respelled: 'Web Socket' },
  { id: 'ci-cd', canonical: 'CI/CD', plain: 'CI/CD', respelled: 'C I C D' },
  { id: 'cli', canonical: 'CLI', plain: 'CLI', respelled: 'C L I' },
  { id: 'orm', canonical: 'ORM', plain: 'ORM', respelled: 'O R M' },
];
