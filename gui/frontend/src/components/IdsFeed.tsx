import type { Poll } from "../api";
import { clock } from "../format";
import type { IdsEvent, IdsSeverity } from "../types";

// Severity drives the left rail + label color; source is a fixed-width tag so
// the eye can filter by column. Same screen as mesh health, by design — a mesh
// anomaly and a USB insertion belong in one field of view.
const SEV_LABEL: Record<IdsSeverity, string> = {
  info: "INFO",
  warn: "WARN",
  crit: "CRIT",
};

export function IdsFeed({ poll }: { poll: Poll<IdsEvent[]> }) {
  const events = poll.data;

  return (
    <section className="panel" aria-label="ids feed">
      <div className="panel-head">
        <h2>IDS FEED</h2>
        <div className="tally">
          <span className="dim">host · mesh sensors</span>
        </div>
      </div>

      {events === null ? (
        <div className="empty">awaiting first read…</div>
      ) : events.length === 0 ? (
        <div className="empty">no events</div>
      ) : (
        <table className="readout">
          <thead>
            <tr>
              <th className="col-rail" />
              <th>TIME</th>
              <th>SEV</th>
              <th>SOURCE</th>
              <th>SUBJECT</th>
              <th>EVENT</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id} className={`row sev-${e.severity}`}>
                <td className="col-rail" />
                <td className="num dim">{clock(e.at)}</td>
                <td className={`state-label v-${e.severity}`}>{SEV_LABEL[e.severity]}</td>
                <td className="src-tag">{e.source}</td>
                <td className="peer-name">{e.subject}</td>
                <td>{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
