# Runbook — first live IDS mesh test (vega + polaris)

Prove the blind-relay spine on real nodes: a host event on **vega** ships through
vega's relay and shows up — **decrypted and attributed** — in **polaris's**
aggregate feed, while the relay row stays opaque. Two Debian Pis, no SELinux, no
sirius. Code: `feat/ids-mesh` (steps 1–4). Design: `docs/ids-planning/`.

```
vega 10.42.0.2  (hub + sensor)            polaris 10.42.0.1  (master)
  HostDataSource → shipper → relay  ──pull──►  MeshDataSource → /api/ids
  GUI_IDS=host, GUI_IDS_RELAY=1                GUI_IDS=mesh (loopback)
```

**Prereq:** `feat/ids-mesh` is pushed (done). Keep a second SSH session open to
each Pi as a safety net (these touch the unit + restart).

---

## 1. Code on both nodes (vega and polaris)

```bash
cd ~/projects/vpn-pi && git fetch origin && git checkout feat/ids-mesh && git pull
cd gui/backend && ./.venv/bin/pip install -r requirements.txt   # pulls pynacl
./.venv/bin/python -c "import nacl; print('pynacl ok')"
```
If pip tries to *compile* pynacl (no aarch64 wheel for your Python), install
`build-essential libffi-dev` and retry, or use the system python that has a wheel.

---

## 2. Keys (you generate — I never hold these)

```bash
# both nodes: keydir
sudo mkdir -p /var/lib/vpn-pi/ids && sudo chown billy:billy /var/lib/vpn-pi/ids

# polaris (master) — the X25519 pair
cd ~/projects/vpn-pi/gui/backend
./.venv/bin/python ../deploy/ids-keygen.py master --out /var/lib/vpn-pi/ids
#   -> master.key (0600) + master.pub. Note the printed master public key.

# vega (sensor) — its Ed25519 signer
./.venv/bin/python ../deploy/ids-keygen.py node --out /var/lib/vpn-pi/ids
#   -> node.key (0600). COPY the printed "verify key" — you register it next.
```

Distribute (only public material moves):
```bash
# copy polaris's master.pub to vega
scp polaris:/var/lib/vpn-pi/ids/master.pub /tmp/master.pub
scp /tmp/master.pub vega:/tmp/master.pub
ssh vega 'sudo install -o billy -g billy -m644 /tmp/master.pub /var/lib/vpn-pi/ids/master.pub'

# register vega's verify key on polaris (the registry the master trusts)
ssh polaris 'echo "10.42.0.2=<VEGA_VERIFY_KEY>" | sudo tee /var/lib/vpn-pi/ids/registry'
ssh polaris 'sudo chown billy:billy /var/lib/vpn-pi/ids/registry'
```

---

## 3. Journal read access (both nodes — for HostDataSource)

```bash
sudo usermod -aG systemd-journal billy
#   the group takes effect when the service restarts (step 5)
```

---

## 4. Service env

### vega — `sudo systemctl edit --full su495-gui.service`, add to `[Service]`:
```ini
Environment=GUI_IDS=host
Environment=GUI_IDS_RELAY=1
Environment=GUI_IDS_NODE_KEY=/var/lib/vpn-pi/ids/node.key
Environment=GUI_IDS_MASTER_PUBKEY=/var/lib/vpn-pi/ids/master.pub
Environment=GUI_IDS_RELAY_URL=http://10.42.0.2:8787
Environment=GUI_IDS_NODE_ADDR=10.42.0.2
```
(keep its existing `GUI_FILES=sqlite`, `GUI_NODE_NAME=vega`, the `--host 10.42.0.2`
bind, etc.)

### polaris — ensure the unit is enabled, then add:
```ini
Environment=GUI_IDS=mesh
Environment=GUI_IDS_MASTER_KEY=/var/lib/vpn-pi/ids/master.key
Environment=GUI_IDS_REGISTRY=/var/lib/vpn-pi/ids/registry
Environment=GUI_IDS_RELAY_URL=http://10.42.0.2:8787
Environment=GUI_NODE_NAME=polaris
```
polaris keeps its **loopback** bind (`--host 127.0.0.1`) and needs no `GUI_FILES`
(placeholder default is fine — this test is about IDS). `ReadWritePaths=/var/lib/vpn-pi`
must be present (it is, in the shipped unit).

---

## 5. Restart + sanity

```bash
# each node
sudo systemctl daemon-reload && sudo systemctl restart su495-gui.service
systemctl status su495-gui.service --no-pager        # active, no 203/EXEC
```

---

## 6. Verify the spine

**a. vega has a real local feed** (loopback won't work — vega binds wg0):
```bash
# on vega
curl -s 10.42.0.2:8787/api/ids | python3 -m json.tool | head
#   -> real journal events (your ssh logins show as LOGIN). Trigger a fresh one:
#      open a new `ssh vega` session, then re-curl — a new LOGIN appears.
```

**b. the relay buffered ciphertext** (opaque):
```bash
# on vega
curl -s '10.42.0.2:8787/api/ids/relay?since=0' | python3 -m json.tool | head
#   -> {"cursor": N, "blobs": [{"node":"10.42.0.2","seq":1,"ct":"<base64>"}, ...]}
sudo sqlite3 /var/lib/vpn-pi/ids-relay.db 'SELECT node,seq,substr(ct,1,24) FROM relay LIMIT 3;'
#   -> ct is base64 ciphertext; no plaintext message anywhere. The hub is blind.
```

**c. polaris sees vega's events, decrypted + attributed** — the proof:
```bash
# on polaris (loopback passes the wg0 allowlist)
curl -s 127.0.0.1:8787/api/ids | python3 -m json.tool
#   -> events with "node":"10.42.0.2" (vega), correctly decrypted, MERGED with
#      polaris's own local feed. That round trip = the whole design working.
```

View it in the browser the real way (from the Mac):
```bash
ssh -L 8787:127.0.0.1:8787 polaris      # then open http://127.0.0.1:8787
```

---

## 7. If something's off

| Symptom | Likely cause / fix |
|---|---|
| vega deposit `403 blob node does not match caller` | vega's POST to itself egressed as `127.0.0.1`. Confirm `GUI_IDS_RELAY_URL=http://10.42.0.2:8787` (not loopback); the source must be `10.42.0.2`. |
| polaris `/api/ids` shows only its own events | registry missing/typo'd vega's verify key; or `master.pub` on vega ≠ `master.key` on polaris (regenerate as a pair); or polaris can't reach vega — `curl -s --max-time5 10.42.0.2:8787/api/health` from polaris. |
| empty journal feed on vega | `billy` not in `systemd-journal`, or service didn't restart after `usermod`. Re-check `id billy`, restart. |
| `pynacl` import fails | no wheel for that Python — `apt install build-essential libffi-dev` and reinstall, or use a Python with an aarch64 wheel. |
| polaris service won't start | unit may have been disabled when its store moved to vega — `sudo systemctl enable --now su495-gui.service`; check `journalctl -u su495-gui -n50`. |

---

## 8. What this proves (and doesn't)

**Proves:** real journald sensor read; sign+seal on a node; the hub buffering
**opaque** ciphertext; the master pulling, decrypting, verifying, attributing, and
merging — the full blind-relay loop on real hardware.

**Doesn't yet:** multi-endpoint fan-out (just add sirius/altair later — same env,
their own keys), daemon `TUNNEL` warnings (Step 4a), and the view-password +
sequence-gap UI (Step 5). None of those change what's proven here.
