import { clock } from "../format";
import type { NodeIdentity } from "../types";
import type { Poll } from "../api";

// The masthead: who this pane reports for, and whether the backend is live. The
// link state (LIVE / SIGNAL LOST) is the first thing to go red when the node's
// backend goes silent — the node going quiet is the alarm.
export function StatusBar({ poll }: { poll: Poll<NodeIdentity> }) {
  const node = poll.data;
  const live = !poll.stale && poll.data !== null;

  return (
    <header className="statusbar">
      <div className="brand">
        <span className="glyph">◇</span>
        <span className="node-name">{node?.name ?? "—"}</span>
        <span className="dim">/{node?.wg_interface ?? "wg0"}</span>
        <span className="role-tag">{node?.role ?? "?"}</span>
      </div>

      <div className="link">
        <span className={`link-dot ${live ? "up" : "down"}`} />
        <span className={live ? "s-ok" : "s-degraded"}>
          {live ? "LIVE" : "SIGNAL LOST"}
        </span>
        <span className="dim">
          {poll.lastOk ? `last read ${clock(poll.lastOk.toISOString())}` : "no read yet"}
        </span>
      </div>
    </header>
  );
}
