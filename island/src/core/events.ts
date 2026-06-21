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
import type { DaemonPeer, JailStatus, WgStatus } from "./sysinfo.ts";

export class EventError extends Error {}

export interface SecurityEvent {
  kind: "fail2ban" | "degraded-link" | string;
  subject: string; // the ip / peer the event is about
  detail: string;
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
export function collectLocal(jails: JailStatus[], wg: WgStatus, daemon: DaemonPeer[] = []): SecurityEvent[] {
  const out: SecurityEvent[] = [];
  for (const j of jails) {
    for (const ip of j.banned_ips) out.push({ kind: "fail2ban", subject: ip, detail: `blocked by ${j.jail}` });
  }
  for (const p of wg.peers) {
    if (!p.up) {
      out.push({
        kind: "degraded-link",
        subject: p.wg0 || p.publicKey.slice(0, 12),
        detail: p.handshakeAgeS == null ? "no handshake yet" : `stale handshake (${p.handshakeAgeS}s)`,
      });
    }
  }
  // wg-selfheal daemon classifications (richer than raw link state: "degraded" means
  // the self-heal circuit breaker latched — remediation exhausted).
  for (const d of daemon) {
    out.push({
      kind: "self-heal",
      subject: d.peer,
      detail: `${d.state}${d.endpoint ? ` (${d.endpoint})` : ""}`,
    });
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
  at: string;
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
      .query("SELECT node,label,events,at FROM node_events ORDER BY at DESC")
      .all() as { node: string; label: string; events: string; at: string }[];
    return rows.map((r) => ({ node: r.node, label: r.label, at: r.at, events: JSON.parse(r.events) as SecurityEvent[] }));
  }
}

/** Collector side: verify + store a report. */
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
