import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.API_ORIGIN ?? "http://localhost:3001";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Keep the browser's Host header so the server's same-origin checks pass in development.
      "/api": { target: api, changeOrigin: false },
      "/socket.io": { target: api, ws: true, changeOrigin: false },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
