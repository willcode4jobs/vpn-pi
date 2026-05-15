#!/bin/bash
set -euo pipefail

# --- Logging setup ---
LOG_DIR="/var/log/vpn-pi"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/$(basename "$0" .sh)-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1
echo "[$(date +%H:%M:%S)] Logging to: $LOG_FILE"

# =============================================================================
# pi-deployment/harden-base.sh — baseline hardening for VPN mesh nodes
# =============================================================================
# Applied to every node in the mesh: master (polaris), edges, endpoints.
# Self-contained — no external config files required, so this script can be
# scp'd to a fresh node and run standalone.
#
# Idempotent: every section checks state before changing. Safe to re-run.
#
# Targets Pi OS Lite 64-bit on Raspberry Pi (also works on Ubuntu Server
# 24.04 for prototype testing — both are Debian-family).
#
# Explicitly does NOT:
#   - configure WireGuard tunnels (architecture pivot pending)
#   - open the WireGuard UDP port in the firewall (per-node decision, later)
#   - change the SSH port (default 22 for now)
#   - touch /etc/hostname or other Imager-set values
#
# Usage:
#   sudo bash pi-deployment/harden-base.sh
# =============================================================================

readonly DROPIN_SSHD=/etc/ssh/sshd_config.d/00-vpn-pi-hardening.conf
readonly NFTABLES_CONF=/etc/nftables.conf
readonly FAIL2BAN_LOCAL=/etc/fail2ban/jail.local
readonly UNATTENDED_PERIODIC=/etc/apt/apt.conf.d/20auto-upgrades

require_root() {
	if [[ ${EUID} -ne 0 ]]; then
		echo "ERROR: harden-base.sh must run as root (try: sudo bash $0)" >&2
		exit 1
	fi
}

apt_refresh() {
	echo "==> [1/7] apt update + upgrade"
	apt-get update -y
	DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
}

install_packages() {
	echo "==> [2/7] install hardening package set"
	# Idempotent: apt-get install on already-installed packages is a no-op.
	# WireGuard tools only — no tunnel config; kernel module is built into
	# Pi OS bookworm's 6.x kernel.
	DEBIAN_FRONTEND=noninteractive apt-get install -y \
		nftables \
		fail2ban \
		unattended-upgrades \
		wireguard
}

harden_sshd() {
	echo "==> [3/7] SSH hardening (verify, drop-in only if needed)"

	# sshd -T prints the *effective* configuration after parsing /etc/ssh/sshd_config
	# and any Include drop-ins — the cleanest source of truth.
	local pass perm pubkey
	pass=$(sshd -T 2>/dev/null | awk '/^passwordauthentication / {print $2}')
	perm=$(sshd -T 2>/dev/null | awk '/^permitrootlogin / {print $2}')
	pubkey=$(sshd -T 2>/dev/null | awk '/^pubkeyauthentication / {print $2}')

	echo "    current: PasswordAuthentication=${pass} PermitRootLogin=${perm} PubkeyAuthentication=${pubkey}"

	local need_change=0
	[[ "${pass}"   == "no"  ]] || need_change=1
	[[ "${perm}"   == "no"  ]] || need_change=1
	[[ "${pubkey}" == "yes" ]] || need_change=1

	if [[ ${need_change} -eq 0 ]]; then
		echo "    all required directives already correct; no drop-in written"
		return 0
	fi

	echo "    one or more directives wrong; installing drop-in: ${DROPIN_SSHD}"
	# Drop-in approach: leave /etc/ssh/sshd_config untouched (matches the
	# Pi OS / Debian convention of layering overrides under sshd_config.d).
	# sshd reads drop-ins via the Include directive at the top of sshd_config;
	# first occurrence of a directive wins, and Include files are read first,
	# so this drop-in takes precedence over anything in the main config.
	cat > "${DROPIN_SSHD}" <<'EOF'
# Managed by pi-deployment/harden-base.sh — do not edit by hand.
# Re-run the script to refresh.
PasswordAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
EOF
	chmod 0644 "${DROPIN_SSHD}"
	chown root:root "${DROPIN_SSHD}"

	# Validate combined config (main + all drop-ins) before reloading.
	sshd -t
	systemctl reload ssh
	echo "    drop-in installed and ssh reloaded"
}

configure_nftables() {
	echo "==> [4/7] nftables baseline (default-deny inbound)"

	local tmp
	tmp=$(mktemp)
	cat > "${tmp}" <<'EOF'
#!/usr/sbin/nft -f
# Managed by pi-deployment/harden-base.sh — do not edit by hand.
# Default-deny inbound; allow loopback, established/related, SSH, ICMP echo.
# WireGuard UDP port is intentionally NOT opened here — added per-node
# by a later script when the tunnel comes up.

flush ruleset

table inet filter {
	chain input {
		type filter hook input priority filter; policy drop;

		iif "lo" accept

		ct state established,related accept
		ct state invalid drop

		tcp dport 22 ct state new accept

		# ICMP echo (ping) on v4 and v6, plus IPv6 neighbor discovery
		# (required for IPv6 to function at all on the link).
		icmp type echo-request accept
		icmpv6 type echo-request accept
		icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit, nd-router-advert } accept
	}

	chain forward {
		type filter hook forward priority filter; policy drop;
	}

	chain output {
		type filter hook output priority filter; policy accept;
	}
}
EOF

	# Validate ruleset syntax + semantics before touching the live file.
	nft -c -f "${tmp}"

	local changed=0
	if [[ ! -f "${NFTABLES_CONF}" ]] || ! cmp -s "${tmp}" "${NFTABLES_CONF}"; then
		install -m 0644 -o root -g root "${tmp}" "${NFTABLES_CONF}"
		changed=1
		echo "    installed new ${NFTABLES_CONF}"
	else
		echo "    ${NFTABLES_CONF} unchanged"
	fi
	rm -f "${tmp}"

	systemctl enable --now nftables
	# Reload only when the on-disk config actually changed; avoids a
	# brief rule-flush on every re-run.
	if [[ ${changed} -eq 1 ]]; then
		systemctl reload nftables
		echo "    ruleset reloaded"
	fi
}

configure_fail2ban() {
	echo "==> [5/7] fail2ban (sshd jail, maxretry 5, bantime 1h)"

	local tmp
	tmp=$(mktemp)
	cat > "${tmp}" <<'EOF'
# Managed by pi-deployment/harden-base.sh — do not edit by hand.
# Conservative thresholds. Pairs with nftables baseline (banaction).

[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
# Use nftables for ban actions since the baseline ruleset is nftables.
banaction          = nftables-multiport
banaction_allports = nftables-allports

[sshd]
enabled = true
port    = ssh
backend = systemd
EOF

	local changed=0
	if [[ ! -f "${FAIL2BAN_LOCAL}" ]] || ! cmp -s "${tmp}" "${FAIL2BAN_LOCAL}"; then
		install -m 0644 -o root -g root "${tmp}" "${FAIL2BAN_LOCAL}"
		changed=1
		echo "    installed new ${FAIL2BAN_LOCAL}"
	else
		echo "    ${FAIL2BAN_LOCAL} unchanged"
	fi
	rm -f "${tmp}"

	systemctl enable --now fail2ban
	if [[ ${changed} -eq 1 ]]; then
		systemctl restart fail2ban
	fi
	# systemctl returns once the process is launched, but fail2ban-server
	# binds its control socket a moment later — poll until it responds.
	local i
	for i in {1..20}; do
		if fail2ban-client ping >/dev/null 2>&1; then
			break
		fi
		sleep 0.5
	done
	# Confirm the jail actually came up (catches typos in jail.local
	# that fail2ban would otherwise silently ignore).
	fail2ban-client status sshd >/dev/null
	echo "    sshd jail active"
}

configure_unattended_upgrades() {
	echo "==> [6/7] unattended-upgrades (security patches only)"

	# Pi OS / Debian's stock /etc/apt/apt.conf.d/50unattended-upgrades already
	# restricts Origins-Pattern to *-security by default — we deliberately
	# don't overwrite it. We only need to enable the periodic timer that
	# drives unattended-upgrade execution.
	local tmp
	tmp=$(mktemp)
	cat > "${tmp}" <<'EOF'
// Managed by pi-deployment/harden-base.sh — do not edit by hand.
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

	if [[ ! -f "${UNATTENDED_PERIODIC}" ]] || ! cmp -s "${tmp}" "${UNATTENDED_PERIODIC}"; then
		install -m 0644 -o root -g root "${tmp}" "${UNATTENDED_PERIODIC}"
		echo "    installed ${UNATTENDED_PERIODIC}"
	else
		echo "    ${UNATTENDED_PERIODIC} unchanged"
	fi
	rm -f "${tmp}"

	# unattended-upgrades.service is a oneshot that runs at boot; the actual
	# periodic execution is driven by apt-daily-upgrade.timer (enabled by
	# default in Pi OS / Debian). Enabling the service is harmless and makes
	# `systemctl is-enabled` reflect intent.
	systemctl enable unattended-upgrades.service
}

print_summary() {
	echo "==> [7/7] verification summary"

	echo "    --- service states ---"
	local svc state
	for svc in ssh nftables fail2ban unattended-upgrades; do
		state=$(systemctl is-active "${svc}" 2>/dev/null || true)
		printf "    %-22s %s\n" "${svc}" "${state:-unknown}"
	done

	echo "    --- effective sshd directives ---"
	sshd -T 2>/dev/null \
		| grep -E '^(passwordauthentication|permitrootlogin|pubkeyauthentication|port) ' \
		| sed 's/^/    /'

	echo "    --- nftables ruleset ---"
	nft list ruleset | sed 's/^/    /'

	echo "    --- fail2ban sshd jail ---"
	fail2ban-client status sshd | sed 's/^/    /'

	echo
	echo "==> harden-base.sh complete."
}

main() {
	require_root
	apt_refresh
	install_packages
	harden_sshd
	configure_nftables
	configure_fail2ban
	configure_unattended_upgrades
	print_summary
}

main "$@"
