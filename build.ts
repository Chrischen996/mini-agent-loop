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
  extraExternals: readonly string[] = [],
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
          id === "@earendil-works/pi-tui" ||
          nodeBuiltins.has(id) ||
          extraExternals.includes(id),
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
// P4: the published TUI executable is the renderer router. The default
// path is the pi-tui canonical entrypoint; `--renderer=scrollback` uses the
// raw ANSI variant. The router's dynamic imports are external so the sibling
// bundles resolve at runtime from dist/ rather than being inlined.
await buildEntry("src/tui/terminal-main.ts", "terminal-main.js", false);
await buildEntry("src/tui/terminal-main.ts", "terminal.js", false);
await buildEntry(
  "src/tui/tui-bin.ts",
  "tui.js",
  false,
  ["./terminal.js", "./terminal-main.js"],
);
