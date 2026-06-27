# Finishing the canary gate — egress deploy + the missing mint tool

Status + plan for getting the internet gate working **end-to-end on vega**. The model
brain (Llama) is done; this doc covers the egress mechanism, the admin keypair, and the
one missing piece of code. Reference for the design + security model is
[`RUNBOOK-gate.md`](RUNBOOK-gate.md) — this doc is the "where we are / how to finish it"
companion.

---

## Where the gate stands

| Piece | State |
|---|---|
| **Llama policy model** (vega) | ✅ done — `llama-server` running loopback-only on `127.0.0.1:8080`, returns `APPROVE`/`DENY` (grammar-constrained) |
| **Crypto verification** (`canary.ts` / `gate.ts`) | ✅ done — seal + admin-signature + keyword + freshness, anti-replay |
| **Egress mechanism** (`island-gate` helper + sudoers) | 📦 in repo, **not yet deployed** to vega |
| **Admin keypair** + `ISLAND_ADMIN_PUBKEY` | ⏳ not generated / not set |
| **Prod canary minting** (the "admin app") | ❌ **missing** — see Part 3 |

**The blocker:** the web UI's "open gate" button mints via `POST /admin/canary/mint`,
which is **mock-only** (the daemon returns 404 for it in production). So in prod the
button just errors *"Needs the admin app in production."* The signing code (`makeCanary`)
exists, but nothing in prod exposes it — **the gate cannot be opened until we add a mint
tool** (Part 3).

---

## How the gate works (recap)

```
 admin machine                         vega (edge)
 ────────────                          ───────────
 makeCanary(adminKey, "GREEN18 …",     POST /admin/canary
   seal→vega.x25519)  ───── blob ────►  1. open the seal          (only vega can)
                                        2. verify admin signature (ISLAND_ADMIN_PUBKEY allowlist)
                                        3. keyword == GREEN18, first token
                                        4. nonce unseen + fresh    (anti-replay)
                                            │  all four pass
                                            ▼
                                        Llama: APPROVE? ──► island-gate open
                                            │                   (nftables: wg0→uplink + masquerade)
                                            ▼
                                        egress for 45 min → auto-reclose → island
```

**The crypto is the real gate.** Llama is only a refusal layer; an unreachable/slow model
fails **safe (deny)**. Typing the keyword is not enough — the admin *signature* is the
secret.

---

## Part 1 — Deploy the egress mechanism (vega)

The `island-gate` helper is the **only** root-capable piece; it owns the nft rules so the
unprivileged daemon never touches the firewall. It takes exactly `open`|`close`, no other
args, and the sudoers rule pins those two verbs.

**1a. Confirm vega's real uplink interface** (the helper defaults to `eth0`, but recent Pi
OS often uses `end0` / `wlan0`):

```bash
# on vega:
ip route get 1.1.1.1        # the "dev <iface>" in the output IS your uplink
```

**1b. Push + install the helper** (root-owned, not writable by the daemon user):

```bash
# from the repo on builder:
scp island/deploy/island-gate island/deploy/island-gate.sudoers <user>@10.42.0.2:/tmp/

# on vega:
sudo install -o root -g root -m 0755 /tmp/island-gate /usr/local/sbin/island-gate
ls -l /usr/local/sbin/island-gate          # MUST be root:root 0755 (else the sudo grant = root escalation)
```

**1c. Prove it toggles** (substitute your uplink if not `eth0`):

```bash
sudo ISLAND_UPLINK_IFACE=<uplink> /usr/local/sbin/island-gate open
sudo nft list table inet island_gate       # shows forward (wg0→uplink) + masquerade rules
sudo /usr/local/sbin/island-gate close
sudo nft list table inet island_gate       # "No such file" = good — island mode restored
```

If the uplink isn't `eth0`, bake it in rather than relying on the default:
`sudo sed -i 's/eth0/<uplink>/' /usr/local/sbin/island-gate`.

**1d. Pin the sudoers rule** (edit the user inside the file if not `islandd`):

```bash
sudo install -o root -g root -m 0440 /tmp/island-gate.sudoers /etc/sudoers.d/island-gate
sudo visudo -cf /etc/sudoers.d/island-gate # must print "parsed OK"
```

---

## Part 2 — The admin keypair (you generate)

Per project rule, **you** generate keys; the daemon only ever loads the admin *public*
key. `islandd keygen` doubles as the admin keypair maker (Ed25519 + X25519).

**2a. Generate on a trusted machine that is NOT vega** (builder/polaris — wherever you'll
operate as admin; the private key must never live on the edge node):

```bash
islandd keygen ~/island-admin    # writes the keypair, prints the admin Ed25519 public key
```

**2b. Get vega's X25519** (the admin needs it to seal canaries TO vega):

```bash
# on vega (loopback/operator):
curl -s localhost:8787/api/identity   # copy the "x25519" value
```

**2c. Wire vega's `/etc/islandd/islandd.env`:**

```ini
ISLAND_SHARE=sqlite                 # vega is the file authority
ISLAND_ADMIN_PUBKEY=<admin ed25519 pub from 2a>
ISLAND_LLAMA_URL=http://127.0.0.1:8080
ISLAND_GATE_CMD=sudo /usr/local/sbin/island-gate
ISLAND_GATE_TTL=2700                # 45 minutes
ISLAND_CANARY_KEYWORD=GREEN18
ISLAND_MESH_IFACE=wg0
ISLAND_UPLINK_IFACE=<uplink>
```

```bash
sudo systemctl restart islandd
curl -s localhost:8787/api/gate     # expect {"state":"island", ...}
```

---

## Part 3 — The missing code: a prod canary-mint command

The web UI can't mint a real canary (the admin *private* key must never be in a browser),
and `/admin/canary/mint` is mock-only. So prod needs a small CLI "admin app" that signs +
seals a canary locally and POSTs it. Proposed:

```
islandd canary \
  --admin-dir ~/island-admin \            # the keypair from Part 2a (holds the private key)
  --to-x25519 <vega-x25519> \             # from Part 2b (seal target)
  --text "GREEN18 open the gate" \        # first token must be the keyword
  --send http://10.42.0.2:8787 \          # vega; omit to just print the blob
  --admin-token <vega-admin-token>        # /admin/canary is admin-token gated
```

What it does (all pieces already exist in `src/core/`):
1. `loadIdentity(adminDir)` → the admin keypair.
2. `makeCanary(admin, keyword, text, vegaX25519)` → the signed+sealed base64 blob.
3. If `--send`: `POST {blob}` to `/admin/canary` with `x-admin-token`; print
   `{opened, reason, gate}`. Else: print the blob for manual paste.

This is the only remaining build task for egress. It's self-contained — a new CLI
subcommand reusing `makeCanary`, plus a couple of tests.

---

## End-to-end test path

1. `curl localhost:8787/api/gate` → `island`.
2. From the admin machine: `islandd canary … --text "GREEN18 open the gate" --send …`.
3. vega verifies crypto → Llama approves → helper opens:
   - `curl localhost:8787/api/gate` → `internet` with `closes_at` ~45 min out.
   - `sudo nft list table inet island_gate` → the rules exist.
   - a mesh client can now reach the internet through vega.
4. `POST /admin/gate/close` (or wait for TTL) → back to `island`, table removed.
5. `GET /admin/gate/log` → the open/close/deny audit trail.
6. **Negative test:** mint a canary with a *non-allowlisted* key → `/admin/canary` returns
   403 (signature not from an admin). Replay the same blob twice → second is rejected.

---

## Security notes

- A compromised islandd can do exactly one thing with its sudo grant: `island-gate
  open`/`close`. No root shell, no other commands (pinned sudoers, no wildcards).
- The helper is `root:root 0755` — **not** writable by the daemon user, or the sudo grant
  becomes a privilege escalation.
- Base firewall stays default-deny on forward; the gate only *adds* an egress table while
  open and deletes it on close (fail-safe = island).
- Admin key rotation/revocation = edit `ISLAND_ADMIN_PUBKEY` (comma-separated allowlist).
- The admin private key lives only on the admin machine, never on vega.

---

## Checklist

- [ ] uplink interface confirmed on vega.
- [ ] `island-gate` installed `root:root 0755`; `open`/`close` toggle the nft table.
- [ ] sudoers pinned + `visudo -cf` parses OK; user matches the islandd service user.
- [ ] admin keypair generated off-vega; public key in `ISLAND_ADMIN_PUBKEY`.
- [ ] vega X25519 captured for the admin to seal to.
- [ ] gate env set; `islandd` restarted; `/api/gate` = island.
- [ ] **`islandd canary` mint command built + tested** (Part 3).
- [ ] end-to-end open/close verified; negative tests (bad signer, replay) pass.
