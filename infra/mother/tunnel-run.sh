#!/bin/sh
#
# Started by the `tunnel` service. Opens one local forward per brand, from this container's
# MOTHER_TUNNEL_FORWARDS ("<listen port>:<brand port> ..."), to 127.0.0.1:<brand port> on the
# brands' server, and keeps it open. Nothing here can run a command on the far side: the
# account there has no shell, and its key may only open the ports its permitopen lists.

set -eu

: "${MOTHER_TUNNEL_HOST:?MOTHER_TUNNEL_HOST is the brands server}"
: "${MOTHER_TUNNEL_USER:=mother-tunnel}"
: "${MOTHER_TUNNEL_FORWARDS:?MOTHER_TUNNEL_FORWARDS lists <listen>:<brand port> pairs}"

set --
for pair in $MOTHER_TUNNEL_FORWARDS; do
  listen=${pair%%:*}
  target=${pair#*:}
  case "$listen$target" in
    *[!0-9]*) echo "bad forward: $pair" >&2; exit 2 ;;
  esac
  set -- "$@" -L "0.0.0.0:$listen:127.0.0.1:$target"
done

export AUTOSSH_GATETIME=0
exec autossh -M 0 -N \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/tunnel/known_hosts \
  -o IdentitiesOnly=yes -i /etc/tunnel/id_ed25519 \
  "$@" "$MOTHER_TUNNEL_USER@$MOTHER_TUNNEL_HOST"
