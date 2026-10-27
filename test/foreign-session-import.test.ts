import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import request from "supertest";
import { parseCliArgs } from "../src/cli.ts";
import { importForeignSession } from "../src/foreign-session.ts";
import { makeLlmConfig } from "../src/llm/index.ts";
import { sanitizeResumableMessages } from "../src/session-history.ts";
import { SessionManager } from "../src/session-manager.ts";
import { listForeignSessions } from "../src/foreign-session.ts";
import { createAgentServer } from "../src/server.ts";
import { parseForeignResumeCommand } from "../src/tui/session-serialization.ts";
import { SLASH_COMMANDS } from "../src/tui/slash-commands.ts";
import { slugify } from "../skills/adapt-foreign-session/scripts/session-reader.mjs";

const claudeId = "11111111-1111-4111-8111-111111111111";
const llm = makeLlmConfig({ apiKey: "test", baseUrl: "http://localhost/v1", model: "faux" });

async function writeClaude(root: string, cwd: string): Promise<void> {
  const config = path.join(root, "claude");
  const dir = path.join(config, "projects", slugify(cwd));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${claudeId}.jsonl`), JSON.stringify({
    type: "user",
    uuid: claudeId,
    cwd,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "fix the login bug" }] },
  }));
  process.env.CLAUDE_CONFIG_DIR = config;
}

describe("foreign session import", () => {
  it("parses the CLI and TUI import commands", () => {
    const listed = parseCliArgs(["--resume-claude"]);
    assert.deepEqual(listed.foreignResume, { source: "claude", reference: "" });
    const selected = parseCliArgs(["--resume-codex", "latest", "continue"]);
    assert.equal(selected.foreignResume?.source, "codex");
    assert.equal(selected.foreignResume?.reference, "latest");
    assert.equal(selected.prompt, "continue");
    assert.deepEqual(parseForeignResumeCommand("/resume-claude login"), { source: "claude", reference: "login" });
    assert.ok(SLASH_COMMANDS.some((command) => command.name === "resume-claude"));
    assert.ok(SLASH_COMMANDS.some((command) => command.name === "resume-codex"));
  });

  it("imports a Claude transcript once and reopens the same local session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "foreign-import-"));
    const cwd = path.join(root, "work");
    const previous = process.env.CLAUDE_CONFIG_DIR;
    try {
      await mkdir(cwd);
      await writeClaude(root, cwd);
      const manager = new SessionManager({ dataDir: path.join(root, "sessions"), workspaceId: cwd, projectPath: cwd });
      const first = await importForeignSession(manager, "claude", cwd, "login", cwd);
      assert.equal(first.created, true);
      assert.equal(first.session.origin?.source, "claude");
      assert.equal(first.session.origin?.sourceSessionId, claudeId);
      assert.equal(first.session.permissionMode, "plan");
      assert.equal(first.session.messages.some((message) => message.role === "assistant" && message.toolCalls), false);
      const reloaded = await manager.load(first.session.id);
      assert.equal(reloaded?.origin?.sourceSessionId, claudeId);
      assert.equal(sanitizeResumableMessages(reloaded?.messages ?? []).some((message) => message.role === "user"), true);
      const second = await importForeignSession(manager, "claude", cwd, claudeId, cwd);
      assert.equal(second.created, false);
      assert.equal(second.session.id, first.session.id);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists and imports a Claude session over HTTP", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "foreign-http-"));
    const workspace = path.join(root, "work");
    const previous = process.env.CLAUDE_CONFIG_DIR;
    try {
      await mkdir(workspace);
      await writeClaude(root, workspace);
      const app = createAgentServer({ llm, tools: [], workspace, dataDir: root });
      const listed = await request(app).get("/api/foreign-sessions?source=claude");
      assert.equal(listed.status, 200);
      assert.equal(listed.body.sessions[0]?.session_id, claudeId);
      const imported = await request(app).post("/api/sessions/import").send({ source: "claude", reference: "login" });
      assert.equal(imported.status, 201);
      const detail = await request(app).get(`/api/sessions/${imported.body.id}`);
      assert.equal(detail.status, 200);
      assert.match(JSON.stringify(detail.body), /fix the login bug/);
      const again = await request(app).post("/api/sessions/import").send({ source: "claude", reference: claudeId });
      assert.equal(again.status, 200);
      assert.equal(again.body.id, imported.body.id);
      assert.equal(again.body.created, false);
      await request(app).put(`/api/sessions/${imported.body.id}/permission-mode`).send({ mode: "bypass" });
      const kept = await request(app).post("/api/sessions/import").send({ source: "claude", reference: claudeId });
      assert.equal(kept.body.id, imported.body.id);
      const mode = await request(app).get(`/api/sessions/${imported.body.id}/permission-mode`);
      assert.equal(mode.body.mode, "bypass");
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists a Codex rollout that exists only as a compressed file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "foreign-zst-"));
    const cwd = path.join(root, "work");
    const home = path.join(root, "codex");
    const previous = process.env.CODEX_HOME;
    const codexId = "44444444-4444-4444-8444-444444444444";
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(path.join(home, "sessions", "2026", "01", "02"), { recursive: true });
      const body = [
        JSON.stringify({ type: "session_meta", payload: { id: codexId, cwd, source: "cli" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "compressed chat" }] } }),
      ].join("\n");
      await writeFile(
        path.join(home, "sessions", "2026", "01", "02", `rollout-2026-01-02T00-00-00-${codexId}.jsonl.zst`),
        gzipSync(body),
      );
      process.env.CODEX_HOME = home;
      const listed = await listForeignSessions("codex", cwd);
      assert.equal(listed.sessions[0]?.session_id, codexId);
      assert.match(listed.sessions[0]?.title ?? "", /zstd/);
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
