# syntax=docker/dockerfile:1.7
#
# The owner console's images (M32, D-480, D-497): the mother server (API, worker and CLI in
# one image, a different command each) and, as the `web` target, the console's static files.
# Built only from the mother's workspaces and the shared pure packages they depend on; no
# brand image is built from this file, and the brand images never contain it.
#
#   docker build -f infra/mother/mother.Dockerfile -t elysium-mother .
#   docker build -f infra/mother/mother.Dockerfile --target web --output type=local,dest=out .

ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

FROM ${NODE_IMAGE} AS build
ENV CI=true
RUN npm install -g pnpm@12.5.1
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm,target=/var/cache/pnpm \
    pnpm install --store-dir /var/cache/pnpm --frozen-lockfile \
      --filter "@elysium/mother-server..." --filter "@elysium/mother-console..."
RUN pnpm --filter "@elysium/mother-server..." --filter "@elysium/mother-console..." run build
RUN --mount=type=cache,id=pnpm,target=/var/cache/pnpm \
    pnpm --store-dir /var/cache/pnpm deploy --filter=@elysium/mother-server --prod /out

# --- the console's files, for nginx -------------------------------------------------------
FROM scratch AS web
COPY --from=build /repo/apps/mother-console/dist /www

# --- the server ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    MOTHER_API_HOST=0.0.0.0 \
    MOTHER_API_PORT=3300
WORKDIR /app
COPY --from=build /out /app
USER node
EXPOSE 3300
CMD ["node", "dist/main.api.js"]
