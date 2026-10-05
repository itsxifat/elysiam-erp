#!/bin/sh
#
# Set up one brand's ERP on the brands server: write its .env.brand with fresh secrets
# (M31, D-474).
#
#   sh infra/brand/new-brand.sh <slug> <admin-host> [--port <n>] [--dir <brands dir>] [--force]
#
#   sh infra/brand/new-brand.sh oura-lifestyle admin.ouralifestyle.com
#
# Writes <brands dir>/<slug>/.env.brand (default brands dir: ~/erp-brands/brands), readable
# by its owner only. The API port is the next free one from 3501 unless --port names one.
# Needs only `sh` and `openssl`. Refuses to overwrite an existing file: its database
# passwords are already inside the brand's database volume, and new ones would lock the
# brand's ERP out of its own data. Pass --force only with a fresh volume.
#
# The slug must be one the seed knows (packages/db/src/seed/orgs.ts): the first deploy seeds
# that brand alone into the brand's own database (`db:seed --brand <slug>`, D-470).

set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
EXAMPLE="$HERE/.env.brand.example"

FORCE=no
SLUG=""
HOST=""
PORT=""
DIR="${ERP_BRANDS_DIR:-$HOME/erp-brands}/brands"
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=yes ;;
    --port) PORT="${2:?--port needs a number}"; shift ;;
    --dir) DIR="${2:?--dir needs a path}"; shift ;;
    *)
      if [ -z "$SLUG" ]; then SLUG="$1"
      elif [ -z "$HOST" ]; then HOST="$1"
      else echo "unexpected argument: $1" >&2; exit 2
      fi
      ;;
  esac
  shift
done

if [ -z "$SLUG" ] || [ -z "$HOST" ]; then
  echo "usage: sh infra/brand/new-brand.sh <slug> <admin-host> [--port <n>] [--dir <brands dir>] [--force]" >&2
  exit 2
fi
case "$SLUG" in
  *[!a-z0-9-]*|-*|*-) echo "not a brand slug: $SLUG (a-z, 0-9 and inner dashes)" >&2; exit 2 ;;
esac
case "$HOST" in
  *[!a-z0-9.-]*|.*|*.) echo "not a hostname: $HOST" >&2; exit 2 ;;
esac
case "$HOST" in
  *.*) ;;
  *) echo "not a hostname: $HOST (expected e.g. admin.<brand domain>)" >&2; exit 2 ;;
esac
command -v openssl >/dev/null 2>&1 || { echo "openssl is needed: sudo apt-get install -y openssl" >&2; exit 1; }

TARGET="$DIR/$SLUG/.env.brand"
if [ -e "$TARGET" ] && [ "$FORCE" != yes ]; then
  echo "$TARGET already exists; keeping it. Delete it (and the brand's volumes) to start over." >&2
  exit 1
fi

# One loopback port per brand, from 3501, never one another brand's file already holds.
if [ -z "$PORT" ]; then
  PORT=3501
  while grep -qs "^BRAND_API_PORT=$PORT\$" "$DIR"/*/.env.brand; do
    PORT=$((PORT + 1))
  done
else
  case "$PORT" in
    *[!0-9]*|'') echo "not a port: $PORT" >&2; exit 2 ;;
  esac
  for other in "$DIR"/*/.env.brand; do
    [ -f "$other" ] || continue
    [ "$other" = "$TARGET" ] && continue
    if grep -qs "^BRAND_API_PORT=$PORT\$" "$other"; then
      echo "port $PORT is already $(dirname "$other")'s" >&2
      exit 1
    fi
  done
fi

hex() { openssl rand -hex "$1"; }
b64() { openssl rand -base64 "$1"; }

umask 077
mkdir -p "$DIR/$SLUG"
{
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      BRAND_SLUG=) echo "BRAND_SLUG=$SLUG" ;;
      BRAND_ADMIN_HOST=) echo "BRAND_ADMIN_HOST=$HOST" ;;
      BRAND_API_PORT=) echo "BRAND_API_PORT=$PORT" ;;
      BRAND_DB_ROOT_PASSWORD=|BRAND_DB_OWNER_PASSWORD=|BRAND_DB_APP_PASSWORD=|BRAND_DB_ANALYTICS_PASSWORD=|BRAND_VALKEY_PASSWORD=)
        echo "${line}$(hex 24)" ;;
      BRAND_AUTH_SECRET=|BRAND_INTAKE_KEY_SECRET=) echo "${line}$(hex 32)" ;;
      # 32 bytes of base64, which the field-encryption keys require.
      BRAND_HR_FIELD_KEY=|BRAND_COURIER_CREDENTIALS_KEY=|BRAND_MARKETING_CREDENTIALS_KEY=|BRAND_STOREFRONT_CREDENTIALS_KEY=)
        echo "${line}$(b64 32)" ;;
      *) echo "$line" ;;
    esac
  done < "$EXAMPLE"
} > "$TARGET"
chmod 600 "$TARGET"

echo "wrote $TARGET: $SLUG on https://$HOST, API on 127.0.0.1:$PORT"
echo "Keep a copy of it somewhere safe. Next: point $HOST at this server, then deploy:"
echo "  sh infra/brand/deploy.sh <user@server> $SLUG"
