#!/bin/bash
set -euo pipefail

# =============================================================================
# VPN Pi project — base hardening bootstrap
# =============================================================================
# Idempotent bootstrap for a fresh Ubuntu Server 24.04 or Pi OS Lite 64-bit
# host. Installs the hardening package set, deploys the project's hardened
# sshd / nftables / fail2ban configs, and enables unattended security upgrades.
#
# Usage (run from anywhere; the script locates its own repo):
#   sudo bash prototype/scripts/harden-base.sh
#
# Re-running on an already-hardened host is safe: package installs become
# no-ops, configs are overwritten with the same content, and services reload.
# =============================================================================

if [[ ${EUID} -ne 0 ]]; then
	echo "ERROR: harden-base.sh must run as root (EUID=${EUID}). Try: sudo bash $0" >&2
	exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_DIR="${REPO_DIR}/configs"

SSHD_SRC="${CONFIG_DIR}/sshd/sshd_config.hardened"
NFT_SRC="${CONFIG_DIR}/nftables/baseline.nft"
F2B_SRC="${CONFIG_DIR}/fail2ban/jail.local"

# Fail fast if any source config is missing — easier to debug than a
# half-applied hardening run.
for src in "${SSHD_SRC}" "${NFT_SRC}" "${F2B_SRC}"; do
	if [[ ! -f "${src}" ]]; then
		echo "ERROR: missing config source: ${src}" >&2
		exit 1
	fi
done

echo "==> [1/10] apt update"
apt-get update -y

echo "==> [2/10] apt upgrade"
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y

echo "==> [3/10] install hardening package set"
DEBIAN_FRONTEND=noninteractive apt-get install -y \
	nftables \
	tcpdump \
	git \
	fail2ban \
	lynis \
	unattended-upgrades \
	curl \
	vim

echo "==> [4/10] enable unattended-upgrades"
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> [5/10] validate + install hardened sshd_config"
# Validate the candidate file before touching /etc/ssh/sshd_config so a
# syntax error never reaches the live config.
sshd -t -f "${SSHD_SRC}"
install -m 0644 -o root -g root "${SSHD_SRC}" /etc/ssh/sshd_config
# Sanity-check the now-installed file too (catches Include drop-in conflicts).
sshd -t

echo "==> [6/10] reload ssh"
systemctl reload ssh

echo "==> [7/10] validate + install nftables baseline ruleset"
nft -c -f "${NFT_SRC}"
install -m 0644 -o root -g root "${NFT_SRC}" /etc/nftables.conf
systemctl enable nftables
systemctl restart nftables

echo "==> [8/10] install fail2ban jail.local"
install -m 0644 -o root -g root "${F2B_SRC}" /etc/fail2ban/jail.local
systemctl enable fail2ban
systemctl restart fail2ban
# Confirm fail2ban parsed the new config and the sshd jail came up.
fail2ban-client status sshd >/dev/null

echo "==> [9/10] lynis audit (informational only — does not gate this script)"
# Findings are logged to /var/log/lynis.log and /var/log/lynis-report.dat.
# We do not act on them here; remediation is Phase 10 work.
if ! lynis audit system --quick --quiet; then
	echo "    lynis exited non-zero — see /var/log/lynis.log; continuing."
fi

echo "==> [10/10] done"
echo "    sshd:     reloaded with $(grep -c '^[^#]' /etc/ssh/sshd_config) active directives"
echo "    nftables: $(nft list ruleset | wc -l) lines of ruleset loaded"
echo "    fail2ban: $(fail2ban-client status | awk -F': *' '/Number of jail/ {print $2}') jail(s) active"
