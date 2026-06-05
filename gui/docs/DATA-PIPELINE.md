# Mesh GUI — Data Pipeline (Mock → Real, the Coupling Lever)

How the per-node GUI gets its data, from the browser down to the WireGuard
kernel, and the one architectural seam that lets us defer the big decision
without blocking the build.

This doc covers the **data path** specifically. For the GUI's product scope and
non-negotiables see [`../../GUI-CONTEXT.md`](../../GUI-CONTEXT.md); for the
daemon internals see `daemon/DAEMON-CONTEXT.md` (on the `daemon-v1` branch).

---

## 1. The whole picture in one diagram

```
  Browser  (127.0.0.1:5173 dev  /  :8787 prod)
     │  HTTP poll every 2s:  GET /api/mesh , GET /api/ids
     ▼
  FastAPI backend            gui/backend/  — binds 127.0.0.1 ONLY, never 0.0.0.0
     │  SOURCE.mesh()  /  SOURCE.ids()
     ▼
  DataSource  ◄───────────── the COUPLING LEVER (one binding, selected by env)
     ├── MockDataSource       GUI_SOURCE=mock   (default) synthetic, no daemon
     └── SocketDataSource     GUI_SOURCE=socket  reads the daemon ↓
              │  connect unix socket → read ONE json snapshot → EOF
              ▼
  wg-selfheal daemon         Go, runs as DynamicUser + CAP_NET_ADMIN (not root)
     status.Server  ──serves──►  /run/wg-selfheal/status.sock   (0660)
         ▲  Publish(statuses, events, now)  — once per tick
     read → decide → act  loop
         │  wgctrl (netlink, no `wg show` parsing)
         ▼
  WireGuard kernel  (wg0)
```

Two processes, one node. The daemon is the privileged component that touches
WireGuard; the GUI is an unprivileged reader. They meet at a unix socket.

---

## 2. The coupling lever (the central idea)

`GUI-CONTEXT.md` names exactly one open architectural decision — *how the app
gets its data*:

- **App reads the daemon's status socket** → daemon is **on the critical path**
  (if the daemon dies, the GUI goes dark).
- **App queries `wg` directly** → daemon stays **parallel / off-path** (GUI works
  even if the daemon is down).

That decision was deliberately **parked** ("decide on the Gantt, not now"). The
trap would be to block GUI progress until it's resolved, or to silently bake one
choice in. Instead we made it a **code seam**: everything upstream depends only
on an interface, `DataSource`. Swapping the implementation pulls the lever, and
it's an **env flip, not a code edit**:

```bash
GUI_SOURCE=mock                                                  # default
GUI_SOURCE=socket  GUI_STATUS_SOCK=/run/wg-selfheal/status.sock  # real daemon data
```

We implemented the **socket** arm (daemon on critical path). The **direct-wg**
arm (`WgDataSource`) is deliberately *not* built — see §10 for why.

---

## 3. Components

### 3.1 Frontend — `gui/frontend/`
Vite + React + TypeScript (`.tsx`). Built on the Mac → static assets the backend
serves (same "build-on-Mac, ship-the-artifact" model as the daemon; nothing
heavy lands on a hardened node).

- **One screen** (`src/App.tsx`): `StatusBar` + `MeshHealth` + `IdsFeed`.
- **Polling** (`src/api.ts`): a `usePoll` hook hits each endpoint every **2s**.
  On a failed fetch it keeps the last good data on screen and flags `stale` —
  which the UI renders as **`SIGNAL LOST`**. A node going silent *is* the alarm,
  so we surface the absence loudly rather than blanking to an empty table.
- **Aesthetic**: ops-console — warm near-black, IBM Plex Mono, state by colour +
  left rail + column position, no icons/emoji/rounded cards.

### 3.2 Backend — `gui/backend/`
FastAPI, **binds `127.0.0.1` only** (override `GUI_BIND` for a wg0 address; never
`0.0.0.0`). Three JSON endpoints + serves the built frontend in prod.

| Endpoint        | Returns                          | Polled by        |
|-----------------|----------------------------------|------------------|
| `GET /api/mesh` | `MeshSnapshot`                   | mesh-health panel|
| `GET /api/ids`  | `list[IdsEvent]` (newest-first)  | IDS feed panel   |
| `GET /api/health`| `{status: ok}`                  | liveness         |

The `DataSource` is wired in `app/main.py` and **nowhere else** — that binding is
the lever (§2).

### 3.3 The DataSource seam — `gui/backend/app/sources/`
- `base.py` — the `DataSource` protocol: `mesh() -> MeshSnapshot`,
  `ids(limit) -> list[IdsEvent]`. Small on purpose: it's the contract the real
  daemon socket has to satisfy.
- `mock.py` — `MockDataSource`: a synthetic 5-node mesh (polaris/vega/sirius/
  altair/arcturus) whose handshake ages advance off a fixed epoch, so the screen
  looks live under polling. Deterministic — a reload doesn't reshuffle.
- `socket.py` — `SocketDataSource`: connects to the daemon's unix socket, reads
  one JSON snapshot, maps it to the models (§4, §5).

### 3.4 The daemon status socket — `daemon/internal/status/` (branch `feat/daemon-status-socket`)
A unix-domain socket that sits **beside** the daemon's `read → decide → act`
loop, never inside it.

- **Protocol**: connect → receive one JSON snapshot → EOF. No request grammar to
  version; `nc -U <sock>` is a working client.
- **`Publish(statuses, events, now)`** — called by the loop each tick; a pure
  data handoff, no I/O. Replaces the current peer set, appends new transitions to
  a bounded ring (last 100).
- **`Serve(ctx)`** — the accept loop. Each connection gets the latest published
  snapshot. Removes any stale socket file, `chmod 0660`. Cancelling `ctx` closes
  the listener cleanly.
- The **decide core is untouched** — the socket is a read/publish surface only,
  so all the threshold/breaker logic still lives in exactly one place.

Enabled with the daemon flag `--status-sock=/run/wg-selfheal/status.sock`
(empty = disabled; off by default).

---

## 4. Why the daemon, not raw `wg`? (the thing that justifies B)

The daemon is the **single source of truth for classification**. A raw `wg`
read gives you handshake ages and endpoints — from which you can derive `ok` vs
`stale` — but it **cannot** tell you `degraded`. `degraded` is a *circuit-breaker
latch*: it means the daemon tried to remediate a peer, exhausted its attempts,
and gave up. That state exists only inside the daemon.

So reading the daemon socket lets the GUI render `degraded` for free, without
re-implementing the decide ladder and without giving the web tier `CAP_NET_ADMIN`
to poke at WireGuard. That's the core argument for path B over path A.

---

## 5. The wire contract (one shape, three layers)

The same structure is declared at three layers, kept deliberately in lock-step so
the seam is a *decode*, not a *translation*:

```
daemon Go structs   →   gui/backend/app/models.py   →   gui/frontend/src/types.ts
(heal.PeerStatus,        (Pydantic)                      (TypeScript)
 alert.Event)
```

The JSON the socket serves (real capture from the running daemon):

```json
{
  "node":   { "name": "polaris", "role": "relay",
              "public_key": "pol1Xn4kQ2bV8sR0aZ7yL3mC6dF9gH2jK5nP8qT1wE=",
              "wg_interface": "wg0" },
  "peers": [
    { "peer": "veg7…iO=", "name": "vega", "state": "ok",
      "last_handshake": "2026-06-04T22:49:05-04:00", "endpoint": "203.0.113.41:51820" },
    { "peer": "arc9…uI=", "name": "arcturus", "state": "degraded",
      "last_handshake": null, "endpoint": null }
  ],
  "events": [
    { "peer": "arc9…uI=", "name": "arcturus", "kind": "degraded",
      "from": "stale", "to": "degraded",
      "last_handshake": null, "endpoint": null, "at": "2026-06-04T22:49:11-04:00" }
  ],
  "generated_at": "2026-06-04T22:49:19-04:00"
}
```

**Field notes that matter:**
- `peers[*]` field names + null semantics align **1:1** with the GUI's
  `PeerStatus`, so `mesh()` is literally `MeshSnapshot.model_validate(snap)` — the
  extra `events` key is ignored.
- `last_handshake: null` = the peer has **never handshaked**. `endpoint: null` =
  none configured. The daemon emits JSON `null` (not `""` or epoch) precisely so
  the GUI's optional fields don't have to special-case sentinels.
- `state` ∈ `{ok, stale, degraded}`; `kind` ∈ `{recovered, stale, degraded}`.
- `events` are served **newest-first** (the socket reverses its ring), so the
  GUI feed renders them in order with no client-side sort.

---

## 6. A poll cycle, end to end (socket mode)

```
1. Browser timer fires → GET /api/mesh
2. FastAPI handler calls SOURCE.mesh()           (SOURCE = SocketDataSource)
3. SocketDataSource opens AF_UNIX → connect(/run/wg-selfheal/status.sock)
4. Reads bytes until EOF → json.loads → the snapshot dict
5. MeshSnapshot.model_validate(snapshot)         (peers decode 1:1)
6. FastAPI serializes → HTTP 200 JSON
7. React renders rows; handshake ages tick locally between polls
   (GET /api/ids runs the same way, independently, on its own 2s timer)
```

If step 3 fails (daemon down / socket absent), `SocketDataSource` raises
`OSError`. FastAPI returns non-2xx, the frontend marks the poll `stale`, and the
masthead flips to **`SIGNAL LOST`**. That is the designed behaviour, not a bug to
hide — silent node = alarm.

---

## 7. The IDS event mapping (where translation *does* happen)

The mesh half decodes 1:1, but the IDS half needs a small map. The daemon only
knows **mesh transitions** (it has no idea about USB insertions or console
logins). `SocketDataSource` turns each native daemon event into the GUI's richer
`IdsEvent`:

| GUI `IdsEvent` field | Source                                            |
|----------------------|---------------------------------------------------|
| `source`             | always `mesh` (that's all the daemon emits)       |
| `severity`           | from `kind`: recovered→`info`, stale→`warn`, degraded→`crit` |
| `subject`            | the peer's `name`                                 |
| `message`            | rendered per kind, e.g. "peer arcturus degraded — remediation exhausted" |
| `id`                 | `"{public_key}@{at}"` — stable, keys off identity not name |
| `at`                 | the transition timestamp                          |

Host sensors (USB / login / reboot via auditd/udev) are a **separate feed** and
do **not** come through here — they're an unbuilt sensor effort (§10). The mock
source fakes them so the panel is shaped right in the meantime.

---

## 8. How to run it

### Mock (default — no daemon needed)
```bash
# backend
cd gui/backend
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
./.venv/bin/python -m app.main                 # 127.0.0.1:8787

# frontend (dev, proxies /api → backend)
cd gui/frontend && npm install && npm run dev   # 127.0.0.1:5173
```

### Real data (socket mode)
Requires a node with WireGuard tunnels up **and** the daemon running with
`--status-sock` (see §11 — not yet possible end-to-end).
```bash
GUI_SOURCE=socket GUI_STATUS_SOCK=/run/wg-selfheal/status.sock \
  ./.venv/bin/python -m app.main
```

### Production build (ship to a node)
```bash
cd gui/frontend && npm run build        # → ../backend/static/
cd ../backend && ./.venv/bin/python -m app.main   # serves UI at /
# override the bind for wg0:  GUI_BIND=<wg0-addr> GUI_PORT=8787   (never 0.0.0.0)
```

---

## 9. Testing

| Layer        | What's covered                                                     | How                                   |
|--------------|--------------------------------------------------------------------|---------------------------------------|
| Daemon (Go)  | peer/event mapping, null sentinels, ring bounding, newest-first, **serve-over-a-real-socket** | `go test ./internal/status/` (race-clean) |
| GUI (Python) | node/peer decode incl. nulls, transition→`IdsEvent`, `limit`, unreachable→`OSError` | `python -m unittest discover -s tests` |
| Cross-stack  | the **real Go socket → Python `SocketDataSource`** round-trip       | manual; the Python test fixture is the real Go wire output, so the contract is locked in CI-able form |

The Python test's fixture is literally the JSON the Go daemon emitted via
`nc -U`, which makes it a **cross-language contract check**: if the daemon changes
its wire shape, the GUI test breaks.

---

## 10. Security posture

- **Loopback / unix only.** Backend binds `127.0.0.1`; the daemon socket is a
  filesystem-permission-gated unix socket (`0660`) with zero network exposure.
- **Least privilege split.** The daemon holds `CAP_NET_ADMIN` (no root, no sudo,
  `DynamicUser`); the GUI is fully unprivileged and only *reads* a socket. We
  chose unix-over-TCP specifically to keep that split — a `WgDataSource` would
  have forced `CAP_NET_ADMIN` onto the web tier, which is strictly worse.
- **No auth yet (known gap).** Fine while loopback-only for a skeleton, but the
  moment the backend binds wg0 it's an open admin surface. This must be decided
  before the admin/RLPF panel ships (that panel *acts*, it doesn't just read).

---

## 11. Current state & the standing blocker

The pipeline is **built and verified on both sides**, but you can't yet point it
at a real node, because real data needs two things that don't exist:

1. **WireGuard tunnels** — none configured on any node yet (pending the
   architecture pivot; see root `CLAUDE.md`).
2. **The daemon running** on that node with `--status-sock`.

Until both hold, `GUI_SOURCE=socket` correctly renders `SIGNAL LOST`. **The code
is ready ahead of the data.**

One deferred decision blocks deployment even once tunnels are up:
- **Cross-user socket permission.** The daemon runs as a `DynamicUser`; the GUI
  runs as a *different* user. Reading a `0660` socket across that boundary needs
  a shared group. Flagged as an OPEN DECISION in `wg-selfheal@.service` rather
  than guessed into hardened config. Resolve when the GUI deploys on a node.

---

## 12. Deferred / not built (and why)

- **`WgDataSource`** (the direct-`wg`, off-path lever arm) — intentionally not
  built. It duplicates the daemon's decide core, can't show `degraded`, and
  privileges the web tier. Kept as a documented third `_build_source()` case only.
- **wg0-bound TCP listener** — for the cross-node IDS correlator (polaris reading
  other nodes' sensors). The current socket is local-only; the structure leaves
  room for it.
- **Host IDS sensors** (auditd/udev: USB, console login, reboot) — a separate
  sensor build; only the `mesh` source is wired today.
- **Files panel** and **admin / RLPF port-request view** — after the skeleton.
- **Auth** (§10) and a **TTL cache** on `SocketDataSource` (dedupe the two reads
  per poll cycle, if churn ever matters).
- **Type-sync codegen** — the three-layer mirror (§5) is hand-kept today;
  generating `types.ts` from FastAPI's OpenAPI schema is the fix if it ever drifts.

---

## 13. File & branch map

```
feat/gui-skeleton            (GUI app + the consumer side of the lever)
  gui/
    GUI-CONTEXT.md → ../GUI-CONTEXT.md        scope & non-negotiables (repo root)
    README.md                                  quick start
    docs/DATA-PIPELINE.md                       ← this file
    backend/app/
      main.py                                   the coupling lever (_build_source)
      models.py                                 Pydantic — mirrors daemon structs
      sources/{base,mock,socket}.py             the DataSource seam
    backend/tests/test_socket_source.py         cross-language contract test
    frontend/src/{App,api,format,types}.tsx     one screen, 2s polling
    frontend/src/components/{StatusBar,MeshHealth,IdsFeed}.tsx

feat/daemon-status-socket    (daemon side of the lever — separate worktree)
  daemon/
    internal/status/status.go                   Server: New / Publish / Serve
    internal/status/status_test.go              mapping + ring + serve-over-socket
    internal/wg/read.go                          + Reader.PublicKey()
    cmd/wg-selfheal/main.go                      --status-sock, wired into the loop
    deploy/wg-selfheal@.service                  RuntimeDirectory + OPEN DECISION note
    DAEMON-CONTEXT.md                            status socket marked SCAFFOLDED
```
