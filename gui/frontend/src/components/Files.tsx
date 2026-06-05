import { useRef, useState } from "react";
import type { Poll } from "../api";
import { deleteFile, downloadUrl, uploadFile } from "../api";
import { age, bytes } from "../format";
import type { FilesSnapshot } from "../types";

// The island file share, backed by the polaris SQLite store. Users upload via
// the header control; each row downloads or deletes. wg0-bound (never public);
// the panel head shows where files live + the bind so that stays visible.
export function Files({
  poll,
  refetch,
}: {
  poll: Poll<FilesSnapshot>;
  refetch: () => void;
}) {
  const snap = poll.data;
  const files = snap?.files ?? null;

  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      await uploadFile(file);
      refetch(); // show it now, don't wait for the 2s poll
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = ""; // allow re-picking same file
    }
  }

  async function onDelete(id: number) {
    setErr(null);
    try {
      await deleteFile(id);
      refetch();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    }
  }

  return (
    <section className="panel" aria-label="file share">
      <div className="panel-head">
        <h2>FILES</h2>
        <div className="tally">
          <span className="dim">{snap ? snap.root : "—"}</span>
          <span className="src-tag">{snap ? snap.bind : "wg0"}</span>
          <label className="btn">
            {busy ? "UPLOADING…" : "+ UPLOAD"}
            <input
              ref={inputRef}
              type="file"
              onChange={onPick}
              disabled={busy}
              hidden
            />
          </label>
        </div>
      </div>

      {err && <div className="up-err">upload error — {err}</div>}

      {files === null ? (
        <div className="empty">awaiting first read…</div>
      ) : files.length === 0 ? (
        <div className="empty">share empty — upload a file</div>
      ) : (
        <table className="readout">
          <thead>
            <tr>
              <th className="col-rail" />
              <th>NAME</th>
              <th className="num">SIZE</th>
              <th>NODE</th>
              <th className="num">MODIFIED</th>
              <th className="col-act">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.id} className="row">
                <td className="col-rail" />
                <td className="peer-name">{f.name}</td>
                <td className="num dim">{bytes(f.size)}</td>
                <td className="src-tag">{f.node}</td>
                <td className="num dim">{age(f.modified)} ago</td>
                <td className="col-act">
                  <a className="act" href={downloadUrl(f.id)}>
                    get
                  </a>
                  <button className="act act-del" onClick={() => onDelete(f.id)}>
                    del
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
