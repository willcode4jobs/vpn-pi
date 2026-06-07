# Onboard the endpoints — sirius + altair (sensors)

Both are x86 endpoint **sensors**: read their local journal, ship sealed alerts to
the hub (vega `10.42.0.2`), and serve their *own* local feed. They sit at other
sites — **spokes behind NAT**, so the wg tunnel to the hub must stay up for the
shipper. Shared mechanics: [`RUNBOOK-onboard.md`](RUNBOOK-onboard.md) (sensor
role). This doc covers what's different about each box.

| node | wg0 | quirk |
|---|---|---|
| sirius | 10.42.0.5 | SELinux enforcing → `/opt` deploy + py3.12 + policy |
| altair | 10.42.0.4 | **actively-used GUI workstation** → wg-tools + local-browser workarounds |

> Assumption for altair: it's a daily-driver desktop (DE + browser, a person works
> on it), not a headless Pi. If that's wrong, treat it like sirius minus SELinux.

---

## 0. Prereqs (both)
- `harden-base.sh` applied (fail2ban sshd jail, nftables default-deny).
- **fail2ban → journal** (or bans never reach the GUI):
  ```bash
  printf '[Definition]\nlogtarget = SYSTEMD-JOURNAL\n' | sudo tee /etc/fail2ban/fail2ban.local >/dev/null
  sudo systemctl restart fail2ban
  ```
- **wg tunnel up to the hub** — verify with wg tools before anything else (the
  shipper is useless without it):
  ```bash
  sudo wg show wg0                     # expect a peer = hub, "latest handshake" < ~2min
  ping -c2 10.42.0.2                    # hub reachable over wg
  curl -s --max-time 5 http://10.42.0.2:8787/api/health   # {"status":"ok"}
  ```
  Down? `sudo wg-quick up wg0`. Make it boot-persistent: `sudo systemctl enable --now wg-quick@wg0`.

## 1. Common sensor setup (both)
Run the **sensor** path of [`RUNBOOK-onboard.md`](RUNBOOK-onboard.md): code +
py3.12 venv, `systemd-journal` group, **keys** (generate a node key, copy the
hub/master's `master.pub` here, register *this node's* verify key on polaris as
`10.42.0.5=…` / `10.42.0.4=…`), and the env block under `[Service]`:
```ini
Environment=GUI_IDS=host
Environment=GUI_NODE_NAME=sirius            # or altair
Environment=GUI_IDS_NODE_KEY=/var/lib/vpn-pi/ids/node.key
Environment=GUI_IDS_MASTER_PUBKEY=/var/lib/vpn-pi/ids/master.pub
Environment=GUI_IDS_RELAY_URL=http://10.42.0.2:8787
Environment=GUI_IDS_NODE_ADDR=10.42.0.5     # or 10.42.0.4
```
(user is `brichardt` on sirius; adjust the unit's `User=`/`WorkingDirectory=`.)

---

## 2. sirius — SELinux
SELinux blocks a service exec'ing a venv under `/home` (`203/EXEC`). Per
[`RUNBOOK-ids-nodes.md §8`](RUNBOOK-ids-nodes.md):
- deploy the app under **`/opt/vpn-pi`** (not `$HOME`); build the venv there with
  **`python3.12`** (no cp314 wheels for pynacl/pydantic);
- relabel (`semanage fcontext … bin_t` + `restorecon`) and, if denials remain,
  build a tight policy module with `audit2allow` (Tier 2).
- sirius has a browser → view its own feed locally (§3b applies to it too).

## 3. altair — actively-used GUI workstation (workarounds)
A desktop isn't an always-on Pi: the tunnel drops on sleep/reconnect, and the user
wants the dashboard locally. Two workarounds.

### 3a. Keep the tunnel up — wg tools
The shipper delivers only while wg0→hub is up. For a desktop behind NAT:
- **PersistentKeepalive** so the tunnel survives NAT idle timeouts — in altair's
  wg config under the **hub** `[Peer]`:
  ```ini
  # /etc/wireguard/wg0.conf   [Peer] = the hub (vega)
  PersistentKeepalive = 25
  ```
- **Auto-up + survive reboot:** `sudo systemctl enable --now wg-quick@wg0`.
- **After sleep / network change** the handshake may go stale — bounce it:
  ```bash
  sudo wg show wg0            # "latest handshake" stale (> a few min)?
  sudo wg-quick down wg0 && sudo wg-quick up wg0
  ```
  (For hands-off: a NetworkManager `dispatcher.d` hook that re-ups wg0 on
  connect/resume.)
- Degradation is graceful — the shipper retries, never crashes — but undelivered
  alerts are bounded by the journal window, so **tunnel uptime is the thing to
  watch**; keepalive is the fix, `wg show` is the check.

### 3b. View the dashboard locally — no SSH tunnel
altair has a browser, so bind the GUI to **loopback** and open it directly:
- ExecStart `… --host 127.0.0.1 --port 8787`; browse **`http://127.0.0.1:8787`**.
- This is altair's *own* local feed (it's a sensor) — the user sees their machine's
  security events. The whole-mesh view still lives on polaris.
- Optional: a `.desktop` autostart entry that opens the dashboard on login.

### 3c. Coexist with the desktop
- Run as a **system service, loopback-bound** — never a LAN/public bind on a
  daily-driver. The view-password isn't needed (loopback, single local user).
- The user's own ssh logins surface as `LOGIN` events; failed ones as brute-force
  `WARN` — that's the sensor working, not noise to suppress.

---

## 4. Verify (both)
```bash
# tunnel + reachability
sudo wg show wg0 ; curl -s --max-time5 10.42.0.2:8787/api/health

# shipping → the master: fake-ban on the endpoint, watch it on polaris's mesh feed
sudo fail2ban-client set sshd banip 203.0.113.99        # TEST-NET ip; not your own!
#   on polaris: the CRIT ban appears attributed to 10.42.0.5 / 10.42.0.4
# local view (sirius/altair): own feed + the test ban in the JAILS panel
curl -s 127.0.0.1:8787/api/ids | python3 -m json.tool | head
sudo fail2ban-client set sshd unbanip 203.0.113.99      # clean up
```
Healthy endpoint = `wg show` recent handshake + the ban round-trips to polaris's
aggregate. If it doesn't reach polaris but is in the local feed, the tunnel/relay
path is the suspect (re-check §0 / §3a).
