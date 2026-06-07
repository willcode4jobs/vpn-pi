import { Fragment, useState } from "react";
import type { Poll } from "../api";
import { clock } from "../format";
import type { IdsEvent, IdsSeverity } from "../types";

// Severity drives color: info=green, warn=orange, crit=red — on white text over
// warm black. The feed shows the 5 newest by default; SHOW ALL reveals the rest
// in a scroll box. Rows truncate the event line; click a row to read the whole
// event (it wraps, and scrolls if very long). Shares the screen with Files.
const SEV_LABEL: Record<IdsSeverity, string> = {
  info: "INFO",
  warn: "WARN",
  crit: "CRIT",
};

const COLLAPSED = 5;

export function IdsFeed({ poll }: { poll: Poll<IdsEvent[]> }) {
  const events = poll.data;
  const [showAll, setShowAll] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const crit = events?.filter((e) => e.severity === "crit").length ?? 0;
  const warn = events?.filter((e) => e.severity === "warn").length ?? 0;
  const shown = events ? (showAll ? events : events.slice(0, COLLAPSED)) : [];

  return (
    <section className="panel" aria-label="ids feed">
      <div className="panel-head">
        <h2>IDS FEED</h2>
        <div className="tally">
          {events && events.length > 0 && (
            <>
              <span className="dim">{events.length} EVENTS</span>
              {crit > 0 && <span className="chip chip-crit">{crit} CRIT</span>}
              {warn > 0 && <span className="chip chip-warn">{warn} WARN</span>}
              {crit === 0 && warn === 0 && <span className="chip chip-ok">ALL CLEAR</span>}
            </>
          )}
        </div>
      </div>

      {events === null ? (
        <div className="empty">awaiting first read…</div>
      ) : events.length === 0 ? (
        <div className="empty">no events</div>
      ) : (
        <>
          <div className={showAll ? "feed feed-scroll" : "feed"}>
            <table className="readout ids">
              <thead>
                <tr>
                  <th className="col-rail" />
                  <th>TIME</th>
                  <th>SEV</th>
                  <th>NODE</th>
                  <th>SOURCE</th>
                  <th>SUBJECT</th>
                  <th>EVENT</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => {
                  const open = openId === e.id;
                  return (
                    <Fragment key={e.id}>
                      <tr
                        className={`row sev-${e.severity}${open ? " open" : ""}`}
                        onClick={() => setOpenId(open ? null : e.id)}
                        aria-expanded={open}
                      >
                        <td className="col-rail" />
                        <td className="num dim">{clock(e.at)}</td>
                        <td className={`state-label v-${e.severity}`}>
                          {SEV_LABEL[e.severity]}
                        </td>
                        <td className="peer-name">{e.node ?? "—"}</td>
                        <td className="src-tag">{e.source}</td>
                        <td className="peer-name">{e.subject}</td>
                        <td className="evt-cell">
                          <span className="evt-msg">{e.message}</span>
                          <span className="evt-caret">{open ? "▾" : "▸"}</span>
                        </td>
                      </tr>
                      {open && (
                        <tr className={`detail sev-${e.severity}`}>
                          <td className="col-rail" />
                          <td colSpan={6}>
                            <div className="detail-box">{e.message}</div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {events.length > COLLAPSED && (
            <button
              className="feed-more"
              onClick={() => setShowAll((v) => !v)}
              aria-expanded={showAll}
            >
              {showAll ? "▴ SHOW LESS" : `▾ SHOW ALL (${events.length})`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
