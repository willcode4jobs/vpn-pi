import { useFiles, useIds, useNode } from "./api";
import { Files } from "./components/Files";
import { IdsFeed } from "./components/IdsFeed";
import { StatusBar } from "./components/StatusBar";

// One screen, two panels: the island file share (the headline service) and the
// host-security IDS feed. Both poll the loopback backend. No daemon, no
// mesh-health — this is the surface for files + host IDS only.
export default function App() {
  const node = useNode();
  const files = useFiles();
  const ids = useIds();

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
        <Files poll={files} />
        <IdsFeed poll={ids} />
      </main>

      <footer className="footer">
        <span className="dim">su495 island · v0.2 skeleton · mock data source</span>
        <span className="dim">admin — pending</span>
      </footer>
    </div>
  );
}
