// IDS / security events — the admin-only, mesh-wide feed (Phase J).
//
// Each node gathers its LOCAL security state (fail2ban blocks, degraded wg links; later
// the wg-selfheal daemon's socket events) and pushes a SIGNED report to the collector
// (polaris). The collector verifies the signature against the reporter's key — so a node
// can only report as itself, never forge another's events — and keeps the latest snapshot
// per node. The admin reads the union at GET /admin/events. End users never see this; it's
// control-plane metadata, not data-path.

import { Database } from "bun:sqlite";
import { canonicalBytes, type Json } from "./canonical.ts";
import { fromB64, toB64 } from "./codec.ts";
import type { Identity } from "./identity.ts";
import { getSodium } from "./sodium.ts";
import { classifyLink, type DaemonPeer, type JailStatus, type LinkState, type WgStatus } from "./sysinfo.ts";

export class EventError extends Error {}

// Ingest hygiene: bound what an untrusted request body can put in the store/feed.
const MAX_REPORT_EVENTS = 200; // a legit snapshot is a handful of events
const MAX_FEED_NODES = 64; // list() cap — key spam can't grow the admin feed unbounded

// A roster entry's health. Extends the daemon's stateless ladder with "restored",
// the debounced recovery state the daemon owns (age alone cannot express it).
export type RosterState = LinkState | "restored";

export interface SecurityEvent {
  kind: "fail2ban" | "link" | string;
  subject: string; // the ip / peer the event is about
  detail: string;
  // Present on "link" roster entries: the peer's current health. Absent on fail2ban.
  // Every peer emits one "link" event every cycle, so the feed carries ALL statuses
  // (ok included) — not just problems.
  state?: RosterState | string;
}

export interface EventReport {
  node: string; // reporter Ed25519 public (base64) — the event is attributed to this key
  label: string;
  events: SecurityEvent[];
  at: string; // ISO 8601
  sig: string; // self-signature over {node,label,events,at}
}

function signable(r: Omit<EventReport, "sig">): { [k: string]: Json } {
  return { node: r.node, label: r.label, at: r.at, events: r.events as unknown as Json };
}

/** Turn local host readouts into normalized security events. */
export function collectLocal(
  jails: JailStatus[],
  wg: WgStatus,
  daemon: DaemonPeer[] = [],
  // Resolve a wg0 IP to a friend's label so the feed reads "sirius" not "10.42.0.5".
  // Runs on the REPORTING node (which owns the friendbook); defaults to no-op, so
  // an IP falls through unchanged. The daemon now emits wg0 IPs, so its self-heal
  // events resolve too; an older daemon emitting a pubkey simply won't match.
  nameFor: (wg0: string) => string | undefined = () => undefined,
): SecurityEvent[] {
  const out: SecurityEvent[] = [];
  for (const j of jails) {
    for (const ip of j.banned_ips) out.push({ kind: "fail2ban", subject: ip, detail: `blocked by ${j.jail}` });
  }

  // Full per-peer roster (ALL statuses, ok included). Two sources, live wg first:
  //   1. `wg show` peers — current handshake age. BUT `wg show` needs CAP_NET_ADMIN
  //      and islandd runs unprivileged, so on a deployed node this list is EMPTY.
  //   2. the wg-selfheal daemon's journal — the daemon holds CAP_NET_ADMIN and logs
  //      per-peer status (all states with --snapshot; transitions always), readable
  //      via systemd-journal membership. On a deployed node it IS the roster.
  const daemonByPeer = new Map(daemon.map((d) => [d.peer, d] as const));
  for (const p of wg.peers) {
    const ip = p.wg0 || p.publicKey.slice(0, 12);
    const name = nameFor(p.wg0); // prefer the human name; keep the IP in detail when we have one
    const d = p.wg0 ? daemonByPeer.get(p.wg0) : undefined;
    if (p.wg0) daemonByPeer.delete(p.wg0); // covered live — don't emit it twice below

    // Base state is the LIVE handshake age (always current, always present). The daemon
    // overlay only ADDS "restored" — its debounced recovery state — and only while the
    // link currently reads healthy. A stale daemon "degraded"/"stale" transition must
    // never override a live-healthy read; letting it was the frozen-"degraded" bug.
    let state: RosterState | string = classifyLink(p.handshakeAgeS);
    if (d?.state === "restored" && state === "ok") state = "restored";

    const age = p.handshakeAgeS == null ? "no handshake yet" : `${p.handshakeAgeS}s since handshake`;
    const endpoint = d?.endpoint ? d.endpoint : "";
    const detail = [name ? ip : null, age, endpoint || null].filter(Boolean).join(" — ");
    out.push({ kind: "link", subject: name ?? ip, detail, state });
  }
  // Daemon-journal-only peers — the usual case on a deployed node (see above). The
  // daemon re-emits on every change (ok/restored included), so its latest state IS
  // the current state; this is what makes the roster live without root.
  for (const [peer, d] of daemonByPeer) {
    if (!d.state) continue;
    const name = nameFor(peer);
    const age = d.handshakeAge ? (d.handshakeAge === "never" ? "no handshake yet" : `handshake ${d.handshakeAge} ago`) : null;
    const detail = [name ? peer : null, age, d.endpoint || null].filter(Boolean).join(" — ");
    out.push({ kind: "link", subject: name ?? peer, detail, state: d.state });
  }
  return out;
}

/** Node side: build a signed report of this node's events. */
export async function signReport(id: Identity, label: string, events: SecurityEvent[], now: Date = new Date()): Promise<EventReport> {
  const s = await getSodium();
  const body = { node: await toB64(id.ed25519.publicKey), label, events, at: now.toISOString() };
  const sig = await toB64(s.crypto_sign_detached(canonicalBytes(signable(body)), id.ed25519.secretKey));
  return { ...body, sig };
}

/** Parse an untrusted request body into an EventReport — shape + size checks only;
 *  signature and identity checks happen after. Throws EventError on bad input. */
export function parseReport(body: unknown): EventReport {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") throw new EventError("malformed report");
  const { node, label, events, at, sig } = b;
  if (
    typeof node !== "string" ||
    typeof label !== "string" ||
    typeof at !== "string" ||
    typeof sig !== "string" ||
    !Array.isArray(events)
  ) {
    throw new EventError("malformed report");
  }
  if (events.length > MAX_REPORT_EVENTS) throw new EventError("too many events in report");
  for (const e of events as Record<string, unknown>[]) {
    if (!e || typeof e !== "object" || typeof e.kind !== "string" || typeof e.subject !== "string" || typeof e.detail !== "string") {
      throw new EventError("malformed report event");
    }
    // state is optional (roster entries carry it, fail2ban doesn't); reject a non-string
    // so a malformed field can't reach the store or the feed renderer.
    if (e.state !== undefined && typeof e.state !== "string") throw new EventError("malformed report event");
  }
  return { node, label, events: events as SecurityEvent[], at, sig };
}

/** Collector side: verify a report's self-signature. */
export async function verifyReport(r: EventReport): Promise<boolean> {
  const s = await getSodium();
  try {
    return s.crypto_sign_verify_detached(await fromB64(r.sig), canonicalBytes(signable(r)), await fromB64(r.node));
  } catch {
    return false;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS node_events (
  node     TEXT PRIMARY KEY,
  label    TEXT NOT NULL,
  events   TEXT NOT NULL,   -- JSON SecurityEvent[]
  at       TEXT NOT NULL,   -- reporter's timestamp
  received TEXT NOT NULL    -- collector arrival time
);`;

export interface NodeEvents {
  node: string;
  label: string;
  events: SecurityEvent[];
  at: string; // reporter's clock at push time
  received: string; // collector arrival time — the feed uses this to detect a stalled reporter
}

export class EventStore {
  private db: Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.run(SCHEMA);
  }
  /** Keep the latest snapshot per node. */
  upsert(r: EventReport, now: Date = new Date()): void {
    this.db
      .query(
        "INSERT INTO node_events (node,label,events,at,received) VALUES (?,?,?,?,?) " +
          "ON CONFLICT(node) DO UPDATE SET label=excluded.label, events=excluded.events, at=excluded.at, received=excluded.received",
      )
      .run(r.node, r.label, JSON.stringify(r.events), r.at, now.toISOString());
  }
  list(): NodeEvents[] {
    const rows = this.db
      .query(`SELECT node,label,events,at,received FROM node_events ORDER BY at DESC LIMIT ${MAX_FEED_NODES}`)
      .all() as { node: string; label: string; events: string; at: string; received: string }[];
    return rows.map((r) => ({
      node: r.node,
      label: r.label,
      at: r.at,
      received: r.received,
      events: JSON.parse(r.events) as SecurityEvent[],
    }));
  }
}

/** Collector side: verify + store a report. NOTE: signature-only — a fresh keypair can
 *  self-sign a valid report, so the ROUTE layer must additionally bind r.node to a known
 *  island identity and never trust the self-reported label (see /events/report in main.ts). */
export async function ingest(store: EventStore, r: EventReport, now: Date = new Date()): Promise<void> {
  if (!(await verifyReport(r))) throw new EventError("bad report signature");
  store.upsert(r, now);
}

/** Node side: push a signed report to the collector (best-effort). */
export async function report(url: string, id: Identity, label: string, events: SecurityEvent[]): Promise<boolean> {
  try {
    const r = await fetch(`${url}/events/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(await signReport(id, label, events)),
    });
    return r.ok;
  } catch {
    return false;
  }
}
