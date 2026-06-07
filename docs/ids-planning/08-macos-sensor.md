# 08 — macOS sensor (altair) — design

Make altair (the MacBook, [[altair-real-identity]]) report its own security posture
into the mesh. **Not a second backend** — one new `DataSource` behind the existing
seam. Status: planned, not built.

## 1. What's reused vs new

**Reused, unchanged on macOS** (this is the whole point of the seam):
- the FastAPI app, `ids_shipper`, `ids_crypto`, the relay client, `peers`,
  `models`, the factory pattern, the frontend. pynacl has macOS wheels; the shipper
  POSTs to the hub over wg exactly as on Linux (altair's `10.42.0.4` is already on
  the wg0 allowlist).

**New:**
- `app/sources/macos.py` — `MacDataSource(DataSource)`, the macOS analog of
  `HostDataSource`.
- `app/sources/maclog.py` — the `log show` runner + ndjson parse + degrade (mirrors
  `journal.py`).
- `factory.py` — `GUI_IDS=host` + `platform.system() == "Darwin"` → `MacDataSource`.
- a **launchd** plist (replaces the systemd unit) + a deploy runbook.
- `tests/test_macos_source.py` (canned `log show` ndjson, injected runner).

## 2. The sensor map (macOS sources → `IdsEvent`)

| `IdsSource` | macOS source | needs root? |
|---|---|---|
| `LOGIN` | `last` / `who` (utmpx) — login history, **un-redacted** | **no** |
| `LOGIN` (console) | `log show … process == "loginwindow"` | partial |
| `AUTH/WARN` (brute-force) | `log show … process == "sshd"` "Failed password" | **yes** (IP is `<private>`) |
| `SUDO` (new) | `log show … process == "sudo"` | **yes** (user/cmd `<private>`) |
| `USB` | `log show … subsystem == IOUSBHost` (or `system_profiler SPUSBDataType`) | partial |
| `REBOOT` | `sysctl kern.boottime` / `last reboot` | **no** |
| `AUTH/CRIT` ban | — **n/a, macOS has no fail2ban** (no JAILS panel either) | — |

Mechanism mirrors the journald path: `log show --style ndjson --last <window>
--predicate '<pred>'` → parse ndjson → `IdsEvent`. The brute-force aggregation,
stable ids, TTL cache, and self-node label all reuse the host-source logic.

## 3. THE crux — log-access privilege (read this before deciding)

This is where macOS is **worse than Linux for least-privilege**, and it drives the
whole design. On Linux the `systemd-journal` group gives full read with no root.
On macOS the unified log **redacts dynamic fields as `<private>`** (the IP in a
failed-ssh line, the user/command in a sudo line) unless the reader is **root** (or
private-data logging is enabled system-wide via `sudo log config --mode
private_data:on`, a standing exposure). Full Disk Access does **not** lift this —
it's file access, not log privacy.

So there are two honest postures:

- **Non-root (least-privilege, recommended start).** Run as a user **LaunchAgent**.
  Get `LOGIN` (via `last`/`who`, fully detailed) + `REBOOT` + best-effort non-private
  `log show` events. **Miss** sudo detail and failed-ssh IPs (they'd show as
  `<private>`). Real value (who logged into this Mac, when), zero new privilege —
  aligns with [[prefers-least-privilege]].
- **Root (full coverage).** A **LaunchDaemon** as root gets un-redacted `log show`
  → sudo invocations + failed-ssh with IPs + everything. The cost is a root service
  on a daily-driver laptop. Only do this if the sudo/failed-ssh detail is worth it.

Recommendation: **build the non-root LaunchAgent first** (`last`-based logins +
reboot), see if that visibility is enough; escalate to the root LaunchDaemon only
if you specifically want sudo / failed-ssh-with-IP from the Mac.

## 4. Other wrinkles
- **launchd, not systemd** — a `.plist` (`~/Library/LaunchAgents/…` for the agent,
  `/Library/LaunchDaemons/…` for the daemon) running `uvicorn`. Template in the
  deploy runbook.
- **`log show` is slow** (scans the store) — the existing 3s `TTLCache` + a tight
  predicate + `--last 24h` keep it off the poll path. Degrade-to-empty on any
  failure, same discipline as the journal reader.
- **format drift** — `log show` message text varies by macOS version; parsing is
  best-effort and unit-tested against canned output, never assumed.

## 5. Decisions to confirm
1. **Privilege posture** — non-root LaunchAgent (logins via `last`) vs root
   LaunchDaemon (full `log show`). The §3 trade-off; least-privilege says start
   non-root.
2. **`IdsSource.SUDO`** — add a new enum value (clean, macOS-forward) vs fold sudo
   into `AUTH`. New value touches `models.py` + the frontend `IdsSource` type.
3. **v1 sensor scope** — login + reboot (non-root) is the minimal useful set;
   sudo + failed-ssh + usb are the root/fiddly extras.

## 6. Verification
- **Unit:** inject canned `last`/`log show` output → assert the LOGIN/REBOOT (and,
  if root, SUDO/AUTH) mapping; degrade-to-empty on failure. (`tests/test_macos_source.py`.)
- **Live (altair):** `GUI_IDS=host`, the LaunchAgent/Daemon running, tunnel up; log
  in / reboot / (root: `sudo`) → events appear in altair's own `/api/ids`, and ship
  to the hub → polaris's mesh shows them attributed to `10.42.0.4`.

## 7. Effort
~1 day for `MacDataSource` + `maclog.py` + tests + a launchd template + the runbook,
**if** non-root scope (logins via `last`). The root path adds the LaunchDaemon +
the `log show` predicate tuning. The variable is entirely the privilege decision,
not the code.
