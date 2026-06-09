# wg-selfheal — Build, Deploy & Run

Operational runbook for the WireGuard self-heal daemon. Build on the **Mac**,
ship **binaries** to the nodes (no git/Go/compiler on nodes). Source of truth for
"how do I run this."

> Current build is **read-only** (it logs the actions it *would* take; it does not
> touch the tunnel yet). Safe to run anywhere.

---

## Node roster

| Node    | Arch    | `GOARCH` | Role    | Notes                         |
|---------|---------|----------|---------|-------------------------------|
| vega    | aarch64 | `arm64`  | `relay` | hub/bastion — never bounces   |
| sirius  | x86_64  | `amd64`  | `spoke` | "<hostname>"                    |
| altair  | aarch64 | `arm64`  | `spoke` | endpoint; reached via passkey |

Role drives remediation aggressiveness — see `DAEMON-CONTEXT.md`.

---

## 1. Build & test (on the Mac)

```bash
cd daemon
go test ./...            # decision core + read-path unit tests (no live wg needed)
go build ./...           # host build smoke
```

Cross-compile (static, stripped) is handled by `push.sh`, but to build by hand:

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w" \
  -o dist/wg-selfheal-arm64 ./cmd/wg-selfheal      # vega, altair
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" \
  -o dist/wg-selfheal-amd64 ./cmd/wg-selfheal      # sirius
```

`dist/` is gitignored — binaries are artifacts, never committed.

---

## 2. Deploy to a node (from the Mac)

`push.sh` cross-builds the right binary and `scp`s binary + unit + installer into
`~/wg-selfheal-deploy/` on the node. It does **not** run sudo remotely (install is
a deliberate manual step).

```bash
# ./deploy/push.sh <ssh-host> <arm64|amd64> <spoke|relay>
./deploy/push.sh vega   arm64 relay
./deploy/push.sh sirius amd64 spoke
./deploy/push.sh altair arm64 spoke
```

If the node's SSH key has a passphrase, unlock it once to avoid repeated prompts:

```bash
ssh-add --apple-use-keychain ~/.ssh/<that-nodes-key>
```

Raw equivalent (no script):

```bash
ssh <host> 'mkdir -p ~/wg-selfheal-deploy'
scp dist/wg-selfheal-<arch>      <host>:~/wg-selfheal-deploy/wg-selfheal
scp deploy/wg-selfheal@.service  deploy/install.sh  <host>:~/wg-selfheal-deploy/
```

---

## 3. Install & run as a service (on the node, sudo)

The real run path: installs the binary to `/usr/local/bin`, installs the templated
unit, enables it (starts on boot), and starts it now. Idempotent.

```bash
cd ~/wg-selfheal-deploy
sudo bash install.sh relay     # vega
sudo bash install.sh spoke     # sirius, altair
```

The role is the systemd template instance, so the service is
`wg-selfheal@<role>.service`:

```bash
systemctl status wg-selfheal@relay      # vega
systemctl status wg-selfheal@spoke      # sirius / altair
```

Privilege model: a `DynamicUser` with **only** `CAP_NET_ADMIN` — no root, no sudo
at runtime, full systemd sandbox.

---

## 4. Manual foreground run (quick test, no install)

To eyeball it without installing a service. Runs as root via sudo (root has the
cap); `Ctrl-C` stops it. Bypasses the sandbox, so use this only for a sanity poke.

```bash
sudo ~/wg-selfheal-deploy/wg-selfheal --role=relay --iface=wg0    # vega
sudo ~/wg-selfheal-deploy/wg-selfheal --role=spoke --iface=wg0    # sirius / altair
```

After install, the binary also lives at `/usr/local/bin/wg-selfheal`.

---

## 5. Watch logs / collect data

The daemon logs structured records to stderr → captured by **journald**:

```bash
journalctl -u wg-selfheal@relay -f          # live follow
journalctl -u wg-selfheal@spoke -S today    # since midnight
journalctl -u wg-selfheal@spoke -S -8h -o short-iso > ~/wgsh-$(hostname).log   # export
```

What to expect on a healthy mesh:
- `msg=starting` once, then `msg=peer` snapshots every 30s (key, endpoint,
  `handshake_age`, `status=healthy`).
- **Zero** `msg="would remediate"` lines. Any of those on a healthy mesh = the
  threshold is wrong.
- `msg="read failed"` (WARN) = couldn't read wg0 (down / missing / permission).

### Persistent logs across reboot (important for power-outage data)
journald is volatile by default on some systems — wiped on reboot. To keep logs
through a reboot/outage:

```bash
journalctl --header | grep -i persistent       # check
sudo mkdir -p /var/log/journal && sudo systemctl restart systemd-journald   # enable
journalctl -u wg-selfheal@spoke -b -1          # read the boot BEFORE the last reboot
```

---

## 6. Stop / uninstall

```bash
sudo systemctl disable --now wg-selfheal@relay     # stop + don't start on boot
# full removal:
sudo rm /etc/systemd/system/wg-selfheal@.service /usr/local/bin/wg-selfheal
sudo systemctl daemon-reload
```

Read-only build, so there's nothing else to clean up.

---

## Flags reference

| Flag        | Default | Meaning                                  |
|-------------|---------|------------------------------------------|
| `--role`    | (req'd) | `spoke` or `relay`. Missing/bad = hard exit before any netlink touch. |
| `--iface`   | `wg0`   | WireGuard interface to watch             |
| `--interval`| `30s`   | how often to poll peer state             |

---

## Notes

- **Static binary, fully local.** Once `scp`'d, a node runs its own copy with the
  Mac off — no runtime dependency on the builder, Go, or shared libs.
- **Arch matters.** arm64 ≠ 32-bit arm (`armv7l`). A wrong-arch binary fails with
  `Exec format error`. `install.sh` prints the binary arch vs host before installing.
- **`push.sh` knows arm64 + amd64 only.** For 32-bit arm, build with
  `GOARCH=arm GOARM=7` by hand.
