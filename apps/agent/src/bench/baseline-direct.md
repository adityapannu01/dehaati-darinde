# `LLM_ENGINE=direct` baseline — captured before touching LangGraph

Recorded on branch `langgraph`, before any LangGraph code exists, per
`LANGGRAPH_PLAN.md` Task 0.1. This is the number to beat (or the number that
proves nothing improved) in `bench/langgraph-ab.md` once the graph exists.

## `pnpm --filter DD_agent benchmark` (deterministic core-engine suite)

```
Cartograph benchmark — 45 generated scenarios (delay x interruptAt x corrections) + 1 out-of-order case, run in both modes.

metric | cartograph | baseline
---|---|---
canvas divergence rate | 0.0% | 86.7%
stale mutation rate (of landed mutations) | 0.0% | 50.0%
out-of-order (41/43/42) resolved correctly | yes | no
fence latency (interruption -> generation cancelled) | N/A in this synchronous harness | see bench/live-latency.md

divergent scenarios (cartograph): 0/45
divergent scenarios (baseline):   39/45
```

This suite drives the core engine only — no LLM — so it cannot move when
`LLM_ENGINE` changes. It's captured here only as a "nothing else regressed"
anchor, not as evidence about the graph.

## 20 manual live turns — time-to-first-audio

**Status: not yet run.** Needs a human with a microphone (same constraint as
`bench/live-latency.md`). Do not fill this in with invented numbers — an
unverified number is worse than an omitted one, per the project's own rule
and the hackathon PS's rule about unverified performance claims.

Procedure once available: same as `bench/live-latency.md`, but specifically
comparing canvas-turn TTFA against chat-turn TTFA under `LLM_ENGINE=direct`.

| # | turn type (canvas/chat) | TTFA (ms) | warm/cold | notes |
|---|---|---|---|---|
| 1 | | | | |
| ... | | | | |
| 20 | | | | |

## 20 scripted turns — tool-call correctness under `direct`

**Status: not yet run.** This is the number LangGraph is supposed to improve
(§3 of the plan) — without it captured now, no claim of improvement is
possible later, honest or otherwise.

For each of 20 scripted instructions (a mix of single-mutation, multi-mutation,
and chitchat/questions), record: did the model call the right tool(s), in the
right order, with exactly one narrating sentence per mutation?

| # | instruction | tools called (order) | sentences match 1:1? | correct? |
|---|---|---|---|---|
| 1 | | | | |
| ... | | | | |
| 20 | | | | |

**Compliance rate: pending** (numerator/20 once run).
