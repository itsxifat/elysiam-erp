#!/bin/sh
#
# Write infra/mother/.env.mother with fresh secrets, and the tunnel's key pair (M32, D-497).
#
#   sh infra/mother/new-env.sh <domain> <brands-server-host> [output-file] [--force]
#
# Needs `sh`, `openssl` and `ssh-keygen`. Refuses to overwrite an existing file: its
# database passwords live in the database volume, and its secrets key is what opens every
# stored brand connection.

set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
FORCE=no
DOMAIN=""
TUNNEL_HOST=""
TARGET=""
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=yes ;;
    *)
      if [ -z "$DOMAIN" ]; then
        DOMAIN="$arg"
      elif [ -z "$TUNNEL_HOST" ]; then
        TUNNEL_HOST="$arg"
      else
        TARGET="$arg"
      fi
      ;;
  esac
done
TARGET="${TARGET:-$HERE/.env.mother}"

if [ -z "$DOMAIN" ] || [ -z "$TUNNEL_HOST" ]; then
  echo "usage: sh infra/mother/new-env.sh <domain> <brands-server-host> [output-file] [--force]" >&2
  exit 2
fi
for name in "$DOMAIN" "$TUNNEL_HOST"; do
  case "$name" in
    *[!a-z0-9.-]*)
      echo "not a hostname: $name" >&2
      exit 2
      ;;
  esac
done
if [ -e "$TARGET" ] && [ "$FORCE" != yes ]; then
  echo "$TARGET already exists; keeping it." >&2
  exit 1
fi
command -v openssl >/dev/null 2>&1 || {
  echo "openssl is needed" >&2
  exit 1
}

umask 077
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    MOTHER_DOMAIN=) echo "MOTHER_DOMAIN=$DOMAIN" ;;
    MOTHER_PUBLIC_URL=) echo "MOTHER_PUBLIC_URL=https://$DOMAIN" ;;
    MOTHER_TUNNEL_HOST=) echo "MOTHER_TUNNEL_HOST=$TUNNEL_HOST" ;;
    MOTHER_DB_ROOT_PASSWORD= | MOTHER_DB_OWNER_PASSWORD= | MOTHER_DB_APP_PASSWORD=)
      echo "${line}$(openssl rand -hex 24)"
      ;;
    MOTHER_AUTH_SECRET=) echo "${line}$(openssl rand -hex 32)" ;;
    MOTHER_SECRETS_KEY=) echo "${line}$(openssl rand -base64 32)" ;;
    *) echo "$line" ;;
  esac
done <"$HERE/.env.mother.example" >"$TARGET"

mkdir -p "$HERE/tunnel"
if [ ! -e "$HERE/tunnel/id_ed25519" ]; then
  ssh-keygen -q -t ed25519 -N '' -C "mother-tunnel@$DOMAIN" -f "$HERE/tunnel/id_ed25519"
  echo "tunnel key: $HERE/tunnel/id_ed25519.pub (install it on $TUNNEL_HOST: mother-deploy.md)"
fi
echo "wrote $TARGET"
