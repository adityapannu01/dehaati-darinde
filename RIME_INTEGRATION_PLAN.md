# Rime TTS Integration Plan — `dehaati-darinde`

**Audience:** a coding agent (Claude Sonnet) implementing this end to end.
**Written:** 2026-09-03. **Verified against:** `@livekit/agents@1.7.1`, `@livekit/agents-plugin-rime@1.7.1`, installed and typechecked in a scratch copy of this repo.

> **Rule for the implementing agent:** LiveKit's SDK moves fast. Everything in the "Ground truth" section below was read out of the *installed package source*, not from memory. If you need an API that is *not* listed here, verify it with `lk docs search` / the LiveKit docs MCP (`https://docs.livekit.io/mcp`) before writing code. Do not invent option names.

---

## 0. What this repo is (one paragraph)

A pnpm + Turborepo monorepo with two runnable apps:

- **`apps/agent`** (`DD_agent`) — a Node.js **LiveKit Agents worker**. It is a long-lived background process that logs into LiveKit Cloud and waits to be assigned to rooms. When assigned, it runs a voice pipeline: STT → LLM → TTS, plus turn detection and noise cancellation. Entry point `src/main.ts`; the agent's persona/instructions live in `src/agent.ts`.
- **`apps/web`** — a Next.js 15 frontend. It mints a LiveKit access token at `POST /api/token`, connects the browser to a LiveKit room, and requests that `DD_agent` be dispatched into that room. UI is LiveKit's "Agents UI" shadcn components.

Shared: `packages/logger` (`@repo/logger`), `packages/config-typescript`, `packages/config-eslint`.

The two apps never talk to each other directly. They meet inside a **LiveKit room** in the cloud. Audio flows browser → LiveKit SFU → agent worker → LiveKit SFU → browser.

**The task:** replace / make swappable the TTS half of that pipeline so the agent speaks with **Rime** instead of Fish Audio.

---

## 1. Ground truth (verified — do not re-derive)

### 1.1 Current pipeline (`apps/agent/src/main.ts`)

| Stage | Current value |
|---|---|
| STT | `inference.STT({ model: 'assemblyai/universal-3-5-pro', language: 'en' })` |
| LLM | `inference.LLM({ model: 'google/gemma-4-31b-it' })` (in `src/agent.ts`) |
| **TTS** | `inference.TTS({ model: 'fishaudio/s2.1-pro', voice: 'fa4c9eb3dccc4806b382b40d61c6b10a' })` |
| Turn detection | `inference.TurnDetector()`, `interruption: { mode: 'adaptive' }`, `preemptiveGeneration: { enabled: true }` |
| Noise cancellation | `audioEnhancement({ model: 'quailVfS' })` from `@livekit/plugins-ai-coustics` |
| **`expressive`** | **`true`** ← this is the landmine, see §1.4 |

Everything goes through **LiveKit Inference**: models are billed through the LiveKit Cloud account and need no per-provider API key. The only secrets today are `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`.

### 1.2 Two ways to use Rime

**Path A — LiveKit Inference gateway (recommended default).**

```ts
import { inference } from '@livekit/agents';

new inference.TTS({
  model: 'rime/coda',          // 'rime/coda' | 'rime/mistv2' | 'rime/mistv3' | 'rime/mist'
  voice: 'celeste',
  language: 'en',
  modelOptions: { speed_alpha: 1.0 },      // Rime-specific, typed as RimeOptions
  fallback: [{ model: 'rime/mistv3', voice: 'celeste' }],  // optional server-side failover
});
```

`modelOptions` for Rime is typed as `RimeOptions` and accepts exactly:
`max_tokens`, `time_scale_factor`, `speed_alpha`, `pause_between_brackets`, `phonemize_between_brackets`, `inline_speed_alpha`, `no_text_normalization`.

There is also a string shorthand accepted by `AgentSession`/`Agent`: `tts: 'rime/coda:celeste'` (type `TTS | TTSModelString | null`). Fine for a spike; prefer the object form so options are expressible.

- No `RIME_API_KEY`. No new dependency. Billing/rate limits stay on LiveKit Cloud.
- Aligned (word-level) transcripts are opt-in per provider via `modelOptions` and Rime exposes **no timestamp flag** in `RimeOptions` — assume **no aligned transcript** on this path.

**Path B — direct Rime plugin.**

```bash
pnpm --filter DD_agent add @livekit/agents-plugin-rime
```

```ts
import * as rime from '@livekit/agents-plugin-rime';

new rime.TTS({
  modelId: 'coda',        // TTSModels = 'coda' | 'mistv2' | 'mistv3'
  speaker: 'celeste',
  lang: 'eng',            // DefaultLanguages = 'eng' | 'spa' | 'fra' | 'ger' (3-letter!)
  useWebsocket: true,     // see below — you almost always want this
  timeScaleFactor: 1.0,
});
```

Full `TTSOptions` (from `dist/tts.d.ts`): `speaker`, `modelId`, `baseURL`, `apiKey`, `useWebsocket`, `segment`, `tokenizer`, `lang`, `repetition_penalty`, `temperature`, `top_p`, `max_tokens`, `samplingRate`, `timeScaleFactor`, `speedAlpha`, `reduceLatency`, `pauseBetweenBrackets`, `phonemizeBetweenBrackets`, `inlineSpeedAlpha`, `noTextNormalization`, `saveOovs`, plus an index signature for arbitrary Rime params.

Verified behaviours of the plugin (read from source):

- Constructor **throws** `'RIME API key is required, whether as an argument or as $RIME_API_KEY'` if neither `opts.apiKey` nor `process.env.RIME_API_KEY` is set. This throws at module/session construction time, so a missing key is a hard boot failure, not a runtime degradation.
- `useWebsocket: true` sets capabilities `{ streaming: true, alignedTranscript: true }`. `useWebsocket: false` (the default) sets both to `false` → non-streaming chunked synthesis → materially worse time-to-first-audio. **Always set `useWebsocket: true` for a live voice agent.**
- Endpoints: HTTP `https://users.rime.ai/v1/rime-tts`, WebSocket `wss://users-ws.rime.ai/ws3?...`.
- Sample rate: `coda` → 24000 Hz, `mistv2` → 16000 Hz, anything else → 24000 Hz. Override with `samplingRate`.
- `modelId: 'mistv2'` + `timeScaleFactor` **throws** `'timeScaleFactor is not supported by the mistv2 model; use mistv3 or coda.'`
- `modelId: 'arcana'` logs a warning: Arcana is retired, use `coda`.
- Option routing is model-aware: `coda` forwards `repetition_penalty`/`temperature`/`top_p`/`max_tokens`/`timeScaleFactor`; `mist*` forwards `speedAlpha`/`pauseBetweenBrackets`/`phonemizeBetweenBrackets` (and `timeScaleFactor` for non-mistv2). **`speedAlpha` is silently dropped on `coda`** — use `timeScaleFactor` there instead.
- Default speaker resolution: `new rime.TTS({})` → `speaker: 'luna'`; `new rime.TTS({ modelId: 'coda' })` → `speaker: 'lyra'`. Always pass `speaker` explicitly.

### 1.3 Version lockstep (important)

`@livekit/agents-plugin-rime@1.7.1` declares an **exact** peer dependency `"@livekit/agents": "1.7.1"`. This repo's `apps/agent/package.json` says `^1.6.3`, and the lockfile currently resolves it to **1.7.1**, so they match today. If either is bumped independently the install will complain. Treat `@livekit/agents` and `@livekit/agents-plugin-rime` as a version pair and bump them together.

(Verified: `pnpm --filter DD_agent add @livekit/agents-plugin-rime` installs 1.7.1 cleanly and `tsc --noEmit` passes.)

### 1.4 `expressive: true` does NOT work with Rime — this is the single biggest gotcha

`main.ts` currently sets `expressive: true`. Expressive mode injects a provider-specific markup guide into the LLM prompt so the model emits inline delivery tags (`<expr type="sound" label="laugh"/>` etc.) that the TTS renders and the transcript strips.

Verified from the SDK source (`dist/tts/provider_format.js` + `dist/voice/agent_activity.d.ts`):

- Markup dialects exist for exactly four providers: **`cartesia`, `fishaudio`, `inworld`, `xai`**.
- The SDK's own doc comment names Rime explicitly: *"gateway providers without one (e.g. `rime`, `deepgram`) get no markup instructions, so no tags can appear in the stream"*.
- Expressive also requires `inference.TTS` — with a direct plugin (Path B) it is disabled regardless.

**Therefore: when the TTS is Rime, `expressive` must be `false`.** It will not error, it will silently do nothing, and leaving it `true` is misleading. Wire `expressive` to the selected provider (§4.3) rather than hardcoding it.

Also update `apps/agent/README.md`, which currently claims expressive mode is on by default and that Fish Audio is the TTS.

### 1.5 Rime models & voices (from Rime's docs)

| Model | Plugin `modelId` | Inference `model` | Languages | Notes |
|---|---|---|---|---|
| Coda (flagship, May 2026) | `coda` | `rime/coda` | en, es, fr, de, hi, it, ja, ar, pt | 253 voices, sub-100 ms model latency, word-level timestamps, `spell()` |
| Mist v3 | `mistv3` | `rime/mistv3` | en, es, fr, de | 78 voices, ~37 ms P50 TTFA — the latency pick |
| Mist v2 | `mistv2` | `rime/mistv2` | en, es, fr, de | 138 voices, only model with inline phoneme control (`phonemizeBetweenBrackets`) |
| Mist v1 | — | `rime/mist` | en | deprecated, do not use |

Known-good voice names: `astra`, `luna`, `celeste`, `lyra`, `cove`, `masonry`, `albion`, `lawton`. The full catalogue is in the Rime dashboard / docs — **do not hardcode a voice you have not confirmed exists**; a bad speaker name fails at synthesis time, mid-call.

**Recommended default: `coda` + `celeste`.** Fall back to `mistv3` if TTFA matters more than quality.

### 1.6 Where to get a Rime API key (Path B only)

`https://rime.ai` → dashboard → API keys. Set `RIME_API_KEY` in `apps/agent/.env.local`. Never commit it (`.env.local` is already gitignored).

---

## 2. Pre-existing repo problems (fix in Phase 0 — these are NOT caused by Rime)

All four were reproduced by installing this repo from a clean checkout and running the scripts.

| # | Problem | Symptom | Fix |
|---|---|---|---|
| 1 | `packages/logger/tsconfig.json` has `"types": ["jest", "node"]` but `@types/jest` is not installed (leftover from the `create-turbo` kitchen-sink starter) | `pnpm check-types` fails: `error TS2688: Cannot find type definition file for 'jest'` | Change to `"types": ["node"]` |
| 2 | `apps/web` declares `"@livekit/protocol": "^1.41.0"` → resolves 1.51.0, but `livekit-server-sdk` pins **exactly** `1.48.0`. Two copies in the tree → nominal type mismatch | `app/api/token/route.ts(97,5): error TS2322: RoomConfiguration is not assignable to RoomConfiguration` | Pin `"@livekit/protocol": "1.48.0"` in `apps/web/package.json` (verified fix), or add a root `pnpm.overrides` entry |
| 3 | `components/app/view-controller.tsx` — `VIEW_MOTION_PROPS.transition.ease` widens to `string`, which `motion` rejects | 2 × `error TS2322 ... Type 'string' is not assignable to type 'Easing'` | `ease: 'linear' as const` (verified fix) — or `satisfies Transition` on the whole object |
| 4 | `pnpm-lock.yaml` is stale: it still contains importers for `apps/admin`, `apps/api`, `apps/blog`, `apps/storefront`, `packages/jest-presets`, `packages/ui`, none of which exist | `pnpm install --frozen-lockfile` (CI default) will fail | Run `pnpm install --no-frozen-lockfile` once and commit the regenerated lockfile |

After fixes 1–3, `pnpm check-types` passes across all four workspace projects (verified).

**Known and deliberately left alone (non-blocking):**

- `pnpm lint` fails in `apps/web`: `ESLint configuration ... plugin:@next/next/recommended is invalid: Unexpected top-level property "name"`. This is an upstream incompatibility between `eslint-config-next` (any 15.5.x) consumed through `@eslint/eslintrc`'s `FlatCompat` and ESLint 9. Bumping `eslint-config-next` to 15.5.18 and `@eslint/eslintrc` to 3.3.7 does **not** fix it. `apps/web` also has *both* a legacy `.eslintrc.json` and a flat `eslint.config.mjs`, which is its own confusion — delete `.eslintrc.json` and switch the script from `next lint` (deprecated in Next 16) to `eslint .` when someone gets to it. Not required for Rime.
- `apps/agent/Dockerfile` was written for the *standalone* agent starter: it does `COPY package.json pnpm-lock.yaml ./` then `pnpm install --frozen-lockfile` from `apps/agent`, but in this monorepo the lockfile lives at the repo root and `@repo/logger` is a `workspace:*` link. **The Dockerfile will not build as-is.** See Phase 7.
- `node src/main.ts dev` prints `dev mode is deprecated and will be removed in a future release; use 'lk agent dev' instead`. Cosmetic for now.

---

## 3. Decision: which path to implement

**Implement both, behind one switch.** Path A is the default; Path B is opt-in.

Rationale: Path A ships in a two-line diff with no new key and no new dependency, which makes it the right *default*. But Path B is the only way to get WebSocket streaming with word-level timestamps, per-request Rime parameters, and Rime-side billing/rate-limit control — and that is exactly the reason someone chooses Rime deliberately. Building the switch once (Phase 2) costs ~40 lines and removes the need to ever re-plumb this.

The switch is an env var, not a code edit, so it can be flipped in deployment without a rebuild.

---

## 4. Implementation phases

Each phase is independently committable and independently verifiable. Do them in order.

### Phase 0 — Get a green baseline (do NOT skip)

Do not touch TTS until the repo builds and the current Fish Audio agent talks.

1. Node **≥ 22.18** required (`apps/agent/.nvmrc` says 24 — prefer 24). The agent runs `node src/main.ts` and relies on Node's **native TypeScript type stripping**; `apps/agent/tsconfig.json` sets `erasableSyntaxOnly: true` and `allowImportingTsExtensions: true` to keep that legal. **Consequence: never add a TS `enum`, `namespace`, or constructor parameter property to `apps/agent/src` — Node cannot strip those and the agent will fail to boot.** Also: every relative import inside `src/` must carry the explicit `.ts` extension (see `import { createAgent } from './agent.ts'`).
2. `corepack enable && corepack prepare pnpm@8.15.6 --activate` (the root `package.json` pins `packageManager: pnpm@8.15.6`).
3. `pnpm install --no-frozen-lockfile` at the repo root. Commit the regenerated `pnpm-lock.yaml`.
4. Apply repo fixes 1–3 from §2. Verify: `pnpm check-types` → 4/4 tasks pass.
5. Credentials — needed by **both** apps:
   ```bash
   cp apps/agent/.env.example apps/agent/.env.local
   cp apps/web/.env.example  apps/web/.env.local
   ```
   Fill `LIVEKIT_URL` (`wss://<project>.livekit.cloud`), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` in **both**. Get them from https://cloud.livekit.io, or automatically:
   ```bash
   lk cloud auth
   lk app env -w -d apps/agent/.env.local
   ```
   Keep `AGENT_NAME=DD_agent` identical in both files — the frontend asks LiveKit to dispatch an agent *by that name* (`app-config.ts` → `agentName` → `room_config.agents[].agent_name` in `/api/token`). A mismatch produces a room where nothing ever joins and no error is shown.
6. Run: `pnpm dev` from the repo root runs both (turbo `dev` is `persistent`, `dependsOn: ["^build"]`, so `@repo/logger` is built first). Or separately: `pnpm dev:agent` / `pnpm dev:web`.
7. Open http://localhost:3000, click **Start call**, confirm the agent greets you in the Fish Audio voice. **This is the baseline.** If it does not work here, Rime will not fix it.

> Note on `/api/token`: it hard-throws unless `NODE_ENV !== 'production'` or `IS_VERCEL_PREVIEW === 'true'`. It is deliberately unauthenticated and dev-only. Do not deploy it as-is.

**Exit criteria:** `pnpm check-types` green; browser ↔ agent voice conversation works.

---

### Phase 1 — Config surface (no behaviour change)

Introduce the knobs before the code that reads them, so every later phase is a pure edit.

**`apps/agent/.env.example`** — append:

```bash
# --- TTS provider selection ---
# 'rime'       -> Rime via LiveKit Inference (default, no extra key)
# 'rime-plugin'-> Rime via the direct plugin (requires RIME_API_KEY)
# 'fishaudio'  -> previous default, keeps expressive mode
TTS_PROVIDER=rime

# Rime voice/model (applies to both Rime paths)
RIME_MODEL=coda
RIME_VOICE=celeste
RIME_LANGUAGE=en

# Only needed when TTS_PROVIDER=rime-plugin
RIME_API_KEY=
```

Do **not** create `.env.local` in the repo — it is gitignored; instruct the human to fill it.

**Exit criteria:** file committed; nothing else changed.

---

### Phase 2 — The TTS factory (new file, still not wired in)

Create **`apps/agent/src/tts.ts`**. This is the whole point of the plan: one place that owns "which voice engine, with what settings", so `main.ts` stays about pipeline shape.

```ts
import { type tts as ttsTypes, inference } from '@livekit/agents';
import * as rime from '@livekit/agents-plugin-rime';

export type TTSProviderName = 'rime' | 'rime-plugin' | 'fishaudio';

export interface TTSSelection {
  tts: ttsTypes.TTS;
  /** Expressive markup only exists for cartesia/fishaudio/inworld/xai via inference.TTS. */
  supportsExpressive: boolean;
  describe: string;
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export function resolveTTSProvider(): TTSProviderName {
  const raw = env('TTS_PROVIDER', 'rime').toLowerCase();
  if (raw === 'rime' || raw === 'rime-plugin' || raw === 'fishaudio') return raw;
  throw new Error(
    `Unknown TTS_PROVIDER "${raw}". Expected one of: rime, rime-plugin, fishaudio.`,
  );
}

export function createTTS(provider: TTSProviderName = resolveTTSProvider()): TTSSelection {
  const voice = env('RIME_VOICE', 'celeste');
  const model = env('RIME_MODEL', 'coda');

  switch (provider) {
    case 'rime':
      return {
        tts: new inference.TTS({
          model: `rime/${model}`,
          voice,
          language: env('RIME_LANGUAGE', 'en'),
          // RimeOptions: max_tokens | time_scale_factor | speed_alpha |
          // pause_between_brackets | phonemize_between_brackets |
          // inline_speed_alpha | no_text_normalization
          modelOptions: { speed_alpha: 1.0 },
        }),
        supportsExpressive: false,
        describe: `LiveKit Inference rime/${model}:${voice}`,
      };

    case 'rime-plugin': {
      if (!process.env.RIME_API_KEY) {
        throw new Error('TTS_PROVIDER=rime-plugin requires RIME_API_KEY in apps/agent/.env.local');
      }
      return {
        tts: new rime.TTS({
          modelId: model,
          speaker: voice,
          // Plugin uses 3-letter codes: eng | spa | fra | ger
          lang: env('RIME_LANGUAGE', 'en') === 'en' ? 'eng' : env('RIME_LANGUAGE', 'eng'),
          // Required for streaming synthesis + word-level timestamps.
          useWebsocket: true,
          // NOTE: speedAlpha is ignored on coda; use timeScaleFactor there.
          ...(model === 'coda' ? { timeScaleFactor: 1.0 } : { speedAlpha: 1.0 }),
        }),
        supportsExpressive: false,
        describe: `Rime plugin ${model}:${voice} (ws)`,
      };
    }

    case 'fishaudio':
      return {
        tts: new inference.TTS({
          model: 'fishaudio/s2.1-pro',
          voice: env('FISHAUDIO_VOICE', 'fa4c9eb3dccc4806b382b40d61c6b10a'),
        }),
        supportsExpressive: true,
        describe: 'LiveKit Inference fishaudio/s2.1-pro',
      };
  }
}
```

Notes for the implementer:

- Return type `ttsTypes.TTS` is the base class both `inference.TTS` and `rime.TTS` extend — this is what makes the union assignable to `AgentSession.tts`. **Verified: this compiles.**
- The `RIME_LANGUAGE` mapping is deliberately crude because the two paths use different code systems (`en` vs `eng`). If you want more than English, build a real 2→3 letter map (`en→eng, es→spa, fr→fra, de→ger`) and throw on anything else, since the plugin's `DefaultLanguages` only covers those four.
- Install the dependency in this phase: `pnpm --filter DD_agent add @livekit/agents-plugin-rime`. Importing it is harmless when `TTS_PROVIDER` is not `rime-plugin` — the constructor (which throws on a missing key) only runs inside the `case`.

**Exit criteria:** `pnpm --filter DD_agent check-types` passes. Nothing at runtime has changed yet.

---

### Phase 3 — Wire the factory into the session

Edit **`apps/agent/src/main.ts`** only. Three changes:

```ts
import { createTTS } from './tts.ts';   // .ts extension is REQUIRED (Node type stripping)

// inside defineAgent({ entry: async (ctx) => { ... } })
const { tts, supportsExpressive, describe } = createTTS();
logger.info(`[DD_agent] TTS: ${describe}`);

const session = new voice.AgentSession({
  stt: new inference.STT({ model: 'assemblyai/universal-3-5-pro', language: 'en' }),
  tts,                                  // <- was inference.TTS({ fishaudio... })
  turnHandling: { /* unchanged */ },
  expressive: supportsExpressive,       // <- was hardcoded `true`
});
```

Delete the now-inaccurate `expressive: true` comment block and replace it with a short note pointing at §1.4 of this document.

Leave STT, LLM, turn detection, and `audioEnhancement` untouched. Rime changes the *output* half only.

**Exit criteria:**
- `TTS_PROVIDER=rime pnpm dev:agent` boots, logs `TTS: LiveKit Inference rime/coda:celeste`, and the browser hears a Rime voice.
- `TTS_PROVIDER=fishaudio` still reproduces the Phase 0 baseline exactly, expressive included. **This is the regression check — do not skip it.**

---

### Phase 4 — The plugin path

1. `RIME_API_KEY=...` in `apps/agent/.env.local`.
2. `TTS_PROVIDER=rime-plugin pnpm dev:agent`.
3. Verify in the logs that a **WebSocket** connection to `wss://users-ws.rime.ai/ws3?...` is opened (bump log level if needed — `initializeLogger({ pretty: true, level: 'debug' })` in a scratch run, or `LOG_LEVEL=debug`).
4. Compare perceived time-to-first-audio against Path A. Note the numbers in the PR description.
5. Sanity-check the guardrails: `modelId: 'mistv2'` + `timeScaleFactor` should throw at construction; a bogus `speaker` should fail at synthesis.

Only if TTFA on Path B is disappointing: try `modelId: 'mistv3'` (Rime's fastest), and confirm `useWebsocket` really is `true` (it defaults to `false`).

**Exit criteria:** both Rime paths produce audible speech; the difference between them is measured, not assumed.

---

### Phase 5 — Tests

`apps/agent/src/agent.test.ts` already exists and uses the LiveKit eval framework (`session.run({ userInput }).wait()` + `.judge(judgeLlm, { intent })`). Those tests construct `new voice.AgentSession()` with **no TTS**, so they are unaffected by this work and must keep passing.

Add **`apps/agent/src/tts.test.ts`** — pure unit tests over the factory, no network:

- `resolveTTSProvider()` defaults to `'rime'` when `TTS_PROVIDER` is unset or empty.
- `resolveTTSProvider()` throws a helpful error on an unknown value.
- `createTTS('rime')` returns `supportsExpressive: false` and a `tts` whose `.model` is `'rime/coda'` and `.provider` is `'rime'` (both are getters on `inference.TTS`).
- `createTTS('fishaudio')` returns `supportsExpressive: true`.
- `createTTS('rime-plugin')` throws when `RIME_API_KEY` is absent; with a dummy key set it returns a `rime.TTS` whose `.provider === 'Rime'` and `.model === 'coda'`.
- Guard test: `new rime.TTS({ modelId: 'mistv2', speaker: 'luna', timeScaleFactor: 1.1, apiKey: 'x' })` throws.

Save/restore `process.env` around each case. Run with `pnpm --filter DD_agent test` (vitest).

**Exit criteria:** `pnpm test` green at the repo root.

---

### Phase 6 — Frontend (optional, cosmetic)

`apps/web` never names the TTS provider, so nothing is *required*. Optional polish in `apps/web/app-config.ts`:

- `pageTitle` / `companyName` still say "LiveKit" / "DD_agent Voice Assistant".
- If Path A is used *without* aligned transcripts (§1.2), word-level transcript highlighting will be coarser than it was with Fish Audio. Do not chase this — it is a provider capability, not a bug.

**Do not** put `RIME_API_KEY` anywhere in `apps/web`. Any `NEXT_PUBLIC_*` variable is shipped to the browser. The frontend never talks to Rime.

---

### Phase 7 — Deployment

Two separate concerns:

1. **Env vars in production.** `TTS_PROVIDER`, `RIME_MODEL`, `RIME_VOICE`, `RIME_LANGUAGE`, and — only on Path B — `RIME_API_KEY` must be set wherever the worker runs (LiveKit Cloud agent secrets, or your container platform). `dotenv` only loads `.env.local`, which is not committed.
2. **The Dockerfile is currently broken for this monorepo** (see §2). It copies `package.json` + `pnpm-lock.yaml` from `apps/agent`, but the lockfile is at the repo root and `@repo/logger` is a workspace link. Before the first `lk agent deploy`, either:
   - build from the repo root with a monorepo-aware Dockerfile using `pnpm deploy --filter DD_agent --prod /out` (pnpm 8+) to produce a self-contained bundle, **or**
   - drop `@repo/logger` from `apps/agent` (it is ~15 lines of `console.*` wrappers) and inline it, which makes `apps/agent` self-contained and the existing Dockerfile correct.

   Pick one and say which in the PR. This is out of scope for "make it speak with Rime" but will bite on the first deploy.

Also note the Dockerfile pins `pnpm@10` while the repo pins `pnpm@8.15.6` — reconcile.

---

## 5. Final verification checklist

Run all of these before opening the PR:

- [ ] `pnpm install --no-frozen-lockfile` clean; regenerated `pnpm-lock.yaml` committed
- [ ] `pnpm check-types` — 4/4 pass
- [ ] `pnpm test` — agent evals + new TTS unit tests pass
- [ ] `TTS_PROVIDER=fishaudio` → identical to the Phase 0 baseline, expressive markup still active
- [ ] `TTS_PROVIDER=rime` → audible Rime voice; log line names the model and voice
- [ ] `TTS_PROVIDER=rime-plugin` → audible Rime voice over WebSocket
- [ ] `TTS_PROVIDER=nonsense` → clear startup error, not a stack trace deep in the SDK
- [ ] `apps/agent/README.md` no longer claims Fish Audio / expressive-by-default
- [ ] `RIME_API_KEY` appears only in `apps/agent/.env.example` (empty) — never in a committed `.env.local`, never in `apps/web`
- [ ] `git status` clean apart from intended files

## 6. Rollback

`TTS_PROVIDER=fishaudio` restores the original behaviour with no code change — that is the entire reason the `fishaudio` branch stays in the factory. Do not delete it.

## 7. Reference links

- Rime via LiveKit Inference — https://docs.livekit.io/agents/models/tts/rime/
- Rime plugin guide — https://docs.livekit.io/agents/models/tts/plugins/rime/
- Rime integration overview — https://docs.livekit.io/agents/integrations/rime/
- Node plugin API reference — https://docs.livekit.io/reference/agents-js/classes/plugins_agents_plugin_rime.TTS.html
- Expressive mode (and why Rime is excluded) — https://livekit.com/blog/making-voice-agents-sound-human-with-expressive-mode
- Rime models — https://docs.rime.ai/api-reference/models
- LiveKit docs MCP — https://docs.livekit.io/mcp
