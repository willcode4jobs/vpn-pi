// islandd — the single node daemon. One process serves the user app (/) and the
// admin surface (/admin); they share src/core/. Bound to wg0 (the tunnel is the
// management-plane auth boundary, as in Phase One).
//
// Phase A: crypto core + health. Phase B: friending. Phase C: the universal file
// share (vega's reused SQLite DB), with the Phase One file API convention.
// Messaging, home, and the canary gate land in Phases D–F.

import type { Server } from "bun";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.ts";
import { CanaryError, makeCanary, verifyCanary } from "./core/canary.ts";
import { decodeInvite, decodeReply, encodeInvite, encodeReply, fingerprint } from "./core/friendcode.ts";
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
import { generateIdentity, loadIdentity, saveIdentity, type Identity } from "./core/identity.ts";
import { MessageBook, openMessage, sealMessage } from "./core/messages.ts";
import {
  announce,
  registerAnnounce,
  RegistryError,
  RegistryStore,
  type RegistryRecord,
  resolve,
} from "./core/registry.ts";
import { collectLocal, EventError, EventStore, ingest, report, type EventReport } from "./core/events.ts";
import {
  buildShare,
  FileNotFound,
  MemoryFileShare,
  type FileShare,
} from "./core/share.ts";
import { getSodium } from "./core/sodium.ts";
import { mockDaemon, mockFail2ban, mockWg, readDaemon, readFail2ban, readWg } from "./core/sysinfo.ts";
import { manageOk, tokenOk } from "./core/auth.ts";
import { AttemptLimiter } from "./core/ratelimit.ts";
// The web UI is bundled into the binary as text, so `bun build --compile` stays a
// single self-contained file (no separate frontend deploy). Served at / and /admin.
import indexHtml from "../web/index.html" with { type: "text" };

const VERSION = "0.0.7";
const MAX_UPLOAD = 25 * 1024 * 1024; // island share, not a CDN

/** Caller is authenticated but not authorized for the share (not a friend). */
class Forbidden extends Error {}
/** Too many failed auth attempts from this source — brute-force lockout. */
class RateLimited extends Error {}

interface Args {
  mock: boolean; // in-memory everything; safe to run on a laptop with no mesh
  host: string; // bind address — wg0 addr in prod (pass --host)
  port: number;
}

/** Auto-detect the address to bind: explicit wins, then mock=loopback, then the wg
 *  interface's own address (so `islandd` needs no --host), else loopback with a warning. */
function resolveHost(explicit: string, mock: boolean, wgIface: string): string {
  if (explicit) return explicit;
  if (mock) return "127.0.0.1";
  const addrs = networkInterfaces()[wgIface] ?? [];
  const v4 = addrs.find((a) => a.family === "IPv4" && !a.internal);
  const v6 = addrs.find((a) => a.family === "IPv6" && !a.internal);
  if (v4) return v4.address;
  if (v6) return v6.address;
  console.warn(`⚠ ${wgIface} has no address — binding 127.0.0.1. Pass --host or ISLAND_HOST to override.`);
  return "127.0.0.1";
}

function parseArgs(argv: string[]): Args {
  const args: Args = { mock: false, host: "", port: Number(process.env.ISLAND_PORT ?? 8787) };
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
  registry: RegistryStore | null; // friend-code directory (polaris; ISLAND_REGISTRY=1)
  registryUrl: string; // where this node announces/resolves codes (ISLAND_REGISTRY_URL)
  eventStore: EventStore | null; // IDS collector (polaris; ISLAND_EVENTS=1)
  eventsUrl: string; // where this node reports security events (ISLAND_EVENTS_URL)
  adminVerify: VerifyKeyFor; // resolves allowlisted admin Ed25519 keys
  canaryKeyword: string;
  canaryFreshnessS: number;
  mockAdmin: Identity | null; // --mock only: drives POST /admin/canary/mint
  adminToken: string; // gates the /admin surface (empty + prod = closed)
  dataDir: string; // where keys/token/marker live (the first-run reveal consumes a marker here)
  opToken: string; // operator token — lets a headless node be managed over the mesh
  authLimiter: AttemptLimiter; // brute-force lockout on failed admin/operator auth
  persist: () => Promise<void>;
}

/** Name of the one-time reveal marker. While it exists, GET /admin/firstrun hands the
 *  auto-generated admin token to the first visitor of /admin, then deletes it (the
 *  token gets to the sysadmin exactly where they go first, then is gone). */
const FIRSTRUN_MARKER = "admin.token.fresh";

/** Resolve the admin token: env var wins; else reuse a saved one, or generate + print
 *  a strong one in the data dir. A freshly generated token also drops a one-time reveal
 *  marker so /admin can surface it once. --mock returns "" (admin is open). */
async function provisionAdminToken(mock: boolean, dataDir: string): Promise<string> {
  if (mock) return "";
  const env = process.env.ISLAND_ADMIN_TOKEN ?? "";
  if (env) {
    if (env.length < 16) console.warn("⚠ ISLAND_ADMIN_TOKEN is short — use a long random value.");
    return env;
  }
  const tokPath = join(dataDir, "admin.token");
  if (existsSync(tokPath)) return (await readFile(tokPath, "utf8")).trim();
  const s = await getSodium();
  const tok = s.to_base64(s.randombytes_buf(18), s.base64_variants.URLSAFE_NO_PADDING);
  await mkdir(dataDir, { recursive: true });
  await writeFile(tokPath, tok, { mode: 0o600 });
  await writeFile(join(dataDir, FIRSTRUN_MARKER), "", { mode: 0o600 }); // shown once at /admin
  console.log(`\n  Admin token:  ${tok}\n  Shown once when you first open /admin, then removed.\n  Also saved to ${tokPath}\n`);
  return tok;
}

async function boot(args: Args): Promise<Ctx> {
  await getSodium(); // fail fast if the crypto library can't initialise

  // No-root default: a personal node just works out of ~/.islandd (the systemd unit
  // overrides this with /var/lib/islandd).
  const dataDir = process.env.ISLAND_DATA_DIR ?? join(homedir(), ".islandd");
  const label = process.env.ISLAND_LABEL ?? (args.mock ? "mock-node" : "node");
  // This node's reachable mesh address — used in tokens, registry records, and as the
  // bind address. ISLAND_WG0 wins; else auto-detect the wg0 interface.
  const wg0 = process.env.ISLAND_WG0 || resolveHost("", args.mock, process.env.ISLAND_WG_IFACE ?? "wg0");

  const peerPort = Number(process.env.ISLAND_PEER_PORT ?? args.port);
  const wgIface = process.env.ISLAND_WG_IFACE ?? "wg0";

  // Admin token: env wins; else reuse/auto-generate one in the data dir and print it,
  // so a fresh node has working (token-gated) admin with zero config. (--mock = open.)
  const adminToken = await provisionAdminToken(args.mock, dataDir);

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

  // ---- friend-code registry (Phase I — polaris). Enabled on the registry node, and
  // always in --mock so the demo can announce+resolve against itself. ----
  const registryEnabled = args.mock || /^(1|true|yes)$/i.test(process.env.ISLAND_REGISTRY ?? "");
  const registry = registryEnabled
    ? new RegistryStore(args.mock ? ":memory:" : join(dataDir, "registry.db"))
    : null;

  // ---- IDS / security collector (Phase J — polaris). On in --mock for the demo. ----
  const eventsEnabled = args.mock || /^(1|true|yes)$/i.test(process.env.ISLAND_EVENTS ?? "");
  const eventStore = eventsEnabled
    ? new EventStore(args.mock ? ":memory:" : join(dataDir, "events.db"))
    : null;

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
    if (!existsSync(join(identityDir, "ed25519.key"))) {
      await saveIdentity(identityDir, await generateIdentity()); // first-run auto-provision
      console.log(`generated this node's identity in ${identityDir}`);
    }
    identity = await loadIdentity(identityDir);
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
    registry,
    registryUrl: process.env.ISLAND_REGISTRY_URL ?? "",
    eventStore,
    eventsUrl: process.env.ISLAND_EVENTS_URL ?? "",
    adminVerify,
    canaryKeyword,
    canaryFreshnessS,
    mockAdmin,
    adminToken,
    dataDir,
    opToken: process.env.ISLAND_OP_TOKEN ?? "",
    // 10 failed auth attempts / 5 min per source IP, then locked out (429).
    authLimiter: new AttemptLimiter(10, 5 * 60_000),
    persist,
  };
}

/**
 * Is this request from the node's operator? mock / loopback / a valid op-token, OR a
 * valid ADMIN token — admin is a superset of operator, so the one admin credential
 * unlocks both operator actions and the /admin surface (a single key per node).
 */
function isOperator(req: Request, server: Server<undefined>, ctx: Ctx): boolean {
  const ip = server.requestIP(req)?.address ?? "";
  return manageOk(
    ip,
    req.headers.get("x-op-token") ?? "",
    req.headers.get("x-admin-token") ?? "",
    { mock: ctx.args.mock, opToken: ctx.opToken, adminToken: ctx.adminToken },
  );
}

/**
 * Authorize a file-share request and return the adder's verified identity (`node`).
 * The operator is always allowed; otherwise membership = a friend of this node
 * (WireGuard pins each peer's wg0 IP to its key, so the source address is real auth).
 */
function authorizeShare(req: Request, server: Server<undefined>, ctx: Ctx): string {
  if (isOperator(req, server, ctx)) return ctx.selfEd;
  const ip = server.requestIP(req)?.address ?? "";
  const friend = ctx.book.friendByWg0(ip);
  if (!friend) throw new Forbidden(`not a friend: ${ip}`);
  return friend.peer.ed25519;
}

/** Operator-only endpoints. Operator = loopback, --mock, or a valid op/admin token.
 *  Failed attempts are rate-limited per IP (brute-force lockout). */
function requireOperator(req: Request, server: Server<undefined>, ctx: Ctx): void {
  const ip = server.requestIP(req)?.address ?? "?";
  if (ctx.authLimiter.locked(ip)) throw new RateLimited("too many attempts — try again later");
  if (isOperator(req, server, ctx)) {
    ctx.authLimiter.reset(ip);
    return;
  }
  ctx.authLimiter.fail(ip);
  throw new Forbidden("operator-only endpoint");
}

/** Gate the /admin surface with the admin token (constant-time + rate-limited). Open in
 *  --mock so the laptop demo works; fail-closed in prod if no token is configured. */
function requireAdmin(req: Request, server: Server<undefined>, ctx: Ctx): void {
  if (ctx.args.mock) return;
  if (!ctx.adminToken) throw new Forbidden("admin token not configured");
  const ip = server.requestIP(req)?.address ?? "?";
  if (ctx.authLimiter.locked(ip)) throw new RateLimited("too many attempts — try again later");
  if (!tokenOk(req.headers.get("x-admin-token") ?? "", ctx.adminToken)) {
    ctx.authLimiter.fail(ip);
    throw new Forbidden("bad admin token");
  }
  ctx.authLimiter.reset(ip);
}

/** Build a URL to reach a peer over the mesh. wg0 may be "ip" or "ip:port" (tests). */
function peerUrl(wg0: string, defaultPort: number, path: string): string {
  const hostPort = /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(wg0) ? wg0 : `${wg0}:${defaultPort}`;
  return `http://${hostPort}${path}`;
}

/** POST JSON to a peer over the mesh, returning whether it was delivered (best-effort). */
async function deliver(wg0: string, port: number, path: string, body: unknown): Promise<boolean> {
  try {
    const r = await fetch(peerUrl(wg0, port, path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch {
    return false;
  }
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
    return Response.json({
      ok: true,
      service: "islandd",
      version: VERSION,
      mock: ctx.args.mock,
      events: !!ctx.eventStore, // is this node the IDS collector? (drives the admin Security tab)
    });
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

  // ---- friend-code registry (Phase I — polaris only). Public directory: any node
  // announces its OWN signed record, anyone resolves a code. ----
  if (ctx.registry && method === "POST" && path === "/registry/announce") {
    const body = await readJson(req);
    const code = await registerAnnounce(ctx.registry, body.record as RegistryRecord, String(body.sig));
    return Response.json({ code });
  }
  if (ctx.registry && method === "GET") {
    const m = path.match(/^\/registry\/resolve\/(.+)$/);
    if (m) {
      const record = ctx.registry.get(decodeURIComponent(m[1]!).toUpperCase());
      if (!record) return new Response("code not found", { status: 404 });
      return Response.json(record);
    }
  }

  // ---- IDS / security events (Phase J — collector node only) ----
  // Inbound (from a node, signature-verified): store its latest security snapshot.
  if (ctx.eventStore && method === "POST" && path === "/events/report") {
    await ingest(ctx.eventStore, (await readJson(req)) as unknown as EventReport);
    return Response.json({ ok: true });
  }
  // Admin: the universal feed across all nodes.
  if (ctx.eventStore && method === "GET" && path === "/admin/events") {
    requireAdmin(req, server, ctx);
    return Response.json({ nodes: ctx.eventStore.list() });
  }

  // ---- admin: manage friendships (Phase G) ----
  // Full friendship view for the admin console.
  if (method === "GET" && path === "/admin/friends") {
    requireAdmin(req, server, ctx);
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
    requireAdmin(req, server, ctx);
    const removed = ctx.book.revoke(decodeURIComponent(adminDel[1]!));
    if (!removed) return new Response("no such friend", { status: 404 });
    await ctx.persist();
    return new Response(null, { status: 204 });
  }

  // ---- first-run admin token reveal ----
  // Deliberately UNAUTHENTICATED: it hands the auto-generated token to whoever opens
  // /admin first (a sysadmin's first stop), then consumes the marker so it's shown
  // exactly once. Only ever returns an AUTO-PROVISIONED token: with --mock (no token)
  // or an env-set ISLAND_ADMIN_TOKEN there is no marker, so this returns null and the
  // operator's own secret is never echoed back. First-viewer-wins — see RUNBOOK.
  if (method === "GET" && path === "/admin/firstrun") {
    const marker = join(ctx.dataDir, FIRSTRUN_MARKER);
    if (!ctx.adminToken || ctx.args.mock || !existsSync(marker)) {
      return Response.json({ token: null });
    }
    await unlink(marker).catch(() => {}); // consume first, so a re-read can't re-reveal
    return Response.json({ token: ctx.adminToken });
  }

  // ---- canary gate (Phase F) — vega ----
  // Open the gate: crypto-gated by the canary itself (admin signature + seal), so the
  // admin app may call this remotely; the LLM then approves/denies.
  if (method === "POST" && path === "/admin/canary") {
    requireAdmin(req, server, ctx); // coarse /admin gate; the canary signature is the real auth
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
    requireAdmin(req, server, ctx);
    return Response.json({ log: ctx.gate.log() });
  }
  // Manual early close (least privilege — closing is always safe).
  if (method === "POST" && path === "/admin/gate/close") {
    requireAdmin(req, server, ctx);
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

  // ---- friending (Phase B) — operator-only (loopback / mock / op-token) ----
  if (method === "GET" && path === "/api/friends") {
    requireOperator(req, server, ctx);
    return Response.json({
      friends: ctx.book.listFriends(),
      pending: ctx.book.listPending(),
      offered: ctx.book.listOffered().length,
    });
  }
  if (method === "POST" && path === "/api/friends/token") {
    requireOperator(req, server, ctx);
    const body = await readJson(req);
    const ttl = typeof body.ttlSeconds === "number" ? body.ttlSeconds : 86_400;
    const token = await ctx.book.issueToken(ttl);
    await ctx.persist();
    return Response.json({ invite: await encodeInvite(token) }); // compact code, not JSON
  }
  if (method === "POST" && path === "/api/friends/receive") {
    requireOperator(req, server, ctx);
    const body = await readJson(req);
    // accept a compact invite code, or a raw token object (legacy)
    const token = body.invite ? await decodeInvite(String(body.invite)) : (body.token as never);
    const request = await ctx.book.receive(token);
    await ctx.persist();
    return Response.json({ request });
  }
  if (method === "POST" && path === "/api/friends/accept") {
    requireOperator(req, server, ctx);
    const body = await readJson(req);
    const giver = String(body.giver);
    const blob = await ctx.book.accept(giver);
    await ctx.persist();
    // mesh path: deliver the accept straight back to the giver; paste path: they copy it
    const wg0 = ctx.book.friend(giver)?.peer.wg0 ?? "";
    const delivered = wg0 ? await deliver(wg0, ctx.peerPort, "/api/friends/accept-inbound", { accept: blob }) : false;
    return Response.json({ reply: encodeReply(blob), delivered });
  }
  if (method === "POST" && path === "/api/friends/confirm") {
    requireOperator(req, server, ctx);
    const body = await readJson(req);
    const accept = body.reply ? decodeReply(String(body.reply)) : String(body.accept);
    const friend = await ctx.book.confirm(accept);
    await ctx.persist();
    return Response.json({ friend });
  }
  // ---- friend by code (Phase I-4) — resolve via registry, handshake over the mesh ----
  // Operator: add a friend by their ISL-… code (resolve → send a signed request).
  if (method === "POST" && path === "/api/friends/add") {
    requireOperator(req, server, ctx);
    if (!ctx.registryUrl) throw new FriendError("no registry configured (set ISLAND_REGISTRY_URL)");
    const body = await readJson(req);
    const record = await resolve(ctx.registryUrl, String(body.code)); // verifies code↔key
    const token = await ctx.book.issueToken(86_400);
    await ctx.persist();
    const sent = await deliver(record.wg0, ctx.peerPort, "/api/friends/request", { token });
    return Response.json({ ok: true, sent, to: record.label });
  }
  // Inbound (from a peer, crypto-gated): a signed friend request → becomes pending.
  if (method === "POST" && path === "/api/friends/request") {
    const body = await readJson(req);
    const request = await ctx.book.receive(body.token as never); // verifies the signed token
    await ctx.persist();
    return Response.json({ ok: true, from: request.label });
  }
  // Inbound (from a peer, crypto-gated): the accept coming back to the initiator.
  if (method === "POST" && path === "/api/friends/accept-inbound") {
    const body = await readJson(req);
    const friend = await ctx.book.confirm(String(body.accept)); // verifies it matches our offer
    await ctx.persist();
    return Response.json({ ok: true, friend: friend.peer.label });
  }

  // This node's own identity (full keys), so the operator can view/share/verify it.
  if (method === "GET" && path === "/api/identity") {
    requireOperator(req, server, ctx);
    return Response.json({
      code: await fingerprint(ctx.selfEd), // short shareable friend code (ISL-…)
      ed25519: ctx.selfEd,
      x25519: await toB64(ctx.identity.x25519.publicKey),
      label: ctx.label,
      wg0: ctx.wg0,
    });
  }
  // Remove one of your own friendships (one-sided revoke). Operator action.
  const friendDel = path.match(/^\/api\/friends\/(.+)$/);
  if (method === "DELETE" && friendDel) {
    requireOperator(req, server, ctx);
    const removed = ctx.book.revoke(decodeURIComponent(friendDel[1]!));
    if (!removed) return new Response("no such friend", { status: 404 });
    await ctx.persist();
    return new Response(null, { status: 204 });
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
    const delivered = await deliver(friend.peer.wg0, ctx.peerPort, "/api/messages/inbound", { blob });
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
  if (err instanceof RateLimited) return 429;
  if (err instanceof FileNotFound) return 404;
  if (err instanceof Forbidden) return 403;
  if (err instanceof VerificationError) return 403; // untrusted message/canary signer
  if (err instanceof CanaryError) return 403; // invalid/replayed/stale canary
  if (err instanceof RegistryError) return 400; // bad announce signature
  if (err instanceof EventError) return 400; // bad event-report signature
  if (err instanceof FriendError) return 400;
  return 500;
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  // A leading non-flag word is a CLI command (e.g. `islandd friend invite`); it talks
  // to the running daemon instead of starting a server. Flags (`--mock`) start the daemon.
  if (argv[0] && !argv[0].startsWith("--")) {
    await runCli(argv);
    return;
  }
  const args = parseArgs(argv);
  const ctx = await boot(args);
  // ctx.wg0 is the advertised mesh address (may be "ip:port" in tests); bind to the IP.
  const host = (args.host || process.env.ISLAND_HOST || ctx.wg0).replace(/:\d+$/, "");

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

  // Auto-announce to the registry so this node is discoverable by its friend code.
  if (ctx.registryUrl) {
    announce(ctx.registryUrl, ctx.identity, ctx.wg0, ctx.label)
      .then((code) => console.log(`announced to registry — your friend code: ${code}`))
      .catch((e) => console.warn(`⚠ registry announce failed: ${(e as Error).message}`));
  }

  // Periodically push this node's local security events to the IDS collector (polaris).
  if (ctx.eventsUrl) {
    const push = async () => {
      const [jails, wg, daemon] = ctx.args.mock
        ? [mockFail2ban(), mockWg(ctx.wgIface), mockDaemon()]
        : await Promise.all([readFail2ban(), readWg(ctx.wgIface), readDaemon()]);
      await report(ctx.eventsUrl, ctx.identity, ctx.label, collectLocal(jails, wg, daemon));
    };
    push().catch(() => {});
    setInterval(() => push().catch(() => {}), 60_000);
  }
}

main();
