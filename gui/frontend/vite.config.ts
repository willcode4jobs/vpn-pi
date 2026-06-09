import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: Vite serves the UI and proxies /api to the loopback FastAPI backend, so
// the browser only ever talks to one origin.
// Build: emits to ../backend/static, where FastAPI's StaticFiles mount serves it
// in production (build-on-Mac, ship-the-artifact — same model as the daemon).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../backend/static",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
});
