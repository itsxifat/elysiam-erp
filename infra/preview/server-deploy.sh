#!/bin/sh
#
# The server half of infra/preview/deploy.sh (D-352). Runs on the preview server from
# ~/<remote dir>/src, with the release unpacked in ./<sha>:
#
#   sh <sha>/infra/preview/server-deploy.sh <sha> <domain> [yes|no: seed again]
#
# Re-runnable, every step idempotent. Kept between releases: the Postgres and files
# volumes, ~/<remote dir>/.env.preview and the nginx site file (certbot edits it).

set -eu

SHA="${1:?usage: server-deploy.sh <sha> <domain> [seed]}"
DOMAIN="${2:?usage: server-deploy.sh <sha> <domain> [seed]}"
SEED="${3:-no}"

SRC_ROOT=$(pwd)
BASE=$(dirname "$SRC_ROOT")
SRC="$SRC_ROOT/$SHA"
ENV_FILE="$BASE/.env.preview"
# Fixed on the server (nginx-elyerp.conf names the web root); overridable only for a dry run.
WEB="${PREVIEW_WEB_ROOT:-/var/www/elyerp}"
SITE="${PREVIEW_NGINX_SITE:-/etc/nginx/sites-available/elyerp.conf}"
SITE_ENABLED="${PREVIEW_NGINX_ENABLED:-/etc/nginx/sites-enabled/elyerp.conf}"
COMPOSE="docker compose -f $SRC/infra/docker-compose.preview.yml --env-file $ENV_FILE"

say() { printf '\n== %s\n' "$*"; }
fail() {
  echo "error: $*" >&2
  exit 1
}

say "checks"
[ -f "$SRC/infra/docker-compose.preview.yml" ] || fail "no release at $SRC"
docker info >/dev/null 2>&1 ||
  fail "docker is not usable by $(id -un): sudo usermod -aG docker $(id -un), then log in again"
docker compose version >/dev/null 2>&1 || fail "docker compose is missing: sudo apt-get install -y docker-compose-v2"
docker buildx version >/dev/null 2>&1 || fail "docker buildx is missing: sudo apt-get install -y docker-buildx"
command -v nginx >/dev/null 2>&1 || fail "nginx is not installed on this server"
command -v curl >/dev/null 2>&1 || fail "curl is missing: sudo apt-get install -y curl"
echo "ok"

say "settings"
if [ -f "$ENV_FILE" ]; then
  echo "keeping $ENV_FILE"
else
  sh "$SRC/infra/preview/init-env.sh" "$DOMAIN" "$ENV_FILE"
fi
setting() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
API_PORT=$(setting PREVIEW_API_PORT)
API_PORT="${API_PORT:-3410}"
CSP_EXTRA=$(setting PREVIEW_CSP_CONNECT_SRC)

say "server image (the first build takes several minutes)"
$COMPOSE build release

say "release step: database roles, migrations, job queues"
# Before anything is recreated: if it fails, the running API and worker are untouched.
$COMPOSE up -d --wait postgres valkey gotenberg
$COMPOSE run --rm --no-deps release

BRANDS=$($COMPOSE exec -T postgres psql -U postgres -d elysium -tAc 'select count(*) from org.organizations')
if [ "$BRANDS" = 0 ] || [ "$SEED" = yes ]; then
  say "seed: the five brands, their branches and charts of accounts"
  $COMPOSE run --rm --no-deps release node node_modules/@elysium/db/dist/cli/seed.js
else
  echo "seed skipped: the database has $BRANDS brands (PREVIEW_SEED=yes runs it again)"
fi

say "API and worker"
$COMPOSE up -d --wait --remove-orphans || {
  $COMPOSE logs --tail 80 release worker api
  fail "the stack did not come up healthy"
}
curl -fsS "http://127.0.0.1:$API_PORT/health/ready" >/dev/null ||
  fail "the API is not answering on 127.0.0.1:$API_PORT"
echo "ready on 127.0.0.1:$API_PORT"

say "the SPAs: console at /, portal at /portal/, till at /pos/"
if [ ! -d "$WEB" ]; then
  sudo mkdir -p "$WEB"
  sudo chown "$(id -u):$(id -g)" "$WEB"
fi
mkdir -p "$WEB/releases"
rm -rf "$WEB/releases/$SHA"
docker build -f "$SRC/infra/docker/web.Dockerfile" --target dist \
  --build-arg "VITE_API_URL=https://$DOMAIN" \
  --build-arg "VITE_CSP_CONNECT_SRC=$CSP_EXTRA" \
  --output "type=local,dest=$WEB/releases/$SHA" "$SRC"
[ -f "$WEB/releases/$SHA/www/index.html" ] || fail "the SPA build wrote no index.html"
PREV_WEB=$(readlink "$WEB/current" 2>/dev/null || true)
ln -sfn "releases/$SHA" "$WEB/current.next"
mv -Tf "$WEB/current.next" "$WEB/current"

say "nginx"
NEW_SITE=no
if [ ! -e "$SITE" ]; then
  # First deploy only: certbot edits the file afterwards, so it is never overwritten here.
  sed "s/elyerp\.enfinito\.cloud/$DOMAIN/g" "$SRC/infra/preview/nginx-elyerp.conf" |
    sudo tee "$SITE" >/dev/null
  sudo ln -sf "$SITE" "$SITE_ENABLED"
  echo "installed $SITE"
  NEW_SITE=yes
fi
if ! sudo nginx -t; then
  # Never leave files on disk that nginx rejects: the next reload or reboot would fail for
  # every site on this host, not only this one. Put the previous state back first.
  if [ -n "$PREV_WEB" ]; then
    ln -sfn "$PREV_WEB" "$WEB/current.next"
    mv -Tf "$WEB/current.next" "$WEB/current"
  fi
  if [ "$NEW_SITE" = yes ]; then
    sudo rm -f "$SITE_ENABLED" "$SITE"
  fi
  fail "nginx rejected the configuration; the previous web files and site were put back"
fi
sudo systemctl reload nginx

# The release the `dcp` shorthand in the runbook points at.
ln -sfn "src/$SHA" "$BASE/current"

say "tidy: the last three releases are kept"
for dir in "$SRC_ROOT" "$WEB/releases"; do
  # Newest first; the release just deployed is never removed.
  ls -1t "$dir" | tail -n +4 | while read -r old; do
    [ "$old" = "$SHA" ] || rm -rf "${dir:?}/$old"
  done
done
docker image prune -f >/dev/null

say "done"
echo "release $SHA: https://$DOMAIN (console), https://$DOMAIN/portal/, https://$DOMAIN/pos/"
if [ "$NEW_SITE" = yes ]; then
  echo
  echo "First deploy: get the certificate once, then open https://$DOMAIN"
  echo "  sudo certbot --nginx -d $DOMAIN"
fi
