# Context — sirius black-screen after `setenforce` (SELinux), during the IDS deploy

What happened on 2026-06-07 while standing sirius up as an IDS sensor
(`RUNBOOK-sirius.md`), how to recover, and how to never cause it again.

## Symptom
After running **global `setenforce 0`** (to collect SELinux AVCs per the old §3c)
and returning to enforcing, sirius's **desktop black-screens after login** — you
see the login screen + the mouse cursor, then black, no desktop session.

## Root cause
The **global `setenforce 0` → work → `setenforce 1`** flip left files/contexts the
graphical session (display manager + user session) can't access under enforcing,
so the session can't start. It is **not** caused by the `/opt` deploy, the systemd
service, or the **`/opt`-scoped** `restorecon` — none of those touch `/home` or the
display stack. The trigger was the *global* enforcement toggle, not the app.

## Red herrings (ruled out here)
- `wireguard_t` AVC — `comm="sort"` denied a cgroup `search`. Harmless WireGuard
  noise (`wg-quick`), nothing to do with the desktop.
- `.ICEauthority` / `.Xauthority` root-owned — checked; wasn't it this time.

## Confirm it's SELinux (one boot)
Boot once permissive: at the **GRUB menu**, highlight the normal kernel → press
**`e`** → append **` enforcing=0`** to the **`linux`** line → **Ctrl-X**.
- Use `enforcing=0`, **NOT `selinux=0`** — `selinux=0` disables labeling and makes
  the mislabel *worse*.
- If `e` says "cannot find command e", you're at the `grub>` *shell*, not the menu —
  type `normal` first to get the menu back.
- **Desktop returns in permissive → confirmed it's SELinux labeling.**

## Fix (permanent) — full relabel
From a root shell (a **rescue kernel** entry, or after the `enforcing=0` boot):
```bash
fixfiles -F onboot && reboot        # or:  touch /.autorelabel && reboot
```
Relabels the whole filesystem correctly, then boots clean back into enforcing
(takes a few minutes). While you're in there, take our deploy out of the loop and
rule out the other vector:
```bash
systemctl disable su495-gui.service
semodule -l | grep su495gui && semodule -r su495gui   # remove our policy module if present
df -h                                                 # a FULL / or /var also black-screens login
```

## Prevention — the real lesson
**Never use global `setenforce 0` to collect AVCs.** Make only the *service's*
domain permissive — it cannot strand the desktop:
```bash
sudo semanage permissive -a <service-domain>   # the domain of the 203/EXEC binary
#   ... start + exercise the service, collect AVCs, audit2allow -M, semodule -i ...
sudo semanage permissive -d <service-domain>   # back to enforcing for that domain only
```
`RUNBOOK-sirius.md §3c` must be changed to scoped `semanage permissive`, never
global `setenforce 0`.

## If it happens again — one line
Rescue kernel → root shell → `fixfiles -F onboot && reboot`.
