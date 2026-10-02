# syntax=docker/dockerfile:1.7
#
# The console, portal and pos, built and served by Caddy (single-server preview, D-352).
#
# The API's URL is baked into each bundle by Vite, so it is a build argument:
#
#   docker build -f infra/docker/web.Dockerfile \
#     --build-arg VITE_API_URL=https://api.preview.example -t elysium-web .
#
# infra/docker-compose.preview.yml builds it with the preview's own values. Production
# serves the same builds from Cloudflare Pages instead (docs/runbooks/deploy.md).

ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG CADDY_IMAGE=caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d

# --- build ------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build

ENV CI=true
RUN npm install -g pnpm@12.5.1

WORKDIR /repo
COPY . .

RUN --mount=type=cache,id=pnpm,target=/var/cache/pnpm \
    pnpm install --store-dir /var/cache/pnpm --frozen-lockfile \
      --filter "@elysium/console..." --filter "@elysium/portal..." --filter "@elysium/pos..."

ARG VITE_API_URL
ARG VITE_CSP_CONNECT_SRC=
ENV VITE_API_URL=${VITE_API_URL} \
    VITE_CSP_CONNECT_SRC=${VITE_CSP_CONNECT_SRC}

# Each build also writes dist/_headers (the CSP with the inline script's hash, D-347);
# Caddy reads the same headers from a snippet generated from it.
RUN pnpm --filter "@elysium/console..." --filter "@elysium/portal..." --filter "@elysium/pos..." run build \
 && mkdir -p /out/caddy \
 && for app in console portal pos; do \
      cp -r "apps/$app/dist" "/out/$app" \
      && node infra/preview/headers-to-caddy.mjs "/out/$app/_headers" > "/out/caddy/$app.caddy" \
      && rm "/out/$app/_headers"; \
    done

# --- serve ------------------------------------------------------------------------------
FROM ${CADDY_IMAGE} AS runtime

COPY --from=build /out/console /srv/console
COPY --from=build /out/portal /srv/portal
COPY --from=build /out/pos /srv/pos
COPY --from=build /out/caddy /etc/caddy/headers
COPY infra/preview/Caddyfile /etc/caddy/Caddyfile
