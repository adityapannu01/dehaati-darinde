import process from 'node:process';
import { type ScenarioResult, runAll, runOutOfOrderScenario } from './runner.ts';
import { SCENARIOS } from './scenarios.ts';

interface ModeSummary {
  scenarioCount: number;
  divergentScenarios: number;
  staleMutations: number;
  totalOracleMutations: number;
  orphanedMutations: number;
}

function summarize(results: ScenarioResult[], baselineMode: boolean): ModeSummary {
  const forMode = results.filter((r) => r.baselineMode === baselineMode);
  return {
    scenarioCount: forMode.length,
    divergentScenarios: forMode.filter((r) => r.divergent).length,
    staleMutations: forMode.reduce((sum, r) => sum + r.staleCount, 0),
    totalOracleMutations: forMode.reduce(
      (sum, r) => sum + r.actual.nodes.length + r.actual.edges.length - r.staleCount,
      0,
    ),
    orphanedMutations: forMode.reduce((sum, r) => sum + r.orphanCount, 0),
  };
}

function pct(n: number, d: number): string {
  return d === 0 ? '0.0%' : `${((n / d) * 100).toFixed(1)}%`;
}

export function buildReport(): string {
  const results = runAll(SCENARIOS);
  const cartograph = summarize(results, false);
  const baseline = summarize(results, true);

  const oooCartograph = runOutOfOrderScenario(false);
  const oooBaseline = runOutOfOrderScenario(true);

  const lines: string[] = [];
  lines.push(
    `Cartograph benchmark — ${SCENARIOS.length} generated scenarios (delay x interruptAt x corrections, plus 3 backchannel-during-narration cases and 3 interrupted direction-change cases) + 1 out-of-order case, run in both modes.`,
  );
  lines.push('');
  lines.push(['metric', 'cartograph', 'baseline'].join(' | '));
  lines.push('---|---|---');
  lines.push(
    [
      'canvas divergence rate',
      pct(cartograph.divergentScenarios, cartograph.scenarioCount),
      pct(baseline.divergentScenarios, baseline.scenarioCount),
    ].join(' | '),
  );
  lines.push(
    [
      'stale mutation rate (of landed mutations)',
      pct(cartograph.staleMutations, cartograph.staleMutations + cartograph.totalOracleMutations),
      pct(baseline.staleMutations, baseline.staleMutations + baseline.totalOracleMutations),
    ].join(' | '),
  );
  lines.push(
    [
      'out-of-order (41/43/42) resolved correctly',
      oooCartograph.correct ? 'yes' : 'no',
      oooBaseline.correct ? 'yes' : 'no',
    ].join(' | '),
  );
  lines.push(
    [
      'orphaned mutations (staged, never committed or dropped)',
      String(cartograph.orphanedMutations),
      String(baseline.orphanedMutations),
    ].join(' | '),
  );
  lines.push(
    'fence latency (interruption -> generation cancelled) | N/A in this synchronous harness | see bench/live-latency.md',
  );
  lines.push('');
  lines.push(
    `divergent scenarios (cartograph): ${cartograph.divergentScenarios}/${cartograph.scenarioCount}`,
  );
  lines.push(
    `divergent scenarios (baseline):   ${baseline.divergentScenarios}/${baseline.scenarioCount}`,
  );

  return lines.join('\n');
}

// Runnable directly: `pnpm benchmark`.
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(buildReport());
}
