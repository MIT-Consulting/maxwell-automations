import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const DAEMON = process.env.LCA_DAEMON_URL ?? "http://127.0.0.1:3747";
// The public-facing port is the daemon's (LCA_PORT), since the daemon
// reverse-proxies the dev UI on a single port. The HMR client must dial that
// port, not Vite's, so live reload works from any host (loopback / Tailscale).
const DAEMON_PORT = Number(process.env.LCA_PORT ?? 3747);

// Single-port dev: the daemon serves /api + /ws and proxies everything else
// (incl. HMR) here. The SPA uses same-origin relative paths in dev and prod.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // Bind loopback only — Vite is never exposed directly; the daemon fronts it.
    host: "127.0.0.1",
    port: 5273,
    // Accept requests the daemon forwards under a LAN/Tailscale Host or Origin.
    allowedHosts: true,
    // HMR client connects to the daemon's port (same origin as the page), which
    // proxies the websocket back to Vite. Hostname is left to the browser's
    // location so loopback and remote (phone) both resolve correctly.
    hmr: { clientPort: DAEMON_PORT },
    // Only used if Vite is hit directly (:5273); in single-port mode the daemon
    // handles these. Harmless to keep as a fallback.
    proxy: {
      "/api": { target: DAEMON, changeOrigin: true },
      "/ws": { target: DAEMON, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
