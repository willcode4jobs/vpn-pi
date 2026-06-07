import type { Poll } from "../api";
import type { JailStatus } from "../types";

// Live fail2ban state — who's locked out right now (current bans), distinct from
// the IDS feed's historical ban/attempt events. Compact, sits above the IDS feed.
// Red when anything is banned, green when clear. Same ops-console palette.
export function JailsPanel({ poll }: { poll: Poll<JailStatus[]> }) {
  const jails = poll.data;
  const banned = jails?.reduce((n, j) => n + j.currently_banned, 0) ?? 0;

  return (
    <section className="panel" aria-label="fail2ban jails">
      <div className="panel-head">
        <h2>JAILS</h2>
        <div className="tally">
          {/* fail2ban state is per-node (not mesh-aggregated like the IDS feed) —
              label the scope so it doesn't read as contradicting the feed. */}
          <span className="dim">this node</span>
          {jails &&
            (banned > 0 ? (
              <span className="chip chip-crit">{banned} BANNED</span>
            ) : (
              <span className="chip chip-ok">NONE BANNED</span>
            ))}
        </div>
      </div>

      {jails === null ? (
        <div className="empty">awaiting first read…</div>
      ) : jails.length === 0 ? (
        <div className="empty">no jails reporting</div>
      ) : (
        <table className="readout">
          <tbody>
            {jails.map((j) => (
              <tr key={j.jail} className={`row sev-${j.currently_banned ? "crit" : "info"}`}>
                <td className="col-rail" />
                <td className="src-tag">{j.jail}</td>
                <td className="num dim">
                  {j.currently_banned} banned · {j.total_banned} total
                </td>
                <td className="peer-name">{j.banned_ips.join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
