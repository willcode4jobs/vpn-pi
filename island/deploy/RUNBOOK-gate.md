# RUNBOOK — the canary internet gate (vega)

How to wire the Phase F gate on **vega**. Nothing here is auto-installed; you run and
review each step. The gate is closed (island) by default and after every reclose.

## How it works (recap)

The admin app signs a `GREEN18 …` canary with the **admin Ed25519 key** and seals it
to **vega's X25519 key**, then POSTs it to `/admin/canary`. vega verifies the seal +
admin signature + keyword + freshness (hard checks), asks the **local Llama** to
approve/deny, and on approve calls the **island-gate** helper to open egress for
**45 minutes**, then auto-recloses. The crypto is the real gate; Llama is a refusal
layer; fail-safe is island.

## 1. Install the privileged helper (the only root-capable piece)

```sh
sudo install -o root -g root -m 0755 island-gate /usr/local/sbin/island-gate
# adjust interfaces if not wg0 / eth0:
#   sudo sed -i 's/eth0/<uplink>/' /usr/local/sbin/island-gate   (or set env in the unit)
sudo /usr/local/sbin/island-gate close      # prove it runs; leaves island mode
```

**Hard requirements (do not skip — these are what make the sudo grant safe):**
1. `island-gate` is `root:root`, mode `0755` — **not writable by the islandd user**
   (else the sudo grant becomes a root escalation). Verify: `ls -l /usr/local/sbin/island-gate`.
2. The sudoers rule pins the **exact** commands — no wildcards (see below).
3. islandd passes only the fixed verb `open`/`close`; no input is interpolated.

## 2. Install the pinned sudoers rule

```sh
sudo install -o root -g root -m 0440 island-gate.sudoers /etc/sudoers.d/island-gate
sudo visudo -cf /etc/sudoers.d/island-gate          # must say "parsed OK"
```
Set the islandd service user to match your unit; the default file assumes `islandd`.

## 3. Local Llama (llama.cpp server)

Run a `llama-server` on vega (the 16 GB Pi) reachable at `ISLAND_LLAMA_URL`
(default `http://127.0.0.1:8080`). Any small instruct model is fine — the policy is
simply "approve opening internet egress." If the server is unreachable, the gate
**fails safe (deny)**.

## 4. The admin keypair (William generates)

Generate a dedicated **admin Ed25519** keypair (per project rule, you make keys; the
daemon only loads the public one). Put the admin **public** key in vega's env as
`ISLAND_ADMIN_PUBKEY` (comma-separated for multiple admins). The admin app holds the
private key and vega's X25519 public key (to seal to).

## 5. islandd environment on vega

```ini
ISLAND_SHARE=sqlite                 # vega is the file authority
ISLAND_ADMIN_PUBKEY=<admin ed25519 b64>
ISLAND_LLAMA_URL=http://127.0.0.1:8080
ISLAND_GATE_CMD=sudo /usr/local/sbin/island-gate   # the pinned helper
ISLAND_GATE_TTL=2700                # 45 minutes
ISLAND_CANARY_KEYWORD=GREEN18
ISLAND_MESH_IFACE=wg0
ISLAND_UPLINK_IFACE=eth0
```

## 6. Test the path

- `curl localhost:8787/api/gate` → `island`.
- Send a real canary from the admin app → `/api/gate` shows `internet` with a
  `closes_at` ~45 min out; confirm `nft list table inet island_gate` exists.
- `POST /admin/gate/close` (or wait for the TTL) → back to `island`, table removed.
- `GET /admin/gate/log` → the open/close/deny audit trail.

## Security notes

- A compromised islandd can do exactly one thing with its sudo grant: toggle the
  gate. It cannot get a root shell or run other commands.
- Keep forward policy default-deny at the base firewall; the gate only adds egress
  while open and removes it on close.
- Rotate/replace the admin key by editing `ISLAND_ADMIN_PUBKEY`; revocation is just
  removing it from the allowlist.
