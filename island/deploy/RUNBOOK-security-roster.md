# RUNBOOK — Security roster fix (journal-sourced peer statuses)

## What broke, in one paragraph

The Security feed's per-peer roster was keyed off `wg show wg0 dump` — but `islandd`
runs unprivileged (`User=islandd`) and `wg show` needs `CAP_NET_ADMIN`, so on every
real node the live wg read comes back **empty** and the roster emitted **zero** link
events (blank Security tab on polaris; nodes pushed empty reports). The wg-selfheal
daemon *does* hold `CAP_NET_ADMIN` and logs per-peer status to journald, which islandd
can read (`systemd-journal` group) — the app now builds the roster from that journal,
with the live wg read as an overlay when it's available (`--mock`, dev).

Two pieces to redeploy: the **islandd binary** (journal roster parsing) on every node,
and the **wg-selfheal unit** (adds `--snapshot` so the journal enumerates stably-ok
peers, not just transitions) on every Linux node running the daemon.

## 1. Redeploy islandd (all nodes)

Binaries are already built in `island/dist/`. From builder — but **verify spokes from
vega/polaris**, per the roaming-relay rule:

```sh
cd island
deploy/push.sh vega    dist/islandd-arm64
deploy/push.sh polaris dist/islandd-arm64
deploy/push.sh sirius  dist/islandd-x64
# altair (macOS LaunchAgent): copy dist/islandd-mac per its usual flow
```

## 2. Enable --snapshot on the wg-selfheal daemons

The updated `daemon/deploy/wg-selfheal@.service` adds `--snapshot` to ExecStart.
Either re-push the daemon the normal way (ships binary + unit + installer):

```sh
cd daemon
deploy/push.sh vega   arm64 relay     # then on vega:   sudo bash ~/wg-selfheal-deploy/install.sh relay
deploy/push.sh sirius amd64 spoke     # then on sirius: sudo bash ~/wg-selfheal-deploy/install.sh spoke
```

…or, since only the unit line changed, edit in place on each daemon node:

```sh
sudo sed -i 's|^ExecStart=.*|ExecStart=/usr/local/bin/wg-selfheal --role=%i --iface=wg0 --snapshot|' \
  /etc/systemd/system/wg-selfheal@.service
sudo systemctl daemon-reload
sudo systemctl restart 'wg-selfheal@*'
```

Without `--snapshot` the app still works, but a peer that has been healthy since the
daemon started won't appear in the roster until its first state transition.

## 3. Verify

On any node (as the islandd user's host):

```sh
# journal has per-tick "peer" snapshot lines now:
journalctl -u 'wg-selfheal@*' -n 10 -o cat        # expect {"msg":"peer","peer":"10.42.0.x","status":"ok",...}

# islandd sees the roster:
curl -s http://<wg0-ip>:8787/api/home | python3 -m json.tool | grep -A3 selfheal
```

- Home tab → Connectivity: peers listed (from the journal roster) with online/offline.
- Home tab → Security: only non-ok peers (plus fail2ban), as before.
- polaris → Security tab (admin): every node's full roster with ok/stale/degraded/restored
  pills, worst first. Local peers show as "on this node"; remote via reports within ~60s.
