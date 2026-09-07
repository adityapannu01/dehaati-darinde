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
