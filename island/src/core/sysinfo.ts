// Host readouts for the Home view: fail2ban jail state + WireGuard connectivity.
//
// Both degrade to empty on any failure and need NO privilege elevation:
//   - fail2ban state is reconstructed from the journal (Ban − Unban replay), same as
//     Phase One's sources/fail2ban.py — needs only systemd-journal access, no sudo.
//   - wg status comes from `wg show <iface> dump` (read-only).
// The command runners are injected so tests don't spawn anything, and --mock returns
// synthetic data so Home is demonstrable on a laptop with no mesh.

/** Live state of one fail2ban jail (same shape as Phase One JailStatus). */
export interface JailStatus {
  jail: string;
  currently_banned: number;
  total_banned: number; // Ban events seen in the journal window
  banned_ips: string[];
}

/** One WireGuard peer's connectivity. */
export interface WgPeer {
  wg0: string; // the peer's tunnel address (from allowed-ips)
  publicKey: string;
  handshakeAgeS: number | null; // seconds since last handshake; null = never
  up: boolean;
}

export interface WgStatus {
  iface: string;
  peers: WgPeer[];
}

type Runner = (argv: string[]) => Promise<string | null>;

/** Run a command, returning stdout on exit 0, else null. Never throws. */
export async function runCmd(argv: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out : null;
  } catch {
    return null;
  }
}

// fail2ban's actions logger emits "[jail] Ban <ip>" / "[jail] Restore Ban <ip>" /
// "[jail] Unban <ip>" lines. Via journald the MESSAGE is either that bare line
// (logtarget=SYSTEMD-JOURNAL) or prefixed "<timestamp> fail2ban.actions [pid]: NOTICE "
// (stdout/syslog capture). Anchor the parse to exactly those two shapes (^ … $) — a
// "[jail] Ban <ip>" embedded MID-message (e.g. inside an attacker-controlled string
// fail2ban happens to log) must not forge a ban entry in the feed.
const F2B_ACTION_RE =
  /^(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\s+fail2ban\.actions\s*\[\d+\]:\s+NOTICE\s+)?\[([\w-]+)\]\s+(?:(Restore)\s+)?(Ban|Unban)\s+((?:\d{1,3}\.){3}\d{1,3})\s*$/;

const FAIL2BAN_ARGV = ["journalctl", "-u", "fail2ban", "-o", "json", "--since", "-24h", "-n", "500"];

/** Reconstruct current jail state from the fail2ban journal (last action per ip wins). */
export async function readFail2ban(run: Runner = runCmd): Promise<JailStatus[]> {
  const out = await run(FAIL2BAN_ARGV);
  if (!out) return [];

  const banned = new Map<string, Map<string, boolean>>(); // jail -> ip -> isBanned
  const totals = new Map<string, number>();

  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    let msg: string;
    try {
      msg = String(JSON.parse(line).MESSAGE ?? "");
    } catch {
      continue;
    }
    const m = F2B_ACTION_RE.exec(msg);
    if (!m) continue;
    const [, jail, restore, action, ip] = m as unknown as [string, string, string | undefined, string, string];
    const ips = banned.get(jail) ?? banned.set(jail, new Map()).get(jail)!;
    if (action === "Ban") {
      ips.set(ip, true);
      // "Restore Ban" is a replay of an old ban on fail2ban restart — don't inflate totals.
      if (!restore) totals.set(jail, (totals.get(jail) ?? 0) + 1);
    } else {
      ips.set(ip, false);
    }
  }

  return [...banned].map(([jail, ips]) => ({
    jail,
    currently_banned: [...ips.values()].filter(Boolean).length,
    total_banned: totals.get(jail) ?? 0,
    banned_ips: [...ips]
      .filter(([, isBanned]) => isBanned)
      .map(([ip]) => ip)
      .sort(),
  }));
}

const UP_WINDOW_S = 180; // a handshake within 3 min counts as "up"

/** Parse `wg show <iface> dump`: first line is the interface, the rest are peers. */
export async function readWg(
  iface: string,
  run: Runner = runCmd,
  now: Date = new Date(),
): Promise<WgStatus> {
  const out = await run(["wg", "show", iface, "dump"]);
  if (!out) return { iface, peers: [] };

  const lines = out.split("\n").filter((l) => l.trim());
  const nowS = Math.floor(now.getTime() / 1000);
  const peers: WgPeer[] = [];

  for (let i = 1; i < lines.length; i++) {
    // peer dump fields: pubkey, psk, endpoint, allowed-ips, latest-handshake, rx, tx, keepalive
    const f = lines[i]!.split("\t");
    const handshake = Number(f[4] ?? "0");
    if (!Number.isFinite(handshake)) continue; // malformed dump line — don't fabricate a "never handshaked" peer
    const handshakeAgeS = handshake > 0 ? Math.max(0, nowS - handshake) : null;
    peers.push({
      wg0: (f[3] ?? "").split(",")[0]!.split("/")[0] ?? "",
      publicKey: f[0] ?? "",
      handshakeAgeS,
      up: handshakeAgeS !== null && handshakeAgeS <= UP_WINDOW_S,
    });
  }
  return { iface, peers };
}

// --- synthetic data for --mock (laptop demo, no mesh) -----------------------

export function mockFail2ban(): JailStatus[] {
  return [{ jail: "sshd", currently_banned: 2, total_banned: 7, banned_ips: ["185.220.101.4", "45.134.26.9"] }];
}

export function mockWg(iface = "wg0"): WgStatus {
  return {
    iface,
    peers: [
      { wg0: "10.42.0.2", publicKey: "vega-mock-pub", handshakeAgeS: 12, up: true },
      { wg0: "10.42.0.5", publicKey: "sirius-mock-pub", handshakeAgeS: 240, up: false },
    ],
  };
}

// --- wg-selfheal daemon: current per-peer health from its journald events ----
//
// The Go daemon logs JSON state-transition events (ok/stale/degraded) to journald.
// We replay them (last transition per peer wins → current state) and surface the
// peers that are not healthy, exactly like the fail2ban Ban/Unban replay. No socket,
// no privilege beyond systemd-journal. Degrades to [] if the daemon isn't running.

export interface DaemonPeer {
  peer: string; // the daemon's (short) peer key
  state: "stale" | "degraded" | string;
  endpoint: string;
}

// The daemon is a systemd TEMPLATE unit — wg-selfheal@spoke / wg-selfheal@relay — so
// match the instance glob, not the bare name (plain "wg-selfheal" matches nothing and
// the feed stays silently empty). The glob also catches a non-templated unit if one is
// ever used. Overridable per node via ISLAND_SELFHEAL_UNIT. This is read-only journald
// access; if the daemon isn't installed yet, journalctl returns nothing and readDaemon
// degrades to [], so the daemon can be dropped in any time after deployment.
const SELFHEAL_UNIT = process.env.ISLAND_SELFHEAL_UNIT || "wg-selfheal@*";
const DAEMON_ARGV = ["journalctl", "-u", SELFHEAL_UNIT, "-o", "json", "--since", "-24h", "-n", "300"];

export async function readDaemon(run: Runner = runCmd): Promise<DaemonPeer[]> {
  const out = await run(DAEMON_ARGV);
  if (!out) return [];

  const latest = new Map<string, { state: string; endpoint: string }>();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    let evt: { msg?: string; peer?: string; to?: string; endpoint?: string };
    try {
      evt = JSON.parse(String(JSON.parse(line).MESSAGE ?? "")); // journald MESSAGE is the daemon's JSON line
    } catch {
      continue;
    }
    if (evt.msg !== "state change" || !evt.peer) continue;
    latest.set(evt.peer, { state: String(evt.to ?? ""), endpoint: String(evt.endpoint ?? "") });
  }

  return [...latest]
    .filter(([, v]) => v.state && v.state !== "ok") // recovered/ok → healthy, drop
    .map(([peer, v]) => ({ peer, state: v.state, endpoint: v.endpoint }));
}

export function mockDaemon(): DaemonPeer[] {
  return [{ peer: "sirius-m…", state: "degraded", endpoint: "203.0.113.9:51820" }];
}
