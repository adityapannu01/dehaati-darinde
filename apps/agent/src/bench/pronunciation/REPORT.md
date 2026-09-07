# Rime pronunciation harness

Rendered 44 infrastructure terms through the **shipped judged path** —
Rime `coda` / speaker `celeste` / `eng` / WebSocket plugin. Model and voice held
constant; the only variable is the submitted text.

- **A** — `This is <term>.` verbatim, what a naive prompt sends.
- **B** — a hand-picked respelling (`terms.ts`), for comparison.
- **C** — exactly what the shipped `ttsNode` tap sends Rime, i.e. `applyLexicon(...)`
  from `core/lexicon.ts`. This is the one that ships. `winner` = `c` where the lexicon
  changed the text; `a` where the plain form is already fine; `?` where B exists but
  the lexicon has no entry (candidate for one).

Coda has **no inline phonemes** (Mist v2 only — and Mist v2 has no word timestamps,
which the commit gate needs), so respelling the submitted text is the only lever.
Terms the lexicon could not meaningfully improve are left on the plain form.

`/textnorm`: Rime's text-normalization inspection endpoint is not reachable on this
API key (every `POST users.rime.ai/*` path returns synthesised audio), so
"normalization mangled it" vs "synthesis mangled it" is isolated instead by
comparing A against C by ear.

| term | A: plain | dur A | B: respelled | dur B | C: shipped lexicon | dur C | winner |
|---|---|--:|---|--:|---|--:|---|
| nginx | `nginx` (a) | 1760 | `engine X` (b) | 1440 | `engine ex` (c) | 1520 | c |
| PostgreSQL | `PostgreSQL` (a) | 1840 | `Postgres Q L` (b) | 2080 | `Postgres Q L` (c) | 2160 | c |
| Postgres | `Postgres` (a) | 1600 | `post-gress` (b) | 1600 | _(no lexicon entry)_ |  | ? |
| etcd | `etcd` (a) | 1520 | `et-cee-dee` (b) | 2160 | `et see dee` (c) | 2080 | c |
| Redis | `Redis` (a) | 1280 | `red-iss` (b) | 2160 | _(no lexicon entry)_ |  | ? |
| Kafka | `Kafka` (a) | 1280 | — |  | _(no lexicon entry)_ |  | a |
| gRPC | `gRPC` (a) | 1680 | `g R P C` (b) | 2080 | `gee R P C` (c) | 2080 | c |
| GraphQL | `GraphQL` (a) | 1680 | `graph Q L` (b) | 1680 | `Graph Q L` (c) | 1680 | c |
| JWT | `JWT` (a) | 1760 | `J W T` (b) | 2320 | `J W T` (c) | 2000 | c |
| OAuth | `OAuth` (a) | 1440 | `oh-auth` (b) | 1440 | `oh-auth` (c) | 1920 | c |
| OIDC | `OIDC` (a) | 1840 | `O I D C` (b) | 1840 | `O I D C` (c) | 2000 | c |
| S3 | `S3` (a) | 1360 | `S three` (b) | 1520 | `S three` (c) | 1440 | c |
| EC2 | `EC2` (a) | 1600 | `E C two` (b) | 1440 | `E C two` (c) | 2880 | c |
| IAM | `IAM` (a) | 1600 | `I A M` (b) | 2080 | `I A M` (c) | 2480 | c |
| VPC | `VPC` (a) | 1440 | `V P C` (b) | 1520 | `V P C` (c) | 1520 | c |
| CDN | `CDN` (a) | 1840 | `C D N` (b) | 2000 | `C D N` (c) | 1920 | c |
| k8s | `k8s` (a) | 1680 | `Kubernetes` (b) | 1520 | `kubernetes` (c) | 1600 | c |
| Kubernetes | `Kubernetes` (a) | 1520 | `koo-ber-net-eez` (b) | 2640 | _(no lexicon entry)_ |  | ? |
| Istio | `Istio` (a) | 1920 | `ist-ee-oh` (b) | 2000 | _(no lexicon entry)_ |  | ? |
| Envoy | `Envoy` (a) | 1360 | — |  | _(no lexicon entry)_ |  | a |
| Traefik | `Traefik` (a) | 1440 | `traffic` (b) | 1520 | _(no lexicon entry)_ |  | ? |
| HAProxy | `HAProxy` (a) | 2080 | `H A proxy` (b) | 2160 | `H A proxy` (c) | 2000 | c |
| NATS | `NATS` (a) | 1280 | `nats` (b) | 1200 | _(no lexicon entry)_ |  | ? |
| RabbitMQ | `RabbitMQ` (a) | 1680 | `Rabbit M Q` (b) | 1840 | _(no lexicon entry)_ |  | ? |
| SQS | `SQS` (a) | 1920 | `S Q S` (b) | 2160 | _(no lexicon entry)_ |  | ? |
| DynamoDB | `DynamoDB` (a) | 2400 | `Dynamo D B` (b) | 2160 | _(no lexicon entry)_ |  | ? |
| ClickHouse | `ClickHouse` (a) | 1520 | `Click House` (b) | 1360 | _(no lexicon entry)_ |  | ? |
| Elasticsearch | `Elasticsearch` (a) | 2000 | `Elastic Search` (b) | 1840 | _(no lexicon entry)_ |  | ? |
| MinIO | `MinIO` (a) | 1520 | `min-I-O` (b) | 2720 | _(no lexicon entry)_ |  | ? |
| Cassandra | `Cassandra` (a) | 1520 | — |  | _(no lexicon entry)_ |  | a |
| Memcached | `Memcached` (a) | 2160 | `mem-cash-dee` (b) | 1920 | _(no lexicon entry)_ |  | ? |
| MongoDB | `MongoDB` (a) | 1920 | `Mongo D B` (b) | 1840 | _(no lexicon entry)_ |  | ? |
| MariaDB | `MariaDB` (a) | 1520 | `Maria D B` (b) | 2160 | _(no lexicon entry)_ |  | ? |
| Keycloak | `Keycloak` (a) | 1280 | `Key Cloak` (b) | 1840 | _(no lexicon entry)_ |  | ? |
| Vault | `Vault` (a) | 1040 | — |  | _(no lexicon entry)_ |  | a |
| Consul | `Consul` (a) | 1520 | — |  | _(no lexicon entry)_ |  | a |
| Prometheus | `Prometheus` (a) | 1680 | `pro-mee-thee-us` (b) | 3520 | _(no lexicon entry)_ |  | ? |
| Grafana | `Grafana` (a) | 1360 | `gra-fah-na` (b) | 1760 | _(no lexicon entry)_ |  | ? |
| Terraform | `Terraform` (a) | 1440 | — |  | _(no lexicon entry)_ |  | a |
| WebRTC | `WebRTC` (a) | 1600 | `Web R T C` (b) | 2400 | `Web R T C` (c) | 1920 | c |
| WebSocket | `WebSocket` (a) | 1280 | `Web Socket` (b) | 1520 | _(no lexicon entry)_ |  | ? |
| CI/CD | `CI/CD` (a) | 2480 | `C I C D` (b) | 1760 | `C I C D` (c) | 2160 | c |
| CLI | `CLI` (a) | 1600 | `C L I` (b) | 1680 | _(no lexicon entry)_ |  | ? |
| ORM | `ORM` (a) | 1680 | `O R M` (b) | 1280 | _(no lexicon entry)_ |  | ? |

## OOV words

Set `RIME_SAVE_OOVS=true` and run a real session — the Rime API then logs the words
it had to guess at (agent worker log / Rime dashboard). That list is the definitive
input for which terms need a lexicon entry or a Rime dictionary submission.

_Generated by `pnpm --filter DD_agent pronunciation` on 2026-09-07._
