#!/usr/bin/env bash
set -euo pipefail

# --- Logging setup ---
LOG_DIR="/var/log/vpn-pi"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/$(basename "$0" .sh)-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1
echo "[$(date +%H:%M:%S)] Logging to: $LOG_FILE"

# =============================================================================
# open-gui-port.sh — per-node follow-on to harden-base.sh.
#
# Opens the GUI file-store port (8787) in the nftables baseline so the island
# NODES can reach polaris's central SQLite store (GUI_FILES=remote -> polaris).
# This is the per-node port addition the baseline defers ("WG UDP port is
# intentionally NOT opened here — added per-node by a later script").
#
# WHY THIS IS NARROW: the GUI upload/delete API is UNAUTHENTICATED. The firewall
# source scope is the only access control until app auth lands — so the rule
# matches only the named island node IPs (or wg0), never the whole world.
#
# DURABILITY MODEL: harden-base.sh owns /etc/nftables.conf and rewrites it with a
# full `flush ruleset` on every run, so a hand-edit there is clobbered and a live
# `nft add` is lost on reboot. Instead this script installs:
#   1. /usr/local/sbin/vpn-pi-gui-port-apply  — a dedup-idempotent apply helper
#   2. nft-gui-port.service                    — oneshot, After=nftables.service,
#                                                re-asserts the rule on boot
# So the rule survives REBOOT automatically. After re-running harden-base.sh
# (which reloads nftables and flushes the rule), re-assert with:
#       sudo systemctl restart nft-gui-port.service        # or re-run this script
# The apply helper deletes any existing :8787 rule before adding one, so it never
# stacks duplicates no matter how many times it runs.
#
# Run on POLARIS (the file authority), after harden-base.sh:
#       cd ~/projects/vpn-pi && sudo bash -x pi-deployment/open-gui-port.sh
# =============================================================================

# --- Config -----------------------------------------------------------------
# The port the GUI/uvicorn backend binds (RUNBOOK.md §9).
readonly GUI_PORT=8787

# Allowed sources for the (unauthenticated) GUI API. Accepts whatever an nftables
# `ip saddr { ... }` set takes: a CIDR subnet and/or individual IPs.
# Default: the whole wg subnet — only wg peers hold 10.42.0.x, so this is tight
# enough while covering every spoke (incl. the builder 10.42.0.6) with no per-IP
# bookkeeping as nodes come and go. To pin to specific hosts instead, use e.g.
# "10.42.0.4, 10.42.0.5". To scope by interface on the hub, see WG0 MODE below.
readonly ISLAND_SOURCES="10.42.0.0/24"

readonly APPLY_HELPER=/usr/local/sbin/vpn-pi-gui-port-apply
readonly SERVICE_UNIT=/etc/systemd/system/nft-gui-port.service
readonly SERVICE_NAME=nft-gui-port.service
readonly NFT=/usr/sbin/nft

# --- Helpers ----------------------------------------------------------------

require_root() {
	echo "==> [1/5] preflight"
	if [[ "${EUID}" -ne 0 ]]; then
		echo "    must run as root (sudo). aborting." >&2
		exit 1
	fi
	if [[ ! -x "${NFT}" ]]; then
		echo "    ${NFT} not found — is nftables installed (harden-base.sh)?" >&2
		exit 1
	fi
	if ! "${NFT}" list chain inet filter input >/dev/null 2>&1; then
		echo "    'inet filter' input chain absent — run harden-base.sh first." >&2
		exit 1
	fi
	echo "    root + nftables baseline present"
}

# Install a file from a temp copy only when it differs — keeps the run idempotent
# and avoids needless service churn. Args: <tmp> <dest> <mode>
install_if_changed() {
	local tmp="$1" dest="$2" mode="$3"
	if [[ ! -f "${dest}" ]] || ! cmp -s "${tmp}" "${dest}"; then
		install -m "${mode}" -o root -g root "${tmp}" "${dest}"
		echo "    installed ${dest}"
		return 0   # changed
	fi
	echo "    ${dest} unchanged"
	return 1       # unchanged
}

write_apply_helper() {
	echo "==> [2/5] apply helper (${APPLY_HELPER})"
	local tmp
	tmp="$(mktemp)"

	# Two heredocs: the first (unquoted) bakes in the config values; the second
	# (quoted) keeps runtime $vars literal in the installed helper.
	cat > "${tmp}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
# Managed by pi-deployment/open-gui-port.sh — do not edit by hand.
# Idempotently allow the island nodes to reach polaris's GUI store on tcp/${GUI_PORT}.
PORT=${GUI_PORT}
SOURCES="${ISLAND_SOURCES}"
EOF
	cat >> "${tmp}" <<'EOF'
NFT=/usr/sbin/nft

# Remove any prior rule(s) for this port (dedup), then add exactly one. This is
# what makes every invocation idempotent regardless of current ruleset state.
while :; do
	# `|| true`: on a fresh ruleset the grep finds nothing and head closes the
	# pipe early — both non-zero under pipefail, which would otherwise trip set -e
	# and abort here before the rule is ever added.
	handle="$("$NFT" -a list chain inet filter input 2>/dev/null \
		| grep "tcp dport ${PORT}" | grep -oE 'handle [0-9]+' | awk '{print $2}' | head -1 || true)"
	[ -n "${handle:-}" ] || break
	"$NFT" delete rule inet filter input handle "$handle"
done

# WG0 MODE: to scope by interface instead of source IP once wg is up, replace the
# line below with:
#   "$NFT" add rule inet filter input iifname "wg0" tcp dport ${PORT} ct state new accept
# shellcheck disable=SC2086  # the set braces/elements must stay unquoted for nft
"$NFT" add rule inet filter input ip saddr { ${SOURCES} } tcp dport ${PORT} ct state new accept
EOF

	bash -n "${tmp}"   # syntax-check before installing
	install_if_changed "${tmp}" "${APPLY_HELPER}" 0755 || true
	rm -f "${tmp}"
}

write_service() {
	echo "==> [3/5] systemd unit (${SERVICE_UNIT})"
	local tmp
	tmp="$(mktemp)"
	cat > "${tmp}" <<EOF
# Managed by pi-deployment/open-gui-port.sh — do not edit by hand.
# Re-asserts the GUI file-store nftables rule after nftables loads its baseline.
# Survives reboot; PartOf ties it to an nftables RESTART. After a harden-base.sh
# re-run (which RELOADs nftables and flushes the rule), re-assert manually:
#   sudo systemctl restart ${SERVICE_NAME}

[Unit]
Description=Open GUI file-store port (tcp/${GUI_PORT}) for island nodes
After=nftables.service
Wants=nftables.service
PartOf=nftables.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${APPLY_HELPER}

[Install]
WantedBy=multi-user.target
EOF
	install_if_changed "${tmp}" "${SERVICE_UNIT}" 0644 || true
	rm -f "${tmp}"
}

enable_and_apply() {
	echo "==> [4/5] enable + apply"
	systemctl daemon-reload
	# enable so it re-asserts on boot; restart so it applies right now (the helper
	# is dedup-safe, so a restart on an already-applied ruleset is a no-op net).
	systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1 || true
	systemctl restart "${SERVICE_NAME}"
	echo "    ${SERVICE_NAME} enabled + applied"
}

verify() {
	echo "==> [5/5] verify"
	echo "    --- matching input rules ---"
	if "${NFT}" list chain inet filter input | grep --color=never "dport ${GUI_PORT}"; then
		echo "    rule present in live ruleset"
	else
		echo "    WARNING: no tcp/${GUI_PORT} rule found in the live ruleset" >&2
	fi
	echo "    --- listening socket (informational) ---"
	if command -v ss >/dev/null 2>&1; then
		ss -tlnp | grep ":${GUI_PORT}" \
			|| echo "    nothing listening on :${GUI_PORT} yet — bind the service off-loopback (RUNBOOK §9)"
	fi
	echo
	echo "    sources allowed: ${ISLAND_SOURCES}"
	echo "    NOTE: the GUI API is UNAUTHENTICATED — this firewall scope is the"
	echo "          only access control. Keep the source list tight."
	echo "    to re-assert after a harden-base.sh run: systemctl restart ${SERVICE_NAME}"
}

main() {
	require_root
	write_apply_helper
	write_service
	enable_and_apply
	verify
	echo "[$(date +%H:%M:%S)] done."
}

main "$@"
