# IDS mesh — build status

What's actually implemented on `feat/ids-mesh` so far, versus the plan
(README + 01–05). Companion to the node-setup runbook
(`gui/deploy/RUNBOOK-ids-nodes.md`). Updated through Step 3.

## Done (committed, unit-tested)

### Step 1 — real per-node feed + source switch  (`feat:` baec342)
- **`gui/backend/app/sources/host.py`** — `HostDataSource`. Reads the local
  journal via `journalctl -o json` (stdlib subprocess, no new dep) and maps:
  fail2ban bans → `AUTH/CRIT`, sshd logins → `LOGIN/INFO`, kernel usb-storage →
  `USB/WARN`, kernel boot lines → `REBOOT/WARN`. **Degrades to an empty feed** on
  any read failure (no journalctl, permission denied) instead of crashing the API.
- **`gui/backend/app/sources/factory.py`** — `build_data_source()`, mirrors
  `build_store()`: `GUI_IDS` picks `mock` (default) | `host` | `mesh`.
  `main.py`'s `SOURCE` now comes from it. `mesh` is guarded until Step 4.
- Tests: `tests/test_host_source.py` (7) — injected journalctl runner, no live
  journal. Mock default is unchanged, so dev/builder behave exactly as before.

### Step 2 — the envelope + key registry  (`feat:` 1d35651)
- **`gui/backend/app/ids_crypto.py`** — `seal_sign` (node signs the canonical
  payload with Ed25519, then seals payload+signature to the master's X25519 key
  via `nacl.SealedBox`) and `open_verify` (master decrypts, verifies the
  signature against the registered key for the payload's node). **Sign-then-seal**
  hides the signature inside the box; **fail-closed** on any
  decrypt/parse/trust/signature error.
- **`gui/backend/app/ids_registry.py`** — node → Ed25519 verify key, loaded from
  `GUI_IDS_REGISTRY`. Mirrors the wg0 peer allowlist (`app/peers.py`). Empty by
  default = trust no one.
- **`gui/deploy/ids-keygen.py`** — operator-run keygen (private keys 0600, prints
  publics). Real keys are made by the operator on the hosts, never by tooling here.
- `pynacl==1.5.0` pinned in `requirements.txt` (nodes + master only, **not** the
  hub). Tests: `tests/test_ids_crypto.py` (6) — round-trip, tamper, wrong-signer,
  unknown-node, wrong-master, and a check that cleartext is absent from the blob.

### Step 3 — the hub blind relay  (`feat:` 1c37a80)
- **`gui/backend/app/relay.py`** — `RelayBuffer`, a bounded append-only sqlite
  ring of opaque sealed blobs (per-call connections, same style as `app/db.py`).
  `deposit()` appends + evicts beyond the cap; `drain(since)` returns blobs newer
  than the master's cursor, oldest-first. **No crypto import** — the relay can't
  read a blob by construction.
- **`gui/backend/app/main.py`** — `POST`/`GET /api/ids/relay`, both
  `require_peer`-gated, mounted only when the hub sets `GUI_IDS_RELAY=1` (else
  503). Deposit rejects `node != caller` (403) and oversized blobs (413).
- Tests: `tests/test_relay.py` (5) + route-guard smoke (503/403/413/happy path).

### Step 4 — ship + aggregate (the spine)  (`feat:` 610deb6)
- **`gui/backend/app/ids_shipper.py`** — per-node daemon thread: tails the local
  feed, seals+signs unsent events, POSTs to the hub relay. Per-node monotonic
  `seq` **persisted across restarts**; a seq is consumed only on a successful
  POST (hub down → retry, nothing lost); shipped events tracked by id so a
  journal re-read doesn't re-ship. Started from `main.py` startup; **no-op**
  unless a node key + relay URL are set (so the master/hub-only never ship).
- **`gui/backend/app/sources/mesh.py`** — `MeshDataSource` (`GUI_IDS=mesh`, master
  only): pull the relay since a cursor, open+verify each blob, cross-check the
  hub-visible `{node,seq}` against the authenticated inner copy, dedupe by
  `(node,seq)`, merge with the master's own local feed. **Attribution = the
  verified signing identity.** Fail-closed (no key / unknown signer / tamper /
  mismatch → dropped).
- `IdsEvent` gained an optional `node` (set from the verified identity). Factory
  wires `GUI_IDS=mesh → build_mesh_source`.
- Tests: `test_mesh_source.py` (6) + `test_ids_shipper.py` (5), **plus an
  in-process spine smoke** (ship → opaque relay → pull → decrypt → attribute).

**Totals:** 45 unit tests passing. The full suite runs on the builder (Mac) —
`./.venv/bin/python -m unittest discover -s tests` — with no journal, keys, or
network needed (everything is injected).

### Proven LIVE on real hardware (2026-06-06)
Ran `gui/deploy/RUNBOOK-ids-live-test.md` on **vega (hub+sensor) + polaris
(master)**: a real journald event on vega was sealed, buffered as opaque
ciphertext on the hub, pulled by polaris, decrypted, verified, and attributed
(`"node":"10.42.0.2"`) in its aggregate feed. The blind-relay spine works end to
end on actual nodes — not just unit-tested.

Field fixes the live run surfaced (`fix:` f3a0ec6): the fail2ban filter matched
the substring "Ban " in systemd's "Started fail2ban.service" → bogus CRIT;
OpenSSH ≥9.6 logs accepted auths from `sshd-session` not `sshd` → real logins
were invisible. Both fixed + regression-locked.

## Not built yet

### Step 4a — daemon connection sensor
- `IdsSource.TUNNEL` (`models.py`) + `app/sources/daemon.py` — read the
  `wg-selfheal` status socket, map `degraded/stale` → `TUNNEL` events
  (best-effort), compose with `HostDataSource`. Brings daemon tunnel warnings
  into the feed; aggregated mesh-wide by the relay. Reuses the daemon's
  `status.Server`; resurrects the cut `socket.py` reader. (Scope added 2026-06-06.)

### Step 5a/5b — DONE (`feat:` 3e3c01e)
- **NODE column** — `IdsEvent.node` (set from the verified identity) rendered in
  `IdsFeed.tsx`; `types.ts` gains the field.
- **View-password** — `app/viewauth.py` gates the master's browser reads
  (`/api/node`, `/api/ids`) on top of `require_peer`. Active only where
  `GUI_VIEW_PASSWORD` is set (the master); no-op elsewhere. `POST /api/login`
  mints an in-memory session token; the frontend stores it, a 401 drives the
  `LoginGate` overlay. 4 viewauth unit tests; frontend builds clean.

### fail2ban brute-force integration — DONE (`feat:` c0fbe75, 4b6089c)
- **Attack timeline** — sshd `Failed password` aggregated per source IP → one
  `AUTH/WARN` per IP (stable id); **enriched bans** — `AUTH/CRIT` with the jail +
  folded-in failure count. The feed reads as attempt-buildup → ban.
- **Live JAILS panel** — `app/sources/fail2ban.py` → `GET /api/jails` →
  `JailsPanel` (current bans, per-node, labeled "this node"). **Journal-derived**
  (Ban − Unban from `journalctl -u fail2ban`) — **no sudo / no privilege
  elevation**; reuses the `systemd-journal` group. Degrades to empty if the
  journal is unreadable. See `07-fail2ban-bruteforce.md`.

### Debug pass — DONE (`fix:` 484e9a2)
Audit of the IDS/auth/fail2ban surface; fixed: master memory leak
(`MeshDataSource._events` now bounded), brute-force re-ship (stable id), 500-on-sort
(normalize/defensive), the `journalctl` subprocess storm (memo + 3s cache), the
`usePoll` abort-flap (skip-if-inflight), and unbounded/never-expiring view tokens
(TTL + prune). 56 tests; regressions added.

### Step 5c — deferred
- Sequence-gap + signed-heartbeat surfacing so alert *suppression* is visible
  (shipper heartbeats + master per-node expected-seq/last-seen + `IdsSource.MESH`
  meta-events). Not built. (Note for then: `seq` is node-attested, not
  hub-attested — a registered node can poison its own seq space.)

## Env vars introduced so far

| Var | Where | Meaning |
|---|---|---|
| `GUI_IDS` | all | `mock` (default) \| `host` \| `mesh` |
| `GUI_IDS_SINCE`, `GUI_IDS_PER_SENSOR_LIMIT` | sensor nodes | journal query window / per-sensor cap |
| `GUI_IDS_REGISTRY` | master | path to node→verify-key file |
| `GUI_IDS_RELAY` | hub | `1` to enable the relay buffer |
| `GUI_IDS_RELAY_DB`, `GUI_IDS_RELAY_CAP` | hub | relay db path / max buffered blobs |
| `GUI_IDS_BLOB_MAX` | hub | max accepted blob size |
| `GUI_IDS_RELAY_URL` | nodes + master | hub relay base URL (ship to / pull from) |
| `GUI_IDS_NODE_KEY`, `GUI_IDS_MASTER_PUBKEY`, `GUI_IDS_NODE_ADDR` | sensor nodes | shipper: signer / seal-to key / own wg0 addr |
| `GUI_IDS_MASTER_KEY` | master | X25519 private key (opens blobs) |
| `GUI_VIEW_PASSWORD` | master | view-password gate (root-owned env file, never inline) |

## How to try what exists

- **Unit tests** (builder): `cd gui/backend && ./.venv/bin/python -m unittest discover -s tests`.
- **Real local feed** (a Linux node, via the runbook): set `GUI_IDS=host`, join
  `systemd-journal`, restart, then `curl localhost:8787/api/ids`.
- The relay + aggregate need Step 4 before they do anything end to end.
