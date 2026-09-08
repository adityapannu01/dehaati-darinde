# Rime pronunciation & controlled-delivery harness

Everything rendered through the **shipped judged path** — Rime `coda` /
speaker `celeste` / `eng` / WebSocket plugin,
region `us-west-2`. Model and voice held constant; the only lever is the submitted
text — Coda has **no inline phonemes** (Mist v2 only) and its text normalisation
cannot be turned off (`noTextNormalization` is not forwarded for `coda` by
`@livekit/agents-plugin-rime@1.7.1` — verified in `modelParams()`).

**Verdicts are a human pass.** Listen to the clip pair, then edit `verdicts.json` and
re-run — the tables below merge it. `_(listen)_` = not yet judged.

## 1. Domain vocabulary

- **A** — `This is <term>.` verbatim, what a naive prompt sends → `<id>.a.wav`
- **B** — a hand-picked candidate respelling (`terms.ts`) → `<id>.b.wav`
- **C** — exactly what the shipped `ttsNode` tap sends Rime (`applyLexicon`, `core/lexicon.ts`) → `<id>.c.wav`

| term | A: plain | dur | B: candidate | dur | C: shipped lexicon | dur | verdict |
|---|---|--:|---|--:|---|--:|---|
| nginx | `nginx` | 1440 | `engine X` | 2000 | `engine ex` | 1840 | **lexicon** — 'engine ex' is the community-standard pronunciation; 'nginx' as a token is unspeakable |
| PostgreSQL | `PostgreSQL` | 1680 | `Postgres Q L` | 2560 | `Postgres Q L` | 2080 | **lexicon** — 'Postgres-Q-L'; the raw form invites 'postgre-sequel' |
| Postgres | `Postgres` | 1520 | `post-gress` | 1600 | _(no lexicon entry)_ |  | _(listen)_ |
| etcd | `etcd` | 1600 | `et-cee-dee` | 1680 | `et see dee` | 1600 | _(listen)_ |
| Redis | `Redis` | 1440 | `red-iss` | 1280 | _(no lexicon entry)_ |  | _(listen)_ |
| Kafka | `Kafka` | 1200 | — |  | _(no lexicon entry)_ |  | _(listen)_ |
| gRPC | `gRPC` | 2720 | `g R P C` | 2480 | `gee R P C` | 2960 | **lexicon** — initialism engineers spell out: 'gee-R-P-C' |
| GraphQL | `GraphQL` | 1680 | `graph Q L` | 1760 | `Graph Q L` | 2560 | **lexicon** — said 'graph-Q-L', not 'graphkwl' |
| JWT | `JWT` | 1600 | `J W T` | 1600 | `J W T` | 2160 | **lexicon** — initialism, spelled: 'J-W-T' |
| OAuth | `OAuth` | 1280 | `oh-auth` | 2240 | `oh-auth` | 1920 | _(listen)_ |
| OIDC | `OIDC` | 1600 | `O I D C` | 2000 | `O I D C` | 2080 | **lexicon** — initialism, spelled: 'O-I-D-C' |
| S3 | `S3` | 1600 | `S three` | 1760 | `S three` | 1520 | _(listen)_ |
| EC2 | `EC2` | 2000 | `E C two` | 2320 | `E C two` | 2400 | _(listen)_ |
| IAM | `IAM` | 1600 | `I A M` | 1760 | `I A M` | 1920 | _(listen)_ |
| VPC | `VPC` | 1680 | `V P C` | 1440 | `V P C` | 1920 | _(listen)_ |
| CDN | `CDN` | 1280 | `C D N` | 1760 | `C D N` | 2400 | _(listen)_ |
| k8s | `k8s` | 1840 | `Kubernetes` | 1520 | `kubernetes` | 1520 | **lexicon** — numeronym; only speakable expanded to 'kubernetes' |
| Kubernetes | `Kubernetes` | 1600 | `koo-ber-net-eez` | 2800 | _(no lexicon entry)_ |  | _(listen)_ |
| Istio | `Istio` | 1520 | `ist-ee-oh` | 1840 | _(no lexicon entry)_ |  | _(listen)_ |
| Envoy | `Envoy` | 1440 | — |  | _(no lexicon entry)_ |  | _(listen)_ |
| Traefik | `Traefik` | 1440 | `traffic` | 1360 | `traffic` | 1280 | **lexicon** — pronounced 'traffic' — project-documented, not an ear call |
| HAProxy | `HAProxy` | 1920 | `H A proxy` | 2080 | `H A proxy` | 1840 | _(listen)_ |
| NATS | `NATS` | 1920 | `nats` | 1280 | _(no lexicon entry)_ |  | _(listen)_ |
| RabbitMQ | `RabbitMQ` | 1760 | `Rabbit M Q` | 2640 | _(no lexicon entry)_ |  | _(listen)_ |
| SQS | `SQS` | 2320 | `S Q S` | 1600 | _(no lexicon entry)_ |  | _(listen)_ |
| DynamoDB | `DynamoDB` | 1680 | `Dynamo D B` | 1920 | _(no lexicon entry)_ |  | _(listen)_ |
| ClickHouse | `ClickHouse` | 1520 | `Click House` | 1440 | _(no lexicon entry)_ |  | _(listen)_ |
| Elasticsearch | `Elasticsearch` | 2080 | `Elastic Search` | 2000 | _(no lexicon entry)_ |  | _(listen)_ |
| MinIO | `MinIO` | 1520 | `min-I-O` | 1520 | _(no lexicon entry)_ |  | _(listen)_ |
| Cassandra | `Cassandra` | 1440 | — |  | _(no lexicon entry)_ |  | _(listen)_ |
| Memcached | `Memcached` | 1360 | `mem-cash-dee` | 1600 | _(no lexicon entry)_ |  | _(listen)_ |
| MongoDB | `MongoDB` | 1520 | `Mongo D B` | 1680 | _(no lexicon entry)_ |  | _(listen)_ |
| MariaDB | `MariaDB` | 1600 | `Maria D B` | 1760 | _(no lexicon entry)_ |  | _(listen)_ |
| Keycloak | `Keycloak` | 1200 | `Key Cloak` | 1680 | _(no lexicon entry)_ |  | _(listen)_ |
| Vault | `Vault` | 1120 | — |  | _(no lexicon entry)_ |  | _(listen)_ |
| Consul | `Consul` | 1280 | — |  | _(no lexicon entry)_ |  | _(listen)_ |
| Prometheus | `Prometheus` | 1520 | `pro-mee-thee-us` | 2000 | _(no lexicon entry)_ |  | _(listen)_ |
| Grafana | `Grafana` | 1520 | `gra-fah-na` | 1760 | _(no lexicon entry)_ |  | _(listen)_ |
| Terraform | `Terraform` | 1440 | — |  | _(no lexicon entry)_ |  | _(listen)_ |
| WebRTC | `WebRTC` | 2000 | `Web R T C` | 2080 | `Web R T C` | 2160 | **lexicon** — 'Web-R-T-C' |
| WebSocket | `WebSocket` | 1360 | `Web Socket` | 1360 | _(no lexicon entry)_ |  | _(listen)_ |
| CI/CD | `CI/CD` | 2960 | `C I C D` | 2400 | `C I C D` | 2400 | **lexicon** — 'C-I-C-D', the slash is not spoken |
| CLI | `CLI` | 1680 | `C L I` | 1920 | _(no lexicon entry)_ |  | _(listen)_ |
| ORM | `ORM` | 1440 | `O R M` | 1760 | _(no lexicon entry)_ |  | _(listen)_ |

## 2. Numbers, codes, identifiers, addresses + delivery

The persona (`agent.ts`, "Writing for the ear") tells the LLM to phrase these as words,
not digits/symbols — Coda normalisation is unpredictable and cannot be disabled. Each
row: `<id>.naive.wav` (what a naive prompt emits) vs `<id>.persona.wav` (the rule).

| id | category | naive ("before") | persona form ("after") | listen for | verdict |
|---|---|---|---|---|---|
| `port-number` | number | `The gateway listens on port 8080.` | `The gateway listens on port eighty eighty.` | "8080" — "eight thousand eighty", digit-by-digit, or a clean "eighty eighty" | _(listen)_ |
| `version-string` | identifier | `Deploy version 2.1.3.` | `Deploy version two point one point three.` | whether "2.1.3" is read as a date, a decimal, or three numbers | _(listen)_ |
| `replica-count` | number | `Scale the workers to 3 replicas.` | `Scale the workers to three replicas.` | a bare digit "3" — usually fine, the control case | _(listen)_ |
| `percentage` | number | `The SLO is 99.9% availability.` | `The SLO is ninety nine point nine percent.` | "%" and the decimal — does "99.9" survive normalisation | _(listen)_ |
| `region-code` | identifier | `Run it in us-east-1.` | `Run it in US East one.` | "us-east-1" — hyphens as pauses, "1" swallowed, or spelled letter-by-letter | _(listen)_ |
| `ip-address` | address | `The database is at 10.0.0.1.` | `The database is at ten dot zero dot zero dot one.` | four octets vs "ten point zero zero one" / one decimal number | _(listen)_ |
| `cidr` | address | `The VPC subnet is 10.0.0.0/16.` | `The VPC subnet is a slash sixteen.` | whether "/16" is intelligible at all — the persona rewrites it | _(listen)_ |
| `port-range` | number | `Open ports 30000-32767.` | `Open ports thirty thousand to thirty two thousand seven hundred.` | a hyphenated numeric range — almost always mangled, hence the rewrite | _(listen)_ |
| `comma-vs-period` | punctuation | `Adding a Redis cache. Then wiring it to the gateway.` | `Adding a Redis cache, then wiring it to the gateway.` | comma = short pause + held pitch; period = full stop + falling pitch | _(listen)_ |
| `em-dash` | punctuation | `That is a queue (Kafka, specifically).` | `That is a queue — Kafka, specifically.` | em-dash prosody vs a parenthetical; does Rime pause on "—" | _(listen)_ |
| `opening-filler` | filler | `Adding the auth service now.` | `Okay, adding the auth service now.` | a single "Okay," lead-in — natural, or clipped/robotic | _(listen)_ |
| `false-start` | false-start | `Adding a Redis — no wait, a Memcached — cache.` | `Adding a Redis cache. Actually, make that Memcached.` | the clean two-sentence self-correction should sound deliberate, not confused | _(listen)_ |
| `repeated-word` | punctuation | `The gateway routes to the orders service and payments service.` | `The gateway routes to the orders service and the payments service.` | the deliberate repeated "service" — emphatic, or a stutter | _(listen)_ |

## 3. Speed

Same sentence — _"The API gateway routes requests to the auth service and the orders service."_ — at three `timeScaleFactor` values
(`RIME_SPEED` env in production; >1 = slower on Coda). Clips: `speed-<factor>.wav`.
Per-word slow-down (`inlineSpeedAlpha`) is **not** available on Coda — the plugin gates
it behind `modelId.includes("mist")`.

| factor | dur (ms) | verdict |
|--:|--:|---|
| 0.9 | 4455 | _(listen)_ |
| 1 | 5760 | _(listen)_ |
| 1.15 | 5670 | _(listen)_ |

## OOV reporting — checked, not available

The Rime `ws3` streaming endpoint returns no out-of-vocabulary report. Verified
directly: `save_oovs=true` / `saveOovs=true` on the `ws3` URL yields only `chunk` /
`timestamps` / `done` frames, and `@livekit/agents-plugin-rime@1.7.1` never forwards
`saveOovs` anyway. So which terms Rime guessed at is judged here by ear (A vs C), not
from a provider list. Rime's account dashboard may surface OOVs for a real session;
that is the only other source.

_Generated by `pnpm --filter DD_agent pronunciation` on 2026-09-08._
