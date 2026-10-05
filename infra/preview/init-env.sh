#!/bin/sh
#
# Write .env.preview with fresh random secrets (D-352).
#
#   sh infra/preview/init-env.sh elyerp.enfinito.cloud [output-file] [--force]
#
# The output defaults to infra/preview/.env.preview. Needs only `sh` and `openssl`, which a
# fresh Ubuntu server has. Refuses to overwrite an existing file: its database passwords are
# already inside the database's volume, and new ones would lock the application out. Pass
# --force only with a fresh volume.

set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
EXAMPLE="$HERE/.env.preview.example"

FORCE=no
DOMAIN=""
TARGET=""
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=yes ;;
    *)
      if [ -z "$DOMAIN" ]; then DOMAIN="$arg"; else TARGET="$arg"; fi
      ;;
  esac
done
TARGET="${TARGET:-$HERE/.env.preview}"

if [ -z "$DOMAIN" ]; then
  echo "usage: sh infra/preview/init-env.sh <domain> [output-file] [--force]" >&2
  exit 2
fi
case "$DOMAIN" in
  *[!a-z0-9.-]*) echo "not a hostname: $DOMAIN" >&2; exit 2 ;;
esac
if [ -e "$TARGET" ] && [ "$FORCE" != yes ]; then
  echo "$TARGET already exists; keeping it. Delete it (and the postgres volume) to start over." >&2
  exit 1
fi
command -v openssl >/dev/null 2>&1 || { echo "openssl is needed: sudo apt-get install -y openssl" >&2; exit 1; }

hex() { openssl rand -hex "$1"; }
b64() { openssl rand -base64 "$1"; }

umask 077
{
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      PREVIEW_DOMAIN=) echo "PREVIEW_DOMAIN=$DOMAIN" ;;
      PREVIEW_PUBLIC_URL=) echo "PREVIEW_PUBLIC_URL=https://$DOMAIN" ;;
      PREVIEW_DB_ROOT_PASSWORD=|PREVIEW_DB_OWNER_PASSWORD=|PREVIEW_DB_APP_PASSWORD=|PREVIEW_DB_ANALYTICS_PASSWORD=|PREVIEW_VALKEY_PASSWORD=)
        echo "${line}$(hex 24)" ;;
      PREVIEW_AUTH_SECRET=|PREVIEW_INTAKE_KEY_SECRET=) echo "${line}$(hex 32)" ;;
      # 32 bytes of base64, which the field-encryption keys require.
      PREVIEW_HR_FIELD_KEY=|PREVIEW_COURIER_CREDENTIALS_KEY=|PREVIEW_MARKETING_CREDENTIALS_KEY=|PREVIEW_STOREFRONT_CREDENTIALS_KEY=)
        echo "${line}$(b64 32)" ;;
      *) echo "$line" ;;
    esac
  done < "$EXAMPLE"
} > "$TARGET"
chmod 600 "$TARGET"

echo "wrote $TARGET for https://$DOMAIN (secrets generated; keep a copy somewhere safe)"
