// islandd CLI — manage a node from the terminal, built for HEADLESS nodes (a Pi over
// SSH, no browser). It just talks HTTP to the running daemon, so the daemon stays the
// single source of truth. Operator auth: loopback (the default ISLAND_ADDR) or the
// op-token (ISLAND_OP_TOKEN, sent as x-op-token) for a daemon bound to wg0.
//
//   islandd keygen [dir]                 (generate this node's identity keys)
//   islandd canary --admin-dir <dir> --to-x25519 <vega-x25519> [--send <url> --admin-token <tok>]
//                                        (mint a signed+sealed canary to open vega's gate)
//   islandd friend invite [--ttl <seconds>]
//   islandd friend accept  '<token>'
//   islandd friend confirm '<reply>'
//   islandd friend list

import { join } from "node:path";

const ADDR = process.env.ISLAND_ADDR ?? "http://127.0.0.1:8787";
const OP = process.env.ISLAND_OP_TOKEN ?? "";
const ADMIN = process.env.ISLAND_ADMIN_TOKEN ?? ""; // admin token also authorizes operator actions

async function req(path: string, json?: unknown): Promise<any> {
  const headers: Record<string, string> = {};
  if (ADMIN) headers["x-admin-token"] = ADMIN;
  if (OP) headers["x-op-token"] = OP;
  let body: string | undefined;
  if (json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(json);
  }
  const r = await fetch(`${ADDR}${path}`, { method: body ? "POST" : "GET", headers, body });
  const j = (await r.json().catch(() => null)) as any;
  if (!r.ok) throw new Error((j && j.error) || `HTTP ${r.status}`);
  return j;
}

function usage(): never {
  console.log(
    `islandd keygen [dir]         generate this node's identity keypairs (does not overwrite)
islandd canary               mint a signed+sealed canary to open vega's gate
  --admin-dir <dir>          the admin keypair dir (from \`islandd keygen\`; holds the private key)
  --to-x25519 <b64>          vega's X25519 public key (read it from vega's /api/identity)
  [--text '<keyword …>']     the request (default "<keyword> open the gate")
  [--keyword GREEN18]        the canary keyword (default GREEN18 / ISLAND_CANARY_KEYWORD)
  [--send <url>]             POST the canary to vega; omit to just print the blob
  [--admin-token <tok>]      vega's admin token (/admin/canary is admin-gated; or ISLAND_ADMIN_TOKEN)
islandd friend <command>
  invite [--ttl <seconds>]   issue an invite to hand to a friend (default 24h)
  accept  '<token>'          accept an invite -> prints a reply to send back
  confirm '<reply>'          finish a friendship you invited
  list                       show friends + pending requests

friend commands connect to ISLAND_ADDR (${ADDR}). For a remote/headless node, set
ISLAND_ADMIN_TOKEN (the node's admin credential; ISLAND_OP_TOKEN also works).`,
  );
  process.exit(2);
}

/** Generate this node's identity keys into <dir>. Run by the operator (the daemon
 *  itself never mints keys); refuses to overwrite an existing identity. */
async function keygen(dir: string): Promise<void> {
  const { existsSync } = await import("node:fs");
  const { generateIdentity, saveIdentity } = await import("./core/identity.ts");
  const { toB64 } = await import("./core/codec.ts");
  if (existsSync(join(dir, "ed25519.key"))) {
    console.error(`refusing to overwrite an existing identity in ${dir}`);
    process.exit(1);
  }
  const id = await generateIdentity();
  await saveIdentity(dir, id);
  console.log(`identity written to ${dir}`);
  console.log(`this node's public key: ${await toB64(id.ed25519.publicKey)}`);
}

/** Parse `--key value` / bare `--flag` pairs into a map (values with spaces come pre-split
 *  by the shell into a single argv element, so `--text 'a b c'` arrives intact). */
function parseFlags(argv: string[]): Record<string, string> {
  const f: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith("--")) continue;
    const next = argv[i + 1];
    f[a.slice(2)] = next && !next.startsWith("--") ? argv[++i]! : "true";
  }
  return f;
}

/**
 * Mint a canary — sign it with the ADMIN private key and seal it to vega's X25519 — then
 * (optionally) POST it to vega's /admin/canary. This is the production "admin app" for the
 * gate: the admin private key lives ONLY here, never in a browser and never on vega.
 * Without --send it prints the sealed blob so it can be delivered by hand.
 */
async function mintCanary(argv: string[]): Promise<void> {
  const { loadIdentity } = await import("./core/identity.ts");
  const { makeCanary } = await import("./core/canary.ts");
  const f = parseFlags(argv);
  const adminDir = f["admin-dir"];
  const toX = f["to-x25519"];
  const keyword = f["keyword"] ?? process.env.ISLAND_CANARY_KEYWORD ?? "GREEN18";
  const text = f["text"] ?? `${keyword} open the gate`;
  const send = f["send"];
  const adminToken = f["admin-token"] ?? ADMIN;
  if (!adminDir || !toX) {
    console.error(
      "usage: islandd canary --admin-dir <dir> --to-x25519 <vega x25519 b64>\n" +
        "       [--text '<keyword …>'] [--keyword GREEN18] [--send <vega url> --admin-token <tok>]\n" +
        "  --to-x25519 is vega's encryption key — read it from vega's /api/identity.",
    );
    process.exit(2);
  }
  const admin = await loadIdentity(adminDir); // throws clearly if the keypair dir is wrong
  const blob = await makeCanary(admin, keyword, text, toX);
  if (!send) {
    console.log(blob); // print the sealed canary for manual delivery / paste into /admin
    return;
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (adminToken) headers["x-admin-token"] = adminToken;
  const r = await fetch(`${send}/admin/canary`, { method: "POST", headers, body: JSON.stringify({ blob }) });
  const j = (await r.json().catch(() => null)) as { error?: string; opened?: boolean; reason?: string; gate?: { state: string; closes_at: string | null } } | null;
  if (!r.ok) {
    console.error("error:", (j && j.error) || `HTTP ${r.status}`);
    process.exit(1);
  }
  console.log(j?.opened ? `Gate opened — ${j.reason}` : `Denied — ${j?.reason ?? "no reason"}`);
  if (j?.gate) console.log(`gate: ${j.gate.state}${j.gate.closes_at ? ` (recloses ${j.gate.closes_at})` : ""}`);
}

export async function runCli(argv: string[]): Promise<void> {
  const [group, cmd, ...rest] = argv;
  if (group === "keygen") {
    await keygen(cmd ?? join(process.env.ISLAND_DATA_DIR ?? "/var/lib/islandd", "identity"));
    return;
  }
  if (group === "canary") {
    await mintCanary(argv.slice(1));
    return;
  }
  if (group !== "friend") usage();
  try {
    if (cmd === "invite") {
      const i = rest.indexOf("--ttl");
      const ttl = i >= 0 ? Number(rest[i + 1]) : 86_400;
      const { invite } = await req("/api/friends/token", { ttlSeconds: ttl });
      console.log("Send this invite to your friend:\n");
      console.log(invite);
    } else if (cmd === "accept") {
      if (!rest[0]) usage();
      const { request } = await req("/api/friends/receive", { invite: rest[0] });
      const { reply } = await req("/api/friends/accept", { giver: request.ed25519 });
      console.log(`Connected to ${request.label}. Send this reply back to them:\n`);
      console.log(reply);
    } else if (cmd === "confirm") {
      if (!rest[0]) usage();
      const { friend } = await req("/api/friends/confirm", { reply: rest[0] });
      console.log(`Friendship complete: ${friend.peer.label}`);
    } else if (cmd === "list") {
      const d = await req("/api/friends");
      console.log(`Friends (${d.friends.length}):`);
      for (const f of d.friends) console.log(`  ${f.peer.label}  ${f.peer.ed25519.slice(0, 20)}…`);
      if (d.pending.length) {
        console.log(`Pending (${d.pending.length}):`);
        for (const p of d.pending) console.log(`  ${p.peer.label}  (run: islandd friend list to accept via UI)`);
      }
    } else {
      usage();
    }
  } catch (e) {
    console.error("error:", (e as Error).message);
    process.exit(1);
  }
}
