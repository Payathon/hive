import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API runs separately (apps/server, port 8787); dev requests to /v1 are proxied to it, and so are
// the agent-facing paths, so the 接入 agent prompt can point at this origin.
// host: true lets a phone on the same Wi-Fi open the dev server.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: Object.fromEntries(["/v1", "/mcp", "/agent.md", "/skill", "/hive.mjs"].map((p) => [p, process.env.HIVE_API ?? "http://localhost:8787"])),
  },
});
