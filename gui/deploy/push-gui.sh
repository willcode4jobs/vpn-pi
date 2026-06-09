#!/usr/bin/env bash
set -euo pipefail

# push-gui.sh — build the frontend on the Mac and ship the static bundle to nodes
# over ssh/wg0. The frontend is a static artifact (build-on-Mac, ship-the-artifact,
# same model as the daemon); each node serves it from its own backend, so nothing
# heavy (npm/node) ever lands on a hardened node.
#
# The backend (Python) is deployed separately via `git pull` on the node — this
# script only moves the built UI.
#
# usage:  ./push-gui.sh <host> [<host> ...]
#   ./push-gui.sh polaris vega sirius altair arcturus
#
# Per Option B each node then runs its own backend:
#   polaris:  GUI_FILES=sqlite GUI_DB_PATH=/var/lib/vpn-pi/island.db GUI_NODE_NAME=polaris
#   others :  GUI_FILES=remote GUI_FILES_URL=http://<polaris-wg0>:8787 GUI_NODE_NAME=<node>

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <host> [<host> ...]" >&2
  exit 1
fi

cd "$(dirname "$0")/../frontend"

echo "[*] building frontend (tsc + vite) ..."
npm run build                       # -> ../backend/static/

SRC="../backend/static/"
DEST="projects/vpn-pi/gui/backend/static/"   # repo path on the node (~ implied)

for host in "$@"; do
  echo "[*] $host: shipping static bundle -> ~/$DEST"
  ssh "$host" "mkdir -p ~/$DEST"
  rsync -az --delete "$SRC" "$host:~/$DEST"
done

echo "[✓] done. Restart each node's backend to serve the new UI."
