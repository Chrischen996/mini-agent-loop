import { test } from "node:test";
import { deepStrictEqual, ok } from "node:assert";
import { mkdir, writeFile, rm } from "node:fs/promises";
import * as nodePath from "node:path";
import { listCandidates, parseAtRefs } from "../src/tui/file-refs.ts";

function makeFixtures(base: string) {
  return {
    base,
    async setup() {
      await rm(this.base, { recursive: true, force: true });
      await mkdir(nodePath.join(this.base, "src", "tui"), { recursive: true });
      await writeFile(nodePath.join(this.base, "README.md"), "hello");
      await writeFile(nodePath.join(this.base, "src", "index.ts"), "");
      await writeFile(nodePath.join(this.base, "src", "tui", "App.tsx"), "");
      await writeFile(nodePath.join(this.base, "src", "tui", "state.ts"), "");
    },
    async teardown() {
      await rm(this.base, { recursive: true, force: true });
    },
  };
}

test("parseAtRefs extracts @ references", async () => {
  deepStrictEqual(parseAtRefs("read @src/tui/App.tsx please"), ["src/tui/App.tsx"]);
  deepStrictEqual(
    parseAtRefs("look at @foo/bar and @baz/qux"),
    ["foo/bar", "baz/qux"],
  );
  deepStrictEqual(parseAtRefs("no refs here"), []);
  // Email-like strings must not match (no path chars after @)
  deepStrictEqual(parseAtRefs("user@gmail.com"), []);
});

test("listCandidates returns files in cwd root", async () => {
  const f = makeFixtures(nodePath.resolve("test/fixtures/file-refs-a"));
  await f.setup();
  try {
    const result = await listCandidates(f.base, "");
    ok(result.includes("README.md"), "should include README.md");
    ok(result.includes("src/"), "should include src/ directory");
  } finally {
    await f.teardown();
  }
});

test("listCandidates filters by prefix", async () => {
  const f = makeFixtures(nodePath.resolve("test/fixtures/file-refs-b"));
  await f.setup();
  try {
    const result = await listCandidates(f.base, "s");
    ok(result.includes("src/"), "should include src/ matching prefix 's'");
    ok(!result.includes("README.md"), "should exclude README.md not matching 's'");
  } finally {
    await f.teardown();
  }
});

test("listCandidates lists directory contents", async () => {
  const f = makeFixtures(nodePath.resolve("test/fixtures/file-refs-c"));
  await f.setup();
  try {
    const result = await listCandidates(f.base, "src/");
    ok(result.includes("src/tui/"), "should include src/tui/ subdirectory");
    ok(result.includes("src/index.ts"), "should include src/index.ts");
  } finally {
    await f.teardown();
  }
});

test("listCandidates recursive match: @App hits src/tui/App.tsx", async () => {
  const f = makeFixtures(nodePath.resolve("test/fixtures/file-refs-d"));
  await f.setup();
  try {
    const result = await listCandidates(f.base, "App");
    ok(result.includes("src/tui/App.tsx"), "should recursively match src/tui/App.tsx");
  } finally {
    await f.teardown();
  }
});

test("listCandidates on non-existent dir returns empty", async () => {
  const f = makeFixtures(nodePath.resolve("test/fixtures/file-refs-e"));
  await f.setup();
  try {
    const result = await listCandidates(f.base, "nonexistent/");
    deepStrictEqual(result, []);
  } finally {
    await f.teardown();
  }
});
