# Rime pronunciation harness (§4.3)

Rendered 44 infrastructure terms through the shipped judged path:
**Rime `coda` / speaker `celeste` / `eng` / WebSocket plugin**, `saveOovs: true`.
Model and voice are held constant — the only variable is the submitted text.
Clips are in [`clips/`](./clips). Listen to `<term>.a.wav` (what the LLM says by
default) against `<term>.b.wav` (a respelled attempt) and keep whichever wins.

Coda exposes no inline phonemes, so respelling the submitted text is the only
lever — see the repo README "Rime depth" section. Where spelling B is clearly
better, the fix is a term-substitution pass on the LLM output before TTS, or a
Rime dictionary submission for that word.

| term | canonical | spelling A (plain) | dur A | spelling B (respelled) | dur B |
|---|---|---|--:|---|--:|
| nginx | nginx | `nginx` → nginx.a.wav | 1600 ms | `engine X` → nginx.b.wav | 1440 ms |
| postgresql | PostgreSQL | `PostgreSQL` → postgresql.a.wav | 1680 ms | `Postgres Q L` → postgresql.b.wav | 2080 ms |
| postgres | Postgres | `Postgres` → postgres.a.wav | 1760 ms | `post-gress` → postgres.b.wav | 1920 ms |
| etcd | etcd | `etcd` → etcd.a.wav | 1520 ms | `et-cee-dee` → etcd.b.wav | 1680 ms |
| redis | Redis | `Redis` → redis.a.wav | 1760 ms | `red-iss` → redis.b.wav | 2080 ms |
| kafka | Kafka | `Kafka` → kafka.a.wav | 1200 ms | _(no variant)_ |  |
| grpc | gRPC | `gRPC` → grpc.a.wav | 1600 ms | `g R P C` → grpc.b.wav | 1760 ms |
| graphql | GraphQL | `GraphQL` → graphql.a.wav | 1440 ms | `graph Q L` → graphql.b.wav | 1840 ms |
| jwt | JWT | `JWT` → jwt.a.wav | 1520 ms | `J W T` → jwt.b.wav | 2320 ms |
| oauth | OAuth | `OAuth` → oauth.a.wav | 1280 ms | `oh-auth` → oauth.b.wav | 1280 ms |
| oidc | OIDC | `OIDC` → oidc.a.wav | 2160 ms | `O I D C` → oidc.b.wav | 1600 ms |
| s3 | S3 | `S3` → s3.a.wav | 1520 ms | `S three` → s3.b.wav | 1600 ms |
| ec2 | EC2 | `EC2` → ec2.a.wav | 2640 ms | `E C two` → ec2.b.wav | 1440 ms |
| iam | IAM | `IAM` → iam.a.wav | 2800 ms | `I A M` → iam.b.wav | 1920 ms |
| vpc | VPC | `VPC` → vpc.a.wav | 1520 ms | `V P C` → vpc.b.wav | 1600 ms |
| cdn | CDN | `CDN` → cdn.a.wav | 1840 ms | `C D N` → cdn.b.wav | 2160 ms |
| k8s | k8s | `k8s` → k8s.a.wav | 1680 ms | `Kubernetes` → k8s.b.wav | 1360 ms |
| kubernetes | Kubernetes | `Kubernetes` → kubernetes.a.wav | 1360 ms | `koo-ber-net-eez` → kubernetes.b.wav | 4400 ms |
| istio | Istio | `Istio` → istio.a.wav | 1360 ms | `ist-ee-oh` → istio.b.wav | 2000 ms |
| envoy | Envoy | `Envoy` → envoy.a.wav | 1680 ms | _(no variant)_ |  |
| traefik | Traefik | `Traefik` → traefik.a.wav | 1360 ms | `traffic` → traefik.b.wav | 1600 ms |
| haproxy | HAProxy | `HAProxy` → haproxy.a.wav | 2000 ms | `H A proxy` → haproxy.b.wav | 1920 ms |
| nats | NATS | `NATS` → nats.a.wav | 1280 ms | `nats` → nats.b.wav | 1360 ms |
| rabbitmq | RabbitMQ | `RabbitMQ` → rabbitmq.a.wav | 1600 ms | `Rabbit M Q` → rabbitmq.b.wav | 1680 ms |
| sqs | SQS | `SQS` → sqs.a.wav | 1680 ms | `S Q S` → sqs.b.wav | 1680 ms |
| dynamodb | DynamoDB | `DynamoDB` → dynamodb.a.wav | 2400 ms | `Dynamo D B` → dynamodb.b.wav | 1840 ms |
| clickhouse | ClickHouse | `ClickHouse` → clickhouse.a.wav | 1840 ms | `Click House` → clickhouse.b.wav | 1680 ms |
| elasticsearch | Elasticsearch | `Elasticsearch` → elasticsearch.a.wav | 1840 ms | `Elastic Search` → elasticsearch.b.wav | 2000 ms |
| minio | MinIO | `MinIO` → minio.a.wav | 1200 ms | `min-I-O` → minio.b.wav | 2240 ms |
| cassandra | Cassandra | `Cassandra` → cassandra.a.wav | 1440 ms | _(no variant)_ |  |
| memcached | Memcached | `Memcached` → memcached.a.wav | 1520 ms | `mem-cash-dee` → memcached.b.wav | 1840 ms |
| mongodb | MongoDB | `MongoDB` → mongodb.a.wav | 1840 ms | `Mongo D B` → mongodb.b.wav | 3120 ms |
| mariadb | MariaDB | `MariaDB` → mariadb.a.wav | 2080 ms | `Maria D B` → mariadb.b.wav | 1760 ms |
| keycloak | Keycloak | `Keycloak` → keycloak.a.wav | 1520 ms | `Key Cloak` → keycloak.b.wav | 1360 ms |
| vault | Vault | `Vault` → vault.a.wav | 1200 ms | _(no variant)_ |  |
| consul | Consul | `Consul` → consul.a.wav | 1280 ms | _(no variant)_ |  |
| prometheus | Prometheus | `Prometheus` → prometheus.a.wav | 1600 ms | `pro-mee-thee-us` → prometheus.b.wav | 2640 ms |
| grafana | Grafana | `Grafana` → grafana.a.wav | 1440 ms | `gra-fah-na` → grafana.b.wav | 1600 ms |
| terraform | Terraform | `Terraform` → terraform.a.wav | 1440 ms | _(no variant)_ |  |
| webrtc | WebRTC | `WebRTC` → webrtc.a.wav | 2160 ms | `Web R T C` → webrtc.b.wav | 2640 ms |
| websocket | WebSocket | `WebSocket` → websocket.a.wav | 1360 ms | `Web Socket` → websocket.b.wav | 1440 ms |
| ci-cd | CI/CD | `CI/CD` → ci-cd.a.wav | 2080 ms | `C I C D` → ci-cd.b.wav | 1840 ms |
| cli | CLI | `CLI` → cli.a.wav | 1280 ms | `C L I` → cli.b.wav | 1760 ms |
| orm | ORM | `ORM` → orm.a.wav | 1760 ms | `O R M` → orm.b.wav | 1680 ms |

## OOV words

With `saveOovs: true` the Rime API logs the words it had to guess at. Check the
agent worker log for `oov` entries after a real session, or the Rime dashboard —
that list is the definitive fixture set for which terms need a dictionary entry.

_Generated by `pnpm --filter DD_agent pronunciation` on 2026-09-07._
