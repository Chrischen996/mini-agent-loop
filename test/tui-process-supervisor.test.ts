import assert from "node:assert/strict";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  getSpawnConfig,
  needsTsxLoader,
  resolveChildEntry,
} from "../src/tui/process-supervisor.ts";

/**
 * Regression coverage for the supervisor's child-entry resolution.
 *
 * The packaged bin is `dist/tui-supervisor.js`; it must spawn `dist/tui.js`
 * WITHOUT the tsx loader. The previous `includes("/dist/")` sniff never
 * matched a directory that *is* `dist`, so the published bin spawned the
 * non-existent `dist/ink-main.tsx` and died on MODULE_NOT_FOUND — which also
 * forced every launch onto the ~3x slower dev/tsx startup path.
 */

const originalEntry = process.env.MINI_AGENT_CHILD_ENTRY;

after(() => {
  if (originalEntry === undefined) delete process.env.MINI_AGENT_CHILD_ENTRY;
  else process.env.MINI_AGENT_CHILD_ENTRY = originalEntry;
});

function withEntry<T>(entry: string | undefined, run: () => T): T {
  if (entry === undefined) delete process.env.MINI_AGENT_CHILD_ENTRY;
  else process.env.MINI_AGENT_CHILD_ENTRY = entry;
  try {
    return run();
  } finally {
    if (originalEntry === undefined) delete process.env.MINI_AGENT_CHILD_ENTRY;
    else process.env.MINI_AGENT_CHILD_ENTRY = originalEntry;
  }
}

describe("TUI process supervisor child entry", () => {
  it("detects TypeScript entries that need the tsx loader", () => {
    assert.equal(needsTsxLoader("/repo/src/tui/ink-main.tsx"), true);
    assert.equal(needsTsxLoader("/repo/src/tui/process-supervisor.ts"), true);
    assert.equal(needsTsxLoader("/repo/src/tui/entry.mts"), true);
    assert.equal(needsTsxLoader("/repo/dist/tui.js"), false);
    assert.equal(needsTsxLoader("/repo/dist/tui.mjs"), false);
  });

  it("resolves the source entry next to this (.ts) supervisor", () => {
    // The test imports the TypeScript module, so the sibling entry is the
    // dev entry. A bundled supervisor would resolve to `tui.js` instead.
    const entry = withEntry(undefined, () => resolveChildEntry());
    assert.equal(path.basename(entry), "ink-main.tsx");
  });

  it("honors the MINI_AGENT_CHILD_ENTRY override", () => {
    const entry = withEntry("/tmp/mini-agent-custom-entry.js", () => resolveChildEntry());
    assert.equal(entry, "/tmp/mini-agent-custom-entry.js");
  });

  it("spawns a bundled entry without the tsx loader", () => {
    const { spawnArgs, env } = withEntry("/repo/dist/tui.js", () =>
      getSpawnConfig(["--max-old-space-size=4096"], ["--resume"]),
    );
    assert.deepEqual(spawnArgs, [
      "--max-old-space-size=4096",
      "/repo/dist/tui.js",
      "--resume",
    ]);
    assert.equal(spawnArgs.includes("--import"), false, "no tsx loader for a bundle");
    assert.equal(env.MINI_AGENT_CHILD, "1");
  });

  it("spawns a source entry behind the tsx loader", () => {
    const { spawnArgs } = withEntry("/repo/src/tui/ink-main.tsx", () => getSpawnConfig([], []));
    assert.deepEqual(spawnArgs.slice(0, 2), ["--import", "tsx"]);
    assert.equal(spawnArgs.at(-1), "/repo/src/tui/ink-main.tsx");
  });
});
