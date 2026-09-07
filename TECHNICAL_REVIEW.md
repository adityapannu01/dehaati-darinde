# Cartograph — Technical Review & Implementation Brief

**Repo:** `dehaati-darinde` · **Head at review:** `bfbe1d7` · **Reviewed:** 2026-09-07
**Stack:** LiveKit Agents 1.7.1 (Node) · Rime `coda:celeste` (direct WebSocket plugin) · xyflow 12 · Next.js

This document is written to be handed to a coding agent. Every defect below was confirmed by
reading the source at the cited path. Work top-to-bottom: §1 tasks are ordered by dependency,
not by interest.

**Do not "fix" a defect by changing the benchmark or relaxing an invariant.** The commit-gate
invariant — *the canvas only ever shows what was actually heard* — is the entire product. If a
fix appears to require weakening it, stop and flag it instead.

---

## Table of contents

1. [Defect register (B1–B8)](#1-defect-register)
2. [Feature: addressivity / ambient meeting mode](#2-feature-addressivity)
3. [Drawing quality](#3-drawing-quality)
4. [Rime depth](#4-rime-depth)
5. [Evidence gaps](#5-evidence-gaps)
6. [Sequencing](#6-sequencing)

---

## 1. Defect register

Severity: **P0** = fix before anything else · **P1** = fix before demo · **P2** = cosmetic.

| ID | Title | Severity | Reported by user |
|----|-------|----------|------------------|
| B1 | Backchannel silently orphans staged mutations | P0 correctness | — |
| B2 | Stops on any sound, including grunts | P0 UX | issue #3 |
| B3 | Viewport never re-fits; node 5+ off-screen | P0 demo | issue #2 |
| B4 | Layout is a fixed grid that ignores the graph | P1 demo | issue #2 |
| B5 | Nodes collide after any removal | P1 correctness | — |
| B6 | No way to clear the board | P0 capability | issue #1 |
| B7 | Agent cannot read its own diagram | P0 capability | root cause of #1 |
| B8 | Header badge painted over the HUD | P2 cosmetic | issue #4 |

---

### B1 — Backchannel silently orphans staged mutations · **P0**

**Files:** `apps/agent/src/main.ts:183-192` · `apps/agent/src/agent.ts:74-80` · `apps/agent/src/core/commit-gate.ts:93`

**Symptom.** A user says "mm-hmm" while the agent is narrating. The agent keeps talking and
finishes the sentence "I'm adding a Redis cache." No Redis node ever appears. Nothing is logged —
the event ledger shows no `mutation_dropped`. This is a *silent* violation of the core invariant.

**Root cause.** The fence fires on *every* final transcript, but the session also runs
`interruption: { mode: 'adaptive' }`, which correctly decides **not** to interrupt the agent for a
backchannel. The two layers disagree and nothing reconciles them.

```ts
// main.ts:183 — fires on ANY final transcript, including "mm-hmm"
session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
  if (!ev.isFinal) return;
  pendingInterruptGeneration = gm.currentId;
  gm.cancelCurrent();            // gen 5 fenced
  const g = gm.start(ev.transcript);  // gen 6 opened
  commitGate.startGeneration();  // tracker.reset() — delivery history wiped
});

// agent.ts:74 — words attributed to whoever is current WHEN HEARD,
// not to the generation that actually produced the speech
const gen = deps.gm.currentId;   // now 6; the audio playing is gen 5's
deps.commitGate.onWord(gen, word);
```

**Full failure trace.**

1. Gen 5 stages a mutation under `sentenceIndex 0`.
2. Backchannel produces a final transcript → gen 5 fenced, gen 6 opened, `tracker.reset()`.
3. Adaptive mode keeps gen 5's audio playing.
4. Gen 5's words arrive and are credited to **gen 6**; `commitThrough(6, …)` finds nothing,
   because the mutation is filed under gen 5.
5. `ConversationItemAdded` fires with `item.interrupted === false`, so `onTurnComplete(gen 6)`
   runs — also finds nothing.
6. `onInterrupted(5)` never runs, so the mutation is not even *dropped*. It is stranded in the
   staging buffer permanently, with no ledger event.

**Fix — two parts, both required.**

- **(a) Tag words with the generation that produced them.** In `CanvasAgent`
  (`apps/agent/src/canvas-agent.ts`), capture `gm.currentId` when the TTS/transcription stream for
  a turn *opens* and close over that value, instead of reading `gm.currentId` at word-arrival time
  in `agent.ts:74`. Pass the captured id into `commitGate.onWord(gen, word)`.
- **(b) Stop fencing on the transcript event.** Fence when LiveKit confirms a real interruption —
  drive it from `ConversationItemAdded` with `item.interrupted === true`. Make the existing
  `AgentFalseInterruption` handler (`main.ts:208`) an explicit **un-fence** that restores the
  generation, rather than only pushing a ledger line.

**Acceptance criteria.**

- New benchmark scenario 46, *backchannel during narration*: 0% canvas divergence, 0 orphaned
  mutations with fencing on; non-zero under `CARTOGRAPH_BASELINE=true`.
- Manual: say "mm-hmm" mid-narration; the described node still appears.
- Every staged mutation ends in exactly one terminal ledger event (`mutation_committed` or
  `mutation_dropped`). Add an assertion for this — silent orphaning must be impossible.

---

### B2 — Stops on any sound, including grunts · **P0** · *user issue #3*

**Files:** `apps/agent/src/main.ts:136-148` (session options), same handler as B1

**Root cause.** Same handler as B1, plus three unset knobs. `adaptive` mode governs whether
*LiveKit* stops the agent's audio — it does not govern *your* fence, which fires unconditionally
one layer above it. Even when adaptive correctly ignores the grunt, the generation counter has
already rolled.

**Fix — layered, in this order.**

1. **Fix B1 first.** Most of the observed behaviour is the local fence, not LiveKit.
2. **Set interruption thresholds** under `turnHandling.interruption` (currently all defaults):
   - `minWords: 2` (kills "mm", "uh", "yeah", "right")
   - `minDuration: ~350` ms (kills coughs, chair noise, door)
   - keep `mode: 'adaptive'`
3. **Wire the recovery path:** `falseInterruptionTimeout` (Node takes **milliseconds**) plus
   `resumeFalseInterruption: true`.
4. **Raise the STT floor.** AssemblyAI will emit a final transcript for a grunt. Discard finals
   below a confidence threshold, or under two tokens, before they reach the fence.

**Acceptance criteria.** Cough, "mm-hmm", "yeah", and a chair scrape during narration each leave
the generation counter unchanged and the diagram correct. A real correction still fences in under
the latency budget recorded in `live-latency.md`.

> **Scope note.** Thresholds fix the grunt. They do **not** fix "another engineer said a full,
> confident, three-second sentence to a colleague." That is §2 — the same defect at a higher level
> of abstraction. Build thresholds now (one hour); build §2 because it is the actual product.

---

### B3 — Viewport never re-fits; node 5+ off-screen · **P0** · *user issue #2*

**File:** `apps/web/components/cartograph/architecture-canvas.tsx:317`

**Root cause.** `fitView` is passed as a bare boolean prop. In React Flow v12 that fits the
viewport **on initial mount only**. The canvas mounts empty, so the camera is framed on nothing
and never moves again. The first four nodes land inside the default viewport by luck; everything
after is drawn outside it.

**Why it looks like "a straight line."** It is not. `LAYOUT_COLUMNS = 4` (`core/canvas.ts:63`)
*does* wrap at node 5. The second row is simply never in frame. Two stacked defects, one symptom —
this one and B4.

**Fix.** Call `fitView` imperatively from `useReactFlow()` inside an effect keyed on node count:

```ts
const { fitView } = useReactFlow();
useEffect(() => {
  if (flowNodes.length === 0) return;
  fitView({ padding: 0.2, duration: prefersReducedMotion ? 0 : 400 });
}, [flowNodes.length, fitView, prefersReducedMotion]);
```

`ArchitectureCanvas` must be inside a `<ReactFlowProvider>` for `useReactFlow()` to work — add one
if it is not already there. The animated duration matters: a camera gliding to accommodate a new
node reads as the diagram *growing*. Respect `prefers-reduced-motion`, which the codebase already
honours elsewhere.

**Acceptance criteria.** Twelve nodes added by voice; all twelve visible without manual panning.

---

### B4 — Layout is a fixed grid that ignores the graph · **P1** · *user issue #2*

**File:** `apps/agent/src/core/canvas.ts:57-72` (`nextLayout`)

**Root cause.** Position is assigned from insertion order in a four-column grid at 220px pitch.
Nothing consults the edges. A gateway fanning out to five services is drawn as a queue of boxes,
so every edge crosses the grid diagonally and the picture carries no structural information.

**Fix.** See §3.1 — replace with ELK layered layout, computed agent-side.

**Keep the existing comment's principle** ("never ask the LLM for coordinates — it wastes tokens,
adds latency, and produces garbage layouts"). It is correct and belongs in the README.

---

### B5 — Nodes collide after any removal · **P1**

**File:** `apps/agent/src/core/canvas.ts:65`

**Root cause.** `nextLayout()` derives the grid index from `this.nodes.size`. Remove a node and
the size drops, so the next node is assigned an already-occupied slot. Two boxes stack exactly.

**Trigger.** Any demo that removes then adds — i.e. the correction script in `RIME_EVIDENCE.md`.

**Fix.** Use a monotonic counter that only ever increments, **or** delete `nextLayout` entirely
once B4's layout engine owns placement. Prefer the latter.

---

### B6 — No way to clear the board · **P0** · *user issue #1*

**Files:** `apps/agent/src/tools/canvas-tools.ts` · `packages/protocol/src/index.ts` (`MutationOp`)

**Root cause — three causes compounding.**

1. No `clearCanvas` tool exists. The only removal is `removeComponent(targetLabel)`, one node at a
   time, by name.
2. `PERSONA` (`agent.ts:26`) mandates "exactly ONE change per sentence", so an enumerated clear
   would need one spoken sentence per node.
3. **B7** means the model cannot enumerate the nodes at all — which is *why* it replies that it can
   only remove what you name.

**Fix.**

- Add `{ op: 'clear' }` to `MutationOp` in `packages/protocol/src/index.ts`.
- Handle it in `CanvasStore.apply()` — clear both maps, bump `version`.
- Add a `clearCanvas` tool that stages **exactly one atomic mutation** against one sentence.
  Do **not** implement it as a loop of `removeNode` ops: one op keeps it atomic under the commit
  gate, keeps the ledger readable, and makes it trivially undoable.
- Reset any layout counter from B5 when clearing.
- Update `PERSONA` so the one-change-per-sentence rule explicitly permits bulk ops as a single
  change ("Clearing the board." is one sentence describing one mutation).

**Same shape unlocks these small commands** — add them together:

| Tool | Behaviour |
|------|-----------|
| `clearCanvas()` | One atomic `clear` op. |
| `undoLast()` | Pops the last **committed** mutation. Interesting precisely because you can only undo what was heard. |
| `arrangeLayout(direction)` | From §3.1 — re-run layout, e.g. left-to-right vs top-down. |

**Acceptance criteria.** "Clear the board", "wipe it", "start over" all clear the canvas in one
narrated sentence. Interrupting mid-sentence leaves the board **unchanged** (the clear was never
heard).

---

### B7 — Agent cannot read its own diagram · **P0**

**Files:** `apps/agent/src/tools/canvas-tools.ts:206-213` · `apps/agent/src/core/canvas.ts:88`

**Root cause.** `describeArchitecture` returns `"The diagram currently has 5 component(s)."` — a
count. Meanwhile `CanvasStore.summary()` already renders labels, kinds and edges in exactly the
compact form a model needs, and is wired **only** to the LangGraph planner.

**Fix.** Effectively one line:

```ts
const describeArchitecture = tool({
  name: 'describeArchitecture',
  description:
    'Read-only summary of the current architecture diagram (only committed, already-spoken components). Stages nothing.',
  execute: async () =>
    deps.canvas.nodeCount === 0
      ? 'The diagram is currently empty.'
      : deps.canvas.summary(),
});
```

This is the root cause of B6's symptom, of any "what have we got so far?" question, and a
prerequisite for §2 (which must resolve "the cache" against real labels).

---

### B8 — Header badge painted over the HUD · **P2** · *user issue #4*

**Files:** `apps/web/app/layout.tsx:75-99` · `apps/web/components/app/view-controller.tsx:95`

**Root cause.** The header is `fixed top-0 left-0 z-50 w-full p-6 justify-between`, placing
"Built with LiveKit Agents" at roughly y=24px on the right at `z-50`. The HUD is
`fixed top-4 right-4 z-20` — y=16px, right=16px, `z-20`. Same rectangle; the badge wins.

**Fix.**

- `view-controller.tsx:95` → `className="fixed top-16 right-4 z-20"`.
- Then fix the invisible half: the header is a full-width fixed box at `z-50`, so it intercepts
  pointer events across the entire top strip of the canvas. Add `pointer-events-none` to
  `<header>` and `pointer-events-auto` to the two links inside it.

Check `EventLedger` at `view-controller.tsx:96` (`fixed right-4 bottom-28`) does not collide with
the taller HUD after the offset.

---

## 2. Feature: addressivity

**Goal:** leave Cartograph running in a meeting. It works out for itself when it is being spoken
to and when two engineers are just talking to each other. Muting between commands defeats the
premise of a hands-free canvas.

### 2.1 Why this is worth building

Published work on device-addressed speech detection puts roughly **8% of voice segments in an
ambient multi-person environment as actually directed at the device**. An always-on agent with no
addressivity model is therefore responding to the wrong thing about nine times out of ten. That is
the pitch: push-to-talk is not a UI preference, it is a workaround for a missing capability.

### 2.2 Blocking constraint — verify before planning around it

> LiveKit Agents 1.7.1 is **single-participant by design.**
>
> - `voice/events.d.ts:62` — `UserInputTranscribedEvent.speakerId` is annotated
>   *"Not supported yet. Always null by default."*
> - `voice/room_io/room_io.d.ts:109` — `setParticipant(participantIdentity)`. The session binds to
>   one participant at a time, defaulting to the first who joins.
>
> A second engineer speaking in the room is not merely unattributed — by default the session may
> not be listening to them at all.

"Leave it running in a meeting" is therefore **not a prompt change**. It needs a second audio path:

- Subscribe to each participant's track from `ctx.room` (`TrackSubscribed`).
- Run a per-participant STT stream.
- Feed a shared classifier.
- Use `AgentSession` only for speech output and the addressed path.

**Budget a day for this alone and prove it with two browser tabs before building anything on top.**
If it does not work, everything downstream is blocked.

### 2.3 Design — separate "should I speak?" from "should I draw?"

Do not build a single engage/ignore gate. Score two independent things per utterance:

- **Addressivity** — is this directed at the agent? → controls whether it **speaks**.
- **Salience** — does this contain architecture content? → controls whether it **draws**.

|  | **Architecture content** | **No architecture content** |
|---|---|---|
| **Addressed** | Speak + commit *(current behaviour, unchanged)* | Speak only — answer from `summary()`, touch nothing |
| **Not addressed** | **Draw silently as a proposal (ghost node). No audio.** | **Do nothing.** Most meeting speech. |

### 2.4 Ghost nodes make ambient inference safe

Ambient understanding will be wrong sometimes. A proposal state means being wrong costs nothing,
which is what lets you ship an imperfect classifier without risking the demo.

A ghost:

- renders dashed / translucent;
- never enters the committed canvas;
- never appears in the oracle's expected committed state;
- is promoted only when a human confirms it or the agent narrates it aloud;
- is removed by disagreement, explicit rejection, or a timeout.

This is also what makes "if somebody disagrees it should remove by itself" safe to build.
Disagreement detection over overheard speech ("no, that won't work", "we're not using Kafka",
"scratch that") is unreliable enough that letting it delete real work would be reckless.

> **Safety invariant — put this in the README verbatim:**
>
> **Overheard speech can only ever create or destroy proposals. Committed state is changed only by
> addressed speech.**
>
> A misheard disagreement costs a ghost. Nothing a judge says to a colleague can destroy the diagram.

### 2.5 How the commit gate absorbs this

Objection: an ambient mutation has no agent sentence to gate on. Answer — generalise the invariant
from *"the canvas matches what the agent said"* to *"the canvas matches what was said in the room."*

| Mutation origin | Delivery evidence | Lands as |
|---|---|---|
| Agent tool call, addressed turn | Rime word timestamps | Committed |
| Overheard engineer speech | Human final transcript | Proposal (ghost) |
| Proposal confirmed | Rime word timestamps | Committed |

One rule, three sources of evidence for "heard". The oracle extends the same way: it already
re-derives expected state from heard-sentence counts; it now derives committed state from
agent-heard sentences and proposal state from human-heard utterances.

### 2.6 Implementing the classifier

**Do not train anything.**

**The finding that should shape the design:** in the SAS work, removing short-horizon
conversational context dropped F1 from **0.95 to 0.57**. Utterances like "do it again" or "make
that Postgres" are lexically identical whether aimed at a machine or a colleague; only the last few
seconds of interaction history disambiguates them.

So the classifier input is **never the bare utterance**. Give it a rolling window:

- last ~8s of transcript, with speaker labels
- whether the agent spoke recently, and what it said
- whether the agent asked a question
- current `canvas.summary()`

**Layer for latency:**

1. **Free prefilter (0 ms).** Direct address ("Cartograph", "hey"), imperative mood, second-person
   pronouns, canvas vocabulary matched against live `summary()`, utterance length, whether it
   directly answers an agent question. Confident cases never reach the model.
2. **Small-model classifier (~100–200 ms).** One structured call returning
   `{ addressed: 0..1, salient: 0..1, stance: 'agree' | 'disagree' | 'neutral' }`.
   Route through the existing LangGraph path — there is already a router node, and this is a
   routing decision.
3. **Prosodic prior (optional).** Device-directed speech shows elevated F₀, slower rate, higher
   energy. Even a crude energy/rate feature from the VAD as a tiebreak is defensible.

**Expose the threshold.** Make τ a runtime knob shown in the HUD. Report precision/recall at two
settings rather than one number. Reference points from published systems: ~2.1% false-trigger at
τ=0.70; F1 degrades 0.98 (one speaker) → 0.91 (four speakers).

**Measure it.** Record one genuine 10-minute two-person architecture discussion. Hand-label every
utterance `addressed` / `not addressed`. Commit it as a fixture and produce a confusion matrix.
Do this **even if the classifier is mediocre** — a measured mediocre number beats an unmeasured
good one.

### 2.7 Voice-design decision to make deliberately

When the agent draws ambiently it must **not** talk — narrating every overheard idea would be
intolerable in a real meeting. But silent mutation gives no feedback.

- Use a non-speech **earcon** (soft tick as a ghost lands).
- Reserve speech for addressed turns.
- If a second register is wanted, Rime's `inlineSpeedAlpha` plus a quieter delivery can distinguish
  "I'm chiming in" from "I'm answering you."

State this as a design decision in the README. **Deciding when *not* to speak is voice
engineering**, and saying so out loud is how it gets credited.

---

## 3. Drawing quality

### 3.1 Layout — ELK, not dagre

Replace `nextLayout()` with [elkjs](https://github.com/kieler/elkjs) running `layered`. Dagre is the
more common React Flow pairing and is simpler, but ELK is right here for three specific reasons:

- **Orthogonal edge routing** — architecture diagrams read as right-angled buses, not swooping beziers.
- **Nested / hierarchical nodes** — groups (§3.2) work without a second engine.
- **Port constraints** — edges attach to meaningful sides.

React Flow ships an ELK layouting guide, so this is a documented path.

**Run it agent-side in `CanvasStore`** so the server stays the owner of positions and the browser
stays a pure renderer — that invariant is load-bearing for the correctness claim. Recompute on each
committed mutation; let positions animate to their new values. A diagram that reflows as it grows is
a much better demo beat than one that appends.

### 3.2 Vocabulary — three additions, in this order

| Addition | Tool surface | Why | Effort |
|---|---|---|---|
| **Icons** | renderer only | Real logos for Postgres, Redis, Kafka, S3, nginx (Iconify logo set). Stops looking like boxes. Highest visual return per hour. | 1–2 h |
| **Groups & boundaries** | `groupComponents(label, members[])` | VPCs, trust boundaries, domains. Biggest expressiveness gap. ELK nests natively; xyflow renders parent nodes natively. | half day |
| **Edge semantics** | `connectServices(…, protocol)` | Sync vs async, HTTP/gRPC/Kafka, bidirectional. One field + a stroke/marker map. | 1–2 h |

### 3.3 Word-synced labels — build this one

**The best Rime showpiece available in this project.**

`startTime` and `endTime` are already received for **every spoken word** (`canvas-agent.ts`,
`SpokenWord`). Nobody else at this hackathon has that plumbed to the browser.

Type each node's label into the canvas **in sync with the words Rime is actually speaking** — the
word "Redis" finishes rendering exactly as it finishes being said.

Implementation: forward the word timings already tapped in `canvas-agent.ts` over the existing
`publishData` channel (add a `{ kind: 'word' }` variant to `ServerMessage`), and drive a
per-character reveal from them.

It makes the abstract claim — *the canvas is downstream of delivered audio* — something a judge
**sees** rather than reads, and it is the most legible demonstration of why the direct WebSocket
plugin was chosen over the Inference gateway.

### 3.4 Renderer — stay where you are

| Option | Gain | Cost | Verdict |
|---|---|---|---|
| **xyflow + ELK** | Layered layout, orthogonal routing, nested groups. Keeps every existing animation. | ~1 day, incremental, no rewrite. | **Do this.** |
| Excalidraw (skeleton API) | Hand-drawn aesthetic suiting "sketching while talking". | Rewrite of renderer, lifecycle animations, edge draw-on. | Not now. |
| tldraw SDK | Most polished canvas, real multiplayer primitives. | Same rewrite + licensing review. | Not now. |
| rough.js over xyflow | The sketch *look* without the rewrite — render node borders and edges through rough.js inside existing components. | An afternoon, reversible. | Good stretch. |

**Do not use Mermaid as the renderer.** It re-renders the whole diagram from a declarative source on
every change, which is fundamentally incompatible with per-sentence incremental commits. It is a
fine **export** target — `describeArchitecture` returning Mermaid gives the user something to take
away — but not a renderer.

---

## 4. Rime depth

Rime is central to the *mechanism*, which is unusual and will be noticed. But the criterion has two
halves and only one is built: **"the output is clear and appropriate"** is currently untested.

### 4.1 The gap

This is the one product where infrastructure vocabulary *is* the content — nginx, k8s, PostgreSQL,
gRPC, etcd, JWT, S3, IAM, OAuth, Istio, Envoy, GraphQL, MinIO, ClickHouse — and TTS systems mangle
these notoriously. The brief names this explicitly as a hard voice problem and states the method:
*test names, codes, identifiers and domain vocabulary early, with representative fixtures and
before-and-after evidence.*

**Thesis-level argument for doing it** (this is what stops it diluting focus): the gate guarantees
the canvas matches what the user *heard*. If the user heard "en-jinx" and the node reads "nginx",
the state matches the transcript but not the user's understanding. **Pronunciation correctness is a
precondition for heard-state consistency to mean anything.** Same claim, hardened.

### 4.2 The constraint to document, not hide

| Capability | Coda (current) | Mist v2 | Consequence |
|---|---|---|---|
| Word-level timestamps | **Yes** | No | The commit gate only exists on Coda. |
| Inline phonemes (`phonemizeBetweenBrackets`) | No | **Yes** | Cannot fix pronunciation the easy way. |
| `spell()` | Docs contradict themselves — models table says yes, text-normalization page says no | — | Test it on the shipped path; report what you find. |

The model cannot be switched without destroying the mechanism, so the easy pronunciation lever is
closed. **That is a genuine engineering trade-off discovered by building, and reporting it honestly
scores better than a clean claim with no tension in it.**

Remaining levers: respelling in the submitted text, `noTextNormalization`, `pauseBetweenBrackets`,
`inlineSpeedAlpha`, the `/textnorm` endpoint for inspecting normalization before synthesis, and
dictionary submission for the handful of words that matter most.

> **Already available and unused:** `saveOovs: true` is exposed in the Rime plugin's options and is
> not currently set. It logs out-of-vocabulary words — a ready-made instrument for answering "which
> architecture terms does Rime not know?" with data instead of guesses. Turn it on, run a session,
> and the output *is* the fixture list.

### 4.3 The harness

~40 infrastructure terms, rendered through the **shipped path** (`TTS_PROVIDER=rime-plugin`,
`coda:celeste`, WebSocket), clips committed to the repo, plus a table of which wording changed which
result. Hold model and voice constant, render **at least two text variants per term**, save both,
and explain what changed.

That is the brief's own stated methodology for a delivery claim, followed literally. An afternoon.

---

## 5. Evidence gaps

### 5.1 The unfilled latency table — **do this before writing any new code**

`apps/agent/src/bench/live-latency.md` still reads *"Status: not yet run"* with `_pending_` in every
cell, and `RIME_EVIDENCE.md` §4 repeats it. The README links there twice.

Unverified numbers earn no credit — but a number you **promised** and did not deliver reads worse
than one never claimed, because a judge who follows the link finds the gap themselves. The
instrumentation already exists. This is 20 real interruptions, ~45 minutes.

### 5.2 The word "collaborative"

It is in the product name and the README's first line, and the demo is one person. `publishData` is
a room broadcast, so a second browser tab in the same room should already see the same canvas.
Verify it, put both windows in the demo video, and the rendering half of the claim is earned for
~30 minutes. **If it does not work, you need to know now, not on stage.** (The listening half is §2.)

### 5.3 New benchmark scenarios

- **46 — backchannel during narration.** The B1 regression. 0% divergence with the fix; non-zero without.
- **47 — ambient proposal never commits without confirmation.** Proves the §2.4 safety invariant mechanically.
- **48 — overheard disagreement removes a ghost, never a committed node.** The invariant a judge will most want to attack.

All three fit the existing harness: deterministic, no audio, no LLM, no LiveKit. **That property is
the most valuable thing about the benchmark — protect it.**

### 5.4 Keep the injected delay

On replacing `SLOW_TOOL_MS` with genuinely slow tools: do it, but **keep the synthetic delay too.**
The brief's own full-duplex example says to introduce a fixed delay into a tool call — the injected
delay is the sanctioned *test fixture*, and it is what makes the benchmark deterministic and
reproducible on any machine.

Add a real slow tool for the demo; keep the synthetic one for the harness; state in the README which
is which and why. A live network fetch on stage is a failure point — cache a fixture as the fallback.

---

## 6. Sequencing

Ordered by score-per-hour. The first block is all defects and evidence — no new surface area —
because a broken invariant costs more than a missing feature.

### First — stop the bleeding

- **B1** — generation-tagged words; fence on confirmed interruption. The only correctness bug.
- **B2** — `minWords`, `minDuration`, `resumeFalseInterruption`, STT confidence floor.
- **B7** then **B6** — one line, then `clearCanvas` as an atomic op. B7 first: it is *why* B6 presents the way it does.
- **B3**, **B5**, **B8** — imperative `fitView`; monotonic layout counter; HUD offset + pointer-events.
- **Run `live-latency.md`** and paste real numbers.
- **Verify two-tab sync** and record it.

### Second — make it look like a real tool

- **B4** — ELK layered layout, agent-side, animated reflow.
- **Icons**, then **edge semantics**. Both cheap, both immediately visible.
- **Word-synced labels** (§3.3). The Rime showpiece — do not let this slip.
- **Pronunciation harness** (§4.3). An afternoon; closes half of a 20% criterion.

### Third — addressivity

- **Multi-participant audio path first** (§2.2). Prove with two tabs before building on it.
- **Two-axis classifier** with rolling context window and free prefilter.
- **Ghost state** in protocol, renderer, and oracle.
- **Labelled fixture** from one real recorded discussion + confusion matrix.

### If time — stretch

- **Groups and boundaries** — highest-value remaining drawing feature.
- **Real long-running tool** with cached fixture fallback, alongside the retained `SLOW_TOOL_MS`.
- **Mermaid export** and **undo by voice** — an hour each, both demo well.
- **rough.js** sketch aesthetic over the existing renderer.

---

## The one risk to manage

The brief is explicit that **a focused product with one convincingly solved voice problem beats a
broad assistant with many shallow features.** There are now three voice tracks in play:
heard-state consistency, addressivity, and pronunciation.

That is defensible **only** if they are presented as one claim with three faces:

> **The canvas shows exactly what was heard in the room, and nothing else.**
>
> - Interruption handling protects it from stale intent.
> - Addressivity protects it from speech that was never meant for the agent.
> - Pronunciation ensures "heard" means understood.

If that sentence cannot be said naturally in the demo, cut whichever track does not fit it rather
than presenting three separate features.

---

## Sources

Findings in §1 are from direct inspection of the repository at `bfbe1d7`.

- [Selective Attention System: Device-Addressed Speech Detection](https://arxiv.org/html/2604.08412)
- [A Multimodal Approach to Device-Directed Speech Detection with LLMs](https://arxiv.org/html/2403.14438)
- [Apple ML — Device-Directed Speech Detection](https://machinelearning.apple.com/research/device-directed-speech)
- [Rime — models](https://docs.rime.ai/docs/models) · [text normalization](https://docs.rime.ai/docs/text-normalization) · [custom pronunciation](https://docs.rime.ai/docs/custom-pronunciation)
- [LiveKit — turn detection](https://docs.livekit.io/agents/build/turns/) · [Rime plugin](https://docs.livekit.io/agents/models/tts/plugins/rime/)
- [React Flow — layouting](https://reactflow.dev/learn/layouting/layouting)
- [Excalidraw — element skeleton API](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/excalidraw-element-skeleton)
