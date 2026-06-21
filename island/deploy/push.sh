#!/bin/sh
# Push islandd to a mesh node over wg0 with rsync, then (re)install + start it.
#
#   deploy/push.sh <ssh-target> <binary> [remote-dir]
#   e.g.  deploy/push.sh pi@10.42.0.2 dist/islandd-arm64
#
# Run from the island/ directory (so deploy/ is alongside). Identity, admin token,
# and /etc/islandd/islandd.env on the node are preserved across pushes.
set -eu

[ $# -ge 2 ] || { echo "usage: deploy/push.sh <ssh-target> <binary> [remote-dir]"; exit 1; }
TARGET="$1"
BIN="$2"
REMOTE="${3:-island}"
[ -x "$BIN" ] || { echo "no binary at $BIN — build it first (see RUNBOOK-deploy.md §4a)"; exit 1; }

echo "→ rsync binary + deploy/ to $TARGET:$REMOTE"
ssh "$TARGET" "mkdir -p '$REMOTE'"
rsync -avz "$BIN" "$TARGET:$REMOTE/islandd"
rsync -avz deploy/ "$TARGET:$REMOTE/deploy/"

echo "→ install + start on $TARGET (needs sudo there)"
ssh -t "$TARGET" "cd '$REMOTE' && chmod +x islandd && sudo deploy/install.sh"

echo
echo "Done. Now set this node's role in /etc/islandd/islandd.env (see RUNBOOK-deploy.md §4c),"
echo "then:  ssh $TARGET 'sudo systemctl restart islandd'"
