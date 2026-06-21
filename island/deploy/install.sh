#!/bin/sh
# island node installer — sets up islandd as a systemd service in one command.
#
#   cd island
#   bun run build            # produce ./islandd for this machine (or copy a prebuilt one)
#   sudo deploy/install.sh   # install + start the service, print the admin token
#
# Idempotent: re-running won't clobber an existing identity, admin token, or env file.
set -eu

# Binary: a positional arg wins (it survives `sudo`, unlike ISLANDD_BIN), then the env
# var, then ./islandd. This installer does NOT build — on a node with no Bun (e.g. an
# x86 box), rsync a cross-compiled binary here and pass its path.
BIN="${1:-${ISLANDD_BIN:-./islandd}}"
SVC_USER=islandd
DATA=/var/lib/islandd
ENVF=/etc/islandd/islandd.env
HERE="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "run as root:  sudo deploy/install.sh [binary]"; exit 1; }
if [ ! -x "$BIN" ]; then
  echo "no islandd binary at '$BIN'."
  echo "  • Build host (has Bun):   bun run build   then   sudo deploy/install.sh"
  echo "  • This node (no Bun):     rsync a built binary here, then pass it:"
  echo "                            sudo deploy/install.sh ./islandd"
  echo "    (use deploy/push.sh from the build host — it does this for you; see RUNBOOK-deploy.md)"
  exit 1
fi
command -v systemctl >/dev/null 2>&1 || { echo "this installer needs systemd"; exit 1; }

echo "→ service user + data dir"
id "$SVC_USER" >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin "$SVC_USER"
install -d -o "$SVC_USER" -g "$SVC_USER" -m 0750 "$DATA"

echo "→ binary → /usr/local/bin/islandd"
install -o root -g root -m 0755 "$BIN" /usr/local/bin/islandd

echo "→ config → $ENVF"
if [ -f "$ENVF" ]; then
  echo "  ($ENVF exists — left as-is)"
else
  install -D -o root -g "$SVC_USER" -m 0640 "$HERE/islandd.env.example" "$ENVF"
  echo "  wrote $ENVF (defaults work; edit later for label / file share)"
fi

echo "→ systemd unit → islandd.service"
install -o root -g root -m 0644 "$HERE/islandd.service" /etc/systemd/system/islandd.service
systemctl daemon-reload
systemctl enable --now islandd

# give it a moment to provision identity + token on first boot
sleep 1
echo
echo "✅ islandd is installed and running."
if [ -f "$DATA/admin.token" ]; then
  echo "   Admin token (enter at /admin):  $(cat "$DATA/admin.token")"
fi
echo "   Open  http://<this node's wg0 address>:8787/admin  and paste it."
echo "   Logs:  journalctl -u islandd -f"
