# Cartograph — Evidence

## 1. Claim

> When the user interrupts and changes the request, queued Rime audio stops promptly, in-flight tool work is cancelled or fenced, stale results can never re-enter the conversation, and the shared canvas state stays consistent with the words the user actually heard.

Reported but not the headline claim: perceived response time (see [`apps/agent/src/bench/live-latency.md`](apps/agent/src/bench/live-latency.md)).

## 2. Acceptance test

Four cases, defined before any demo run:

1. **Normal flow** — a multi-component instruction, uninterrupted. Every proposed mutation lands, once its describing sentence is confirmed delivered.
2. **Mid-speech interruption** — the user cuts in mid-sentence. Any mutation whose sentence was already fully delivered stays committed; anything not yet delivered is dropped, permanently, even if the underlying tool call eventually resolves.
3. **Tool race** — a slow tool call (`SLOW_TOOL_MS`) resolves *after* its generation has already been superseded. The result is discarded (`STALE_DISCARDED`) and never reaches the canvas.
4. **Triple interruption, out-of-order** — three generations open back-to-back; their tool results resolve out of arrival order. Only the result belonging to the generation that is *still current at the moment its own result resolves* may land — regardless of which result physically arrives first.

Pass condition: 0% canvas divergence and 0% stale mutations for all four cases with fencing enabled (`CARTOGRAPH_BASELINE=false`, the default); non-zero for both with `CARTOGRAPH_BASELINE=true`, proving the comparison has teeth (a baseline with no measurable difference proves nothing).

## 3. Procedure

```bash
pnpm --filter DD_agent benchmark
```

Runs 45 deterministically generated scenarios (`toolDelay × interruptAt × corrections`, 3×5×3) plus the explicit out-of-order case, each once with fencing on and once with `CARTOGRAPH_BASELINE=true`, against an independent oracle (`apps/agent/src/bench/oracle.ts`) that re-derives the expected canvas from only the heard-sentence counts — sharing no code with the commit gate it's checking. The same invariant is asserted directly in `apps/agent/src/bench/runner.test.ts`, so `pnpm test` catches a regression here too, not only a human reading the printed table.

Live interruption/recovery timing: manual procedure in [`apps/agent/src/bench/live-latency.md`](apps/agent/src/bench/live-latency.md) — 20 real interruptions, median + p95, warm/cold labelled separately.

## 4. Results

Measured 2026-09-05, this repo, `pnpm --filter DD_agent benchmark`:

| Metric | Cartograph (fencing on) | Baseline (`CARTOGRAPH_BASELINE=true`) |
|---|---|---|
| Canvas divergence rate | **0.0%** (0/45) | 86.7% (39/45) |
| Stale mutation rate (of landed mutations) | **0.0%** | 50.0% |
| Out-of-order (1→3→2) resolved correctly | **yes** | no |
| Fence latency (interruption → generation cancelled) | N/A in the synchronous harness | see live-latency.md |

Live interruption/recovery latency (fence latency, recovery latency): **not yet measured** — pending the manual procedure in `live-latency.md`. This report will be updated with real numbers once that run happens; no numbers are invented in the meantime.

`pnpm test` (67 tests across core engine, tools, commit gate, transport, benchmark, and 3 agent evals): **all passing** as of this commit.

## 5. Limitations

- Read-only/reversible tools only — no purchases, deletes, or emails; an irreversible external effect can't be meaningfully fenced.
- The anchor-phrase mismatch guard is a warning on the event ledger, not a block — a genuine mismatch still commits, deliberately, so a monitoring feature can't become a live-demo failure.
- Commit granularity is per-sentence, not per-word.
- 45 generated scenarios + 1 hand-scripted out-of-order case are not a production traffic distribution — they exercise the specific race the commit gate closes, not general robustness. The generator matrix is parametric (`apps/agent/src/bench/scenarios.ts`) rather than 100 hand-authored scripts, trading raw scenario count for higher confidence that each generated case is actually correct.
- Single-room scale; no multi-agent handoffs, telephony, or multilingual routing.
- Live interruption/recovery latency has not yet been measured — see §4.
