# syntax=docker/dockerfile:1.7
#
# The server image (architecture §3, §28; M14b, D-340).
#
# The API and the worker are one image with a different command, because they are one
# codebase with two entrypoints. Kamal sets the command per role (infra/kamal/deploy.yml):
#
#   api      node --import ./dist/instrument.js dist/main.api.js      (the default below)
#   worker   node --import ./dist/instrument.js dist/main.worker.js
#   migrate  node node_modules/@elysium/db/dist/cli/migrate.js         (the release step)
#
# Build from the repository root:
#
#   docker build -f infra/docker/server.Dockerfile -t elysium-server .
#
# Nothing secret enters the image: .dockerignore keeps every .env out, and configuration
# arrives as environment variables when the container starts.

ARG NODE_IMAGE=node:24.21.0-bookworm-slim

# --- build: install, compile, and cut a production-only copy ---------------------------
FROM ${NODE_IMAGE} AS build

ENV CI=true
# pnpm from npm rather than corepack: pnpm 12 ships as a native binary chosen through
# optional dependencies, which `npm install -g` resolves for this platform.
RUN npm install -g pnpm@12.5.1

WORKDIR /repo
COPY . .

# Only the server and the workspace packages it depends on. The cache mount keeps the
# store between builds and out of the image.
RUN --mount=type=cache,id=pnpm,target=/var/cache/pnpm \
    pnpm install --store-dir /var/cache/pnpm --frozen-lockfile --filter "@elysium/server..."

RUN pnpm --filter "@elysium/server..." run build

# A self-contained copy: the server's `dist`, its production dependencies, and each
# workspace package as published (`files`), which for @elysium/db includes the migrations.
RUN --mount=type=cache,id=pnpm,target=/var/cache/pnpm \
    pnpm --store-dir /var/cache/pnpm deploy --filter=@elysium/server --prod /out

# --- runtime ----------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=3000 \
    # The Bangla and Latin fonts the invoice PDFs embed (§22); fonts.ts reads this.
    PDF_FONT_DIR=/app/fonts

WORKDIR /app

# Owned by root and only readable by the process: the application cannot rewrite its own
# code or dependencies.
COPY --from=build /out /app
COPY --from=build /repo/packages/ui/src/assets/fonts /app/fonts

# The `node` user (uid 1000) of the official image. Never root.
USER node

EXPOSE 3000

CMD ["node", "--import", "./dist/instrument.js", "dist/main.api.js"]
