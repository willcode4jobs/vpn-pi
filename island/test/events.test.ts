import { expect, test } from "bun:test";
import {
  collectLocal,
  EventError,
  EventStore,
  ingest,
  signReport,
  verifyReport,
} from "../src/core/events.ts";
import { generateIdentity } from "../src/core/identity.ts";

test("collectLocal emits fail2ban + a full per-peer roster (all statuses, ok included)", () => {
  const ev = collectLocal(
    [{ jail: "sshd", currently_banned: 1, total_banned: 3, banned_ips: ["1.2.3.4"] }],
    { iface: "wg0", peers: [
      { wg0: "10.42.0.5", publicKey: "K", handshakeAgeS: 30, up: true },    // < 150s → ok
      { wg0: "10.42.0.6", publicKey: "K2", handshakeAgeS: 160, up: true },  // 150–180s → stale
      { wg0: "10.42.0.7", publicKey: "K3", handshakeAgeS: 600, up: false }, // ≥ 180s → degraded
      { wg0: "10.42.0.8", publicKey: "K4", handshakeAgeS: null, up: false },// never → degraded
    ] },
  );
  expect(ev).toContainEqual({ kind: "fail2ban", subject: "1.2.3.4", detail: "blocked by sshd" });
  const links = ev.filter((e) => e.kind === "link");
  expect(links).toHaveLength(4); // EVERY peer present — a healthy peer is no longer dropped
  expect(links.find((e) => e.subject === "10.42.0.5")!.state).toBe("ok");
  expect(links.find((e) => e.subject === "10.42.0.6")!.state).toBe("stale");
  expect(links.find((e) => e.subject === "10.42.0.7")!.state).toBe("degraded");
  const never = links.find((e) => e.subject === "10.42.0.8")!;
  expect(never.state).toBe("degraded");
  expect(never.detail).toMatch(/no handshake/);
});

test("collectLocal overlays the daemon's 'restored' onto a live-healthy link", () => {
  const ev = collectLocal(
    [],
    { iface: "wg0", peers: [{ wg0: "10.42.0.5", publicKey: "K", handshakeAgeS: 10, up: true }] },
    [{ peer: "10.42.0.5", state: "restored", endpoint: "203.0.113.9:51820" }],
  );
  const link = ev.find((e) => e.kind === "link" && e.subject === "10.42.0.5")!;
  expect(link.state).toBe("restored"); // debounced recovery — age alone can't express this
  expect(link.detail).toContain("203.0.113.9:51820");
});

test("collectLocal: a stale daemon 'degraded' never overrides a live-healthy read", () => {
  // This is the frozen-"degraded" bug: a peer that handshaked 10s ago is healthy NOW,
  // even if the daemon's last (stale) transition said degraded. Live wins.
  const ev = collectLocal(
    [],
    { iface: "wg0", peers: [{ wg0: "10.42.0.5", publicKey: "K", handshakeAgeS: 10, up: true }] },
    [{ peer: "10.42.0.5", state: "degraded", endpoint: "" }],
  );
  expect(ev.find((e) => e.kind === "link")!.state).toBe("ok");
});

test("collectLocal resolves wg0 IPs to friend names (IP retained in detail)", () => {
  const nameFor = (wg0: string) => (wg0 === "10.42.0.5" ? "sirius" : undefined);
  const ev = collectLocal(
    [],
    { iface: "wg0", peers: [{ wg0: "10.42.0.5", publicKey: "K", handshakeAgeS: 600, up: false }] },
    [{ peer: "10.42.0.5", state: "degraded", endpoint: "203.0.113.9:51820" }],
    nameFor,
  );
  const link = ev.find((e) => e.kind === "link")!;
  expect(link.subject).toBe("sirius"); // named: subject is the label
  expect(link.state).toBe("degraded");
  expect(link.detail).toContain("10.42.0.5"); // IP retained in detail
  expect(link.detail).toContain("203.0.113.9:51820");
});

test("a report verifies; tampering or a foreign signer does not", async () => {
  const id = await generateIdentity();
  const r = await signReport(id, "sirius", [{ kind: "fail2ban", subject: "1.2.3.4", detail: "blocked by sshd" }]);
  expect(await verifyReport(r)).toBe(true);
  expect(await verifyReport({ ...r, label: "evil" })).toBe(false);
  expect(await verifyReport({ ...r, events: [{ kind: "fail2ban", subject: "9.9.9.9", detail: "x" }] })).toBe(false);

  const other = await signReport(await generateIdentity(), "sirius", r.events);
  expect(await verifyReport({ ...r, sig: other.sig })).toBe(false);
});

test("ingest stores the latest snapshot per node; bad sig rejected", async () => {
  const store = new EventStore(":memory:");
  const id = await generateIdentity();

  await ingest(store, await signReport(id, "sirius", [{ kind: "fail2ban", subject: "1.1.1.1", detail: "a" }]));
  await ingest(store, await signReport(id, "sirius", [{ kind: "fail2ban", subject: "2.2.2.2", detail: "b" }]));
  const list = store.list();
  expect(list).toHaveLength(1); // replaced, not appended
  expect(list[0]!.events[0]!.subject).toBe("2.2.2.2");

  const bad = await signReport(id, "sirius", []);
  expect(ingest(store, { ...bad, sig: "AAAA" })).rejects.toThrow(EventError);
});

test("two nodes appear as two snapshots", async () => {
  const store = new EventStore(":memory:");
  await ingest(store, await signReport(await generateIdentity(), "sirius", []));
  await ingest(store, await signReport(await generateIdentity(), "altair", []));
  expect(store.list().map((n) => n.label).sort()).toEqual(["altair", "sirius"]);
});
