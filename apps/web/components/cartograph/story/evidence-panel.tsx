import CountUp from '@/components/CountUp';

// Sourced from RIME_EVIDENCE.md — measured via `pnpm --filter DD_agent benchmark`.
// Real numbers only; update this alongside that file, never independently.
const ROWS = [
  { label: 'canvas divergence rate', cartograph: 0.0, baseline: 86.7 },
  { label: 'stale mutation rate', cartograph: 0.0, baseline: 50.0 },
];

function Stat({ value, tone }: { value: number; tone: 'good' | 'bad' }) {
  return (
    <span
      className="font-mono text-3xl font-bold md:text-4xl"
      style={{ color: tone === 'good' ? 'var(--state-committed)' : 'var(--state-stale)' }}
    >
      <CountUp to={value} duration={1.5} />%
    </span>
  );
}

export function EvidencePanel() {
  return (
    <div className="story-panel mx-auto max-w-2xl px-6 py-24 text-center">
      <p className="text-muted-foreground font-mono text-xs tracking-widest uppercase">
        The evidence
      </p>
      <h2 className="text-foreground mt-3 text-2xl font-bold md:text-3xl">
        Measured, not asserted.
      </h2>
      <p className="text-muted-foreground mx-auto mt-4 max-w-xl leading-7">
        45 deterministic scenarios, plus an explicit out-of-order case, run twice each — once with
        fencing on, once with the naive baseline — against an independent oracle. No LiveKit, no
        audio, no LLM: reproducible on any machine with{' '}
        <code className="font-mono text-xs">pnpm --filter DD_agent benchmark</code>.
      </p>
      <div className="mt-10 grid grid-cols-1 gap-8 md:grid-cols-2">
        {ROWS.map((row) => (
          <div key={row.label} className="border-border rounded-lg border p-6">
            <div className="text-muted-foreground mb-4 font-mono text-xs tracking-wide uppercase">
              {row.label}
            </div>
            <div className="flex items-center justify-around">
              <div>
                <Stat value={row.cartograph} tone="good" />
                <div className="text-muted-foreground mt-1 text-xs">cartograph</div>
              </div>
              <div>
                <Stat value={row.baseline} tone="bad" />
                <div className="text-muted-foreground mt-1 text-xs">baseline</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
