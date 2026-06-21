# 07 — Migration & build plan

> **Nothing here has been executed.** This is the proposed sequence for your
> review. Per project convention I will **not** run `git push` or delete history;
> you drive the pushes. The destructive steps are spelled out so you can run or
> approve them deliberately.

## Current git reality (so the plan is grounded)

- Branch `feat/ids-mesh` has the old GUI **already staged for deletion** (`gui/…`
  shows as `D`), and a parallel copy lives in untracked/`gui-and-app/`. The repo is
  mid-reorganization. The archive step must capture the *working* code **before**
  it's lost.
- The Phase One reference implementation we want to preserve (and port from) is
  the Python/React tree under `gui/` and `gui-and-app/`, the `daemon/`, and docs.

## Step 1 — Archive the old app/gui (preserve, don't lose)

Goal: a permanent `archive/phase-one-gui` branch on GitHub holding the full
Python/React app exactly as it last worked.

```bash
# from a clean checkout that still HAS the old files (e.g. origin/feat/gui-files-ids
# or a commit before the deletions). Verify it contains a working gui/ first.
git switch -c archive/phase-one-gui <commit-with-working-gui>
# (no code change — this branch is a snapshot)
# YOU push:  git push -u origin archive/phase-one-gui
```

⚠️ I need you to confirm **which ref** has the last-good Python app — the current
branch already deleted it. Candidates from `git branch -a`:
`origin/feat/gui-files-ids`, `origin/feat/gui-skeleton`, `origin/feat/archived-daemon-gui`.
See the question in [08](08-open-questions.md).

## Step 2 — New branch off main for the TS build

```bash
git switch main && git pull
git switch -c feat/island-ts
```

## Step 3 — Delete the superseded files on the new branch

Remove the Python/React app + anything the TS build replaces, *after* Step 1 has it
archived:

```bash
git rm -r gui gui-and-app archive            # old app(s) + old prototype
# keep: pi-deployment/ (hardening), docs/ (port what's relevant), wg-templates/
# decide: daemon/ (Go self-heal) — keep as-is or fold into the TS app? → [08]
git commit -m "refactor: remove Phase One python/react app (archived to archive/phase-one-gui)"
```

> **Live data is not a git step.** The universal file share is vega's running
> `island.db` — it stays on vega and the TS `core/share.ts` reads the same schema.
> polaris's DB server is **decommissioned at deploy time** (stop its service), not
> by anything in the repo. Nothing here deletes file data.

## Step 4 — Scaffold the TS/Bun tree

```
island/                     # the Phase Two app root
  package.json              # deps: libsodium-wrappers, typescript; scripts: dev/build/test
  tsconfig.json
  bunfig.toml               # (optional) test/runtime config
  src/
    main.ts                 # arg parse, bind wg0, Bun.serve()
    routes/                 # user routes + /admin routes (same server)
    core/                   # identity, friends, envelope, store, gate, canary, sysinfo
  web/                      # static bundle (the four user views + /admin)
  test/                     # *.test.ts, run by `bun test`
  deploy/                   # islandd.service, island-gate.(service|sh), runbook
```

## Build & test

- **Dev:** `bun run src/main.ts` — Bun runs `.ts` directly, no build step.
- **Ship:** `bun build --compile --outfile islandd src/main.ts` → a single
  self-contained executable, per target:
  ```bash
  bun build --compile --target=bun-linux-arm64  ...   # Pi
  bun build --compile --target=bun-linux-x64    ...   # sirius
  bun build --compile --target=bun-darwin-arm64 ...   # macs
  ```
  (Confirm Bun's cross-`--target` matrix covers all three at build time; if a
  target is missing, build that node's binary on the node — noted in [08].)
- **Tests:** `bun test`. Mirror Phase One coverage where it carries over:
  - `envelope` round-trip (sign-then-seal / open-then-verify), tamper rejection,
    and **cross-language byte-compatibility** vs. the Python canonicalisation
    (load a Python-made envelope fixture, verify it in TS).
  - `friends` state machine: token issue → accept → mutual; expiry; replay reject;
    revoke; **no force path exists**.
  - `canary` verify: good open, bad signature deny, expired deny, missing keyword.
  - `sysinfo` parsers: fail2ban + `wg show` fixtures.
- **README + runbook** updated so the project still satisfies the SU495 rubric
  (runs on a separate machine, clear README, foldered, commented, public). The TS
  app must keep a **laptop-only demo path** (mock peers / no real mesh) like Phase
  One's mock store, so it's demonstrable without deploying nodes. With Bun this is
  just `bun run src/main.ts --mock`.

## Step 5 — keep the rubric green

The submission rubric requires a clean README, folder structure, comments, and a
separate-machine run. The migration must not regress that — the new `island/README`
and a refreshed top-level README ship in the same series as the TS scaffold.
