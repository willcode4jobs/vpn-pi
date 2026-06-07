import { useFiles, useIds, useNode } from "./api";
import { Files } from "./components/Files";
import { IdsFeed } from "./components/IdsFeed";
import { LoginGate } from "./components/LoginGate";
import { StatusBar } from "./components/StatusBar";

// One screen, two panels: the island file share (the headline service) and the
// host-security IDS feed. Both poll the loopback backend. No daemon, no
// mesh-health — this is the surface for files + host IDS only.
export default function App() {
  const node = useNode();
  const files = useFiles();
  const ids = useIds();

  // On the master the polled reads are view-password gated; a 401 surfaces here.
  if (node.authRequired || ids.authRequired) {
    return (
      <LoginGate
        onAuthed={() => {
          node.refetch();
          ids.refetch();
          files.refetch();
        }}
      />
    );
  }

  const signalLost = node.stale && node.data !== null;

  return (
    <div className="app">
      <StatusBar poll={node} />

      {signalLost && (
        <div className="alarm" role="alert">
          SIGNAL LOST — showing last known state ({node.error}). A silent node is
          itself the alarm.
        </div>
      )}

      <main className="grid">
        <Files poll={files} refetch={files.refetch} />
        <IdsFeed poll={ids} />
      </main>

      <footer className="footer">
        <span className="dim">su495 island · v0.2 skeleton · mock data source</span>
        <span className="dim">admin — pending</span>
      </footer>
    </div>
  );
}
