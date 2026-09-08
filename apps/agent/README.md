<a href="https://livekit.io/">
  <img src="./.github/assets/livekit-mark.png" alt="LiveKit logo" width="100" height="100">
</a>

# DD_agent — Cartograph voice agent

The LiveKit Agents worker for **Cartograph**, a voice-commanded collaborative architecture canvas. See the [repo root README](../../README.md) for the full product disclosure (Rime config, architecture, benchmark, limitations); this file covers the underlying LiveKit Agents Node.js starter this worker is built on.

The starter project includes:

- A simple voice AI assistant, ready for extension and customization
- A voice AI pipeline built on [LiveKit Inference](https://docs.livekit.io/agents/models/inference), providing zero-configuration access to [models](https://docs.livekit.io/agents/models) from top labs
  - Uses the fast, open-weight Gemma 4 31B model, [hosted by LiveKit](https://docs.livekit.io/agents/models/llm/livekit/) and tuned for optimal performance in voice AI, as the default LLM
  - Uses Rime for TTS by default, over the direct WebSocket plugin (word-level timestamps, required by the commit gate); swap engines with the `TTS_PROVIDER` env var (`rime-plugin` | `rime` | `fishaudio`). See `src/tts.ts`
  - Supports more than 50 models from OpenAI, Cartesia, Deepgram, and other providers
  - Access to a wide range of other models, including [Realtime models](https://docs.livekit.io/agents/models/realtime), through extensive plugin ecosystem
- Expressive mode: when the selected TTS provider supports inline delivery markup (Fish Audio, Cartesia, Inworld, xAI via LiveKit Inference), the framework injects the provider's markup guide into the LLM prompt so the model emits inline delivery tags (emotion, pacing, non-verbal sounds) that the TTS renders and the transcript never shows. Rime does not support markup, so expressive mode is off when `TTS_PROVIDER` is `rime` or `rime-plugin`
- Eval suite based on the LiveKit Agents [testing & evaluation framework](https://docs.livekit.io/agents/start/testing)
- [LiveKit Turn Detector](https://docs.livekit.io/agents/logic/turns/turn-detector/), an end-of-turn model that listens to the user's audio directly, combining semantic understanding with acoustic cues for state-of-the-art accuracy across 14 languages
- [Background voice cancellation](https://docs.livekit.io/transport/media/noise-cancellation/)
- Deep session insights from LiveKit [Agent Observability](https://docs.livekit.io/deploy/observability/)
- A monorepo-aware Dockerfile for [production deployment to LiveKit Cloud](https://docs.livekit.io/deploy/agents/) (build from the repo root — see [Deploying to production](#deploying-to-production))

This starter app is compatible with any [custom web/mobile frontend](https://docs.livekit.io/frontends/) or [telephony](https://docs.livekit.io/telephony/).

## Using coding agents

This project is designed to work with coding agents like [Claude Code](https://claude.com/product/claude-code), [Cursor](https://www.cursor.com/), and [Codex](https://openai.com/codex/).

For your convenience, LiveKit offers both a CLI and an [MCP server](https://docs.livekit.io/reference/developer-tools/docs-mcp/) that can be used to browse and search its documentation. The [LiveKit CLI](https://docs.livekit.io/intro/basics/cli/) (`lk docs`) works with any coding agent that can run shell commands. Install it for your platform:

**macOS:**

```console
brew install livekit-cli
```

**Linux:**

```console
curl -sSL https://get.livekit.io/cli | bash
```

**Windows:**

```console
winget install LiveKit.LiveKitCLI
```

The `lk docs` subcommand requires version 2.15.0 or higher. Check your version with `lk --version` and update if needed. Once installed, your coding agent can search and browse LiveKit documentation directly from the terminal:

```console
lk docs search "voice agents"
lk docs get-page /agents/start/voice-ai-quickstart
```

See the [Coding agent support](https://docs.livekit.io/intro/coding-agents/) guide for more details, including MCP server setup.

The project includes a complete [AGENTS.md](AGENTS.md) file for these assistants. You can modify this file to suit your needs. To learn more about this file, see [https://agents.md](https://agents.md).

## Dev Setup

Create a project from this template with the LiveKit CLI (recommended):

```bash
lk cloud auth
lk agent init my-agent --template agent-starter-node
```

The CLI clones the template and configures your environment. Then follow the rest of this guide from [Run the agent](#run-the-agent).

This project uses [pnpm](https://pnpm.io/) as the package manager.

<details>
<summary>Alternative: Manual setup without the CLI</summary>

Clone the repository and install dependencies:

```console
cd agent-starter-node
pnpm install
```

Sign up for [LiveKit Cloud](https://cloud.livekit.io/) then set up the environment by copying `.env.example` to `.env.local` and filling in the required keys:

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`

You can load the LiveKit environment automatically using the [LiveKit CLI](https://docs.livekit.io/intro/basics/cli/):

```bash
lk cloud auth
lk app env -w -d .env.local
```

</details>

## Run the agent

To run the agent during development, use the `dev` command:

```console
pnpm run dev
```

In production, use the `start` command:

```console
pnpm run start
```

## Frontend & Telephony

Get started quickly with our pre-built frontend starter apps, or add telephony support:

| Platform         | Link                                                                                                                | Description                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **Web**          | [`livekit-examples/agent-starter-react`](https://github.com/livekit-examples/agent-starter-react)                   | Web voice AI assistant with React & Next.js        |
| **iOS/macOS**    | [`livekit-examples/agent-starter-swift`](https://github.com/livekit-examples/agent-starter-swift)                   | Native iOS, macOS, and visionOS voice AI assistant |
| **Flutter**      | [`livekit-examples/agent-starter-flutter`](https://github.com/livekit-examples/agent-starter-flutter)               | Cross-platform voice AI assistant app              |
| **React Native** | [`livekit-examples/voice-assistant-react-native`](https://github.com/livekit-examples/voice-assistant-react-native) | Native mobile app with React Native & Expo         |
| **Android**      | [`livekit-examples/agent-starter-android`](https://github.com/livekit-examples/agent-starter-android)               | Native Android app with Kotlin & Jetpack Compose   |
| **Web Embed**    | [`livekit-examples/agent-starter-embed`](https://github.com/livekit-examples/agent-starter-embed)                   | Voice AI widget for any website                    |
| **Telephony**    | [Documentation](https://docs.livekit.io/telephony/)                                                                 | Add inbound or outbound calling to your agent      |

For advanced customization, see the [complete frontend guide](https://docs.livekit.io/frontends/).

## Using this template repo for your own project

Once you've started your own project based on this repo, you should:

1. **Check in your `pnpm-lock.yaml`**: This file is currently untracked for the template, but you should commit it to your repository for reproducible builds and proper configuration management. (The same applies to `livekit.toml`, if you run your agents in LiveKit Cloud)

2. **Remove the git tracking test**: Delete the "Check files not tracked in git" step from `.github/workflows/tests.yml` since you'll now want this file to be tracked. These are just there for development purposes in the template repo itself.

## Deploying to production

To deploy this agent to LiveKit Cloud or another environment, see the [deploying to production](https://docs.livekit.io/deploy/agents/) guide.

### Build context

`apps/agent/Dockerfile` is **monorepo-aware and must be built from the repo root**, because the agent depends on the `@repo/logger` workspace package and the pnpm lockfile lives at the root:

```bash
docker build -f apps/agent/Dockerfile -t dd-agent .
```

It uses `turbo prune` to isolate the agent and its workspace dependencies, then installs, builds `@repo/logger`, pre-downloads plugin model files, and drops dev dependencies. Configure `lk agent deploy` / LiveKit Cloud to use the repo root as the build context.

### Required environment variables in production

`dotenv` only loads `.env.local` (not committed), so set these wherever the worker runs:

| Variable | Notes |
|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Always required |
| `AGENT_NAME` | Must match the frontend's dispatch name (`DD_agent`) |
| `TTS_PROVIDER` | `rime` (default), `rime-plugin`, or `fishaudio` |
| `RIME_MODEL`, `RIME_VOICE`, `RIME_LANGUAGE`, `RIME_SPEED` | Optional Rime tuning (see `.env.example`). English-only — `celeste` on Coda |
| `RIME_API_KEY` | **Only** when `TTS_PROVIDER=rime-plugin` |
| `RIME_SAVE_OOVS` | `true` logs Rime's out-of-vocabulary words — a pronunciation-harness diagnostic, off in production |
| `LLM_ENGINE`, `GRAPH_LLM_MODEL`, `GRAPH_STRUCTURED_METHOD` | `direct` (default) or `graph` — the LangGraph planner |
| `SLOW_TOOL_MS` | Synthetic staging delay (default `0`); the deterministic benchmark fixture |
| `CARTOGRAPH_BASELINE` | `true` disables fencing + the commit gate (naive-agent comparison) |
| `ADDRESSIVITY`, `ADDRESSIVITY_THRESHOLD` | `true` enables ambient meeting mode (§2); τ default `0.6` |
| `LAYOUT_DIRECTION` | `RIGHT` (default) or `DOWN` — ELK layout direction |
| `COMPONENT_LOOKUP` | `fixture` skips the network for `explainComponent` (stage safety) |

## Self-hosted LiveKit

You can also self-host LiveKit instead of using LiveKit Cloud. See the [self-hosting](https://docs.livekit.io/transport/self-hosting/local/) guide for more information. If you choose to self-host, you'll need to also use [model plugins](https://docs.livekit.io/agents/models/#plugins) instead of LiveKit Inference and will need to remove the [LiveKit Cloud noise cancellation](https://docs.livekit.io/transport/media/noise-cancellation/) plugin.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
