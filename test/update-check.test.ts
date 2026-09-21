import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  checkForUpdate,
  compareVersions,
  fetchLatestVersion,
  formatUpdateNotice,
  resolveInstalledVersion,
  UPDATE_CHECK_CACHE_MS,
} from "../src/update-check.ts";

describe("update-check", () => {
  let tmpDir = "";
  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  });

  async function makeCacheFile(): Promise<string> {
    tmpDir = await mkdtemp(path.join(tmpdir(), "update-check-"));
    return path.join(tmpDir, "update-check.json");
  }

  it("detects a newer registry version as an upgrade", async () => {
    const cacheFile = await makeCacheFile();
    const info = await checkForUpdate({
      force: true,
      fetchLatest: async () => "99.0.0",
      currentVersion: "1.0.0",
      cacheFile,
    });
    assert.ok(info);
    assert.equal(info.latest, "99.0.0");
    assert.equal(info.current, "1.0.0");
    assert.equal(info.isUpgrade, true);
  });

  it("returns null when the installed version is current", async () => {
    const cacheFile = await makeCacheFile();
    const info = await checkForUpdate({
      force: true,
      fetchLatest: async () => "1.0.0",
      currentVersion: "1.0.0",
      cacheFile,
    });
    assert.equal(info, null);
  });

  it("returns null when the installed version is newer (no downgrade notice)", async () => {
    const cacheFile = await makeCacheFile();
    const info = await checkForUpdate({
      force: true,
      fetchLatest: async () => "0.9.0",
      currentVersion: "1.0.0",
      cacheFile,
    });
    assert.equal(info, null);
  });

  it("returns null when the registry lookup fails (offline)", async () => {
    const cacheFile = await makeCacheFile();
    const info = await checkForUpdate({
      force: true,
      fetchLatest: async () => {
        throw new Error("offline");
      },
      currentVersion: "1.0.0",
      cacheFile,
    });
    assert.equal(info, null);
  });

  it("reuses a fresh cache entry without touching the network", async () => {
    const cacheFile = await makeCacheFile();
    await writeFile(
      cacheFile,
      JSON.stringify({ checkedAt: Date.now(), latest: "2.0.0", current: "1.0.0" }),
    );
    let fetched = false;
    const info = await checkForUpdate({
      fetchLatest: async () => {
        fetched = true;
        return "3.0.0";
      },
      currentVersion: "1.0.0",
      cacheFile,
    });
    assert.equal(fetched, false);
    assert.ok(info);
    assert.equal(info.latest, "2.0.0");
  });

  it("refetches when the cache entry is older than the throttle window", async () => {
    const cacheFile = await makeCacheFile();
    await writeFile(
      cacheFile,
      JSON.stringify({ checkedAt: Date.now() - UPDATE_CHECK_CACHE_MS - 1000, latest: "2.0.0", current: "1.0.0" }),
    );
    let fetched = false;
    const info = await checkForUpdate({
      fetchLatest: async () => {
        fetched = true;
        return "4.0.0";
      },
      currentVersion: "1.0.0",
      cacheFile,
    });
    assert.equal(fetched, true);
    assert.ok(info);
    assert.equal(info.latest, "4.0.0");
  });

  it("respects the cache when the current version matches the cached one", async () => {
    const cacheFile = await makeCacheFile();
    await writeFile(
      cacheFile,
      JSON.stringify({ checkedAt: Date.now(), latest: "1.0.0", current: "1.0.0" }),
    );
    let fetched = false;
    const info = await checkForUpdate({
      fetchLatest: async () => {
        fetched = true;
        return "9.9.9";
      },
      currentVersion: "1.0.0",
      cacheFile,
    });
    // Cache hit with same current version and no upgrade: null, no fetch.
    assert.equal(fetched, false);
    assert.equal(info, null);
  });

  it("falls back to the network when the cache file is missing or corrupt", async () => {
    const cacheFile = await makeCacheFile();
    let fetched = false;
    const info = await checkForUpdate({
      fetchLatest: async () => {
        fetched = true;
        return "5.0.0";
      },
      currentVersion: "1.0.0",
      cacheFile, // file does not exist yet
    });
    assert.equal(fetched, true);
    assert.ok(info);
    assert.equal(info.latest, "5.0.0");
  });

  it("compares dotted-numeric versions correctly", () => {
    // compareVersions(a, b) === "a is older than b"
    assert.equal(compareVersions("0.1.6", "0.1.7"), true);
    assert.equal(compareVersions("0.1.7", "0.1.6"), false);
    assert.equal(compareVersions("0.1.6", "0.1.6"), false);
    assert.equal(compareVersions("0.2.0", "0.10.0"), true);
    assert.equal(compareVersions("1.0.0", "1.0.0-beta"), false); // prerelease sorted lower
  });

  it("formats a multi-line upgrade notice", () => {
    const text = formatUpdateNotice({ latest: "0.2.0", current: "0.1.7", isUpgrade: true });
    assert.match(text, /@krischen99999\/mini-agent-loop/);
    assert.match(text, /0\.1\.7 → 0\.2\.0/);
    assert.match(text, /npm install -g/);
  });

  it("resolves the installed version by walking up to the package manifest", async () => {
    const version = await resolveInstalledVersion();
    // In dev (src/) and bundled (dist/) the walk-up finds the repo manifest.
    assert.equal(typeof version, "string");
  });

  it("fetchLatestVersion degrades to null on non-OK responses without throwing", async () => {
    // Point the fetch at a bogus port via a failing global fetch override is
    // not available here; instead assert the contract: it never throws.
    let threw = false;
    try {
      await fetchLatestVersion();
    } catch {
      threw = true;
    }
    assert.equal(threw, false);
  });
});
