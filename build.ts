import { build } from "vite";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { builtinModules } from "module";

const nodeBuiltins = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
);

await build({
  configFile: false,
  logLevel: "info",
  build: {
    ssr: true,
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
      external: (id) =>
        id === "react" ||
        id === "react-dom" ||
        id === "ink" ||
        nodeBuiltins.has(id),
    },
    minify: process.env.NODE_ENV === "production",
  },
  plugins: [
    nodeResolve({ preferBuiltins: true }),
  ],
});
