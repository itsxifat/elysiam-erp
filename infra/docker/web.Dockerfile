# syntax=docker/dockerfile:1.7
#
# The console, portal and pos builds for the single-server preview (D-352), as files.
#
# They share one origin with the API there: the console at `/`, the portal under
# `/portal/`, the till under `/pos/`, and the API's own paths (`/v1`, `/api/auth`,
# `/socket.io`, `/health`) proxied by the host's nginx (infra/preview/nginx-elyerp.conf).
# So the API URL is the origin itself, and each app is built under its own base.
#
#   docker build -f infra/docker/web.Dockerfile --target dist \
#     --build-arg VITE_API_URL=https://elyerp.example --output type=local,dest=out .
#
# writes out/www (the web root) and out/nginx/<app>.conf (each app's CSP and security
# headers, from its build's `_headers`, D-347). infra/preview/deploy.sh does this on the
# server. Production serves the same apps from Cloudflare Pages instead.

ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

FROM ${NODE_IMAGE} AS build

ENV CI=true
RUN npm install -g pnpm@12.5.1

WORKDIR /repo
COPY . .

RUN --mount=type=cache,id=pnpm,target=/var/cache/pnpm \
    pnpm install --store-dir /var/cache/pnpm --frozen-lockfile \
      --filter "@elysium/console..." --filter "@elysium/portal..." --filter "@elysium/pos..."

# The workspace packages the three apps import, once.
RUN pnpm --filter "@elysium/console^..." --filter "@elysium/portal^..." --filter "@elysium/pos^..." run build

ARG VITE_API_URL
ARG VITE_CSP_CONNECT_SRC=
ENV VITE_API_URL=${VITE_API_URL} \
    VITE_CSP_CONNECT_SRC=${VITE_CSP_CONNECT_SRC}

RUN cd apps/console && pnpm exec vite build --base / \
 && cd ../portal && pnpm exec vite build --base /portal/ \
 && cd ../pos && pnpm exec vite build --base /pos/

RUN mkdir -p /out/www /out/nginx \
 && cp -r apps/console/dist/. /out/www/ \
 && cp -r apps/portal/dist /out/www/portal \
 && cp -r apps/pos/dist /out/www/pos \
 && node infra/preview/headers-to-nginx.mjs /out/www/_headers > /out/nginx/console.conf \
 && node infra/preview/headers-to-nginx.mjs /out/www/portal/_headers > /out/nginx/portal.conf \
 && node infra/preview/headers-to-nginx.mjs /out/www/pos/_headers > /out/nginx/pos.conf \
 && find /out/www -name _headers -delete

FROM scratch AS dist
COPY --from=build /out /
