import { expect, test } from "bun:test";
import { readDaemon, readFail2ban, readWg } from "../src/core/sysinfo.ts";

// daemon journal: each line is journalctl -o json whose MESSAGE is the daemon's JSON.
const daemonJournal = (entries: Record<string, unknown>[]) => async () =>
  entries.map((e) => JSON.stringify({ MESSAGE: JSON.stringify(e) })).join("\n");

const journal = (msgs: string[]) => async () => msgs.map((m) => JSON.stringify({ MESSAGE: m })).join("\n");

test("readFail2ban replays Ban − Unban (last action per ip wins)", async () => {
  const jails = await readFail2ban(
    journal([
      "[sshd] Ban 1.2.3.4",
      "[sshd] Ban 5.6.7.8",
      "[sshd] Unban 1.2.3.4",
      "[nginx] Ban 9.9.9.9",
    ]),
  );
  const sshd = jails.find((j) => j.jail === "sshd")!;
  expect(sshd.currently_banned).toBe(1);
  expect(sshd.total_banned).toBe(2); // two Ban events seen
  expect(sshd.banned_ips).toEqual(["5.6.7.8"]);
  expect(jails.find((j) => j.jail === "nginx")!.banned_ips).toEqual(["9.9.9.9"]);
});

test("readFail2ban does not treat 'Unban' as a Ban", async () => {
  const jails = await readFail2ban(journal(["[sshd] Ban 1.1.1.1", "[sshd] Unban 1.1.1.1"]));
  expect(jails[0]!.currently_banned).toBe(0);
});

test("readFail2ban degrades to [] when the journal is unavailable", async () => {
  expect(await readFail2ban(async () => null)).toEqual([]);
});

test("readWg parses peers, derives handshake age + up flag", async () => {
  const now = new Date("2026-06-17T00:10:00Z");
  const nowS = Math.floor(now.getTime() / 1000);
  const dump = [
    `PRIVKEY\tIFACEPUB\t51820\toff`, // interface line (skipped)
    `PEER_A\t(none)\t1.2.3.4:51820\t10.42.0.2/32\t${nowS - 30}\t100\t200\toff`, // 30s ago -> up
    `PEER_B\t(none)\t5.6.7.8:51820\t10.42.0.5/32\t${nowS - 600}\t0\t0\toff`, // 10m ago -> down
    `PEER_C\t(none)\t(none)\t10.42.0.6/32\t0\t0\t0\toff`, // never -> null/down
  ].join("\n");

  const wg = await readWg("wg0", async () => dump, now);
  expect(wg.iface).toBe("wg0");
  expect(wg.peers).toHaveLength(3);
  expect(wg.peers[0]).toMatchObject({ wg0: "10.42.0.2", up: true, handshakeAgeS: 30 });
  expect(wg.peers[1]).toMatchObject({ wg0: "10.42.0.5", up: false });
  expect(wg.peers[2]).toMatchObject({ wg0: "10.42.0.6", up: false, handshakeAgeS: null });
});

test("readWg degrades to no peers when wg is unavailable", async () => {
  expect(await readWg("wg0", async () => null)).toEqual({ iface: "wg0", peers: [] });
});

test("readDaemon replays state transitions → full roster (ok KEPT), last wins", async () => {
  const peers = await readDaemon(
    daemonJournal([
      { msg: "starting" }, // ignored — not a state change
      { msg: "state change", peer: "alice…", to: "stale", endpoint: "1.1.1.1:51820" },
      { msg: "state change", peer: "alice…", to: "degraded", endpoint: "1.1.1.1:51820", handshake_age: "4m10s" }, // last wins
      { msg: "state change", peer: "bob…", to: "degraded", endpoint: "2.2.2.2:51820" },
      { msg: "state change", peer: "bob…", to: "ok", endpoint: "2.2.2.2:51820" }, // recovered → KEPT as ok (roster, not alerts)
    ]),
  );
  expect(peers.find((p) => p.peer === "alice…")).toMatchObject({ state: "degraded", endpoint: "1.1.1.1:51820", handshakeAge: "4m10s" });
  expect(peers.find((p) => p.peer === "bob…")).toMatchObject({ state: "ok" });
});

test("readDaemon parses --snapshot 'peer' lines, so stably-ok peers are enumerable", async () => {
  const peers = await readDaemon(
    daemonJournal([
      // a peer that never transitioned still appears via the per-tick snapshot
      { msg: "peer", peer: "10.42.0.2", status: "ok", endpoint: "1.2.3.4:51820", handshake_age: "45s" },
      { msg: "peer", peer: "10.42.0.5", status: "degraded", endpoint: "", handshake_age: "never" },
      // a later transition overrides an earlier snapshot for the same peer
      { msg: "state change", peer: "10.42.0.5", to: "restored", endpoint: "5.6.7.8:51820" },
    ]),
  );
  expect(peers.find((p) => p.peer === "10.42.0.2")).toMatchObject({ state: "ok", handshakeAge: "45s" });
  expect(peers.find((p) => p.peer === "10.42.0.5")).toMatchObject({ state: "restored", endpoint: "5.6.7.8:51820" });
});

test("readDaemon queries the systemd TEMPLATE unit, not the bare name", async () => {
  // Regression: `journalctl -u wg-selfheal` matches nothing because the unit is
  // installed as wg-selfheal@spoke / wg-selfheal@relay, leaving the feed silently
  // empty. Must target the instance glob so the daemon can be dropped in post-deploy.
  let seen: string[] = [];
  await readDaemon(async (argv) => {
    seen = argv;
    return null;
  });
  const i = seen.indexOf("-u");
  expect(i).toBeGreaterThan(-1);
  expect(seen[i + 1]).toBe("wg-selfheal@*");
  expect(seen).not.toContain("wg-selfheal"); // the bare (non-matching) name is gone
});

test("readDaemon degrades to [] when the daemon isn't running", async () => {
  expect(await readDaemon(async () => null)).toEqual([]);
});
