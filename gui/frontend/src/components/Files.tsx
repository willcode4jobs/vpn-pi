import type { Poll } from "../api";
import { age, bytes } from "../format";
import type { FilesSnapshot } from "../types";

// The island file share — the headline service proving the island provides its
// own internet-like services. wg0-bound (never public); the panel head shows the
// bind so that stays visible. Dense readout: size right-aligned, newest first.
export function Files({ poll }: { poll: Poll<FilesSnapshot> }) {
  const snap = poll.data;
  const files = snap?.files ?? null;

  return (
    <section className="panel" aria-label="file share">
      <div className="panel-head">
        <h2>FILES</h2>
        <div className="tally">
          <span className="dim">{snap ? snap.root : "—"}</span>
          <span className="src-tag">{snap ? snap.bind : "wg0"}</span>
        </div>
      </div>

      {files === null ? (
        <div className="empty">awaiting first read…</div>
      ) : files.length === 0 ? (
        <div className="empty">share empty</div>
      ) : (
        <table className="readout">
          <thead>
            <tr>
              <th className="col-rail" />
              <th>NAME</th>
              <th className="num">SIZE</th>
              <th>NODE</th>
              <th className="num">MODIFIED</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={`${f.node}:${f.name}`} className="row">
                <td className="col-rail" />
                <td className="peer-name">{f.name}</td>
                <td className="num dim">{bytes(f.size)}</td>
                <td className="src-tag">{f.node}</td>
                <td className="num dim">{age(f.modified)} ago</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
