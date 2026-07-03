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

test("collectLocal turns fail2ban + degraded links into events", () => {
  const ev = collectLocal(
    [{ jail: "sshd", currently_banned: 1, total_banned: 3, banned_ips: ["1.2.3.4"] }],
    { iface: "wg0", peers: [
      { wg0: "10.42.0.5", publicKey: "K", handshakeAgeS: 30, up: true },   // healthy → no event
      { wg0: "10.42.0.6", publicKey: "K2", handshakeAgeS: 600, up: false }, // stale → event
      { wg0: "10.42.0.7", publicKey: "K3", handshakeAgeS: null, up: false },// never → event
    ] },
  );
  expect(ev).toContainEqual({ kind: "fail2ban", subject: "1.2.3.4", detail: "blocked by sshd" });
  expect(ev.filter((e) => e.kind === "degraded-link")).toHaveLength(2);
  expect(ev.find((e) => e.subject === "10.42.0.7")!.detail).toMatch(/no handshake/);
});

test("collectLocal includes wg-selfheal daemon events", () => {
  const ev = collectLocal([], { iface: "wg0", peers: [] }, [
    { peer: "sirius…", state: "degraded", endpoint: "203.0.113.9:51820" },
  ]);
  expect(ev).toContainEqual({ kind: "self-heal", subject: "sirius…", detail: "degraded (203.0.113.9:51820)" });
});

test("collectLocal resolves wg0 IPs to friend names (self-heal + degraded-link)", () => {
  const nameFor = (wg0: string) => (wg0 === "10.42.0.5" ? "sirius" : undefined);
  const ev = collectLocal(
    [],
    { iface: "wg0", peers: [{ wg0: "10.42.0.5", publicKey: "K", handshakeAgeS: 600, up: false }] },
    [{ peer: "10.42.0.5", state: "degraded", endpoint: "203.0.113.9:51820" }],
    nameFor,
  );
  // named: subject is the label, IP retained in detail
  expect(ev).toContainEqual({ kind: "self-heal", subject: "sirius", detail: "degraded (203.0.113.9:51820) — 10.42.0.5" });
  expect(ev.find((e) => e.kind === "degraded-link")!).toMatchObject({ subject: "sirius" });
  // unknown IP falls through to the IP unchanged
  const ev2 = collectLocal([], { iface: "wg0", peers: [] }, [{ peer: "10.42.0.9", state: "stale", endpoint: "" }], nameFor);
  expect(ev2).toContainEqual({ kind: "self-heal", subject: "10.42.0.9", detail: "stale" });
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
