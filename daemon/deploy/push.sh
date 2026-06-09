#!/usr/bin/env bash
set -euo pipefail

# push.sh — Mac-side: cross-build and ship the daemon artifacts to a node.
#
#     ./deploy/push.sh <ssh-host> <arch> <role>
#     ./deploy/push.sh vega   arm64 relay
#     ./deploy/push.sh sirius amd64 spoke
#
# It rebuilds the static binary, then scp's the binary + unit + installer into
# ~/wg-selfheal-deploy/ on the node. It deliberately does NOT run sudo over SSH
# — installing is a manual, deliberate step on the hardened node (see output).
#
# This is the first thin slice of Phase G deployment automation.

HOST="${1:-}"
ARCH="${2:-}"
ROLE="${3:-}"

usage() { echo "usage: $0 <ssh-host> <arm64|amd64> <spoke|relay>" >&2; exit 1; }
[[ -n "$HOST" && -n "$ARCH" && -n "$ROLE" ]] || usage
case "$ARCH" in arm64|amd64) ;; *) echo "bad arch: $ARCH" >&2; usage ;; esac
case "$ROLE" in spoke|relay) ;; *) echo "bad role: $ROLE" >&2; usage ;; esac

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$REPO_DIR/deploy"
BIN="$REPO_DIR/dist/wg-selfheal-$ARCH"
REMOTE_DIR="wg-selfheal-deploy"

echo "=== Building static $ARCH binary ==="
( cd "$REPO_DIR" && CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" \
	go build -trimpath -ldflags="-s -w" -o "$BIN" ./cmd/wg-selfheal )
file "$BIN"

echo "=== Shipping to $HOST:~/$REMOTE_DIR/ ==="
ssh "$HOST" "mkdir -p ~/$REMOTE_DIR"
# Binary lands already renamed to what install.sh expects.
scp "$BIN" "$HOST:~/$REMOTE_DIR/wg-selfheal"
scp "$DEPLOY_DIR/wg-selfheal@.service" "$HOST:~/$REMOTE_DIR/"
scp "$DEPLOY_DIR/install.sh" "$HOST:~/$REMOTE_DIR/"

cat <<EOF

=== Shipped. Finish on the node (manual sudo, by design): ===

    ssh $HOST
    cd ~/$REMOTE_DIR
    sudo bash install.sh $ROLE
    journalctl -u wg-selfheal@$ROLE.service -f
EOF
