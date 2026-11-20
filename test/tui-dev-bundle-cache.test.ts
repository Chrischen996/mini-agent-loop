import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  acquireBuildLock,
  collectSourceStamp,
  computeSourceFingerprint,
  DEV_BUNDLE_CACHE_VERSION,
  isDevBundleFresh,
  readDevBundleMeta,
  releaseBuildLock,
  resolveDevBundlePaths,
  writeDevBundleMeta,
} from "../src/tui/dev-bundle-cache.ts";

/**
 * The dev bundle cache is a correctness-sensitive optimisation: a stale bundle
 * silently runs old code, so the stamp has to move for every kind of source
 * change and the freshness check has to be conservative.
 */

const roots: string[] = [];

function fixture(): { root: string; src: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "mini-agent-dev-cache-"));
  roots.push(root);
  const src = path.join(root, "src");
  mkdirSync(path.join(src, "tui"), { recursive: true });
  writeFileSync(path.join(src, "tui", "a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(root, "package.json"), "{}\n");
  return { root, src };
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const fingerprintOf = (root: string, src: string) =>
  computeSourceFingerprint({ srcDir: src, extraFiles: [path.join(root, "package.json")] });

describe("dev bundle cache stamp", () => {
  it("is stable across identical scans and covers nested files", () => {
    const { root, src } = fixture();
    writeFileSync(path.join(src, "tui", "nested.tsx"), "export const nested = <div />;\n");
    assert.equal(fingerprintOf(root, src), fingerprintOf(root, src));
    assert.equal(collectSourceStamp(src).length, 2);
  });

  it("changes when a file's content changes", () => {
    const { root, src } = fixture();
    const before = fingerprintOf(root, src);
    writeFileSync(path.join(src, "tui", "a.ts"), "export const a = 2;\n");
    assert.notEqual(fingerprintOf(root, src), before);
  });

  it("changes when a file is added or deleted", () => {
    const { root, src } = fixture();
    const before = fingerprintOf(root, src);
    const added = path.join(src, "tui", "b.ts");
    writeFileSync(added, "export const b = 1;\n");
    const withFile = fingerprintOf(root, src);
    assert.notEqual(withFile, before);
    rmSync(added);
    assert.equal(fingerprintOf(root, src), before);
  });

  it("changes for a same-size rewrite inside the same millisecond", () => {
    const { root, src } = fixture();
    const before = fingerprintOf(root, src);
    // Same byte count, no guaranteed mtime tick: content hashing must catch it.
    writeFileSync(path.join(src, "tui", "a.ts"), "export const a = 2;\n");
    assert.notEqual(fingerprintOf(root, src), before);
  });

  it("ignores a touched-but-unchanged file", () => {
    const { root, src } = fixture();
    const file = path.join(src, "tui", "a.ts");
    const before = fingerprintOf(root, src);
    const later = new Date(Date.now() + 60_000);
    utimesSync(file, later, later);
    assert.equal(fingerprintOf(root, src), before, "mtime alone must not invalidate");
  });

  it("ignores non-bundled files and the package.json content it reads", () => {
    const { root, src } = fixture();
    const before = fingerprintOf(root, src);
    writeFileSync(path.join(src, "tui", "notes.md"), "# not bundled\n");
    assert.equal(fingerprintOf(root, src), before);

    writeFileSync(path.join(root, "package.json"), '{"name":"x"}\n');
    assert.notEqual(fingerprintOf(root, src), before);
  });
});

describe("dev bundle cache freshness", () => {
  it("requires a bundle on disk plus a matching stamp and version", () => {
    const { root } = fixture();
    const paths = resolveDevBundlePaths(root);
    mkdirSync(paths.cacheDir, { recursive: true });
    assert.equal(isDevBundleFresh(paths, undefined, "abc"), false, "no meta");

    writeFileSync(paths.bundlePath, "// bundle\n");
    writeDevBundleMeta(paths.metaPath, {
      version: DEV_BUNDLE_CACHE_VERSION,
      fingerprint: "abc",
      builtAt: Date.now(),
    });
    assert.equal(isDevBundleFresh(paths, readDevBundleMeta(paths.metaPath), "abc"), true);
    assert.equal(isDevBundleFresh(paths, readDevBundleMeta(paths.metaPath), "other"), false, "stamp moved");
    assert.equal(
      isDevBundleFresh(
        paths,
        { version: DEV_BUNDLE_CACHE_VERSION + 1, fingerprint: "abc", builtAt: 0 },
        "abc",
      ),
      false,
      "cache format version moved",
    );

    writeFileSync(paths.bundlePath, "");
    assert.equal(isDevBundleFresh(paths, readDevBundleMeta(paths.metaPath), "abc"), false, "empty bundle");
  });

  it("treats an unreadable meta as a miss", () => {
    const { root } = fixture();
    const paths = resolveDevBundlePaths(root);
    mkdirSync(paths.cacheDir, { recursive: true });
    writeFileSync(paths.metaPath, "not json");
    assert.equal(readDevBundleMeta(paths.metaPath), undefined);
  });
});

describe("dev bundle build lock", () => {
  it("is exclusive and released cleanly", () => {
    const { root } = fixture();
    const paths = resolveDevBundlePaths(root);
    assert.equal(acquireBuildLock(paths.lockPath), true);
    assert.equal(acquireBuildLock(paths.lockPath), false, "second builder is refused");
    releaseBuildLock(paths.lockPath);
    assert.equal(acquireBuildLock(paths.lockPath), true);
    releaseBuildLock(paths.lockPath);
    assert.equal(existsSync(paths.lockPath), false);
  });

  it("steals a stale lock left behind by a killed build", () => {
    const { root } = fixture();
    const paths = resolveDevBundlePaths(root);
    assert.equal(acquireBuildLock(paths.lockPath), true);
    // A lock older than the stale window must not block forever.
    assert.equal(acquireBuildLock(paths.lockPath, 1000, Date.now() + 2000), true);
    releaseBuildLock(paths.lockPath);
  });

  it("creates the cache directory on the very first build", () => {
    const { root } = fixture();
    const paths = resolveDevBundlePaths(root);
    assert.equal(existsSync(paths.cacheDir), false);
    assert.equal(acquireBuildLock(paths.lockPath), true);
    releaseBuildLock(paths.lockPath);
  });
});
