import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it } from "node:test";
import request from "supertest";
import { makeLlmConfig } from "../src/llm/index.ts";
import { createAgentServer } from "../src/server.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDir = path.join(repoRoot, "dist", "web");

const llm = makeLlmConfig({
  apiKey: "must-not-leak",
  baseUrl: "http://localhost/v1",
  model: "faux",
});

describe("web ui static serving (P2)", () => {
  it("serves the workbench build and falls back to index.html for SPA routes", async () => {
    const backupDir = `${webDir}.test-backup`;
    const hadDir = existsSync(webDir);
    rmSync(backupDir, { recursive: true, force: true });
    if (hadDir) cpSync(webDir, backupDir, { recursive: true });
    rmSync(webDir, { recursive: true, force: true });
    mkdirSync(webDir, { recursive: true });
    writeFileSync(path.join(webDir, "index.html"), "<html><body>workbench</body></html>");
    writeFileSync(path.join(webDir, "app.js"), "console.log('web');");
    try {
      const app = createAgentServer({ llm, tools: [] });

      const root = await request(app).get("/");
      assert.equal(root.status, 200);
      assert.match(root.text, /workbench/);

      const asset = await request(app).get("/app.js");
      assert.equal(asset.status, 200);
      assert.match(asset.text, /web/);

      const spa = await request(app).get("/sessions/abc");
      assert.equal(spa.status, 200);
      assert.match(spa.text, /workbench/);

      const api404 = await request(app).get("/api/definitely-not-a-route");
      assert.equal(api404.status, 404);
      assert.match(JSON.stringify(api404.body), /Not found/);
    } finally {
      rmSync(webDir, { recursive: true, force: true });
      if (hadDir) cpSync(backupDir, webDir, { recursive: true });
      rmSync(backupDir, { recursive: true, force: true });
    }
  });

  it("does not add a workbench route when no build exists", async () => {
    const backupDir = `${webDir}.test-backup`;
    const hadDir = existsSync(webDir);
    rmSync(backupDir, { recursive: true, force: true });
    if (hadDir) cpSync(webDir, backupDir, { recursive: true });
    rmSync(webDir, { recursive: true, force: true });
    try {
      const app = createAgentServer({ llm, tools: [] });

      const root = await request(app).get("/");
      assert.equal(root.status, 404);

      const spa = await request(app).get("/sessions/abc");
      assert.equal(spa.status, 404);
    } finally {
      rmSync(webDir, { recursive: true, force: true });
      if (hadDir) cpSync(backupDir, webDir, { recursive: true });
      rmSync(backupDir, { recursive: true, force: true });
    }
  });
});
