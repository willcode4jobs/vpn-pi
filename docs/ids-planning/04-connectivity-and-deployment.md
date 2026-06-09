# 04 — Connectivity and deployment

Why the hub is the only possible rendezvous, what runs where, and the per-node
deploy reality (including the blockers that will actually cost time).

## 1. The reachability facts (from the file-store migration)

Measured, `docs/worklog-2026-06-05.md`:

| Path | Result |
|---|---|
| any spoke → **hub** (vega `10.42.0.2`) | ~4 ms, 0% loss — **reliable** |
| master ↔ hub | reliable (master is a spoke; spoke→hub works) |
| spoke → **spoke** (e.g. builder → polaris `10.42.0.1`) | **100% loss** — dead |

Node → wg0 address map: polaris `10.42.0.1` (master), vega `10.42.0.2` (hub),
altair `10.42.0.4`, sirius `10.42.0.5`, builder `10.42.0.6`.

Consequence: **everything must rendezvous at the hub.** Nodes push to the hub
(spoke→hub ✓); the master pulls from the hub (master→hub ✓). No spoke→spoke. The
"hub routes spoke-to-spoke via IP-forwarding + `AllowedIPs=10.42.0.0/24`" idea is
flagged in the worklog as a **separate topology project** and is not a
prerequisite here — and wouldn't help trust anyway (§02).

## 2. What runs where

| Node | `GUI_IDS` | Role in IDS | Binds |
|---|---|---|---|
| sirius, altair | `host` | local feed + **shipper** → hub | loopback (+ own UI) |
| vega (hub) | `host` | local feed + **relay buffer** (`GUI_IDS_RELAY=1`) | `10.42.0.2:8787` (already open to wg0) |
| polaris (master) | `mesh` | **aggregator** (pull+decrypt+merge) + own local feed | loopback only |
| builder (Mac) | `mock`/`host` | viewer; optional local feed | loopback |

The relay rides the hub's **existing** `8787` (already wg0-exposed via
`open-gui-port.sh`). **No new port, no new nftables rule** — the relay is just
two more routes on the same FastAPI app, gated by the same `require_peer`. This
is simpler than a second port and keeps the firewall surface unchanged.

## 3. Per-node env (extends the existing `GUI_*` set)

Added to each node's `su495-gui.service` (`Environment=` lines), alongside the
existing `GUI_FILES* / GUI_NODE_NAME / GUI_PORT`:

```
# every real-sensor node (sirius, altair, vega, polaris-local)
GUI_IDS=host
GUI_IDS_NODE_KEY=/var/lib/vpn-pi/ids/node.key          # Ed25519 priv (0600)
GUI_IDS_MASTER_PUBKEY=/var/lib/vpn-pi/ids/master.pub   # to seal to
GUI_IDS_RELAY_URL=http://10.42.0.2:8787                # where the shipper posts

# hub (vega) — also turn the relay buffer on
GUI_IDS_RELAY=1

# master (polaris) — aggregator instead of a plain host feed
GUI_IDS=mesh
GUI_IDS_MASTER_KEY=/var/lib/vpn-pi/ids/master.key      # X25519 priv (0600, crown jewel)
GUI_IDS_REGISTRY=/var/lib/vpn-pi/ids/registry          # node → verify key
GUI_IDS_RELAY_URL=http://10.42.0.2:8787                # where to pull from
```

`/var/lib/vpn-pi` is already the service's only writable path
(`ReadWritePaths=/var/lib/vpn-pi` in `su495-gui.service`), so the `ids/` keydir
fits with no hardening change.

## 4. Journal read permission (do NOT run as root)

`HostDataSource` shells to `journalctl`. The service runs as an unprivileged user
(`billy`, or `brichardt` on sirius). Grant journal read by group, not root:

```
sudo usermod -aG systemd-journal <service-user>
```

fail2ban, auditd, sshd, and kernel USB events all surface in the journal, so
group membership covers every sensor in §01's table without a sudoers carve-out.
Keep `NoNewPrivileges=true` and the existing `ProtectSystem=strict`.

## 5. Per-node deploy — and the blockers that cost time

This is the honest part. The multi-node story needs **a backend actually running
on each endpoint**, and that is partly blocked:

- **sirius (x86, `brichardt`, SELinux enforcing).** SELinux blocks executing a
  venv under `/home` (`203/EXEC`). The fix — deploy out of the home into a system
  path (e.g. `/opt`) — is documented in `RUNBOOK-sirius.md` but **not yet done**.
  This must be solved before sirius can ship alerts. Budget real time for it.
- **sirius Python 3.14.** No cp314 wheels for the pinned deps (and now the crypto
  lib). Build the venv with `python3.12` (`RUNBOOK-sirius.md` §2).
- **altair.** Not yet stood up as a node.
- **arcturus.** Does not exist yet.

The aggregation code (relay + mesh source + crypto) can be **built and demoed end
to end with master + hub + one endpoint** long before all nodes are up. Don't
gate the code on the deployment tail.

## 6. Viewing the aggregate (the consequence of keeping it off the hub)

**Decided: the mesh view is the same React GUI, served by the master,
browser-viewable, and password-gated.** It is *not* served by the hub — doing so
would force the hub to decrypt/render alerts and break blind-relay. Instead:

- The master runs the same frontend bundle as the fileshare; the IDS panel shows
  the merged mesh feed. It looks and behaves identically to the fileshare GUI.
- The master is loopback-bound (a spoke unreachable over wg0), so the operator
  reaches it the way polaris is already administered — an **SSH local-forward**,
  then a normal browser tab:
  ```
  ssh -L 8787:127.0.0.1:8787 polaris    # then browse http://127.0.0.1:8787 on the Mac
  ```
  This matches CLAUDE.md's "Master admin via SSH/CLI."
- A **session view-password** (`GUI_VIEW_PASSWORD` on the master) gates the
  aggregate — the consolidated security feed is sensitive, so viewing is gated in
  addition to the SSH/loopback access. See `02-threat-model.md §9` and the
  `app/viewauth.py` build item in `05-implementation-plan.md`.

Per-node panels (each node's own local feed) remain directly browsable on that
node; only the *aggregate* is master-served + password-gated.

## 7. Firewall / nftables

No change. The relay reuses `8787`, already opened to wg0 by
`pi-deployment/open-gui-port.sh` (reboot-safe via `nft-gui-port.service`,
re-asserted after any `harden-base.sh` run — see `gui/deploy/NFTABLES-gui-port.md`).
If we ever split the relay to its own port, extend that script with a
`RELAY_PORT` rather than hand-editing `nftables.conf`.
