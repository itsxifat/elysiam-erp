#!/bin/sh
#
# Deploy a commit to the owner console's server (M32, D-497).
#
#   sh infra/mother/deploy.sh <user@server> [commit]
#
# Run from the repository root in a POSIX shell with git, ssh and scp (Git Bash on Windows
# has all three). Packages the commit with `git archive`, copies it to the server and runs
# infra/mother/server-deploy.sh there: build the mother's images, run its release step
# (roles, migrations), start the stack (Postgres, tunnel, worker, API), swap the console's
# files into its web root and reload nginx.
#
# The server must have been set up first: .env.mother and the tunnel's files written by
# infra/mother/new-env.sh, the brands server's host key in tunnel/known_hosts.
# docs/runbooks/mother-deploy.md has the one-time setup and each step.
#
# Deploy the mother from the same commit as the brands: it reads a brand only when the
# brand's migrations are exactly the ones this commit ships (D-481).
#
# Settings, all optional:
#   MOTHER_SSH_KEY   private key for ssh and scp
#   MOTHER_DIR       the mother's directory on the server (default mother, under the remote
#                    user's home)

set -eu

TARGET="${1:-}"
COMMIT="${2:-HEAD}"
REMOTE_DIR="${MOTHER_DIR:-mother}"

if [ -z "$TARGET" ]; then
  echo "usage: sh infra/mother/deploy.sh <user@server> [commit]" >&2
  exit 2
fi
case "$REMOTE_DIR" in
  *[!A-Za-z0-9._/-]*) echo "MOTHER_DIR must be a plain path" >&2; exit 2 ;;
esac

set --
if [ -n "${MOTHER_SSH_KEY:-}" ]; then
  set -- -i "$MOTHER_SSH_KEY" -o IdentitiesOnly=yes
fi

SHA=$(git rev-parse --short=12 "$COMMIT^{commit}")
if [ "$COMMIT" = HEAD ] && [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "note: uncommitted changes are not deployed; deploying commit $SHA as committed" >&2
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
ARCHIVE="mother-$SHA.tar.gz"

echo "packaging $SHA"
# To stdout: Git for Windows would not understand a /tmp path given as an argument.
git archive --format=tar.gz --prefix="$SHA/" "$SHA" >"$WORK/$ARCHIVE"

echo "copying to $TARGET:$REMOTE_DIR/src/"
ssh "$@" "$TARGET" "mkdir -p '$REMOTE_DIR/src'"
scp -q "$@" "$WORK/$ARCHIVE" "$TARGET:$REMOTE_DIR/src/$ARCHIVE"

echo "deploying the owner console on $TARGET"
ssh -t "$@" "$TARGET" "set -e; cd '$REMOTE_DIR/src' && rm -rf '$SHA' && tar -xzf '$ARCHIVE' && rm '$ARCHIVE' && sh '$SHA/infra/mother/server-deploy.sh' '$SHA'"
