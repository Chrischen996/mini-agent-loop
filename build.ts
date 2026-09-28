import { build } from "vite";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { builtinModules } from "node:module";

const nodeBuiltins = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
);

async function buildEntry(
  input: string,
  entryFileName: string,
  emptyOutDir: boolean,
): Promise<void> {
  await build({
    configFile: false,
    logLevel: "info",
    build: {
      ssr: true,
      target: "node22",
      outDir: "dist",
      emptyOutDir,
      chunkSizeLimit: 100000,
      rollupOptions: {
        input,
        output: {
          entryFileNames: entryFileName,
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
}

// One-shot CLI and the single Ink terminal client are the only executables.
await buildEntry("src/cli.ts", "cli.js", true);
await buildEntry("src/tui/ink-main.tsx", "tui.js", false);
