import { useState } from "react";
import { login } from "../api";

// Full-screen password gate for the master's aggregate (shown when a poll comes
// back 401 — the GUI_VIEW_PASSWORD gate). Ops-console aesthetic: monospace, dark,
// no chrome. On success the parent refetches and the overlay falls away.
export function LoginGate({ onAuthed }: { onAuthed: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await login(password);
      onAuthed();
    } catch {
      setErr("rejected — wrong view password");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gate" role="dialog" aria-label="view password">
      <form className="gate-box" onSubmit={onSubmit}>
        <h2>RESTRICTED — IDS MESH</h2>
        <p className="dim">master aggregate · view password required</p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          placeholder="view password"
          aria-label="view password"
        />
        {err && <div className="gate-err">{err}</div>}
        <button className="btn" type="submit" disabled={busy || !password}>
          {busy ? "CHECKING…" : "UNLOCK"}
        </button>
      </form>
    </div>
  );
}
