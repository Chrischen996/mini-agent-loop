import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * Web workbench (P2) build configuration.
 *
 * - Dev: `npm run web:dev` runs Vite on 127.0.0.1:5173 and proxies `/api`
 *   to the local Express server (default 127.0.0.1:3001). Set
 *   MINI_AGENT_API_URL to point the proxy elsewhere.
 * - Prod: `npm run web:build` emits `dist/web`, which `createAgentServer`
 *   (src/server.ts) serves when the directory exists.
 */
export default defineConfig({
  root: path.join(repoRoot, "apps/web"),
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.MINI_AGENT_API_URL ?? "http://127.0.0.1:3001",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: path.join(repoRoot, "dist/web"),
    emptyOutDir: true,
  },
});
