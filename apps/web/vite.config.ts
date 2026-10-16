import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API runs separately (apps/server, port 8787); dev requests to /v1 are proxied to it.
// host: true lets a phone on the same Wi-Fi open the dev server.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: { "/v1": process.env.HIVE_API ?? "http://localhost:8787" },
  },
});
