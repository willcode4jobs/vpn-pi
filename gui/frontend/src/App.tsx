import { useIds, useMesh } from "./api";
import { IdsFeed } from "./components/IdsFeed";
import { MeshHealth } from "./components/MeshHealth";
import { StatusBar } from "./components/StatusBar";

// One screen. Mesh health on top (the heart), IDS feed beneath it, both polling
// the loopback backend. Files + admin (RLPF port-request) panels come after the
// skeleton — this is the surface for the daemon + IDS stack, not three builds.
export default function App() {
  const mesh = useMesh();
  const ids = useIds();

  const signalLost = mesh.stale && mesh.data !== null;

  return (
    <div className="app">
      <StatusBar poll={mesh} />

      {signalLost && (
        <div className="alarm" role="alert">
          SIGNAL LOST — showing last known state ({mesh.error}). A silent node is
          itself the alarm.
        </div>
      )}

      <main className="grid">
        <MeshHealth poll={mesh} />
        <IdsFeed poll={ids} />
      </main>

      <footer className="footer">
        <span className="dim">su495 mesh · v0.1 skeleton · mock data source</span>
        <span className="dim">files · admin — pending</span>
      </footer>
    </div>
  );
}
