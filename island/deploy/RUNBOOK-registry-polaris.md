# RUNBOOK — bring the island registry up on polaris

Turn on the **friend-code directory** (the `ISL-…` registry) so "Add a friend → By code"
works. The registry is already built + unit-tested (`src/core/registry.ts` + the `/registry/*`
routes) — this is **config only**: polaris *serves* the directory, every other node *points at
it* and auto-announces its code on boot.

> The error `no registry configured (set ISLAND_REGISTRY_URL)` comes from `/api/friends/add`
> on a node that has no `ISLAND_REGISTRY_URL`. Fixing that is Step 3 (and Step 4 for builder).

## Conventions — read once

- **Commands are grouped by machine** — **ON POLARIS** (`ssh <user>@10.42.0.1`), **ON A NODE**
  (vega/sirius/altair), **ON BUILDER** (the Mac). Run each group on the machine in its header.
- **`sudo` to edit `/etc/islandd/islandd.env`** — it's `root:islandd` mode 0640.
- polaris's wg0 IP is **`10.42.0.1`**; the registry listens on the node's normal port (`8787`).

## Why it's safe (no extra hardening needed)

- **polaris can't MITM**: a code is a fingerprint of the key; `resolve()` re-derives it and
  rejects a swapped key (`assertCodeCommits`, unit-tested).
- **polaris can't be squatted**: every announce is self-signed (`verifyAnnounce`), so you can
  only register your own key's code.
- The registry is **control-plane only** — it maps code → record. The actual friend handshake
  goes **node→node over wg0**, never through polaris.

---

## Step 0 — Is islandd already on polaris?  (ON POLARIS)

```bash
systemctl is-active islandd
```
- `active` → skip to **Step 2**.
- `inactive` / `failed` / "Unit islandd.service could not be found" → do **Step 1** first.

---

## Step 1 — (only if not deployed) Install islandd on polaris  (ON BUILDER)

```bash
cd /Users/billyr/Desktop/projects/initfolder/vpn-pi/island
bun run typecheck && bun test && bun run build:arm64
deploy/push.sh <user>@10.42.0.1 dist/islandd-arm64
```
`install.sh` (run remotely by `push.sh`) creates the `islandd` user + `/var/lib/islandd`,
installs the binary + systemd unit, seeds `/etc/islandd/islandd.env` from the example, and
prints polaris's auto-generated admin token. Re-running later never clobbers identity/token/env.

---

## Step 2 — Make polaris the registry  (ON POLARIS)

Edit the env file:
```bash
sudo nano /etc/islandd/islandd.env
```
Set / uncomment:
```
ISLAND_LABEL=polaris
ISLAND_REGISTRY=1
# optional same-pass add-on — also make polaris the IDS/security collector:
ISLAND_EVENTS=1
```
Restart and confirm:
```bash
sudo systemctl restart islandd
systemctl is-active islandd
```
`registry.db` is created automatically in `/var/lib/islandd` on first use — no manual step.
Sanity-check the routes are mounted (empty DB returns 404, which still proves it's serving):
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://10.42.0.1:8787/registry/resolve/ISL-00000-00000
```
`404` = registry is up (code just isn't announced). Connection refused = islandd isn't running.

---

## Step 3 — Point every other node at polaris  (ON EACH NODE: vega, sirius, altair, …)

```bash
sudo nano /etc/islandd/islandd.env
```
Add:
```
ISLAND_REGISTRY_URL=http://10.42.0.1:8787
# only if Step 2 enabled events:
ISLAND_EVENTS_URL=http://10.42.0.1:8787
```
Restart and confirm the node announced itself:
```bash
sudo systemctl restart islandd
journalctl -u islandd -n 20 --no-pager | grep -i announce
```
Expect: `announced to registry — your friend code: ISL-XXXXX-XXXXX`.
(`⚠ registry announce failed: …` = the node can't reach `10.42.0.1:8787` — check wg0 / that
polaris is up.)

---

## Step 4 — Builder (the Mac admin app — special case)

Builder runs from source on loopback and its wg0 won't auto-detect, so it needs the registry
URL exported before you run it (this is what clears your `no registry configured` error):
```bash
export ISLAND_REGISTRY_URL=http://10.42.0.1:8787
export ISLAND_WG0=10.42.0.6      # so its announce isn't a useless 127.0.0.1
# (plus the admin-app exports from RUNBOOK-gate-open-from-app.md)
bun run src/main.ts --host 127.0.0.1
```
**Caveat:** builder bound to `127.0.0.1` **can't receive** inbound friend requests, so you can
*initiate* add-by-code from builder but the round-trip approval is best shown **between two mesh
nodes** (e.g. vega ↔ a spoke). Builder is the admin console, not a social node — that's expected.

---

## Verify end-to-end  (the HTTP path the unit tests don't cover)

1. **Registry resolves a real code** — grab an `ISL-…` from a node's announce log (Step 3), then
   ON POLARIS:
   ```bash
   curl -s http://10.42.0.1:8787/registry/resolve/ISL-XXXXX-XXXXX
   ```
   → JSON with `ed25519` / `x25519` / `wg0` / `label`. (`code not found` = not announced yet.)
2. **Full friend-by-code handshake** (two mesh nodes, e.g. vega ↔ sirius):
   - In sirius's GUI → Friends tab → copy its `ISL-…` ("Copy code" at the top).
   - In vega's GUI → **Add a friend → By code** → paste → **Add** → `Request sent to sirius`.
   - On sirius → **Pending approvals** → accept → both show "you're now friends".
3. **Negative checks**: an unknown code → `code not found`; an offline peer → `sent=false`
   ("Couldn't reach … — are they online?").

---

## Rollback / notes

- Config-only on existing nodes. To revert: comment the added lines and `sudo systemctl restart islandd`.
- Pushing a new binary later never overwrites these env files (`push.sh` preserves them).
- `bun`/build is needed only in Step 1; Steps 2–4 are pure env edits + restarts.

## Checklist

- [ ] (polaris) `ISLAND_REGISTRY=1` set; `islandd` `active`; resolve route returns 404 on a fake code
- [ ] (each node) `ISLAND_REGISTRY_URL` set; log shows `announced to registry — your friend code: ISL-…`
- [ ] (polaris) `resolve/<real code>` returns the record JSON
- [ ] (two nodes) by-code add → pending → accept → "you're now friends"
- [ ] (optional) `ISLAND_EVENTS` on polaris + `ISLAND_EVENTS_URL` on nodes, if doing IDS too
