# syntax=docker/dockerfile:1
#
# Monorepo-aware build for the DD_agent LiveKit Agents worker.
#
#   IMPORTANT: the build context is the REPO ROOT, not apps/agent.
#   Build locally with:
#       docker build -f apps/agent/Dockerfile -t dd-agent .
#   `lk agent deploy` / LiveKit Cloud must likewise use the repo root as context.
#
# The agent depends on the `@repo/logger` workspace package, and the pnpm
# lockfile lives at the repo root, so a single-package build can't work. This
# uses `turbo prune` to carve out a minimal subset (DD_agent + its workspace
# deps + the root lockfile), then installs and builds that.

ARG NODE_VERSION=24

# ---------------------------------------------------------------------------
# base — common tooling. Node >= 22.18 is required for native TS type stripping
# (the agent runs `node src/main.ts` directly, no compile step).
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# ca-certificates: the LiveKit native core reads the system trust store at runtime.
RUN apt-get update -qq \
    && apt-get install --no-install-recommends -y ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Pin pnpm to the version in the root package.json `packageManager` field.
RUN npm install -g pnpm@8.15.6

# ---------------------------------------------------------------------------
# prune — produce a focused subset of the monorepo for DD_agent.
# `out/json`  = package.json files only (for a cacheable install layer)
# `out/full`  = full source of DD_agent + its workspace deps
# `out/pnpm-lock.yaml` = pruned lockfile
# ---------------------------------------------------------------------------
FROM base AS prune
RUN npm install -g turbo@^2
WORKDIR /repo
COPY . .
RUN turbo prune DD_agent --docker

# ---------------------------------------------------------------------------
# build — install deps, build workspace deps, pre-fetch models, prune to prod.
# ---------------------------------------------------------------------------
FROM base AS build
WORKDIR /repo

# 1. Install against the manifests + lockfile only, so this layer is cached
#    until a dependency actually changes.
COPY --from=prune /repo/out/json/ ./
COPY --from=prune /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile

# 2. Bring in the pruned source and build the workspace deps the agent imports
#    (`@repo/logger` compiles to dist/ via bunchee; the agent itself is not compiled).
COPY --from=prune /repo/out/full/ ./
RUN pnpm --filter=@repo/logger build

# 3. Pre-download ML models for any installed @livekit/agents-plugin-* packages
#    (turn detector, etc.). The standalone CLI finds them without loading agent code.
RUN cd apps/agent && npx livekit-agents download-files

# 4. Reinstall without dev dependencies for a lean runtime image.
#    `@repo/logger`'s built dist/ lives in the source tree and survives this.
RUN pnpm install --frozen-lockfile --prod

# ---------------------------------------------------------------------------
# runtime — non-root, production.
# ---------------------------------------------------------------------------
FROM base
ARG UID=10001
RUN adduser --disabled-password --gecos "" --home "/app" --shell "/sbin/nologin" --uid "${UID}" appuser

WORKDIR /app
COPY --from=build --chown=appuser:appuser /repo /app
# Model cache written by `download-files`.
COPY --from=build --chown=appuser:appuser /root/.cache /app/.cache

USER appuser
ENV NODE_ENV=production
ENV HOME=/app
ENV XDG_CACHE_HOME=/app/.cache

WORKDIR /app/apps/agent
# `start` = `node src/main.ts start` — connect to LiveKit and wait for jobs.
CMD ["pnpm", "start"]
