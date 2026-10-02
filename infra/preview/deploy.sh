#!/bin/sh
#
# Deploy a commit to the single-server preview, from a workstation (D-352).
#
#   sh infra/preview/deploy.sh <user@server> [commit]
#
# Run from the repository root in a POSIX shell with git, ssh and scp (Git Bash on Windows
# has all three). Packages the commit with `git archive` (no git remote needed), copies it
# to the server and runs infra/preview/server-deploy.sh there: build the server image, run
# the release step (roles, migrations, job queues; the seed on a fresh database), start the
# stack, build the SPAs under their paths, swap them into nginx's web root and reload nginx.
# docs/runbooks/preview-server.md has the one-time server setup.
#
# Settings, all optional:
#   PREVIEW_SSH_KEY     private key for ssh and scp (e.g. ~/.ssh/envo_vps_ed25519)
#   PREVIEW_DOMAIN      default elyerp.enfinito.cloud
#   PREVIEW_REMOTE_DIR  default elyerp, under the remote user's home
#   PREVIEW_SEED=yes    run the seed again although the database has brands (resets their
#                       names and system accounts to the template's; deploy.md explains)

set -eu

TARGET="${1:-}"
COMMIT="${2:-HEAD}"
DOMAIN="${PREVIEW_DOMAIN:-elyerp.enfinito.cloud}"
REMOTE_DIR="${PREVIEW_REMOTE_DIR:-elyerp}"
SEED="${PREVIEW_SEED:-no}"

if [ -z "$TARGET" ]; then
  echo "usage: sh infra/preview/deploy.sh <user@server> [commit]" >&2
  exit 2
fi
case "$REMOTE_DIR" in
  *[!A-Za-z0-9._/-]*) echo "PREVIEW_REMOTE_DIR must be a plain path" >&2; exit 2 ;;
esac
case "$DOMAIN" in
  *[!a-z0-9.-]*) echo "PREVIEW_DOMAIN must be a hostname" >&2; exit 2 ;;
esac

set --
if [ -n "${PREVIEW_SSH_KEY:-}" ]; then
  set -- -i "$PREVIEW_SSH_KEY" -o IdentitiesOnly=yes
fi

SHA=$(git rev-parse --short=12 "$COMMIT^{commit}")
if [ "$COMMIT" = HEAD ] && [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "note: uncommitted changes are not deployed; deploying commit $SHA as committed" >&2
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
ARCHIVE="elysium-$SHA.tar.gz"

echo "packaging $SHA"
# To stdout: Git for Windows would not understand a /tmp path given as an argument.
git archive --format=tar.gz --prefix="$SHA/" "$SHA" >"$WORK/$ARCHIVE"

echo "copying to $TARGET:$REMOTE_DIR/src/"
ssh "$@" "$TARGET" "mkdir -p '$REMOTE_DIR/src'"
scp -q "$@" "$WORK/$ARCHIVE" "$TARGET:$REMOTE_DIR/src/$ARCHIVE"

echo "deploying on $TARGET"
ssh -t "$@" "$TARGET" "set -e; cd '$REMOTE_DIR/src' && rm -rf '$SHA' && tar -xzf '$ARCHIVE' && rm '$ARCHIVE' && sh '$SHA/infra/preview/server-deploy.sh' '$SHA' '$DOMAIN' '$SEED'"
