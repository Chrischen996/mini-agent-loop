import { build } from "vite";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { builtinModules } from "module";

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

// Keep the published default aligned with README's one-shot CLI contract.
await buildEntry("src/cli.ts", "cli.js", true);
// Publish the interactive ANSI client as a separate executable as well.
await buildEntry("src/tui/terminal-main.ts", "tui.js", false);
