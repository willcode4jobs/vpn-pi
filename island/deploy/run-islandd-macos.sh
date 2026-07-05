#!/bin/bash
# run-islandd-macos.sh — deterministic islandd launcher for a macOS spoke (altair).
#
# WHY THIS EXISTS
# The macOS WireGuard GUI creates a utunN interface, NOT wg0. islandd's wg0 auto-detect
# (resolveHost in src/main.ts) then finds nothing and falls back to 127.0.0.1 — so the node
# binds loopback (unreachable over the mesh) AND announces its address as 127.0.0.1 into the
# registry + every friend token. That wrong wg0 is the real source of altair's 403s and
# "friend mismatch": peers store altair under 127.0.0.1, so friendByWg0(10.42.0.4) never hits.
#
# This script HARDCODES the mesh address + roles so nothing depends on interface auto-detect
# or on the flaky GUI/launchctl env. Pair it with the LaunchAgent plist next to this file so
# it owns islandd cleanly (RunAtLoad + KeepAlive), independent of the WireGuard app's own jobs.
set -euo pipefail

# ==== edit these for the node ==============================================
LABEL=altair
WG0=10.42.0.4          # this node's WireGuard address (the GUI's Interface > Address)
HUB=10.42.0.2          # vega  — durable file share + gate
REG=10.42.0.1          # polaris — friend-code registry + IDS collector
# ===========================================================================

# Run from source with bun by default (matches builder); set ISLANDD_BIN to a compiled
# binary to use that instead. ISLAND_REPO points at the island/ dir when running from source.
REPO="${ISLAND_REPO:-$HOME/vpn-pi/island}"
BIN="${ISLANDD_BIN:-}"

export ISLAND_DATA_DIR="${ISLAND_DATA_DIR:-$HOME/.islandd}"
export ISLAND_LABEL="$LABEL"
export ISLAND_WG0="$WG0"                       # <-- THE FIX: advertise the real mesh address
export ISLAND_REGISTRY_URL="http://$REG:8787"  # announce + friend-by-code
export ISLAND_EVENTS_URL="http://$REG:8787"    # report security events to the collector
export ISLAND_SHARE=remote                     # pull vega's durable share (not a local memory one)
export ISLAND_SHARE_URL="http://$HUB:8787"

# Best-effort real interface name for Home's link status (macOS names it utunN). If
# wireguard-tools can't see the GUI tunnel, fall back to wg0 — Home just shows no peers,
# which is cosmetic and does NOT affect friending or the file share.
WG_BIN="$(command -v wg || true)"
if [ -n "$WG_BIN" ]; then
  IFACE="$("$WG_BIN" show interfaces 2>/dev/null | awk '{print $1}')"
  export ISLAND_WG_IFACE="${IFACE:-wg0}"
fi

# launchd may start us before the WireGuard GUI has the tunnel up, so binding $WG0 would
# fail. Wait until the address is actually assigned, then start — so the bind succeeds first try.
echo "waiting for $WG0 to be assigned (WireGuard tunnel up)…"
until /sbin/ifconfig 2>/dev/null | grep -q "inet $WG0 "; do sleep 2; done
echo "tunnel up — starting islandd bound to $WG0"

if [ -n "$BIN" ]; then
  exec "$BIN" --host "$WG0"
else
  exec bun run "$REPO/src/main.ts" --host "$WG0"
fi
