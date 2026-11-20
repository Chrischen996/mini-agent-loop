/**
 * Guards for the `npm run tui` launcher.
 *
 * The launcher is the only file in the repo that runs under plain `node`
 * (Node >= 22.19 strips TypeScript types without a loader), so it has to stay
 * type-strip friendly — a stray `enum` or `namespace` there breaks
 * `npm run tui` while `typecheck` and the rest of the suite stay green.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcherPath = path.join(repoRoot, "src", "tui", "dev-launch.ts");

test("the dev launcher imports under plain node (type stripping, no tsx)", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const mod = await import(${JSON.stringify(pathToFileURL(launcherPath).href)});
       if (typeof mod.main !== "function") throw new Error("main is not exported");`,
    ],
    { cwd: repoRoot, encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
});

test("npm run tui keeps the fast, tsx-free launcher entry", () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(pkg.scripts.tui, "node src/tui/dev-launch.ts");
  // The launcher must not spawn itself through npm (that would add ~200 ms and
  // recurse); only the child uses the tsx loader.
  assert.ok(!pkg.scripts.tui.includes("npm "));
});
