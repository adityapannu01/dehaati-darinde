# Cartograph — Multilingual & Pronunciation Implementation Plan

> **Outcome (post-implementation):** the **pronunciation** half shipped and stays — it is
> on-thesis for English (see `RIME_EVIDENCE.md §4a`). The **multilingual** half was built and
> then **removed**: the §0 spike below fired (Coda gives word-level delivery evidence only for
> English), a follow-up `ws3` spike confirmed there is no per-sentence delivery frame in any
> language, and shipping the product's core commit-gate guarantee in a degraded state for most
> of its languages was judged worse than scoping to English. This document is kept as the
> record of what was investigated and why. The two spikes are preserved in `RIME_EVIDENCE.md §4a`.

**Companion to** `TECHNICAL_REVIEW.md`. Covers two PS directions:
*Pronunciation and controlled delivery* and *Multilingual and code-switched speech* (PS p.3).

Written to be handed to a coding agent. Every capability claim below was verified against
Rime's docs, AssemblyAI's docs, or the installed SDK in `node_modules` — the source is cited
inline so nothing has to be taken on trust.

---

## 0. Do this spike first — it can kill the multilingual feature

**Everything in §2 depends on one unverified assumption: that Rime Coda returns word-level
timestamps for non-English languages.**

The commit gate is driven entirely by `alignedTranscript` word timings. If Hindi synthesis
returns no timings — or returns them without `startTime`/`endTime` populated — then **the canvas
never commits in Hindi** and the whole product silently stops working in the language you are
demoing.

**30-minute spike, before writing any other code:**

```bash
# apps/agent — a throwaway script, not committed
RIME_MODEL=coda RIME_LANGUAGE=hin RIME_VOICE=<a Hindi Coda voice>
# synthesize a 3-sentence Hindi string over the WebSocket path,
# log every word with startTime / endTime, and confirm:
#   1. words arrive at all
#   2. startTime/endTime are populated (not undefined)
#   3. sentence boundaries are detectable
```

Repeat for one more non-Latin-script language (Japanese or Arabic) — script matters here, see §2.5.

- **If timings are populated:** proceed with §2.
- **If they are not:** multilingual is dead for the gated path. Fall back to §2.7's degraded mode
  and say so in the README — a documented, measured limitation scores; a broken demo does not.

---

## 1. What the PS actually asks for

> **Pronunciation and controlled delivery.** Test names, numbers, codes, addresses, identifiers,
> and domain vocabulary early, using representative fixtures and before-and-after evidence. Use
> Brooke Larson's *Writing for the ear* guide to match the prompt to the selected voice, keep
> sentences short, and test punctuation, fillers, repeated words, and false starts by rendering
> alternatives and listening. A language-learning tutor could repeat or slow a full response or
> selected words and phrases where supported; test intelligibility and naturalness at each speed.

> **Multilingual and code-switched speech.** Select compatible models, voices, and language
> settings deliberately, and test with real target-language material.

Two things to read carefully:

- **"where supported"** — the PS is explicitly acknowledging that not every control exists on
  every model. Coda does *not* support `inlineSpeedAlpha` (§3.1). Saying so is scoring, not
  conceding.
- **"Select compatible models, voices, and language settings deliberately"** — this is the whole
  multilingual brief. It is a *compatibility* problem, not a translation problem. §2.1 is the
  deliverable.

Also note the README requirement on p.2: the exact **Rime model ID, speaker, language, endpoint,
audio format, and transport** must be disclosed. Once language and speaker become dynamic, that
table has to become a *matrix*, not a single row. See §2.8.

---

## 2. Multilingual

### 2.1 The capability intersection — build this table first

Three constraints stack. Only their intersection is actually shippable.

**Constraint A — TTS must be Coda.** The commit gate needs word timestamps, and only Coda
provides them via the direct WebSocket plugin. Coda supports **9 languages**:

> English, Arabic, French, German, **Hindi**, Italian, Japanese, Portuguese, Spanish

**Constraint B — STT must detect the language.** You are already on
`assemblyai/universal-3-5-pro`, which happens to be the *only* AssemblyAI streaming model with
native mid-sentence code-switching, covers 18 languages including Hindi, and reports a detected
language per turn. **You are already on the right model — it is just pinned to English.**

**Constraint C — Rime speakers are language-specific.** From Rime's voices docs:
*"A voice serves one language"* and *"no individual Coda voice crosses between them."*
`celeste` is English-only. Every language needs its own speaker.

**The shippable set is the 9 Coda languages**, and Hindi is in it.

| Layer | Setting today | Setting needed |
|---|---|---|
| STT model | `assemblyai/universal-3-5-pro` | unchanged ✅ |
| STT language | `'en'` (hardcoded, `main.ts:128`) | `'multi'` + language detection |
| TTS model | `coda` | unchanged ✅ |
| TTS language | `RIME_LANGUAGE=eng` (fixed at boot) | dynamic per turn |
| TTS speaker | `celeste` (fixed at boot) | dynamic per turn, from a lang→speaker map |

### 2.2 STT — enable detection

`apps/agent/src/main.ts:126`:

```ts
stt: new inference.STT({
  model: 'assemblyai/universal-3-5-pro',
  language: 'multi',          // was 'en'
  // keyterms_prompt — see §3.5, do this at the same time
}),
```

`STTLanguages` in the installed SDK
(`@livekit/agents/dist/inference/stt.d.ts:163`) is:
`'multi' | 'en' | 'de' | 'es' | 'fr' | 'ja' | 'pt' | 'zh' | 'hi' | AnyString`.
The SDK also accepts a combined form: `'assemblyai/universal-3-5-pro:multi'`.

**Where the detected language arrives:** `UserInputTranscribedEvent` already carries it —
`events.d.ts:64`, `language: LanguageCode | null`. No extra plumbing.

```ts
session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
  if (!ev.isFinal) return;
  if (ev.language) languageRouter.observe(ev.language);   // new
  // ... existing fence logic (see TECHNICAL_REVIEW.md B1 — fix that first)
});
```

### 2.3 TTS — the speaker map

Build a static map from Rime's machine-readable voice catalogs:

- `/data/voices/all-v2.json` — voice names by model and language
- `/data/voices/voice_details.json` — demographics and metadata per voice

Generate `apps/agent/src/voices.ts` once, commit it, do not fetch at runtime:

```ts
// lang code (Rime 3-letter) -> Coda speaker
export const SPEAKER_BY_LANG: Record<string, string> = {
  eng: 'celeste',
  hin: '<hindi coda voice>',
  spa: '<spanish coda voice>',
  // ... only the languages you actually test
};

// STT reports 2-letter; Rime plugin wants 3-letter
export const TWO_TO_THREE: Record<string, string> = {
  en: 'eng', hi: 'hin', es: 'spa', fr: 'fra',
  de: 'ger', it: 'ita', ja: 'jpn', pt: 'por', ar: 'ara',
};
```

> **Pick voices for timbre continuity, not at random.** Use `voice_details.json` demographics to
> choose speakers with similar age/gender/register across languages. The agent will still sound
> like a different person when it switches — that is unavoidable, since no Coda voice crosses
> languages — but matched demographics make it read as *the same character speaking another
> language* rather than a handoff to a stranger. **This directly trades against the PS's
> "Expressive and persistent voice identity" direction. Name the trade-off in the README rather
> than letting a judge find it.**

### 2.4 Runtime switching — the mechanism

The Rime plugin exposes `updateOptions(opts: Partial<TTSOptions>)`
(`agents-plugin-rime/dist/tts.d.ts`), and both `speaker` and `lang` are in `TTSOptions`.
`lang` reaches the wire: `modelParams()` sets it unconditionally (`tts.js:49`) and `wsUrl()`
spreads `modelParams` into the WebSocket query string (`tts.js:117`).

```ts
function applyLanguage(tts: rime.TTS, lang3: string) {
  const speaker = SPEAKER_BY_LANG[lang3];
  if (!speaker) return;                 // unsupported → stay on current language
  tts.updateOptions({ lang: lang3, speaker });
}
```

**Three implementation warnings.**

1. **`updateOptions` only merges options — it does not tear down a live WebSocket.**
   `tts.js:179-182` is a plain object merge. The WS URL is built once per connection with the
   speaker and lang baked into the query string. **Switch only between turns, never mid-utterance**,
   and verify the plugin opens a fresh connection for the next `SynthesizeStream`. If it pools the
   connection, you will need to construct a new `rime.TTS` instance per language instead — test
   this explicitly, it is the highest-risk unknown in §2.
2. **Hysteresis.** Do not switch on a single transcript. One misdetected turn should not flip the
   agent's voice. Require two consecutive turns in the new language, or a confidence threshold,
   before switching. A voice that flickers between languages is worse than one that is
   occasionally in the wrong language.
3. **Unsupported languages degrade, never fail.** If detection returns a language with no Coda
   speaker, keep the current voice and have the agent say — in the current language — that it will
   continue in that language. Silence or a crash is a demo-ender.

### 2.5 What multilingual breaks in the commit gate

**This is the part that is actual engineering rather than configuration, and it is what will
distinguish this from a config-change submission.**

**(a) Sentence segmentation is punctuation-based and Latin-biased.**
`DeliveryTracker` (`core/delivery.ts`) counts sentences to decide what has been delivered.
Non-Latin scripts do not use `.` `?` `!`:

| Language | Sentence terminator |
|---|---|
| Hindi | `।` (danda) |
| Japanese | `。` |
| Arabic | `؟` `،` and RTL ordering |
| Chinese | `。` `？` |

If the splitter only knows Latin punctuation, **`sentenceCount` never increments and nothing ever
commits.** Extend the terminator set in `DeliveryTracker` and add a unit test per script. This is
a one-line fix with a test, and it is the single most likely silent failure.

**(b) The anchor-phrase guard will mismatch on every commit.**
`commit-gate.ts:180` does `heard.includes(item.anchorPhrase.toLowerCase())`. The anchor is the
component label the tool was called with; `heard` is what was actually spoken. In Hindi narration
the surrounding sentence is Hindi but the component name is a loanword — "Redis" is "Redis"
everywhere — so this *mostly* survives. It breaks when:

- the model translates the label ("gateway" → "गेटवे"), or
- the label is transliterated into Devanagari.

**Mitigation:** instruct the model in `PERSONA` to keep component names in their original Latin
form even when narrating in another language. This is also correct product behaviour — engineers
say "Redis", not a translation, in every language. Then the anchor guard keeps working unchanged.

**(c) Node labels stay canonical.** Whatever language is spoken, the canvas keeps English/Latin
component names. This is not a compromise — it is how engineers actually write diagrams — and it
keeps (b) true and the oracle unchanged.

### 2.6 Code-switching — what is actually possible

Be precise here, because the PS names code-switching and it is easy to overclaim.

| Direction | Capable? | Why |
|---|---|---|
| **Understanding** mixed-language input ("add a Redis cache yahan pe") | **Yes** | `universal-3-5-pro` does native mid-sentence code-switching. |
| **Speaking** a mixed-language reply | **No** | One Rime request = one speaker = one language. There is no way to switch voice mid-utterance. |

**The honest design:** detect the *dominant* language of the turn, reply wholly in that language,
and keep technical nouns in Latin script (which is what a bilingual engineer does anyway — Hinglish
technical speech is Hindi grammar with English nouns). Document the asymmetry:

> *Cartograph understands code-switched speech but replies in a single language per turn, because
> a Rime request binds one speaker to one language and no Coda voice crosses languages.*

That sentence is a better answer than a vague claim of "multilingual support," and it is exactly
the kind of deliberate model/voice/language reasoning the PS asks for.

### 2.7 Scope recommendation

**Ship two languages: English and Hindi.** Not nine.

- Hindi is on Coda, is authentic to the team, and is far more memorable to a judge than another
  European language.
- Two languages is enough to prove the whole mechanism — detection, switching, hysteresis,
  segmentation, anchor handling.
- Nine languages means nine untested speakers and nine untested segmentation paths.

Write the map so adding a language is one line, list the 9 supported ones in the README, and state
that **two are tested**. Untested breadth is a liability; tested narrowness with a documented
extension path is not.

**Degraded mode**, if §0's spike fails: run multilingual on the *ungated* path only — the agent
speaks the detected language, but canvas commits fall back to `onTurnComplete` granularity instead
of per-sentence. Disclose it as a measured limitation.

### 2.8 README disclosure becomes a matrix

PS p.2 requires the exact model ID, speaker, language, endpoint, audio format, and transport.
Replace the single row with:

| Language | Rime model | Speaker | `lang` | Timestamps verified | Tested |
|---|---|---|---|---|---|
| English | coda | celeste | eng | yes | yes |
| Hindi | coda | *(chosen)* | hin | *(from §0 spike)* | yes |
| Spanish / French / … | coda | mapped | … | not verified | no |

---

## 3. Pronunciation

### 3.1 What is actually available on Coda

| Lever | Coda | Note |
|---|---|---|
| `spell()` for identifiers | **Yes** | Per the models table. The text-normalization page contradicts this — **test it and report what you find** (§3.6). |
| Inline phonemes (`phonemizeBetweenBrackets`) | **No** | Mist v2 only — and Mist v2 has no word timestamps, so it is unusable here. |
| `inlineSpeedAlpha` (slow selected words) | **No** | Mist family only. This is the PS's *"slow selected words and phrases"* lever — **it does not exist on your model.** Say so. |
| `timeScaleFactor` (whole utterance) | **Yes** | `<1.0` faster, `>1.0` slower. Your `tts.ts` comment already has this right. |
| `pauseBetweenBrackets` | Yes | Exposed in `TTSOptions`. |
| `noTextNormalization` | Yes | Exposed in `TTSOptions`. |
| `saveOovs` | Yes | **Exposed and unused.** See §3.6. |
| `/textnorm` endpoint | Yes | Verify normalization before shipping. |
| Dictionary submission | Yes | Via Rime, for the top few offenders. |

**Consequence:** with inline phonemes and inline speed both unavailable, **respelling the text you
send is your main lever.** §3.2 is how to do it without breaking anything.

### 3.2 The pronunciation lexicon — apply it at the `ttsNode` tap

Do **not** put respellings in the LLM prompt. That pollutes the transcript, the ledger, the canvas
labels, and the anchor guard.

`CanvasAgent` already taps the text on its way *into* the TTS (`canvas-agent.ts`, the `ttsNode`
override that currently feeds `commitGate.onGeneratedChunk`). **That tap is exactly the right
place** — it sits after the model has produced correct text and before Rime sees it.

```ts
// apps/agent/src/tts/lexicon.ts
export const LEXICON: Array<[RegExp, string]> = [
  [/\bnginx\b/gi,      'engine ex'],
  [/\bk8s\b/gi,        'Kubernetes'],
  [/\bPostgreSQL\b/gi, 'Postgres Q L'],
  [/\betcd\b/gi,       'et see dee'],
  [/\bgRPC\b/gi,       'gee RPC'],
  [/\bJWT\b/gi,        'spell(JWT)'],
  [/\bS3\b/gi,         'S three'],
  [/\bIAM\b/gi,        'spell(IAM)'],
  // ... populated from the saveOovs run in §3.6, not guessed
];

export function applyLexicon(text: string): string {
  return LEXICON.reduce((s, [re, sub]) => s.replace(re, sub), text);
}
```

Applied only on the TTS-bound branch. The transcript, the canvas, and the ledger keep the correct
spelling.

**Streaming caveat:** the tap sees *chunks*, not whole sentences. A term can be split across chunk
boundaries ("ngi" + "nx"), and a naive per-chunk regex will miss it. Buffer to sentence boundaries
before applying the lexicon, then release — the commit gate already thinks in sentences, so this
aligns with the existing model rather than fighting it.

### 3.3 The anchor-guard interaction — do not miss this

`commit-gate.ts:180` checks `heard.includes(anchorPhrase)`. `heard` derives from the words Rime
actually spoke — i.e. **post-lexicon text**. So respelling `nginx` → `engine ex` makes the anchor
`"nginx"` stop matching, and **every commit gets flagged `anchor_mismatch` in the ledger the demo
reads from.**

Fix: normalise both sides through the same lexicon before comparing.

```ts
const heardNorm  = applyLexicon(this.tracker.deliveredText).toLowerCase();
const anchorNorm = applyLexicon(item.anchorPhrase).toLowerCase();
const matched    = heardNorm.includes(anchorNorm);
```

Add a unit test: a component named `nginx` commits **without** an `anchor_mismatch` flag.

### 3.4 Rewrite the persona's pronunciation rule

`agent.ts` currently says:

> `- Avoid acronyms and words with unclear pronunciation, when possible.`

**This is exactly backwards for this product.** The entire vocabulary of system architecture is
acronyms and unclear words. You cannot build a diagramming tool that avoids saying "nginx". Delete
that line and apply Rime's own *writing for the ear* guidance instead:

- Sentences **under 15 words** — already aligned with the one-change-per-sentence rule.
- Punctuation is prosody: commas = short pause + slight pitch rise; periods = falling pitch;
  ellipses sparingly.
- Contractions ("I'll", "we're"); drop formal connectors ("furthermore", "additionally").
- Light disfluencies are permitted but **never stacked** — no two fillers in a row.
- Numbers: expand bare dates and month-year forms; add minutes to bare hours.
- **Show examples in the prompt rather than stating rules** — the guide is explicit that the model
  imitates examples better than it follows instructions. Put two or three model narration sentences
  in `PERSONA` verbatim.
- Keep component names in Latin script when narrating in another language (§2.5b).

### 3.5 The mirror problem — recognition, not just synthesis

Pronunciation cuts both ways: AssemblyAI has to *recognise* "nginx" and "etcd" too, or the tool
gets called with a garbage label and the diagram is wrong before Rime is ever involved.

The installed SDK exposes `keyterms_prompt?: string[]` on `AssemblyAIOptions`
(`inference/stt.d.ts:83`). Feed it the same term list as the lexicon:

```ts
stt: new inference.STT({
  model: 'assemblyai/universal-3-5-pro',
  language: 'multi',
  keyterms_prompt: INFRA_TERMS,   // same source list as LEXICON
}),
```

There is also `agent_context` (max 1500 chars, `u3-rt-pro` only) for biasing recognition with live
context — the current `canvas.summary()` would be the natural payload if you ever move to that
model. Worth one line in the README as a considered-and-rejected option.

### 3.6 The evidence harness

This is what turns pronunciation work into marks. The PS asks for *"representative fixtures and
before-and-after evidence"* and *"rendering alternatives and listening."*

**Step 1 — discover, don't guess.** Turn on `saveOovs: true` in the Rime TTS options, run a full
architecture session, and collect the out-of-vocabulary words. **That output is your fixture
list.** Guessing which terms are broken is exactly the unevidenced approach the PS penalises.

**Step 2 — build the fixture.** ~40 terms in
`apps/agent/src/bench/pronunciation/terms.json`, each with a raw form and one or more candidate
respellings.

**Step 3 — render through the shipped path.** `TTS_PROVIDER=rime-plugin`, `coda`, the production
speaker, WebSocket transport. Hold model and voice constant. Render **at least two variants per
term**. Save the clips into the repo.

**Step 4 — verify normalization separately.** POST the tricky strings to `/textnorm` and record
what Rime says it will read. This isolates "normalization mangled it" from "synthesis mangled it" —
a distinction that reads as real diagnostic work.

**Step 5 — write it up** in `RIME_EVIDENCE.md`: a table of term → raw rendering → chosen respelling
→ which one won and why. Include the terms you could **not** fix, and note that inline phonemes
were unavailable because Coda does not support them and Mist v2 would have cost the word timestamps
the commit gate depends on.

**Step 6 — make it a command.** `pnpm --filter DD_agent pronunciation` regenerates every clip. The
PS asks for a repeatable command, script, or fixture wherever practical.

---

## 4. Configuration changes

`.env.example` — placeholders only, per the PS's configuration-hygiene requirement:

```bash
RIME_MODEL=coda                 # unchanged — required for word timestamps
RIME_VOICE=celeste              # now the DEFAULT/fallback voice, not the only one
RIME_LANGUAGE=eng               # now the DEFAULT/fallback language
RIME_MULTILINGUAL=true          # new: enable detection + switching
RIME_SAVE_OOVS=false            # new: on for pronunciation harness runs
STT_LANGUAGE=multi              # new: was hardcoded 'en'
```

Keep `TTS_PROVIDER=rime-plugin` as the judged path. Note in the README that the Inference gateway
fallback (`TTS_PROVIDER=rime`) has **no** word timestamps and therefore no per-sentence commits —
that is already documented and stays true.

---

## 5. Task list

**Gate**

- [ ] §0 spike — Hindi word timestamps over the WebSocket path. **Blocks everything below.**

**Multilingual**

- [ ] Generate `voices.ts` from `all-v2.json` + `voice_details.json`; pick Hindi voice on matched demographics
- [ ] `STT language: 'multi'`; read `ev.language` in `UserInputTranscribed`
- [ ] `LanguageRouter` with two-turn hysteresis
- [ ] `applyLanguage()` via `tts.updateOptions({ lang, speaker })`, between turns only
- [ ] **Verify the plugin opens a fresh WS on switch** — fall back to a per-language TTS instance if not
- [ ] Extend `DeliveryTracker` sentence terminators: `।` `。` `？` `！` `؟`; one unit test per script
- [ ] `PERSONA`: keep component names in Latin script when narrating in another language
- [ ] Graceful degrade for unsupported languages
- [ ] README disclosure matrix (§2.8)

**Pronunciation**

- [ ] `saveOovs` run → fixture list
- [ ] `lexicon.ts` + sentence-buffered application at the `ttsNode` tap
- [ ] **Normalise both sides of the anchor check** through the lexicon + regression test
- [ ] Replace the "avoid acronyms" persona line with writing-for-the-ear rules and worked examples
- [ ] `keyterms_prompt` on the STT with the same term list
- [ ] `/textnorm` verification pass
- [ ] `pnpm pronunciation` harness + clips + `RIME_EVIDENCE.md` table

---

## 6. Focus warning — read before starting

The PS is explicit: *"A focused product with one convincingly solved voice problem is stronger than
a broad assistant with many shallow features."*

Counting what is now in play: interruption/heard-state consistency, addressivity, pronunciation,
multilingual. **That is four directions.** Three of them can be told as one story; the fourth is
the odd one out.

- **Pronunciation belongs.** If the user heard "en-jinx" and the node reads "nginx", the state
  matches the transcript but not the user's understanding. Pronunciation correctness is a
  *precondition* for the heard-state claim to mean anything. Same claim, hardened.
- **Addressivity belongs.** It protects the same invariant from speech that was never meant for
  the agent.
- **Multilingual is genuinely additive.** It does not make the heard-state claim stronger. It
  broadens the audience. It also carries the only risk on this list that can break the core
  mechanism outright (§0).

**Recommendation:** do the §0 spike and the pronunciation work regardless — pronunciation is
cheap, on-thesis, and closes half of a 20% criterion. Treat multilingual as **scoped to
English + Hindi and cut first** if the schedule tightens. If it ships, present it as one sentence
inside the existing claim rather than as a separate feature:

> *The canvas shows exactly what was heard in the room — in whichever of the room's languages it
> was heard.*

If that sentence cannot be said naturally in the demo, cut multilingual and spend the time on
evidence instead.

---

## Sources

Verified against the installed SDK at `node_modules` (paths cited inline) and:

- [Rime — models](https://docs.rime.ai/docs/models) · [voices](https://docs.rime.ai/docs/voices) · [speed](https://docs.rime.ai/docs/speed) · [text normalization](https://docs.rime.ai/docs/text-normalization)
- [Rime — prompting / writing for the ear](https://docs.rime.ai/docs/prompting)
- [Rime — Coda WebSocket API](https://docs.rime.ai/api-reference/coda/websocket)
- [AssemblyAI — multilingual streaming](https://www.assemblyai.com/docs/streaming/universal-streaming/multilingual-transcription)
- [LiveKit — Rime plugin](https://docs.livekit.io/agents/models/tts/plugins/rime/)
