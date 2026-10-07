#!/bin/sh
#
# The server half of infra/mother/deploy.sh (M32, D-497). Runs on the owner console's server
# from ~/<mother dir>/src, with the release unpacked in ./<sha>:
#
#   sh <sha>/infra/mother/server-deploy.sh <sha>
#
# Re-runnable, every step idempotent. Kept between releases: the mother's Postgres volume
# (Compose project `elysium-mother`), ~/<mother dir>/.env.mother and ~/<mother dir>/tunnel/
# (new-env.sh), and the nginx site file (certbot edits it).
#
# The API stays up through a deploy until the new containers are healthy; a failed release
# step (roles, migrations) leaves the running API and worker untouched.

set -eu

SHA="${1:?usage: server-deploy.sh <sha>}"

SRC_ROOT=$(pwd)
BASE=$(dirname "$SRC_ROOT")
SRC="$SRC_ROOT/$SHA"
ENV_FILE="$BASE/.env.mother"
TUNNEL_DIR="$BASE/tunnel"
# Fixed on the server (the nginx template names the web root); overridable for a dry run.
WEB="${MOTHER_WEB_ROOT:-/var/www/mother}"
SITES="${MOTHER_NGINX_SITES:-/etc/nginx/sites-available}"
ENABLED="${MOTHER_NGINX_ENABLED:-/etc/nginx/sites-enabled}"
SITE="$SITES/elysium-mother.conf"
# The tunnel image's user (tunnel.Dockerfile), which must be able to read the key.
TUNNEL_UID=10001

say() { printf '\n== %s\n' "$*"; }
fail() {
  echo "error: $*" >&2
  exit 1
}

say "checks"
[ -f "$SRC/infra/mother/docker-compose.yml" ] || fail "no release at $SRC"
[ -f "$ENV_FILE" ] ||
  fail "no $ENV_FILE: sh $SRC/infra/mother/new-env.sh <domain> <brands-server> $ENV_FILE"
[ -f "$TUNNEL_DIR/id_ed25519" ] || fail "no tunnel key in $TUNNEL_DIR (new-env.sh writes it)"
[ -s "$TUNNEL_DIR/known_hosts" ] ||
  fail "no brands server host key: ssh-keyscan -t ed25519 <brands-server> > $TUNNEL_DIR/known_hosts (check its fingerprint)"
docker info >/dev/null 2>&1 ||
  fail "docker is not usable by $(id -un): sudo usermod -aG docker $(id -un), then log in again"
docker compose version >/dev/null 2>&1 || fail "docker compose is missing: sudo apt-get install -y docker-compose-v2"
docker buildx version >/dev/null 2>&1 || fail "docker buildx is missing: sudo apt-get install -y docker-buildx"
command -v nginx >/dev/null 2>&1 || fail "nginx is not installed on this server"
command -v curl >/dev/null 2>&1 || fail "curl is missing: sudo apt-get install -y curl"

setting() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
DOMAIN=$(setting MOTHER_DOMAIN)
PORT=$(setting MOTHER_API_PORT)
PORT="${PORT:-3330}"
[ -n "$DOMAIN" ] || fail "$ENV_FILE has no MOTHER_DOMAIN"
case "$DOMAIN" in
  *[!a-z0-9.-]*) fail "MOTHER_DOMAIN is not a hostname: $DOMAIN" ;;
esac
case "$PORT" in
  *[!0-9]*) fail "MOTHER_API_PORT must be a port number" ;;
esac
[ -n "$(setting MOTHER_TUNNEL_FORWARDS)" ] || fail "$ENV_FILE has no MOTHER_TUNNEL_FORWARDS"

export MOTHER_RELEASE="$SHA"
export MOTHER_TUNNEL_DIR="$TUNNEL_DIR"
COMPOSE="docker compose -f $SRC/infra/mother/docker-compose.yml --env-file $ENV_FILE"

say "images elysium-mother:$SHA and elysium-mother-tunnel:$SHA (the first build takes minutes)"
docker build -f "$SRC/infra/mother/mother.Dockerfile" --target runtime -t "elysium-mother:$SHA" "$SRC"
docker build -f "$SRC/infra/mother/tunnel.Dockerfile" -t "elysium-mother-tunnel:$SHA" "$SRC/infra/mother"

say "the tunnel's key, readable by the tunnel's user only"
# ssh refuses a key others can read; the container runs as the tunnel image's own user.
sudo chown "$TUNNEL_UID" "$TUNNEL_DIR/id_ed25519"
sudo chmod 0400 "$TUNNEL_DIR/id_ed25519"
chmod 0644 "$TUNNEL_DIR/known_hosts" 2>/dev/null || sudo chmod 0644 "$TUNNEL_DIR/known_hosts"

say "release step (database roles, migrations)"
$COMPOSE up -d --wait postgres
$COMPOSE run --rm --no-deps release

say "tunnel, worker and API"
$COMPOSE up -d --wait --remove-orphans || {
  $COMPOSE logs --tail 80 tunnel worker api
  fail "the owner console's stack did not come up healthy"
}
curl -fsS "http://127.0.0.1:$PORT/v1/health/ready" >/dev/null ||
  fail "the API is not answering on 127.0.0.1:$PORT"
echo "ready on 127.0.0.1:$PORT"

say "the console's files"
if [ ! -d "$WEB" ]; then
  sudo mkdir -p "$WEB"
  sudo chown "$(id -u):$(id -g)" "$WEB"
fi
mkdir -p "$WEB/releases"
rm -rf "$WEB/releases/$SHA"
docker build -f "$SRC/infra/mother/mother.Dockerfile" --target web \
  --output "type=local,dest=$WEB/releases/$SHA" "$SRC"
[ -f "$WEB/releases/$SHA/www/index.html" ] || fail "the console's build wrote no index.html"
chmod -R u=rwX,go=rX "$WEB/releases/$SHA"
PREV_WEB=$(readlink "$WEB/current" 2>/dev/null || true)
ln -sfn "releases/$SHA" "$WEB/current.next"
mv -Tf "$WEB/current.next" "$WEB/current"

say "nginx"
NEW_SITE=no
if [ ! -e "$SITE" ]; then
  # First deploy only: certbot edits the file afterwards, so it is never overwritten here.
  sed -e "s/__OWNER_DOMAIN__/$DOMAIN/g" -e "s/__API_PORT__/$PORT/g" \
    "$SRC/infra/mother/nginx-mother.conf" | sudo tee "$SITE" >/dev/null
  sudo ln -sf "$SITE" "$ENABLED/elysium-mother.conf"
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
    sudo rm -f "$ENABLED/elysium-mother.conf" "$SITE"
  fi
  fail "nginx rejected the owner console's site; the previous files and site were put back"
fi
sudo systemctl reload nginx

say "tidy: the last three releases are kept"
ls -1t "$WEB/releases" | tail -n +4 | while read -r old; do
  [ "$old" = "$SHA" ] || rm -rf "${WEB:?}/releases/$old"
done
ln -sfn "src/$SHA" "$BASE/current"
ls -1t "$SRC_ROOT" | tail -n +4 | while read -r old; do
  [ "$old" = "$SHA" ] || rm -rf "${SRC_ROOT:?}/$old"
done
docker image prune -f >/dev/null

say "done: https://$DOMAIN"
if [ "$NEW_SITE" = yes ]; then
  echo "first deploy: get the certificate once, then make the first owner:"
  echo "  sudo certbot --nginx -d $DOMAIN"
  echo "  cd $BASE/current && MOTHER_RELEASE=$SHA MOTHER_TUNNEL_DIR=$TUNNEL_DIR $COMPOSE run --rm --no-deps release \\"
  echo "    node dist/main.cli.js bootstrap --email <address> --name \"<name>\""
fi
