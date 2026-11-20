import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // `ws: true`: inoltra anche il WebSocket (/api/ws -> /ws) oltre alle richieste REST e agli /assets.
    proxy: { "/api": { target: "http://127.0.0.1:3000", ws: true, rewrite: (p) => p.replace(/^\/api/, "") } }
  },
  test: { environment: "jsdom", globals: false }
});
