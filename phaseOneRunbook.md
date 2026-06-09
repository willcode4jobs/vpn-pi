# Phase One — submission runbook

How to run this on a clean machine, and where each GitHub requirement is satisfied.
The [`README.md`](README.md) is the project summary; this is the operational doc.

---

## How this Phase One meets the requirements

Infrastructure project, so here's where each GitHub requirement lives — three buckets
covering reqs 1–4, so the grader doesn't have to translate it onto an app rubric:

| Requirement | Where it's satisfied |
|---|---|
| **1 — runs on a separate machine** | the [Quickstart](#quickstart-fresh-machine) below: clone, bring up the GUI in dev mode, run the test suites. No dependency on my hardware. |
| **2 & 3 — real, working, version-controlled** | the GitHub history (feature branches, PRs, commits) + a functional GUI you can drive locally; the [per-folder notes](#per-folder--what-runs-whats-deployed-whats-demonstrated). |
| **4 — documented & commented** | [`CODE-MAP.md`](CODE-MAP.md) (every source file), the `docs/` runbooks, and heavily-commented configs — the WireGuard/nftables configs are the bulk and can't be "run," so the comments carry them. |

> Rubric wording above is my read of the assignment — sanity-check the exact requirement
> numbers against the real handout.

---

## Quickstart (fresh machine)

Brings the GUI up in dev mode and runs the tests on a clean clone — the "runs on a
separate machine" proof.

```bash
git clone git@github.com:willcode4jobs/vpn-pi.git
cd vpn-pi

# 1. backend — FastAPI on loopback :8787  (Python 3.10+)
cd gui/backend
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
./.venv/bin/python -m app.main          # serves /api/* on 127.0.0.1:8787

# 2. frontend — Vite dev server, proxies /api -> backend  (second terminal)
cd gui/frontend
npm install && npm run dev              # open the URL it prints (127.0.0.1:5173)
```

Run the tests:

```bash
# backend unit tests
cd gui/backend && ./.venv/bin/python -m unittest discover -s tests

# daemon unit tests (Go) — later-phase code, but the suite runs clean
cd daemon && go test ./...
```

With no env set, the GUI runs against a built-in mock store + synthetic IDS feed, so
it's fully demonstrable on a laptop with nothing else deployed.

---

## Per-folder — what runs, what's deployed, what's demonstrated

| Folder | Runs | Deployed | Demonstrates |
|---|---|---|---|
| `gui/backend/` | `python -m app.main` (FastAPI :8787) | per node via `su495-gui.service` (systemd) | file-share + IDS APIs; the blind-relay aggregation |
| `gui/frontend/` | `npm run dev` (Vite) | built bundle rsynced to nodes (`gui/deploy/push-gui.sh`) | the ops-console UI |
| `pi-deployment/` | `sudo bash harden-base.sh` | run on each node | default-deny firewall, fail2ban, SSH lockdown |
| `docs/wg-templates/` | *(not run)* — copied to `/etc/wireguard/wg0.conf` | per node | the dual-stack hub/spoke mesh config (over-commented) |
| `daemon/` | `go test ./...` / `go build` | later phase | tunnel self-heal logic (read → decide → act → alert), via unit tests |
| `docs/` (runbooks) | *(procedures)* | — | how every node is stood up + recovered |

**Code entry point:** [`CODE-MAP.md`](CODE-MAP.md) — every source file + a runbook index.
