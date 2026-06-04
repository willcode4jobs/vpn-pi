#!/usr/bin/env bash
set -euo pipefail

# install.sh — node-side installer for the wg-selfheal daemon.
#
# Run ON the target node (vega/sirius), with sudo, from the directory the
# Mac-side push.sh dropped the artifacts into:
#
#     sudo bash install.sh <role>      # role = spoke | relay
#
# Expects alongside it:
#   - wg-selfheal            (the correct-arch binary, already renamed)
#   - wg-selfheal@.service   (the templated systemd unit)
#
# Idempotent: re-running installs the new binary/unit and restarts the service.

# --- Logging setup ---
LOG_DIR="/var/log/vpn-pi"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/$(basename "$0" .sh)-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1
echo "[$(date +%H:%M:%S)] Logging to: $LOG_FILE"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_SRC="$SCRIPT_DIR/wg-selfheal"
UNIT_SRC="$SCRIPT_DIR/wg-selfheal@.service"
BIN_DST="/usr/local/bin/wg-selfheal"
UNIT_DST="/etc/systemd/system/wg-selfheal@.service"

require_root() {
	if [[ $EUID -ne 0 ]]; then
		echo "ERROR: must run as root (sudo bash install.sh <role>)" >&2
		exit 1
	fi
}

parse_role() {
	ROLE="${1:-}"
	case "$ROLE" in
		spoke|relay) ;;
		*)
			echo "ERROR: role must be 'spoke' or 'relay' (got '${ROLE:-<empty>}')" >&2
			exit 1
			;;
	esac
	echo "[$(date +%H:%M:%S)] Role: $ROLE"
}

check_artifacts() {
	echo "=== Verifying artifacts ==="
	[[ -f "$BIN_SRC" ]]  || { echo "ERROR: missing binary at $BIN_SRC" >&2; exit 1; }
	[[ -f "$UNIT_SRC" ]] || { echo "ERROR: missing unit at $UNIT_SRC" >&2; exit 1; }
	# Confirm the binary matches this host's architecture before installing it.
	echo "Binary: $(file -b "$BIN_SRC")"
	echo "Host:   $(uname -m)"
}

install_binary() {
	echo "=== Installing binary -> $BIN_DST ==="
	install -m 0755 -o root -g root "$BIN_SRC" "$BIN_DST"
	echo "Installed: $("$BIN_DST" --help 2>&1 | head -1 || true)"
}

install_unit() {
	echo "=== Installing unit -> $UNIT_DST ==="
	install -m 0644 -o root -g root "$UNIT_SRC" "$UNIT_DST"
	systemctl daemon-reload
}

enable_service() {
	local svc="wg-selfheal@${ROLE}.service"
	echo "=== Enabling + (re)starting $svc ==="
	systemctl enable "$svc"
	systemctl restart "$svc"
	sleep 1
	systemctl --no-pager --full status "$svc" || true
}

main() {
	require_root
	parse_role "${1:-}"
	check_artifacts
	install_binary
	install_unit
	enable_service
	echo
	echo "[$(date +%H:%M:%S)] Done. Watch it think with:"
	echo "    journalctl -u wg-selfheal@${ROLE}.service -f"
}

main "$@"
