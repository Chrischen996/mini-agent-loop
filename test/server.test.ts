import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import request from "supertest";
import { contentAsString } from "../src/content.ts";
import { makeLlmConfig } from "../src/llm.ts";
import { createAgentServer } from "../src/server.ts";
import type { AgentMessage, AssistantMessage } from "../src/types.ts";

const llm = makeLlmConfig({
  apiKey: "must-not-leak",
  baseUrl: "http://localhost/v1",
  model: "faux",
});

describe("agent server", () => {
  it("reports only whether DeepWiki is enabled", async () => {
    const app = createAgentServer({
      llm,
      tools: [],
      chat: async () => ({ role: "assistant", content: "ok" }),
      serveWeb: false,
      deepWikiEnabled: true,
    });
    const config = await request(app).get("/api/config");
    assert.deepEqual((config.body as { deepWiki: unknown }).deepWiki, { enabled: true });
    assert.doesNotMatch(config.text, /mcp\.deepwiki\.com/);
  });

  it("keeps a multi-turn session and streams safe NDJSON events", async () => {
    const chat = async (
      _config: typeof llm,
      messages: AgentMessage[],
    ): Promise<AssistantMessage> => {
      const users = messages.filter((message) => message.role === "user").length;
      return { role: "assistant", content: `server turn ${users}` };
    };
    const app = createAgentServer({
      llm,
      tools: [],
      chat,
      serveWeb: false,
      mcpStatuses: [{
        id: "fixture",
        transport: "stdio",
        required: false,
        state: "ready",
        toolCount: 2,
      }],
    });

    const config = await request(app).get("/api/config");
    assert.equal(config.status, 200);
    assert.doesNotMatch(config.text, /must-not-leak/);
    assert.equal((config.body as { mcp: { enabled: boolean } }).mcp.enabled, true);
    assert.equal((config.body as { deepWiki: { enabled: boolean } }).deepWiki.enabled, false);

    const created = await request(app).post("/api/sessions");
    assert.equal(created.status, 201);
    const sessionId = (created.body as { id: string }).id;

    const first = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .field("prompt", "first");
    assert.equal(first.status, 200);
    const firstEvents = first.text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; content?: string });
    assert.deepEqual(firstEvents.map((event) => event.type), [
      "user",
      "assistant",
      "done",
    ]);
    assert.equal(firstEvents[1]?.content, "server turn 1");

    const second = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .field("prompt", "second");
    assert.equal(second.status, 200);
    assert.match(second.text, /server turn 2/);

    const history = await request(app).get(`/api/sessions/${sessionId}`);
    const data = history.body as { messages: Array<{ role: string }> };
    assert.deepEqual(
      data.messages.map((message) => message.role),
      ["user", "assistant", "user", "assistant"],
    );
    assert.doesNotMatch(history.text, /must-not-leak/);
  });

  it("restores sessions after the server instance is recreated", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "mini-agent-session-persist-"));
    try {
      const chat = async () => ({ role: "assistant" as const, content: "persisted reply" });
      const firstApp = createAgentServer({ llm, tools: [], chat, dataDir, serveWeb: false });
      const created = await request(firstApp).post("/api/sessions");
      const sessionId = (created.body as { id: string }).id;
      await request(firstApp)
        .post(`/api/sessions/${sessionId}/messages`)
        .field("prompt", "remember this");

      const secondApp = createAgentServer({ llm, tools: [], chat, dataDir, serveWeb: false });
      const restored = await request(secondApp).get(`/api/sessions/${sessionId}`);
      assert.equal(restored.status, 200);
      assert.match(restored.text, /remember this/);
      assert.match(restored.text, /persisted reply/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects an empty multipart message", async () => {
    const app = createAgentServer({
      llm,
      tools: [],
      chat: async () => ({ role: "assistant", content: "unused" }),
      serveWeb: false,
    });
    const created = await request(app).post("/api/sessions");
    const sessionId = (created.body as { id: string }).id;
    const response = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .field("prompt", "   ");
    assert.equal(response.status, 400);
    assert.match(response.text, /prompt, image, document, or referenced path/i);
  });

  it("lists workspace files and rejects escapes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-server-ws-"));
    const workspace = path.join(root, "ws");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "package.json"), '{"name":"demo"}', "utf8");
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src", "loop.ts"), "export {}", "utf8");
    await mkdir(path.join(workspace, "node_modules"));
    try {
      const app = createAgentServer({
        llm,
        tools: [],
        chat: async () => ({ role: "assistant", content: "unused" }),
        workspace,
        serveWeb: false,
      });

      const rootList = await request(app).get("/api/workspace/list");
      assert.equal(rootList.status, 200);
      const rootBody = rootList.body as {
        entries: Array<{ name: string; type: string; path: string }>;
      };
      assert.ok(rootBody.entries.some((entry) => entry.name === "package.json"));
      assert.ok(rootBody.entries.some((entry) => entry.name === "src"));
      assert.ok(!rootBody.entries.some((entry) => entry.name === "node_modules"));

      const child = await request(app).get("/api/workspace/list").query({ path: "src" });
      assert.equal(child.status, 200);
      assert.ok(
        (child.body as { entries: Array<{ path: string }> }).entries.some(
          (entry) => entry.path === "src/loop.ts",
        ),
      );

      const escape = await request(app)
        .get("/api/workspace/list")
        .query({ path: "../" });
      assert.equal(escape.status, 400);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts referencedPaths-only messages and injects read hints", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-server-ref-"));
    const workspace = path.join(root, "ws");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "package.json"), '{"name":"demo"}', "utf8");
    try {
      let seenPrompt = "";
      const app = createAgentServer({
        llm,
        tools: [],
        chat: async (_config, messages) => {
          const last = messages[messages.length - 1];
          if (last && last.role === "user") {
            seenPrompt = typeof last.content === "string"
              ? last.content
              : JSON.stringify(last.content);
          }
          return { role: "assistant", content: "ok" };
        },
        workspace,
        serveWeb: false,
      });

      const created = await request(app).post("/api/sessions");
      const sessionId = (created.body as { id: string }).id;
      const response = await request(app)
        .post(`/api/sessions/${sessionId}/messages`)
        .field("prompt", "")
        .field("referencedPaths", JSON.stringify(["package.json"]));
      assert.equal(response.status, 200);
      const events = response.text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as {
          type: string;
          content?: string;
          referencedPaths?: string[];
        });
      assert.equal(events[0]?.type, "user");
      assert.deepEqual(events[0]?.referencedPaths, ["package.json"]);
      assert.match(events[0]?.content ?? "", /请阅读引用的文件/);
      assert.match(seenPrompt, /Referenced workspace files/);
      assert.match(seenPrompt, /package\.json/);
      assert.match(seenPrompt, /use the read tool/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("extracts an uploaded DOCX into the model context", async () => {
    let seenPrompt = "";
    const app = createAgentServer({
      llm,
      tools: [],
      chat: async (_config, messages) => {
        const user = messages.find((message) => message.role === "user");
        seenPrompt = user && user.role === "user" ? contentAsString(user.content) : "";
        return { role: "assistant", content: "document received" };
      },
      serveWeb: false,
    });
    const created = await request(app).post("/api/sessions");
    const sessionId = (created.body as { id: string }).id;
    const document = path.resolve("node_modules/mammoth/test/test-data/single-paragraph.docx");
    const response = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .field("prompt", "总结这个文档")
      .attach("documents", document);
    assert.equal(response.status, 200);
    assert.match(seenPrompt, /Attached document: single-paragraph\.docx/);
    assert.match(response.text, /"documents":\["single-paragraph\.docx"\]/);
  });

  it("creates a downloadable edited document from a tool call", async () => {
    let attachmentId = "";
    let turn = 0;
    const app = createAgentServer({
      llm,
      tools: [],
      chat: async (_config, messages) => {
        turn += 1;
        const user = messages.find((message) => message.role === "user");
        if (turn === 1 && user && user.role === "user") {
          const match = contentAsString(user.content).match(/attachmentId=([^,\]]+)/);
          attachmentId = match?.[1] ?? "";
          return {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "document-edit-1",
              name: "document_edit",
              arguments: {
                attachmentId,
                replacements: [{ oldText: "Walking on imported air", newText: "Edited document text" }],
                outputFormat: "docx",
              },
            }],
          };
        }
        return { role: "assistant", content: "已生成下载文件" };
      },
      serveWeb: false,
    });
    const created = await request(app).post("/api/sessions");
    const sessionId = (created.body as { id: string }).id;
    const document = path.resolve("node_modules/mammoth/test/test-data/single-paragraph.docx");
    const response = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .field("prompt", "把文档内容改掉并帮我下载")
      .attach("documents", document);
    assert.equal(response.status, 200);
    const fileEvent = response.text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; downloadUrl?: string })
      .find((event) => event.type === "file_ready");
    assert.ok(fileEvent?.downloadUrl);
    const downloaded = await request(app).get(fileEvent!.downloadUrl!);
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers["content-type"], "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    assert.ok(Number(downloaded.headers["content-length"]) > 0);
  });

  it("rejects invalid referencedPaths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-server-badref-"));
    const workspace = path.join(root, "ws");
    await mkdir(workspace);
    try {
      const app = createAgentServer({
        llm,
        tools: [],
        chat: async () => ({ role: "assistant", content: "unused" }),
        workspace,
        serveWeb: false,
      });
      const created = await request(app).post("/api/sessions");
      const sessionId = (created.body as { id: string }).id;
      const response = await request(app)
        .post(`/api/sessions/${sessionId}/messages`)
        .field("prompt", "hi")
        .field("referencedPaths", JSON.stringify(["missing.ts"]));
      assert.equal(response.status, 400);
      assert.match(response.text, /not found|Referenced path/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
