# Viewing the real GUI from builder (no setup)

A quick, no-install way to **look at the live island app with real data** — you just open
vega's GUI in a browser on builder. Nothing to run on builder; vega is already serving the
UI over the mesh.

> This is "Option A": *read* vega's real data. It does **not** make builder its own node,
> and it can't open the internet gate yet (see [The gate caveat](#the-gate-caveat)).

---

## Why this works (the one idea)

Every node runs one `islandd` process that serves the **same web UI** on its wg0 address,
port `8787`. So from any machine on the WireGuard mesh, a browser pointed at another node's
address shows *that node's* live app. vega is the interesting one — it holds the file
share, the security feed, and the Llama gate — so we look at vega's GUI **from** builder.

```
builder (your Mac, on the mesh)            vega  10.42.0.2
   browser  ───────── wg0 tunnel ─────────►  islandd :8787  ──►  real data
```

---

## Before you start (sanity checks)

1. **builder is on the mesh.** From builder's terminal, ping vega over wg0:
   ```bash
   ping -c 2 10.42.0.2
   ```
   If that fails, the WireGuard tunnel is down — fix that first (nothing else will work).

2. **vega's islandd is running.** From builder:
   ```bash
   curl -s http://10.42.0.2:8787/api/health
   ```
   You want JSON like `{"ok":true,"service":"islandd",...}`. If it doesn't answer, start
   islandd on vega (`sudo systemctl start islandd`).

3. **You have vega's admin token.** It was printed on vega's first run and saved to
   `/var/lib/islandd/admin.token` on vega. Grab it if you don't have it:
   ```bash
   ssh <user>@10.42.0.2 'sudo cat /var/lib/islandd/admin.token'
   ```
   (The admin console asks for this. The plain user app does not.)

---

## Step 1 — Open the user app

In a browser **on builder**, go to:

```
http://10.42.0.2:8787/
```

This is the end-user app. The **Files** tab is the real island file share (vega's SQLite
store) — you can browse what's actually shared. Home/Friends/Messages show vega's view.

> Note: actions that change things (issue a friend invite, upload a file) are
> *operator-only* and, from a remote browser, need vega's operator token. For "just
> looking," browsing is enough — you don't need to type anything here.

## Step 2 — Open the admin console

```
http://10.42.0.2:8787/admin
```

Click the **🔒 lock** and paste **vega's admin token** (from the sanity checks). Now you
can see the real admin surface:

| Tab | What you're seeing (real) |
|---|---|
| **Home** | vega's WireGuard peers + handshake ages, fail2ban jails, gate state |
| **Friends** | vega's actual friendships + any pending requests |
| **Files** | the island file share (same store as the user app) |
| **Security** | the IDS feed across nodes (if vega is the collector) |
| **Gate** | current state (`island`), the open/close/deny **log**, close button |

Everything here is live data from vega — not mock.

---

## The gate caveat

You **can** see the gate's **state** (`island`) and its **log** here. You **cannot** open
the gate from this screen yet, for two reasons:

1. **Only vega can open it** anyway — it's the only node with the Llama model and the
   `island-gate` helper. (You're already looking at vega, so that part's fine.)
2. **The "open" button isn't wired for production yet.** It currently mints the canary via
   a mock-only endpoint, so in prod it errors with *"Needs the admin app in production."*
   Opening the gate for real needs the `islandd canary` mint tool we still have to build —
   see [`RUNBOOK-egress-finish.md`](RUNBOOK-egress-finish.md).

So today: you can **watch** the gate (state + log) with real data. To **trigger** an open
and watch it flip `island → internet`, finish the egress steps + build the mint command
first.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Browser hangs / can't connect | builder isn't on the mesh, or vega's islandd is down — recheck the two sanity `curl`/`ping`s. |
| `/api/health` works but `/admin` says forbidden | wrong/empty admin token — re-copy `/var/lib/islandd/admin.token` from vega. |
| Files/Home look empty | that's just vega having little data yet — it's still "real," just sparse. |
| Want to *change* things, not just look | remote operator actions need vega's `ISLAND_OP_TOKEN` (or run the app locally on builder — that's "Option B," a separate setup). |

---

## What this is and isn't

- ✅ A zero-install way to confirm the app works with real mesh data, from builder.
- ✅ The right place to watch the gate state/log once egress is finished.
- ❌ Not builder running its own node (that's Option B: `ISLAND_SHARE=remote` + `bun run
  start` on builder).
- ❌ Not a way to open the internet gate yet (needs the mint tool).
