// A REAL slow tool (TECHNICAL_REVIEW.md §5.4).
//
// The benchmark's synthetic `SLOW_TOOL_MS` delay is the sanctioned, deterministic
// test fixture — it stays. But an interruption stress demo built entirely on an
// artificial `setTimeout` invites the "that's not real" objection. This tool
// does a genuine network round trip (Wikipedia's REST summary endpoint, usually
// 300-900 ms), so a mid-flight interruption fences an operation that is actually
// in flight, not one that is pretending to be.
//
// Stage safety: a live fetch on stage is a failure point, so ~20 common
// infrastructure terms are answered from a bundled fixture with NO network call,
// and any fetch is bounded by a short timeout that falls back to "no summary".

const FIXTURE: Record<string, string> = {
  redis: 'an open-source in-memory data store, used as a cache, database, and message broker',
  postgres: 'a powerful open-source relational database',
  postgresql: 'a powerful open-source relational database',
  kafka: 'a distributed event-streaming platform for high-throughput pipelines',
  rabbitmq: 'an open-source message broker implementing AMQP',
  nginx: 'a high-performance web server, reverse proxy, and load balancer',
  mongodb: 'a document-oriented NoSQL database',
  mysql: 'a widely used open-source relational database',
  elasticsearch: 'a distributed search and analytics engine',
  cassandra: 'a wide-column NoSQL database built for scale and availability',
  s3: 'object storage from Amazon Web Services',
  dynamodb: 'a fully managed key-value and document database from AWS',
  kubernetes: 'a container orchestration platform',
  grafana: 'an open-source dashboards and observability platform',
  prometheus: 'a monitoring system and time-series database',
  envoy: 'a high-performance service proxy for cloud-native applications',
  istio: 'a service mesh that layers onto Kubernetes',
  memcached: 'a high-performance distributed memory caching system',
  clickhouse: 'a column-oriented database for real-time analytics',
  vault: 'a tool for managing secrets and protecting sensitive data',
};

function key(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export interface EnrichResult {
  summary: string | null;
  source: 'fixture' | 'wikipedia' | 'none';
}

/**
 * A one-line description of `label`. Fixture first (fast, offline, stage-safe),
 * then a bounded live fetch, then nothing. `abortSignal` fences a fetch already
 * in flight when the user interrupts.
 */
export async function enrichComponent(
  label: string,
  opts: { abortSignal?: AbortSignal; live?: boolean; timeoutMs?: number } = {}
): Promise<EnrichResult> {
  const fixture = FIXTURE[key(label)];
  if (fixture) return { summary: fixture, source: 'fixture' };
  if (opts.live === false) return { summary: null, source: 'none' };

  const timeoutMs = opts.timeoutMs ?? 2500;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const signal = opts.abortSignal
    ? AbortSignal.any([opts.abortSignal, timeout.signal])
    : timeout.signal;
  try {
    const title = encodeURIComponent(label.trim().replace(/\s+/g, '_'));
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${title}`, {
      signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return { summary: null, source: 'none' };
    const body = (await res.json()) as { extract?: string; type?: string };
    if (body.type === 'disambiguation' || !body.extract) return { summary: null, source: 'none' };
    // First sentence only — this gets spoken.
    const first = body.extract.split(/(?<=\.)\s/)[0]?.trim();
    return { summary: first ?? null, source: first ? 'wikipedia' : 'none' };
  } catch {
    return { summary: null, source: 'none' }; // aborted, offline, timeout — all the same to the caller
  } finally {
    clearTimeout(timer);
  }
}
