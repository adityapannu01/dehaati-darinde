# Cartograph — Round 3: Complex Layouts & Voice Depth

**Repo state at time of writing:** `7c8a455` · reviewed 2026-09-08
**Companions:** `TECHNICAL_REVIEW.md` (round 1), `MULTILINGUAL_AND_PRONUNCIATION.md` (round 2)

Written for a coding agent. Every claim below was verified against the working tree or the
installed SDK; file:line citations are inline. **Modules are independent** — A and B can be worked
in either order, and inside each module the items are ordered by dependency, not preference.

---

## 0. What is already shipped — do not redo any of this

Rounds 1 and 2 are essentially complete. Confirmed present in the tree:

| Area | State |
|---|---|
| B1 backchannel fence | Fixed. `core/turn-taking.ts`, scenarios 46, orphan assertion in `runner.test.ts` |
| ELK layered layout | Shipped. `core/layout.ts`, recomputed per commit via `relayout()` in `main.ts:143` |
| `clearCanvas`, `undoLast`, `groupComponents`, `exportDiagram`, `explainComponent` | All shipped in `tools/canvas-tools.ts` |
| `describeArchitecture` → `summary()` | Fixed |
| `resolveId` label resolution | Shipped, with a real-bug writeup in the README |
| Addressivity / ghosts / proposals | Shipped behind `ADDRESSIVITY=true` |
| Multilingual + language router + voices map | Shipped behind `RIME_MULTILINGUAL=true` |
| Pronunciation lexicon + `keyterms_prompt` | Shipped. `core/lexicon.ts` |
| Live latency, playout-stop measurement, audit session | Measured and recorded |

**This document only covers what is still missing.**

---

# MODULE A — Complex architectures

The reference target is an Eraser-style architecture diagram: multi-directional flow, nested
containers, many nodes, readable at a glance. Five gaps stand between the current renderer and
that. **A1 is the reported bug; A2 is a latent bug that will be far more visible on a complex
diagram.**

---

## A1 — Layout direction is fixed at process boot

**Severity: P0. This is the "it said it can't do that" bug.**

**File:** `apps/agent/src/main.ts:141`

```ts
const layoutDirection = env('LAYOUT_DIRECTION', 'RIGHT') === 'DOWN' ? 'DOWN' : 'RIGHT';
```

A `const`, read from an environment variable once, at worker startup. `layoutCanvas()` already
accepts `direction: LayoutDirection = 'RIGHT' | 'DOWN'` (`core/layout.ts:17`) and the ELK call
already threads it through — **the capability exists and has no surface.** There is no tool, no
`MutationOp`, and no way to change it inside a session. The model correctly reports it cannot
comply, because it cannot.

### Changes

**1. Protocol** — `packages/protocol/src/index.ts`

```ts
export type LayoutDirection = 'RIGHT' | 'DOWN' | 'LEFT' | 'UP';

// on CanvasSnapshot
direction: LayoutDirection;

// new MutationOp variant
| { op: 'setDirection'; direction: LayoutDirection }
```

Add `'LEFT'` and `'UP'` while you are here — ELK supports all four `elk.direction` values at no
cost, and "right to left" is a natural thing to ask for.

**2. `CanvasStore`** — `apps/agent/src/core/canvas.ts`

- Add `private direction: LayoutDirection = 'RIGHT'`.
- Handle `setDirection` in `apply()` — it **should** go through `pushHistory()` so `undoLast`
  reverses it like any other narrated change.
- Include `direction` in `snapshot()`.
- Reset to `'RIGHT'` on `clear`.

**3. New tool** — `apps/agent/src/tools/canvas-tools.ts`

```ts
const arrangeLayout = tool({
  name: 'arrangeLayout',
  description:
    'Change the direction the diagram flows: left-to-right, top-to-bottom, right-to-left, or ' +
    'bottom-to-top. Use when the user asks to restructure, rearrange, flip, or reorient the ' +
    'diagram. Does not add, remove, or change any component.',
  parameters: z.object({
    direction: z.enum(['RIGHT', 'DOWN', 'LEFT', 'UP'])
      .describe('RIGHT = left-to-right, DOWN = top-to-bottom, LEFT = right-to-left, UP = bottom-to-top.'),
    sentenceIndex: sentenceIndexParam,
  }),
  // same fencing contract as every other mutating tool: snapshot gen,
  // re-check gm.isCurrent(gen), then commitGate.stage(...)
});
```

**4. `relayout()`** — `apps/agent/src/main.ts:143`

Read the direction from the store instead of the boot constant:

```ts
placements = await layoutCanvas(snap.nodes, snap.edges, snap.groups, snap.direction);
```

Keep `LAYOUT_DIRECTION` as the **initial** value only, and rename the variable to make that
obvious (`initialLayoutDirection`).

### Design decision — does a direction change go through the commit gate?

**Yes. Route it as a normal `MutationOp` through `CommitGate.stage()`.**

Reasoning: it is a change the agent narrates ("Switching to top-to-bottom"), so it must not happen
before the sentence is heard — otherwise it is the only visible change in the product that ignores
the invariant, and a judge who interrupts mid-sentence will see it land anyway.

**But exclude it from the oracle's divergence calculation.** `bench/oracle.ts` re-derives expected
*content* — which nodes and edges exist. Direction is presentation, not content. Adding it to the
oracle's comparison would make the divergence metric mean two different things at once. Add a
one-line comment in `oracle.ts` saying so explicitly, so the omission reads as deliberate.

Note this differs from `applyLayout()`, which is correctly excluded from history entirely
(`canvas.ts:60`) — that is ELK repositioning, which nobody asked for. A *direction* change is
something the user asked for, so it is history-worthy and undoable.

### Acceptance criteria

- [ ] "Restructure this top to bottom" reflows the diagram, narrated in one sentence
- [ ] "Flip it back to left to right" returns it
- [ ] Interrupting mid-sentence leaves the direction unchanged
- [ ] `undoLast` after a direction change restores the previous direction
- [ ] `clearCanvas` resets direction to `RIGHT`
- [ ] Unit test in `layout.test.ts` for all four directions
- [ ] Benchmark divergence rate unchanged at 0.0%

---

## A2 — Groups are never sent to ELK

**Severity: P0 for complex diagrams. Latent bug, currently invisible because diagrams are small.**

**Files:** `apps/agent/src/main.ts:148` · `apps/agent/src/core/layout.ts:44` · `apps/agent/src/core/canvas.ts` (`groupBoxes`)

```ts
placements = await layoutCanvas(snap.nodes, snap.edges, layoutDirection);
//                              ^^^^^ groups are NOT passed
```

`layoutCanvas` takes only nodes and edges. **ELK has no idea groups exist.** It places nodes purely
by edge topology, and `groupBoxes()` (`canvas.ts`) then draws a bounding box around wherever the
members happened to land.

**Consequences, which get worse as the diagram grows:**

1. A group's members can be scattered across the layout, so the boundary becomes a huge rectangle
   spanning most of the canvas.
2. That rectangle **swallows unrelated nodes** that happen to sit inside its bounds — the diagram
   shows a node inside a VPC it is not in. This is the worst failure: the picture asserts something
   false.
3. Two groups' boxes can overlap, which is visually meaningless.

### Change — build a hierarchical ELK graph

ELK natively supports nesting: a group becomes a child node that itself has `children`.

```ts
export async function layoutCanvas(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  groups: readonly CanvasGroup[] = [],
  direction: LayoutDirection = 'RIGHT',
): Promise<Map<string, Placement>> {
```

Build shape:

```
root
├── group-vpc          (layoutOptions: elk.padding, optional elk.direction)
│   ├── auth-service
│   └── user-service
├── postgres           (ungrouped nodes stay at root)
└── gateway
```

Required layout options:

- On **root**: `'elk.hierarchyHandling': 'INCLUDE_CHILDREN'` — without this ELK will not route
  edges that cross a group boundary, and most of your edges do.
- On each **group node**: `'elk.padding': '[top=34,left=24,bottom=24,right=24]'` — reserves room
  for the boundary and its label. Match the `GROUP_PADDING = 28` and the `- 14` label allowance
  already in `groupBoxes()`.

**Coordinates become relative.** ELK returns child positions relative to their parent. Flatten them
before handing back placements:

```ts
function collect(container, offsetX, offsetY, out) {
  for (const child of container.children ?? []) {
    const x = offsetX + (child.x ?? 0);
    const y = offsetY + (child.y ?? 0);
    if (child.children?.length) collect(child, x, y, out);   // a group
    else out.set(child.id, { x: Math.round(x), y: Math.round(y) });
  }
}
```

**Keep `groupBoxes()` as-is.** Once members are genuinely clustered by ELK, the derived bounding box
becomes correct rather than accidental — and it stays the single source of the group rectangle, so
the renderer needs no change. Do not have ELK author the group box directly; that would put layout
authority in two places.

**Edge case — a node in two groups.** ELK's tree cannot express it. Today `groups` is a flat map and
nothing prevents overlapping membership. Either reject the second `addGroup` for an
already-grouped node (simplest, and honest — say so in the tool result) or assign it to the first
group only and log it. Pick one and unit-test it; do not leave it undefined.

### Acceptance criteria

- [ ] `layout.test.ts`: members of a group are positioned inside that group's derived box
- [ ] `layout.test.ts`: no ungrouped node's centre falls inside a group's box
- [ ] Edge from a grouped node to an ungrouped node still routes (proves `INCLUDE_CHILDREN`)
- [ ] Two groups produce non-overlapping boxes
- [ ] A 12-node, 3-group diagram is readable in the `/preview` page

---

## A3 — The renderer ignores direction

**Severity: P1. Without this, A1 produces a vertical layout with edges looping sideways.**

**File:** `apps/web/components/cartograph/architecture-canvas.tsx:452, 468, 487, 508`

```ts
sourcePosition: Position.Right,
targetPosition: Position.Left,
```

Hardcoded at all four places nodes are constructed (live, exiting, forming, ghost). With
`direction: 'DOWN'`, ELK stacks nodes vertically but every edge still exits the right side and
enters the left, producing long horizontal detours around each box.

### Change

Thread `snapshot.direction` into `ArchitectureCanvas` and derive handle positions:

```ts
const HANDLES: Record<LayoutDirection, { source: Position; target: Position }> = {
  RIGHT: { source: Position.Right,  target: Position.Left   },
  LEFT:  { source: Position.Left,   target: Position.Right  },
  DOWN:  { source: Position.Bottom, target: Position.Top    },
  UP:    { source: Position.Top,    target: Position.Bottom },
};
```

Apply to all four node-construction sites. The `<Handle>` elements in `CartographNodeView`
(lines 151–163) already exist on all four sides with ids — reuse them rather than adding more.

`CartographEdgeView` uses `getBezierPath` with the passed `sourcePosition`/`targetPosition`, so it
adapts automatically once those are correct. The `stroke-dashoffset` draw-on animation is keyed on
`[path]`, so it will re-run on a direction change — **that is the desired behaviour**: the diagram
redraws itself in the new orientation as the agent narrates the change. Do not suppress it.

### Acceptance criteria

- [ ] `DOWN`: edges leave the bottom, enter the top; no horizontal detours
- [ ] Switching direction re-runs the edge draw-on animation
- [ ] `prefers-reduced-motion` still suppresses the animation

---

## A4 — Per-group direction

**Severity: P2. This is what actually makes Eraser-style diagrams read well.** Do it only after
A1–A3 are solid.

Real architecture diagrams are not uniformly directional: the top-level flow runs left-to-right,
but a cluster of workers inside a boundary stacks vertically. ELK supports this natively —
`elk.direction` is settable **per node**, not only on the root.

Since A2 already makes groups real ELK containers, this is one extra field:

```ts
// protocol
export interface CanvasGroup {
  // ...existing
  direction?: LayoutDirection | undefined;   // inherits root when unset
}
```

Tool surface: extend `arrangeLayout` with an optional `scope`:

```ts
scope: z.string().optional()
  .describe('A boundary name to reorient only that group. Omit to reorient the whole diagram.'),
```

Resolve `scope` through `CanvasStore.resolveId`-style matching against group labels — reuse the
same forgiving resolution, since the LLM will paraphrase group names exactly as it paraphrases node
names.

### Acceptance criteria

- [ ] "Make the diagram left to right but stack the workers vertically" produces exactly that
- [ ] A group with no direction set inherits the root direction

---

## A5 — Visual vocabulary

**Severity: P2, but the highest visual return per hour in this document.**

Every node is currently the same rounded rectangle with a coloured border, differing only by hue.
On a 15-node diagram that reads as a wall of identical boxes. Two cheap changes:

**Shape by kind** — encode `NodeKind` in silhouette, not just colour. This is the same information
in a second channel, which is what makes a dense diagram scannable:

| Kind | Shape |
|---|---|
| `service` | rounded rectangle (current) |
| `datastore` | cylinder (rect + elliptical top) |
| `queue` | rectangle with a notched/parallel right edge |
| `gateway` | hexagon or chamfered rectangle |
| `external` | dashed border, softer fill |

Pure CSS/SVG inside `CartographNodeView` — no new dependency.

**Icons** — Postgres, Redis, Kafka, S3, nginx logos via Iconify's `logos` collection, matched
against the node label with the same normalisation `resolveId` uses. Falls back to no icon. This is
the single change that most makes it look like a real architecture tool rather than a graph demo.

> Keep `NODE_WIDTH`/`NODE_HEIGHT` in `core/layout.ts:21-22` in sync with whatever the renderer
> actually measures. They are already a documented approximation; adding icons widens the box and
> ELK's spacing will drift if these are not updated.

---

## A6 — The model does not know layout exists

**File:** `apps/agent/src/agent.ts` (`PERSONA`)

`PERSONA` contains **no mention of layout, direction, or arrangement**. Adding the `arrangeLayout`
tool without prompt guidance gets a tool that is rarely called and often mis-called.

Add to the "Narrating diagram changes" section:

```
- The diagram has a flow direction. If the user asks to restructure, rearrange, flip, reorient,
  or change how the diagram is laid out, call arrangeLayout — this is not something you decline.
  Describe it in one sentence like any other change: "Switching to top to bottom."
- arrangeLayout only moves things. Never use it to add, remove, or rename a component.
- Do not volunteer a direction change the user did not ask for.
```

That last line matters: without it the model will start "helpfully" rearranging mid-session, which
produces a diagram that will not sit still.

---

# MODULE B — Voice

---

## B1 — Restore the commit gate for non-English

**Severity: P0 opportunity. This is the most valuable item in this document.**

Your `RIME_EVIDENCE.md §4a` records the §0 spike honestly: Coda emits word timestamps **only for
English** (17 words English, 0 Hindi, 0 Japanese). Every non-English language therefore falls back
to `onTurnComplete` granularity, and the README documents this as the product's largest limitation.

**There is a second source of delivery evidence in the plugin, and you are not using it.**

Inspecting the installed Rime plugin's `SynthesizeStream`
(`@livekit/agents-plugin-rime@1.7.1/dist/tts.js`):

- Word timings arrive in a message of type `"timestamps"` carrying
  `word_timestamps.{words,start,end}` — this is the English-only path you use today.
- **Separately**, the stream emits `sendLastFrame(segmentId, final)` — a per-segment boundary with
  a `final` flag, on a completely different code path from `"timestamps"`.

Your TTS is constructed with `segment: 'bySentence'` (the plugin default). **So Rime is already
segmenting server-side by sentence, and emitting a boundary frame per sentence, in every
language.** That boundary is real delivery evidence from the provider — not an estimate, not an
assumption — and it is exactly the granularity the commit gate needs: *this sentence's audio has
been delivered*.

### Change — two delivery sources, selected per language

Extend `DeliveryTracker` (`core/delivery.ts`) to accept either signal:

```
Word timings available  (English)      → per-word progress + per-sentence commit   [today]
Word timings absent     (Hindi, …)     → per-segment-final commit                  [new]
```

The commit rule does not change: *commit everything staged through sentence N once sentence N is
confirmed delivered.* Only the evidence source changes.

Plumb the segment-final signal alongside the existing word tap in `canvas-agent.ts` —
`transcriptionNode`/`ttsNode` already tap this stream, so it is the same hook, one more event type.

### Be precise about what this does and does not give you

State the difference honestly in `RIME_EVIDENCE.md` rather than flattening it:

| | English (word timings) | Non-English (segment boundaries) |
|---|---|---|
| Commit granularity | per sentence | per sentence |
| Mid-sentence progress | yes — drives the forming-node reveal | no |
| Interrupt mid-sentence drops the pending mutation | yes | yes |
| Word-synced label reveal | yes | falls back to sentence-level reveal |

**So the commit gate is restored at full granularity for every language; only the per-word visual
reveal stays English-only.** That is a much smaller and much more defensible limitation than
"non-English loses the gate."

### Why this matters beyond the feature

It converts the project's biggest documented weakness into a piece of engineering, and it is a
genuinely good story for a TTS-focused audience: *two independent delivery signals from the same
provider, selected by what that provider actually gives you for that language, with the weaker one
still strong enough for the invariant.* That is the kind of specific, verified provider knowledge
the Rime team will recognise.

### Acceptance criteria

- [ ] Spike first: log `segmentId`/`final` frames for a 3-sentence Hindi synthesis; confirm one
      boundary per sentence. **If boundaries do not arrive per sentence, stop and keep the
      documented degraded mode** — do not estimate from frame counts, that is not evidence.
- [ ] `delivery.test.ts` covers both evidence sources
- [ ] A Hindi turn commits per sentence
- [ ] Interrupting a Hindi turn mid-sentence drops the un-delivered mutation
- [ ] HUD `degradedTiming` now reflects *reveal* fidelity, not commit fidelity — update the label
- [ ] README and `RIME_EVIDENCE.md §4a` rewritten with the new matrix

---

## B2 — Recovery latency

**Severity: P1. The PS's first-listed direction is perceived response time, and this is your
weakest measured number.**

Your own README: recovery latency **median 3.7–4.0s, p95 6.2–7.3s**, flagged as "a live
optimization target." Fence latency is excellent (13ms median playout-stop). The gap between them
is what a judge will notice — the agent stops instantly and then takes four seconds to say
anything.

Already ruled out or done: `preemptiveGeneration` is on; Rime `reduceLatency` was investigated for
coda and documented as a dead end (`7aeceb8`).

**Remaining levers, in order of expected effect:**

1. **Instant acknowledgement.** The single biggest perceived-latency win, and it costs no real
   latency. On fence, immediately speak a short token — "Right." / "Okay —" — while the LLM plans.
   Rime's own writing-for-the-ear guide explicitly sanctions light disfluencies, and the PS asks
   about *perceived* response time, not model time.

   **It is also free under your invariant:** the acknowledgement carries no mutation, so it stages
   nothing and the commit gate is untouched. Cap it to one token, never stack two
   (the guide is explicit about not stacking fillers), and suppress it when the user's turn was a
   backchannel.

2. **Measure `direct` vs `graph`.** `LLM_ENGINE=graph` adds a planning round-trip before the first
   token. You have both engines and a latency harness — report the split. If graph costs a second,
   that is a documented trade-off (better sentence↔mutation pairing vs. latency), which scores
   better than an unexplained number.

3. **First-sentence streaming.** Confirm the first sentence reaches Rime as soon as it is complete,
   rather than waiting for the whole LLM response. `segment: 'bySentence'` suggests it does — verify
   with a timestamp log rather than assuming.

4. **A smaller model for the first turn.** `google/gemma-4-31b-it` is doing planning and narration.
   Only if 1–3 are insufficient.

### Acceptance criteria

- [ ] Re-run `live-latency.md` with acknowledgement on; report before/after medians and p95
- [ ] Report `direct` vs `graph` separately
- [ ] Confirm the acknowledgement never stages a mutation (unit test)
- [ ] Confirm it does not fire on backchannels

---

## B3 — Single-word commands are swallowed

**Severity: P1. Documented in the README, not yet fixed.**

> *"A single-word command that isn't in the hard-interrupt list ("stop", "wait", "no", "actually", …)
> — e.g. "bigger" — is treated as a backchannel and won't fence until the user says more."*

**File:** `apps/agent/src/core/turn-taking.ts`

This is the cost of the B1 fix and it is a real UX regression: "undo", "clear", "smaller", "again",
"vertical" are all natural single-word commands that currently do nothing until the user adds
words.

**Do not fix it by lowering `minWords` to 1** — that reintroduces the grunt problem the round-1 work
solved.

**Fix:** keep the 2-word floor as the default, and extend the hard-interrupt list from a fixed set
of conversational words to a **command vocabulary**, generated from the tool surface rather than
hand-written:

- direction words: `vertical`, `horizontal`, `up`, `down`, `left`, `right`
- action words: `undo`, `clear`, `reset`, `bigger`, `smaller`, `again`, `redo`
- plus the existing conversational set

Generate it from one place so it cannot drift from the tools, and unit-test that every
single-word command in the list fences while `mm`, `mhm`, `yeah`, `right`… do not.

> `right` is in both categories — a direction word and a backchannel. Resolve it by context:
> treat it as a command only when the agent is *not* mid-sentence, or require "go right". Add an
> explicit test for this collision; it is exactly the case that will show up in a demo.

---

## B4 — Ambient mode has never seen real audio

**Severity: P1 if you demo it; P0 risk if you demo it without checking.**

The README is candid: the classifier, ghost store, safety invariant and scenarios 47/48 are all
unit-tested, but *"the multi-participant STT subscription in `core/ambient-listener.ts` … has not
been exercised with real audio."*

LiveKit Agents 1.7.1 binds `AgentSession` to one participant
(`room_io.d.ts:109 setParticipant`, and `UserInputTranscribedEvent.speakerId` is documented as
always null), so the second engineer's audio comes off a raw track subscription. That plumbing is
the single highest-risk untested path in the repo.

**Two browser tabs, one session, 15 minutes.** Confirm: the second participant's audio produces
transcripts; those transcripts reach `classifyUtterance`; a ghost appears; the agent stays silent;
disagreement removes the ghost; committed state is never touched.

**Decide before the demo:** if it does not work, `ADDRESSIVITY` stays off and it is described as
implemented-and-unvalidated (which the README already does honestly). Do not demo it live off the
back of unit tests alone.

---

# MODULE C — Evidence

Each module above earns its marks only if it is measured. Additions to make:

- **Benchmark scenarios.** Add a direction-change scenario: a `setDirection` mutation staged and
  then interrupted must not apply. Content divergence must stay 0.0% — which also proves direction
  is correctly excluded from the oracle's content comparison.
- **Layout regression fixture.** A fixed 12-node / 3-group graph, laid out in all four directions,
  asserting: members inside their group box, no foreign node inside a group box, no group overlap.
  Deterministic, no audio, fits the existing harness.
- **`RIME_EVIDENCE.md §4a` rewrite** if B1 lands — the multilingual matrix changes materially.
- **Latency re-run** for B2, with before/after.

Keep the harness property that makes it valuable: deterministic, no audio, no LLM, no LiveKit.

---

# Sequencing

| # | Item | Why here |
|---|---|---|
| 1 | **B1 spike** (segment boundaries in Hindi) | 30 min, and the answer changes the README's headline limitation either way |
| 2 | **A1** direction tool | The reported bug. Self-contained. |
| 3 | **A3** renderer handles | A1 looks broken without it |
| 4 | **A2** groups → ELK hierarchy | Biggest correctness win for complex diagrams |
| 5 | **B1** implementation | If the spike passed |
| 6 | **B3** single-word commands | Small, documented, user-visible |
| 7 | **A6** persona | Ten minutes; A1 underperforms without it |
| 8 | **B2** acknowledgement + latency re-run | Best remaining voice number |
| 9 | **A5** shapes + icons | Highest visual return; do before recording the demo |
| 10 | **B4** two-tab ambient check | Before deciding what the demo includes |
| 11 | **A4** per-group direction | Only if time remains |
| 12 | **Module C** | Continuous, not last |

---

# Design decisions not to get wrong

1. **Direction goes through the commit gate, but not into the oracle.** It is narrated, so it must
   be heard before it applies; it is presentation, not content, so it must not enter the divergence
   metric. Comment both choices in code.

2. **ELK owns positions; `groupBoxes()` owns the boundary rectangle.** After A2, do not let ELK
   author the group box as well — one authority per thing, or the two will disagree at the margins.

3. **The browser stays a pure renderer.** A3 and A5 consume `direction` and `kind`; they never
   compute or store position. That property is load-bearing for the whole claim.

4. **Do not weaken `minWords` to fix B3.** Extend the vocabulary instead. The grunt fix was
   expensive to get right.

5. **If the B1 spike fails, keep the honest degraded mode.** Do not estimate sentence boundaries
   from audio frame counts and duration — that is an inference presented as delivery evidence,
   which is precisely the thing this project exists to refuse to do. A documented limitation is
   worth more than a fabricated signal.

6. **Watch the feature count.** Layout is presentation work and does not add a voice track, so
   Module A is safe. Module B deepens tracks you already have rather than opening new ones — B1
   hardens multilingual, B2 hardens perceived latency, B3 hardens interruption, B4 validates
   addressivity. Nothing here is a fifth direction, and it should stay that way.
