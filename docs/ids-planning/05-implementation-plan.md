# 05 — Implementation plan

The executable plan: build order, file-by-file changes, verification, estimate.
Each step is provable on its own before the next — no big-bang integration.

## 1. Build order (de-risked)

| # | Step | Proves | Est. |
|---|---|---|---|
| 1 | `HostDataSource` + `GUI_IDS` factory | journald parsing + perms on a real node; the "off local" core | ~0.5 d |
| 2 | Envelope module + keygen + unit round-trip | sign→seal→open→verify works offline | ~0.5 d |
| 3 | Hub relay routes + bounded sqlite buffer | deposit/drain of opaque blobs, allowlist-gated | ~0.5 d |
| 4 | Shipper (one node) → `MeshDataSource` (master) | end-to-end with master + hub + ONE endpoint | ~1 d |
| 4a | `DaemonSource` (status socket → `TUNNEL` events) + composite node feed | daemon tunnel warnings flow mesh-wide via the relay | ~0.5 d |
| 5 | Fan-out, `node` field + FE column, gap/heartbeat, **view-password** | the real multi-node view | ~1 d |

**~4–4.5 days of code.** Separate and additive: solving **sirius SELinux `/opt`**
(§04) — could be a day on its own; the code does not depend on it.

## 2. File-by-file

**Step 1 — real local feed**
- `gui/backend/app/sources/host.py` (new) — `HostDataSource(DataSource)`; shells
  `journalctl -o json`, maps to `IdsEvent` per §01 table.
- `gui/backend/app/sources/__init__.py` — export it.
- `gui/backend/app/main.py:27` — replace `SOURCE = MockDataSource()` with
  `SOURCE = build_data_source()`.
- `gui/backend/app/sources/factory.py` (new) — `build_data_source()` reading
  `GUI_IDS` (`mock|host|mesh`), mirroring `build_store()` in `app/store.py`
  (local imports for the heavy/optional backends).

**Step 4a — daemon source** (the `wg-selfheal` connection sensor)
- `gui/backend/app/models.py` — add `IdsSource.TUNNEL`.
- `gui/backend/app/sources/daemon.py` (new) — `DaemonSource`: one-shot read of
  `/run/wg-selfheal/status.sock` (`GUI_DAEMON_SOCK`), map `degraded/stale`
  events → `TUNNEL` IdsEvents; degrade-to-empty if absent. Resurrects the cut
  `socket.py` reader against the daemon's existing `status.Server`.
- Compose the node feed: when `GUI_IDS=host` and a daemon sock is set, merge
  `HostDataSource` + `DaemonSource` (factory wires the composite). The shipper
  then ships the union; the master aggregates it mesh-wide. See §01 §3.1a.

**Step 2 — crypto**
- `gui/backend/app/ids_crypto.py` (new) — `seal_sign(payload, node_signing_key,
  master_pub) -> bytes` and `open_verify(blob, master_priv, registry) -> payload`.
  Thin wrapper over PyNaCl (§03). Pure; unit-testable with ephemeral keys.
- `gui/deploy/ids-keygen.py` (new) — mint X25519 (master) / Ed25519 (node) pairs,
  0600, print pubkeys.
- `gui/backend/app/ids_registry.py` (new) — node → verify-key map + loader
  (`GUI_IDS_REGISTRY`), mirroring `app/peers.py`.
- `gui/backend/requirements.txt` — add the pinned crypto lib (test wheels on Pi +
  sirius first, §03).

**Step 3 — hub relay**
- `gui/backend/app/relay.py` (new) — bounded sqlite ring of blobs (reuses the
  sqlite pattern from `app/db.py`); `deposit(blob)` / `drain(since)`.
- `gui/backend/app/main.py` — `POST/GET /api/ids/relay`, both
  `Depends(require_peer)`; mounted only when `GUI_IDS_RELAY=1`.

**Step 4 — ship + aggregate**
- `gui/backend/app/ids_shipper.py` (new) — asyncio task started in `main.py`
  startup when `GUI_IDS_RELAY_URL` is set; tails new `IdsEvent`s by `seq`,
  `seal_sign`, POSTs with retry/backoff.
- `gui/backend/app/sources/mesh.py` (new) — `MeshDataSource(DataSource)`: pull
  (stdlib `urllib`, mirror `app/remote.py`), `open_verify`, dedupe `(node,seq)`,
  merge with a local `HostDataSource`.

**Step 5 — multi-node polish**
- `gui/backend/app/models.py` — add `node: str` to `IdsEvent` (§01).
- `gui/frontend/src/types.ts` + `gui/frontend/src/components/IdsFeed.tsx` — `node`
  field + a NODE column.
- Gap detection + signed heartbeats (§02 §5) surfaced as meta-events.
- **View-password (master only)** — `gui/backend/app/viewauth.py` (new):
  constant-time check of `GUI_VIEW_PASSWORD` (root-owned env), a login route, and
  a dependency on the read routes; fail-closed if unset. Frontend: prompt once,
  hold the token in sessionStorage, re-prompt on 401. Mirrors the shared-token
  shape in `docs/llm-brief-sanitized.md`. See `02-threat-model.md §9`.

## 3. Deployment (after code)

Runbook updates (own `dox:` commit), extending the existing per-node runbooks:
- Add the `GUI_IDS*` env block to `su495-gui.service` per node (§04 §3).
- `usermod -aG systemd-journal <service-user>` on each sensor node (§04 §4).
- Key material into `/var/lib/vpn-pi/ids/` via `ids-keygen.py`; register node
  pubkeys on the master.
- sirius: resolve SELinux `/opt` + `python3.12` venv before enabling its shipper.

## 4. Verification (end to end)

- **Step 1:** on one real node, `curl -s localhost:8787/api/ids` (through an SSH
  tunnel) shows real journal events; insert a USB stick / trigger a fail2ban ban
  and watch it appear.
- **Step 2:** `pytest` — seal+sign then open+verify round-trips; a flipped byte
  fails verify; a wrong signing key fails verify.
- **Step 3:** `POST` a dummy blob to the hub relay from an allowlisted peer (200)
  and from a non-peer (403); `GET ?since=` returns it; confirm the hub stores
  only ciphertext (inspect the row — no plaintext).
- **Step 4:** trigger a real event on one endpoint → confirm it appears in the
  **master's** `/api/ids` (SSH-forwarded), correctly decrypted and attributed;
  stop the endpoint mid-stream → confirm a **sequence gap** is flagged.
- **Step 5:** two endpoints feeding at once → merged newest-first with correct
  per-node NODE column; kill the hub → master shows local feed + mesh marked
  stale (not a silent blank). View-password: wrong/absent password → the
  aggregate is blocked (401), correct password → renders; with no
  `GUI_VIEW_PASSWORD` set on the master, the view fails closed.

## 5. Definition of done (v1)

Real per-node host events, signed by the node and sealed to the master, buffered
by a hub that provably cannot read them, pulled and merged into an SSH-viewable
mesh feed on the master, with sequence-gap + heartbeat detection so suppression
is visible. Demoable on master + hub + one endpoint; remaining endpoints are a
deployment follow-on, not a code dependency.
