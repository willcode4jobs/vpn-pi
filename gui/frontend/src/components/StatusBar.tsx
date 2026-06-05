import { clock } from "../format";
import type { MeshSnapshot } from "../types";
import type { Poll } from "../api";

// The masthead: who this pane reports for, and whether the data is live. The
// link state (LIVE / SIGNAL LOST) is the first thing to go red when the backend
// or daemon goes silent — the node going quiet is the alarm.
export function StatusBar({ poll }: { poll: Poll<MeshSnapshot> }) {
  const node = poll.data?.node;
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
