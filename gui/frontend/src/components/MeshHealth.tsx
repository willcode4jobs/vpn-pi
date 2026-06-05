import type { Poll } from "../api";
import { age } from "../format";
import type { MeshSnapshot, PeerState } from "../types";

// Fixed column order = the severity ladder. State is shown by a left rail color
// + the word, never an icon. Position carries meaning: degraded peers are loud.
const STATE_LABEL: Record<PeerState, string> = {
  ok: "OK",
  stale: "STALE",
  degraded: "DEGRADED",
};

function shortKey(pub: string): string {
  return pub.slice(0, 8) + "…";
}

export function MeshHealth({ poll }: { poll: Poll<MeshSnapshot> }) {
  const snap = poll.data;
  const now = new Date();

  const counts = { ok: 0, stale: 0, degraded: 0 };
  snap?.peers.forEach((p) => (counts[p.state] += 1));

  return (
    <section className="panel" aria-label="mesh health">
      <div className="panel-head">
        <h2>MESH HEALTH</h2>
        <div className="tally">
          <span className="s-ok">{counts.ok} ok</span>
          <span className="s-stale">{counts.stale} stale</span>
          <span className="s-degraded">{counts.degraded} degraded</span>
        </div>
      </div>

      {snap === null ? (
        <div className="empty">awaiting first read…</div>
      ) : (
        <table className="readout">
          <thead>
            <tr>
              <th className="col-rail" />
              <th>PEER</th>
              <th>KEY</th>
              <th>STATE</th>
              <th className="num">HANDSHAKE</th>
              <th>ENDPOINT</th>
            </tr>
          </thead>
          <tbody>
            {snap.peers.map((p) => (
              <tr key={p.peer} className={`row state-${p.state}`}>
                <td className="col-rail" />
                <td className="peer-name">{p.name}</td>
                <td className="dim mono-key">{shortKey(p.peer)}</td>
                <td className={`state-label s-${p.state}`}>{STATE_LABEL[p.state]}</td>
                <td className="num">{age(p.last_handshake, now)}</td>
                <td className="dim">{p.endpoint ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
