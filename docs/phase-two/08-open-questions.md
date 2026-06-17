# 08 — Open questions (your call before build)

Grouped by how much they change the shape of the code. The **bold** option is my
recommendation; none are decided.

> Language is decided: **TypeScript on Bun**. Several earlier C-specific questions
> (HTTP server vendoring, JSON parser) are now answered by Bun's built-ins and have
> been dropped.

## A. Decisions that change the code shape

1. **One process or two?** Recommend **one `islandd` process** with `/admin` as a
   gated route superset (makes "two backends very similar/seamless" true by
   construction). Alternative: two `bun build --compile` outputs (user/admin) from
   the same `src/` tree.

2. **"Singular file" — how literal?** `bun build --compile` already gives **one
   self-contained executable with the web UI bundled in**, which I think satisfies
   "a singular file" cleanly. Confirm that's your reading.

3. **Storage:** *Decided* — the **universal file share is vega's existing SQLite
   DB, reused** (polaris's DB server deprecated). `bun:sqlite` reads it with the
   Phase One `files` schema kept. Open sub-question → **Q3b**.

3b. **Share scope & adder identity.** Is the universal share **fully shared** among
   all friended members (one common space), or **scoped per friend-pair** (files
   you wrote are only visible to that friend)? And should the `files.node` column
   become the adder's **pubkey/label** instead of the Phase One wg0 IP? Recommend
   **fully shared + pubkey/label**. Your call — it shapes the read/write checks.

4. **Cross-compile vs. build-on-node.** `bun build --compile --target=…` should
   cover linux-arm64 (Pi), linux-x64 (sirius), darwin-arm64 (macs). If any target
   isn't emit-able from one machine, we build that node's binary on the node.
   Confirm you're OK with that fallback.

5. **Does the Go `daemon/` (wg self-heal) stay?** Keep it as-is alongside the TS
   app, or fold its function into the TS app for a smaller tree? Recommend **keep
   as-is** for now (it's out of submission scope, and Go↔TS coexist fine).

## B. Topology / deployment

6. **Which node runs Llama?** Lead candidate **sirius** (x86, capable, already has a
   browser). vega co-located is simpler but loads the gate/edge node. Your call —
   affects whether canary step 5 is a local call or a sealed mesh hop.

7. **NAT traversal stance** (see [02](02-topology.md)): accept the
   **endpoint-anchored mesh** (vega bootstraps reachability, no *app-layer* relay)
   as the Phase Two start? Or do you want full direct-mesh everywhere from day one?

8. **Admin identity:** is "admin" a specific keypair (e.g. yours on polaris/builder)
   or any node holding the admin token? Recommend a **dedicated admin Ed25519 key**
   so the canary signer is unambiguous. Who holds it?

## C. Canary specifics (I need your input — can't pick these for you)

9. **The canary keyword** itself (it's not a secret, but pick a distinctive word).
10. **Llama's approval policy** — the system prompt: what egress requests it should
    approve vs. refuse, max TTL, any scope limits (web-only? specific dests?).
11. **Default open duration** and hard-cap TTL for an opened gate.

## D. Migration safety (blocks Step 1)

12. **Which ref holds the last-good Python app to archive?** The current branch
    already deleted `gui/`. Candidates: `origin/feat/gui-files-ids`,
    `origin/feat/gui-skeleton`, `origin/feat/archived-daemon-gui`, or the
    untracked `gui-and-app/` working copy. I'll verify whichever you point at
    actually runs before branching the archive.

---

### What I'd do next, once you've reviewed

On your go-ahead: confirm the archive ref (Q12), then I scaffold `island/` (the
`package.json`/`tsconfig` + `src/core/` stub modules + `bun test` scaffolding + a
`--mock` demo path), commit it to `feat/island-ts`, and hand you the branch to
push. I won't run the deletions or any push until you say so.
