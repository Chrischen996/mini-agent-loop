import { build } from "vite";
import { nodeResolve } from "@vitejs/plugin-node";
import { builtinModules } from "module";

await build({
  configFile: false,
  logLevel: "info",
  build: {
    target: "node22",
    outDir: "dist",
    chunkSizeLimit: 100000,
    rollupOptions: {
      input: "src/tui/terminal-main.ts",
      output: {
        entryFileNames: "cli.js",
        chunkFileNames: "[name]-[hash].js",
        format: "esm",
        preserveModules: false,
      },
      external: [
        "react",
        "react-dom",
        "ink",
        ...builtinModules,
      ],
    },
    minify: process.env.NODE_ENV === "production",
  },
  plugins: [
    nodeResolve({ preferBuiltins: true }),
  ],
});
