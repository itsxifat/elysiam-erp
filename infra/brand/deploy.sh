#!/bin/sh
#
# Deploy a commit to one brand's ERP, or to every brand's, on the brands server (M31, D-474).
#
#   sh infra/brand/deploy.sh <user@server> <slug|all> [commit]
#
# Run from the repository root in a POSIX shell with git, ssh and scp (Git Bash on Windows
# has all three). Packages the commit with `git archive`, copies it to the server and runs
# infra/brand/server-deploy.sh there: build the server image once, then for each brand run
# its release step (roles, migrations, job queues; that brand's seed on a fresh database),
# start its stack, build its SPAs, swap them into its web root and reload nginx.
# A brand must have been set up first with infra/brand/new-brand.sh on the server.
# docs/runbooks/brand-deploy.md has the one-time server setup and each step.
#
# Settings, all optional:
#   BRAND_SSH_KEY     private key for ssh and scp
#   ERP_BRANDS_DIR    the brands' directory on the server (default erp-brands, under the
#                     remote user's home)

set -eu

TARGET="${1:-}"
WHICH="${2:-}"
COMMIT="${3:-HEAD}"
REMOTE_DIR="${ERP_BRANDS_DIR:-erp-brands}"

if [ -z "$TARGET" ] || [ -z "$WHICH" ]; then
  echo "usage: sh infra/brand/deploy.sh <user@server> <slug|all> [commit]" >&2
  exit 2
fi
case "$WHICH" in
  all) ;;
  *[!a-z0-9-]*|-*|*-) echo "not a brand slug: $WHICH" >&2; exit 2 ;;
esac
case "$REMOTE_DIR" in
  *[!A-Za-z0-9._/-]*) echo "ERP_BRANDS_DIR must be a plain path" >&2; exit 2 ;;
esac

set --
if [ -n "${BRAND_SSH_KEY:-}" ]; then
  set -- -i "$BRAND_SSH_KEY" -o IdentitiesOnly=yes
fi

SHA=$(git rev-parse --short=12 "$COMMIT^{commit}")
if [ "$COMMIT" = HEAD ] && [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "note: uncommitted changes are not deployed; deploying commit $SHA as committed" >&2
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
ARCHIVE="erp-$SHA.tar.gz"

echo "packaging $SHA"
# To stdout: Git for Windows would not understand a /tmp path given as an argument.
git archive --format=tar.gz --prefix="$SHA/" "$SHA" >"$WORK/$ARCHIVE"

echo "copying to $TARGET:$REMOTE_DIR/src/"
ssh "$@" "$TARGET" "mkdir -p '$REMOTE_DIR/src'"
scp -q "$@" "$WORK/$ARCHIVE" "$TARGET:$REMOTE_DIR/src/$ARCHIVE"

echo "deploying $WHICH on $TARGET"
ssh -t "$@" "$TARGET" "set -e; cd '$REMOTE_DIR/src' && rm -rf '$SHA' && tar -xzf '$ARCHIVE' && rm '$ARCHIVE' && sh '$SHA/infra/brand/server-deploy.sh' '$SHA' '$WHICH'"
