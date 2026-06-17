// islandd — the single node daemon. One process serves the user app (/) and the
// admin surface (/admin); they share src/core/. Bound to wg0 (the tunnel is the
// management-plane auth boundary, as in Phase One).
//
// Phase A: crypto core + health. Phase B: friending. Phase C: the universal file
// share (vega's reused SQLite DB), with the Phase One file API convention.
// Messaging, home, and the canary gate land in Phases D–F.

import type { Server } from "bun";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CanaryError, makeCanary, verifyCanary } from "./core/canary.ts";
import { fromB64, toB64 } from "./core/codec.ts";
import { VerificationError, type VerifyKeyFor } from "./core/envelope.ts";
import { FriendBook, FriendError } from "./core/friends.ts";
import {
  Gate,
  type GateExec,
  type LlamaClient,
  LlamaHttp,
  MockLlama,
  NoopGateExec,
  ShellGateExec,
} from "./core/gate.ts";
import { generateIdentity, loadIdentity, type Identity } from "./core/identity.ts";
import { MessageBook, openMessage, sealMessage } from "./core/messages.ts";
import {
  buildShare,
  FileNotFound,
  MemoryFileShare,
  type FileShare,
} from "./core/share.ts";
import { getSodium } from "./core/sodium.ts";
import { mockFail2ban, mockWg, readFail2ban, readWg } from "./core/sysinfo.ts";
import { createHash, timingSafeEqual } from "node:crypto";
// The web UI is bundled into the binary as text, so `bun build --compile` stays a
// single self-contained file (no separate frontend deploy). Served at / and /admin.
import indexHtml from "../web/index.html" with { type: "text" };

const VERSION = "0.0.7";
const MAX_UPLOAD = 25 * 1024 * 1024; // island share, not a CDN

/** Caller is authenticated but not authorized for the share (not a friend). */
class Forbidden extends Error {}

interface Args {
  mock: boolean; // in-memory everything; safe to run on a laptop with no mesh
  host: string; // bind address — wg0 addr in prod (pass --host)
  port: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { mock: false, host: "", port: 8787 };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--mock":
        args.mock = true;
        break;
      case "--host":
        args.host = argv[++i] ?? "";
        break;
      case "--port":
        args.port = Number(argv[++i]);
        break;
      default:
        throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

interface Ctx {
  args: Args;
  identity: Identity;
  selfEd: string; // base64 Ed25519 public — our own identity
  label: string;
  wg0: string;
  wgIface: string; // the WireGuard interface to read status from
  peerPort: number; // port to reach friends' inbound endpoint over wg0
  book: FriendBook;
  share: FileShare;
  msgs: MessageBook;
  gate: Gate; // the canary-driven internet gate (default island)
  adminVerify: VerifyKeyFor; // resolves allowlisted admin Ed25519 keys
  canaryKeyword: string;
  canaryFreshnessS: number;
  mockAdmin: Identity | null; // --mock only: drives POST /admin/canary/mint
  adminToken: string; // gates the /admin surface (empty + prod = closed)
  persist: () => Promise<void>;
}

async function boot(args: Args): Promise<Ctx> {
  await getSodium(); // fail fast if the crypto library can't initialise

  const dataDir = process.env.ISLAND_DATA_DIR ?? "/var/lib/islandd";
  const label = process.env.ISLAND_LABEL ?? (args.mock ? "mock-node" : "node");
  const wg0 = process.env.ISLAND_WG0 ?? (args.mock ? "127.0.0.1" : "");

  const peerPort = Number(process.env.ISLAND_PEER_PORT ?? args.port);
  const wgIface = process.env.ISLAND_WG_IFACE ?? "wg0";

  // ---- canary gate setup (Phase F) ----
  const canaryKeyword = process.env.ISLAND_CANARY_KEYWORD ?? "GREEN18";
  const canaryFreshnessS = Number(process.env.ISLAND_CANARY_FRESHNESS ?? 120);
  const gateTtlS = Number(process.env.ISLAND_GATE_TTL ?? 2700); // 45 min

  // admin allowlist: configured pubkeys in prod; a throwaway admin in --mock so the
  // laptop demo can mint+send a canary without a separate admin app.
  let adminPubs = (process.env.ISLAND_ADMIN_PUBKEY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  let mockAdmin: Identity | null = null;
  if (args.mock && adminPubs.length === 0) {
    mockAdmin = await generateIdentity();
    adminPubs = [await toB64(mockAdmin.ed25519.publicKey)];
  }
  const adminKeys = new Map<string, Uint8Array>();
  for (const p of adminPubs) adminKeys.set(p, await fromB64(p));
  const adminVerify: VerifyKeyFor = (ed) => adminKeys.get(ed) ?? null;

  const llama: LlamaClient = args.mock
    ? new MockLlama()
    : new LlamaHttp(process.env.ISLAND_LLAMA_URL ?? "http://127.0.0.1:8080");
  const gateExec: GateExec = args.mock
    ? new NoopGateExec()
    : new ShellGateExec(process.env.ISLAND_GATE_CMD ?? "sudo /usr/local/sbin/island-gate");
  const gate = new Gate(llama, gateExec, gateTtlS);

  let identity: Identity;
  let book: FriendBook;
  let share: FileShare;
  let msgs: MessageBook;
  let persist: () => Promise<void>;

  if (args.mock) {
    identity = await generateIdentity(); // ephemeral
    book = new FriendBook(identity, label, wg0);
    share = new MemoryFileShare();
    msgs = new MessageBook();
    persist = async () => {};
  } else {
    const identityDir = process.env.ISLAND_IDENTITY_DIR ?? join(dataDir, "identity");
    identity = await loadIdentity(identityDir); // never generated here — William's keys
    const bookPath = join(dataDir, "friends.json");
    const msgPath = join(dataDir, "messages.json");
    book = existsSync(bookPath)
      ? FriendBook.fromJSON(identity, label, wg0, JSON.parse(await readFile(bookPath, "utf8")))
      : new FriendBook(identity, label, wg0);
    msgs = existsSync(msgPath)
      ? MessageBook.fromJSON(JSON.parse(await readFile(msgPath, "utf8")))
      : new MessageBook();
    share = buildShare(); // ISLAND_SHARE = sqlite (vega) | remote (other nodes)
    persist = async () => {
      await mkdir(dataDir, { recursive: true });
      await writeFile(bookPath, JSON.stringify(book));
      await writeFile(msgPath, JSON.stringify(msgs));
    };
  }

  return {
    args,
    identity,
    selfEd: await toB64(identity.ed25519.publicKey),
    label,
    wg0,
    wgIface,
    peerPort,
    book,
    share,
    msgs,
    gate,
    adminVerify,
    canaryKeyword,
    canaryFreshnessS,
    mockAdmin,
    adminToken: process.env.ISLAND_ADMIN_TOKEN ?? "",
    persist,
  };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Authorize a file-share request and return the adder's verified identity (`node`).
 * Membership = a friend of this node (vega). WireGuard pins each peer's wg0 IP to its
 * key, so the source address is real per-peer auth. Loopback = the local operator.
 */
function authorizeShare(req: Request, server: Server<undefined>, ctx: Ctx): string {
  if (ctx.args.mock) return ctx.label; // laptop demo: no mesh, allow local
  const ip = server.requestIP(req)?.address ?? "";
  if (LOOPBACK.has(ip)) return ctx.selfEd; // operator on the host itself
  const friend = ctx.book.friendByWg0(ip);
  if (!friend) throw new Forbidden(`not a friend: ${ip}`);
  return friend.peer.ed25519;
}

/** Operator-only endpoints (read your threads / send as this node): loopback or mock. */
function requireOperator(req: Request, server: Server<undefined>, ctx: Ctx): void {
  if (ctx.args.mock) return;
  const ip = server.requestIP(req)?.address ?? "";
  if (!LOOPBACK.has(ip)) throw new Forbidden("operator-only endpoint");
}

const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();

/** Gate the /admin surface with the admin token (constant-time). Open in --mock so the
 *  laptop demo works; fail-closed in prod if no token is configured. */
function requireAdmin(req: Request, ctx: Ctx): void {
  if (ctx.args.mock) return;
  if (!ctx.adminToken) throw new Forbidden("admin token not configured");
  const presented = req.headers.get("x-admin-token") ?? "";
  if (!timingSafeEqual(sha256(presented), sha256(ctx.adminToken))) {
    throw new Forbidden("bad admin token");
  }
}

/** Where to deliver a message to a friend. wg0 may be "ip" or "ip:port" (tests). */
function peerInbound(wg0: string, defaultPort: number): string {
  const hostPort = /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(wg0) ? wg0 : `${wg0}:${defaultPort}`;
  return `http://${hostPort}/api/messages/inbound`;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw new FriendError("invalid JSON body");
  }
}

async function route(req: Request, server: Server<undefined>, ctx: Ctx): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (method === "GET" && path === "/api/health") {
    return Response.json({ ok: true, service: "islandd", version: VERSION, mock: ctx.args.mock });
  }

  // ---- home + gate (Phase E) ----
  // The node's own dashboard: gate state, wg connectivity, local fail2ban, requests.
  if (method === "GET" && path === "/api/home") {
    requireOperator(req, server, ctx);
    const [wg, fail2ban] = ctx.args.mock
      ? [mockWg(ctx.wgIface), mockFail2ban()]
      : await Promise.all([readWg(ctx.wgIface), readFail2ban()]);
    const gs = ctx.gate.state();
    return Response.json({
      gate: { state: gs.state, closes_at: gs.closesAt },
      wg: {
        iface: wg.iface,
        peers: wg.peers.map((p) => ({
          label: ctx.book.friendByWg0(p.wg0)?.peer.label ?? null,
          wg0: p.wg0,
          handshake_age_s: p.handshakeAgeS,
          up: p.up,
        })),
      },
      fail2ban,
      requests: ctx.book.listPending().map((r) => ({
        from_label: r.peer.label,
        from_pubkey: r.peer.ed25519,
        received: r.received,
      })),
    });
  }
  // Island-mode indicator — readable by anyone on the node (informational).
  if (method === "GET" && path === "/api/gate") {
    const gs = ctx.gate.state();
    return Response.json({ state: gs.state, closes_at: gs.closesAt });
  }

  // ---- admin: manage friendships (Phase G) ----
  // Full friendship view for the admin console.
  if (method === "GET" && path === "/admin/friends") {
    requireAdmin(req, ctx);
    return Response.json({
      friends: ctx.book.listFriends(),
      pending: ctx.book.listPending(),
      offered: ctx.book.listOffered().length,
    });
  }
  // Delete (revoke) a friendship. There is deliberately NO POST/create — admin can
  // delete but never forge (a friendship only exists via the verified handshake).
  const adminDel = path.match(/^\/admin\/friends\/(.+)$/);
  if (method === "DELETE" && adminDel) {
    requireAdmin(req, ctx);
    const removed = ctx.book.revoke(decodeURIComponent(adminDel[1]!));
    if (!removed) return new Response("no such friend", { status: 404 });
    await ctx.persist();
    return new Response(null, { status: 204 });
  }

  // ---- canary gate (Phase F) — vega ----
  // Open the gate: crypto-gated by the canary itself (admin signature + seal), so the
  // admin app may call this remotely; the LLM then approves/denies.
  if (method === "POST" && path === "/admin/canary") {
    requireAdmin(req, ctx); // coarse /admin gate; the canary signature is the real auth
    const body = await readJson(req);
    const canary = await verifyCanary(
      ctx.identity,
      String(body.blob),
      ctx.adminVerify,
      ctx.canaryKeyword,
      ctx.canaryFreshnessS,
    );
    const result = await ctx.gate.open(canary);
    return Response.json({
      opened: result.opened,
      reason: result.reason,
      gate: { state: result.state.state, closes_at: result.state.closesAt },
    });
  }
  // Gate audit log.
  if (method === "GET" && path === "/admin/gate/log") {
    requireAdmin(req, ctx);
    return Response.json({ log: ctx.gate.log() });
  }
  // Manual early close (least privilege — closing is always safe).
  if (method === "POST" && path === "/admin/gate/close") {
    requireAdmin(req, ctx);
    const gs = await ctx.gate.close("manual (admin)");
    return Response.json({ gate: { state: gs.state, closes_at: gs.closesAt } });
  }
  // --mock only: mint a canary (the admin app's job in prod) so the laptop demo can
  // drive the full open flow without a separate admin keypair.
  if (method === "POST" && path === "/admin/canary/mint") {
    if (!ctx.args.mock || !ctx.mockAdmin) return new Response("not found", { status: 404 });
    const body = await readJson(req);
    const text = String(body.text ?? `${ctx.canaryKeyword} open the gate`);
    const blob = await makeCanary(
      ctx.mockAdmin,
      ctx.canaryKeyword,
      text,
      await toB64(ctx.identity.x25519.publicKey),
    );
    return Response.json({ blob });
  }

  // ---- friending (Phase B) ----
  if (method === "GET" && path === "/api/friends") {
    return Response.json({
      friends: ctx.book.listFriends(),
      pending: ctx.book.listPending(),
      offered: ctx.book.listOffered().length,
    });
  }
  if (method === "POST" && path === "/api/friends/token") {
    const body = await readJson(req);
    const ttl = typeof body.ttlSeconds === "number" ? body.ttlSeconds : 86_400;
    const token = await ctx.book.issueToken(ttl);
    await ctx.persist();
    return Response.json({ token });
  }
  if (method === "POST" && path === "/api/friends/receive") {
    const body = await readJson(req);
    const request = await ctx.book.receive(body.token as never);
    await ctx.persist();
    return Response.json({ request });
  }
  if (method === "POST" && path === "/api/friends/accept") {
    const body = await readJson(req);
    const accept = await ctx.book.accept(String(body.giver));
    await ctx.persist();
    return Response.json({ accept });
  }
  if (method === "POST" && path === "/api/friends/confirm") {
    const body = await readJson(req);
    const friend = await ctx.book.confirm(String(body.accept));
    await ctx.persist();
    return Response.json({ friend });
  }

  // ---- messaging (Phase D) — direct P2P, sealed ----
  // Read a thread (operator only).
  if (method === "GET" && path === "/api/messages") {
    requireOperator(req, server, ctx);
    const peer = url.searchParams.get("peer");
    if (!peer) throw new FriendError("peer query param required");
    return Response.json({ thread: ctx.msgs.thread(peer) });
  }
  // Send a message AS this node to a friend (operator only): seal, store, deliver.
  if (method === "POST" && path === "/api/messages") {
    requireOperator(req, server, ctx);
    const body = await readJson(req);
    const peer = String(body.peer);
    const text = String(body.body ?? "");
    const friend = ctx.book.friend(peer);
    if (!friend) throw new FriendError("not a friend");
    const blob = await sealMessage(ctx.identity, friend.peer, text);
    ctx.msgs.append(peer, { dir: "out", from: ctx.selfEd, to: peer, body: text, ts: new Date().toISOString() });
    await ctx.persist();
    let delivered = false;
    try {
      const r = await fetch(peerInbound(friend.peer.wg0, ctx.peerPort), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blob }),
      });
      delivered = r.ok;
    } catch {
      delivered = false;
    }
    return Response.json({ ok: true, delivered });
  }
  // Receive a delivered message from a friend. Crypto is the gate (non-friend fails).
  if (method === "POST" && path === "/api/messages/inbound") {
    const body = await readJson(req);
    const verify = await ctx.book.verifyKeyResolver();
    const msg = await openMessage(ctx.identity, String(body.blob), verify);
    ctx.msgs.append(msg.from, { dir: "in", from: msg.from, to: msg.to, body: msg.body, ts: msg.ts });
    await ctx.persist();
    return Response.json({ ok: true });
  }

  // ---- universal file share (Phase C) — Phase One API convention ----
  if (method === "GET" && path === "/api/files") {
    authorizeShare(req, server, ctx);
    return Response.json(await ctx.share.list());
  }
  if (method === "POST" && path === "/api/files") {
    const node = authorizeShare(req, server, ctx);
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new FriendError("missing 'file' field");
    const content = new Uint8Array(await file.arrayBuffer());
    if (content.length > MAX_UPLOAD) {
      return Response.json({ error: "file too large" }, { status: 413 });
    }
    const added = await ctx.share.add(file.name, content, node, file.type || undefined);
    return Response.json(added, { status: 201 });
  }
  const download = path.match(/^\/api\/files\/(\d+)\/download$/);
  if (method === "GET" && download) {
    authorizeShare(req, server, ctx);
    const { name, contentType, content } = await ctx.share.get(Number(download[1]));
    return new Response(content, {
      headers: {
        "content-type": contentType || "application/octet-stream",
        "content-disposition": `attachment; filename="${name}"`,
      },
    });
  }
  const del = path.match(/^\/api\/files\/(\d+)$/);
  if (method === "DELETE" && del) {
    authorizeShare(req, server, ctx);
    await ctx.share.remove(Number(del[1]));
    return new Response(null, { status: 204 });
  }

  // Web UI (Phase G): serve the bundled SPA for any non-API GET. The client routes
  // on the path — "/" is the user app, "/admin" is the admin console.
  if (method === "GET" && !path.startsWith("/api/")) {
    // `with { type: "text" }` makes Bun bundle the file as a string at runtime; the
    // @types/bun .html mapping is HTMLBundle, hence the cast.
    return new Response(indexHtml as unknown as string, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  return new Response("not found", { status: 404 });
}

function errorStatus(err: unknown): number {
  if (err instanceof FileNotFound) return 404;
  if (err instanceof Forbidden) return 403;
  if (err instanceof VerificationError) return 403; // untrusted message/canary signer
  if (err instanceof CanaryError) return 403; // invalid/replayed/stale canary
  if (err instanceof FriendError) return 400;
  return 500;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const ctx = await boot(args);
  const host = args.host || "127.0.0.1"; // prod binds wg0 via --host; mock -> loopback

  const server = Bun.serve({
    hostname: host,
    port: args.port,
    fetch: async (req, srv) => {
      try {
        return await route(req, srv, ctx);
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: errorStatus(err) });
      }
    },
  });

  console.log(
    `islandd ${VERSION} listening on http://${server.hostname}:${server.port} (mock=${args.mock})`,
  );
}

main();
