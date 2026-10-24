#!/bin/sh
#
# The server half of infra/brand/deploy.sh (M31, D-474). Runs on the brands server from
# ~/<brands dir>/src, with the release unpacked in ./<sha>:
#
#   sh <sha>/infra/brand/server-deploy.sh <sha> <slug|all>
#
# Re-runnable, every step idempotent. Kept between releases: each brand's Postgres and files
# volumes (Compose project `erp-<slug>`), its ~/<brands dir>/brands/<slug>/.env.brand
# (new-brand.sh) and its nginx site file (certbot edits it).
#
# One brand failing stops the run before the next: the brands already deployed keep the new
# release, the rest keep the old one, and every brand's API stays up through its own deploy
# until its new containers are healthy.

set -eu

SHA="${1:?usage: server-deploy.sh <sha> <slug|all>}"
WHICH="${2:?usage: server-deploy.sh <sha> <slug|all>}"

SRC_ROOT=$(pwd)
BASE=$(dirname "$SRC_ROOT")
SRC="$SRC_ROOT/$SHA"
BRANDS="$BASE/brands"
# Fixed on the server (the nginx template names the web roots); overridable for a dry run.
WEB_BASE="${ERP_WEB_BASE:-/var/www}"
SITES="${ERP_NGINX_SITES:-/etc/nginx/sites-available}"
ENABLED="${ERP_NGINX_ENABLED:-/etc/nginx/sites-enabled}"

say() { printf '\n== %s\n' "$*"; }
fail() {
  echo "error: $*" >&2
  exit 1
}

say "checks"
[ -f "$SRC/infra/brand/docker-compose.brand.yml" ] || fail "no release at $SRC"
docker info >/dev/null 2>&1 ||
  fail "docker is not usable by $(id -un): sudo usermod -aG docker $(id -un), then log in again"
docker compose version >/dev/null 2>&1 || fail "docker compose is missing: sudo apt-get install -y docker-compose-v2"
docker buildx version >/dev/null 2>&1 || fail "docker buildx is missing: sudo apt-get install -y docker-buildx"
command -v nginx >/dev/null 2>&1 || fail "nginx is not installed on this server"
command -v curl >/dev/null 2>&1 || fail "curl is missing: sudo apt-get install -y curl"

if [ "$WHICH" = all ]; then
  SLUGS=""
  for dir in "$BRANDS"/*/; do
    [ -f "$dir/.env.brand" ] && SLUGS="$SLUGS $(basename "$dir")"
  done
  [ -n "$SLUGS" ] || fail "no brand is set up in $BRANDS (infra/brand/new-brand.sh)"
else
  [ -f "$BRANDS/$WHICH/.env.brand" ] ||
    fail "$WHICH is not set up: sh $SRC/infra/brand/new-brand.sh $WHICH <admin-host>"
  SLUGS="$WHICH"
fi
echo "brands:$SLUGS"

say "server image erp-server:$SHA (the first build takes several minutes)"
docker build -f "$SRC/infra/docker/server.Dockerfile" -t "erp-server:$SHA" "$SRC"
export ERP_RELEASE="$SHA"

deploy_brand() {
  SLUG="$1"
  ENV_FILE="$BRANDS/$SLUG/.env.brand"
  setting() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
  [ "$(setting BRAND_SLUG)" = "$SLUG" ] || fail "$ENV_FILE names another brand"
  HOST=$(setting BRAND_ADMIN_HOST)
  PORT=$(setting BRAND_API_PORT)
  CSP_EXTRA=$(setting BRAND_CSP_CONNECT_SRC)
  # M47 (D-844): the web phone's Envo hosts (its script and session) and SIP sockets. A value
  # replaces the console's default (https://envo.enfinito.cloud, wss://call.enfinito.cloud), so
  # list every host, space-separated; quotes are dropped. Checked here, before the new API
  # starts, so a bad value stops the deploy with the old release still whole.
  CSP_TELEPHONY=$(setting BRAND_CSP_TELEPHONY_ORIGINS | tr -d "\"'")
  CSP_PHONE_SOCKETS=$(setting BRAND_CSP_TELEPHONY_SOCKETS | tr -d "\"'")
  for SOURCE in $CSP_TELEPHONY; do
    printf '%s\n' "$SOURCE" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' \
      || fail "BRAND_CSP_TELEPHONY_ORIGINS: $SOURCE is not an https origin"
  done
  for SOURCE in $CSP_PHONE_SOCKETS; do
    printf '%s\n' "$SOURCE" | grep -Eq '^wss://[A-Za-z0-9.-]+(:[0-9]+)?$' \
      || fail "BRAND_CSP_TELEPHONY_SOCKETS: $SOURCE is not a wss origin"
  done
  BEHIND_CF=$(setting BRAND_BEHIND_CLOUDFLARE)
  # D-908: an unverified courier switched off books nothing, so no label prints by itself.
  for CODE in STEADFAST PATHAO REDX; do
    [ "$(setting "BRAND_COURIER_${CODE}_ENABLED" | tr -d "\"'")" = true ] \
      || echo "$SLUG: note: BRAND_COURIER_${CODE}_ENABLED is not true; nothing is booked with that courier"
  done
  [ -n "$HOST" ] && [ -n "$PORT" ] || fail "$ENV_FILE has no BRAND_ADMIN_HOST or BRAND_API_PORT"
  ID=$(printf '%s' "$SLUG" | tr '-' '_')
  WEB="$WEB_BASE/erp-$SLUG"
  SITE="$SITES/erp-$SLUG.conf"
  COMPOSE="docker compose -f $SRC/infra/brand/docker-compose.brand.yml --env-file $ENV_FILE"
  # M32 (D-482): the owner console's tunnel reads this brand's Postgres on the loopback, for
  # a brand whose .env.brand names the port. Every other brand publishes no database port.
  REPORTING_PORT=$(setting BRAND_REPORTING_DB_PORT)
  if [ -n "$REPORTING_PORT" ]; then
    case "$REPORTING_PORT" in
      *[!0-9]*) fail "$ENV_FILE: BRAND_REPORTING_DB_PORT must be a port number" ;;
    esac
    COMPOSE="$COMPOSE -f $SRC/infra/brand/docker-compose.reporting.yml"
    echo "$SLUG: Postgres published on 127.0.0.1:$REPORTING_PORT for the owner console's tunnel"
  fi

  say "$SLUG: release step (database roles, migrations, job queues)"
  # Before anything is recreated: if it fails, the brand's running API and worker are untouched.
  $COMPOSE up -d --wait postgres valkey gotenberg
  $COMPOSE run --rm --no-deps release

  BRANDS_IN_DB=$($COMPOSE exec -T postgres psql -U postgres -d erp -tAc \
    'select count(*) from org.organizations where not is_training')
  if [ "$BRANDS_IN_DB" = 0 ]; then
    say "$SLUG: seed this brand alone (its chart of accounts, head office, hand-cash wallet, zones)"
    $COMPOSE run --rm --no-deps release node node_modules/@elysium/db/dist/cli/seed.js --brand "$SLUG"
  else
    echo "seed skipped: the database already holds its brand"
  fi

  say "$SLUG: API, worker and camera"
  # The API and worker refuse to start if this database holds another real brand (D-470).
  $COMPOSE up -d --wait --remove-orphans || {
    $COMPOSE logs --tail 80 release worker api camera
    fail "$SLUG's stack did not come up healthy"
  }
  curl -fsS "http://127.0.0.1:$PORT/health/ready" >/dev/null ||
    fail "$SLUG's API is not answering on 127.0.0.1:$PORT"
  echo "ready on 127.0.0.1:$PORT"

  say "$SLUG: the SPAs (console at /, portal at /portal/, till at /pos/)"
  if [ ! -d "$WEB" ]; then
    sudo mkdir -p "$WEB"
    sudo chown "$(id -u):$(id -g)" "$WEB"
  fi
  mkdir -p "$WEB/releases"
  rm -rf "$WEB/releases/$SHA"
  # Built per brand: the API's address is part of each build. The files name no brand
  # (`pnpm check:white-label`); the brand's name comes from its own database at run time.
  docker build -f "$SRC/infra/docker/web.Dockerfile" --target dist \
    --build-arg "VITE_API_URL=https://$HOST" \
    --build-arg "VITE_CSP_CONNECT_SRC=$CSP_EXTRA" \
    --build-arg "VITE_CSP_TELEPHONY_ORIGINS=$CSP_TELEPHONY" \
    --build-arg "VITE_CSP_TELEPHONY_SOCKETS=$CSP_PHONE_SOCKETS" \
    --output "type=local,dest=$WEB/releases/$SHA" "$SRC"
  [ -f "$WEB/releases/$SHA/www/index.html" ] || fail "$SLUG's SPA build wrote no index.html"
  chmod -R u=rwX,go=rX "$WEB/releases/$SHA"
  PREV_WEB=$(readlink "$WEB/current" 2>/dev/null || true)
  ln -sfn "releases/$SHA" "$WEB/current.next"
  mv -Tf "$WEB/current.next" "$WEB/current"

  say "$SLUG: nginx"
  if [ "$BEHIND_CF" = true ]; then
    # Refreshed on every deploy, so a new range list reaches every brand behind Cloudflare.
    sudo mkdir -p /etc/nginx/snippets
    sudo cp "$SRC/infra/brand/nginx-cloudflare-realip.conf" /etc/nginx/snippets/erp-cloudflare-realip.conf
    REAL_IP_LINE="include /etc/nginx/snippets/erp-cloudflare-realip.conf;"
  else
    REAL_IP_LINE=""
  fi
  NEW_SITE=no
  if [ ! -e "$SITE" ]; then
    # First deploy only: certbot edits the file afterwards, so it is never overwritten here.
    sed -e "s/__ADMIN_HOST__/$HOST/g" -e "s/__SLUG__/$SLUG/g" -e "s/__ID__/$ID/g" \
      -e "s/__API_PORT__/$PORT/g" -e "s|#__REAL_IP_INCLUDE__|$REAL_IP_LINE|" \
      "$SRC/infra/brand/nginx-brand.conf" |
      sudo tee "$SITE" >/dev/null
    sudo ln -sf "$SITE" "$ENABLED/erp-$SLUG.conf"
    echo "installed $SITE"
    NEW_SITE=yes
  fi
  if ! sudo nginx -t; then
    # Never leave files nginx rejects: the next reload would fail for every site on the host.
    if [ -n "$PREV_WEB" ]; then
      ln -sfn "$PREV_WEB" "$WEB/current.next"
      mv -Tf "$WEB/current.next" "$WEB/current"
    fi
    if [ "$NEW_SITE" = yes ]; then
      sudo rm -f "$ENABLED/erp-$SLUG.conf" "$SITE"
    fi
    fail "nginx rejected $SLUG's configuration; its previous web files and site were put back"
  fi
  sudo systemctl reload nginx

  # Tidy: the last three web releases are kept.
  ls -1t "$WEB/releases" | tail -n +4 | while read -r old; do
    [ "$old" = "$SHA" ] || rm -rf "${WEB:?}/releases/$old"
  done

  echo "$SLUG: https://$HOST (console), https://$HOST/portal/, https://$HOST/pos/"
  if [ "$NEW_SITE" = yes ]; then
    echo "first deploy of $SLUG: get its certificate once, then open https://$HOST"
    echo "  sudo certbot --nginx -d $HOST"
  fi
}

for slug in $SLUGS; do
  deploy_brand "$slug"
done

# The release the runbook's shorthand points at.
ln -sfn "src/$SHA" "$BASE/current"

say "tidy: the last three source releases and the last two server images are kept"
ls -1t "$SRC_ROOT" | tail -n +4 | while read -r old; do
  [ "$old" = "$SHA" ] || rm -rf "${SRC_ROOT:?}/$old"
done
# Each release's image is about 2 GB; without this they filled the disk (2026-10-11). The
# current one and the one before it stay for a rollback; an image a container still uses
# is never removed (docker refuses).
docker images --format '{{.CreatedAt}}	{{.Repository}}:{{.Tag}}'   | grep -F "erp-server:" | sort -r | cut -f2 | tail -n +3 | while read -r image; do
  [ "$image" = "erp-server:$SHA" ] || docker rmi "$image" >/dev/null 2>&1 || true
done
docker image prune -f >/dev/null
docker builder prune -f --filter until=72h >/dev/null 2>&1 || true

say "done"
