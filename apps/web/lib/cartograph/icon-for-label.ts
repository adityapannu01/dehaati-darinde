// Maps a free-text component label ("Redis Cache", "my postgres db", "S3
// bucket") to an Iconify `logos:` icon name (§3.2). Real logos stop the
// diagram looking like a wall of boxes — the highest visual return per hour in
// the review. Falls back to `null`, and the node then renders the kind-colored
// dot it always had.
//
// Longest keyword wins, so "google cloud storage" beats "google".

const ICONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bpostgres(ql)?\b|\bpg\b/, 'logos:postgresql'],
  [/\bmysql\b/, 'logos:mysql'],
  [/\bmaria ?db\b/, 'logos:mariadb-icon'],
  [/\bmongo ?db?\b/, 'logos:mongodb-icon'],
  [/\bredis\b/, 'logos:redis'],
  [/\bmemcached?\b/, 'logos:memcached'],
  [/\bdynamo ?db\b/, 'logos:aws-dynamodb'],
  [/\bcassandra\b/, 'logos:cassandra'],
  [/\bclickhouse\b/, 'logos:clickhouse'],
  [/\belasticsearch|elastic search|\bes\b/, 'logos:elasticsearch'],
  [/\bkafka\b/, 'logos:kafka-icon'],
  [/\brabbit ?mq\b/, 'logos:rabbitmq-icon'],
  [/\bsqs\b/, 'logos:aws-sqs'],
  [/\bsns\b/, 'logos:aws-sns'],
  [/\bnats\b/, 'logos:nats-icon'],
  [/\bpub ?sub\b/, 'logos:google-cloud'],
  [/\bnginx\b/, 'logos:nginx'],
  [/\benvoy\b/, 'logos:envoyproxy'],
  [/\bistio\b/, 'logos:istio-icon'],
  [/\bkong\b/, 'logos:kong-icon'],
  [/\btraefik\b/, 'logos:traefik'],
  [/\bha ?proxy\b/, 'logos:haproxy'],
  [/\bapi ?gateway\b|\bgateway\b/, 'logos:aws-api-gateway'],
  [/\bcloud ?front\b|\bcdn\b/, 'logos:aws-cloudfront'],
  [/\bs3\b|object storage|\bblob\b|\bbucket\b/, 'logos:aws-s3'],
  [/\bgcs\b|google cloud storage/, 'logos:google-cloud-storage'],
  [/\bminio\b/, 'logos:minio'],
  [/\blambda\b|\bfunctions?\b|serverless/, 'logos:aws-lambda'],
  [/\bkubernetes|k8s\b/, 'logos:kubernetes'],
  [/\bdocker\b|\bcontainer\b/, 'logos:docker-icon'],
  [/\bgraphql\b/, 'logos:graphql'],
  [/\bgrpc\b/, 'logos:grpc'],
  [/\bstripe\b/, 'logos:stripe'],
  [/\bauth0\b/, 'logos:auth0-icon'],
  [/\bokta\b/, 'logos:okta-icon'],
  [/\bkeycloak\b/, 'logos:keycloak-icon'],
  [/\bfirebase\b/, 'logos:firebase'],
  [/\bsupabase\b/, 'logos:supabase-icon'],
  [/\bvercel\b/, 'logos:vercel-icon'],
  [/\bcloudflare\b/, 'logos:cloudflare-icon'],
  [/\bprometheus\b/, 'logos:prometheus'],
  [/\bgrafana\b/, 'logos:grafana'],
  [/\bdatadog\b/, 'logos:datadog'],
  [/\bsentry\b/, 'logos:sentry-icon'],
  [/\betcd\b/, 'logos:etcd'],
  [/\bconsul\b/, 'logos:consul'],
  [/\bvault\b/, 'logos:vault-icon'],
  [/\breact\b|\bnext\.?js\b|\bfrontend\b|\bweb app\b|\bspa\b/, 'logos:react'],
  [/\bnode\.?js\b/, 'logos:nodejs-icon'],
  [/\bpython\b|\bdjango\b|\bflask\b|\bfastapi\b/, 'logos:python'],
  [/\bgo\b|\bgolang\b/, 'logos:go'],
  [/\brust\b/, 'logos:rust'],
  [/\bkotlin\b/, 'logos:kotlin-icon'],
  [/\bspring\b|\bjava\b/, 'logos:java'],
  [/\brails\b|\bruby\b/, 'logos:ruby'],
  [/\bmobile\b|\bios\b|\bandroid\b/, 'logos:android-icon'],
];

/** Iconify `logos:` name for `label`, or null if nothing matches. */
export function iconForLabel(label: string): string | null {
  const text = label.toLowerCase();
  let best: { name: string; span: number } | null = null;
  for (const [pattern, name] of ICONS) {
    const match = text.match(pattern);
    if (match && (!best || match[0].length > best.span)) {
      best = { name, span: match[0].length };
    }
  }
  return best?.name ?? null;
}
