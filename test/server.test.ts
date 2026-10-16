import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import request from "supertest";
import { contentAsString } from "../src/content.ts";
import { makeLlmConfig } from "../src/llm/index.ts";
import { createAgentServer } from "../src/server.ts";
import { projectDirectoryName } from "../src/session-store.ts";
import { SessionManager } from "../src/session-manager.ts";
import type { Tool } from "../src/tools/types.ts";
import type { AgentMessage, AssistantMessage } from "../src/types.ts";

const llm = makeLlmConfig({
  apiKey: "must-not-leak",
  baseUrl: "http://localhost/v1",
  model: "faux",
});

describe("agent server", () => {
  it("exposes background task tools in the default server tool registry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-server-bg-tools-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    let toolNames: string[] = [];
    try {
      const app = createAgentServer({
        llm,
        workspace,
        dataDir: root,
        backgroundTasks: true,
        chat: async (_config, _messages, tools) => {
          toolNames = tools?.map((tool) => tool.name) ?? [];
          return { role: "assistant", content: "ok" };
        },
      });
      const created = await request(app).post("/api/sessions");
      const sessionId = (created.body as { id: string }).id;
      const response = await request(app)
        .post(`/api/sessions/${sessionId}/messages`)
        .field("prompt", "show available tools");
      assert.equal(response.status, 200);
      assert.ok(toolNames.includes("bg_start"));
      assert.ok(toolNames.includes("bg_status"));
      assert.ok(toolNames.includes("bg_logs"));
      assert.ok(toolNames.includes("bg_send"));
      assert.ok(toolNames.includes("bg_wait"));
      assert.ok(toolNames.includes("bg_kill"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("registers multiple workspaces and binds new sessions and file browsing to one root", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "mini-agent-workspaces-"));
    const firstRoot = path.join(dataDir, "project-one");
    const secondRoot = path.join(dataDir, "project-two");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    await writeFile(path.join(firstRoot, "project.txt"), "one");
    await writeFile(path.join(secondRoot, "project.txt"), "two");
    const app = createAgentServer({ llm, tools: [], workspace: firstRoot, dataDir });
    try {
      const initial = await request(app).get("/api/workspaces");
      assert.equal(initial.status, 200);
      const first = (initial.body as { workspaces: Array<{ id: string; path: string }> }).workspaces[0]!;
      assert.equal(first.path, await realpath(firstRoot));

      const defaultDirectoryBrowser = await request(app).get("/api/workspaces/directories");
      assert.equal(defaultDirectoryBrowser.status, 200);
      assert.equal(
        (defaultDirectoryBrowser.body as { path: string; home: string }).path,
        await realpath(homedir()),
      );
      assert.equal((defaultDirectoryBrowser.body as { home: string }).home, homedir());

      const relativeDirectoryBrowser = await request(app)
        .get("/api/workspaces/directories?path=.");
      assert.equal(relativeDirectoryBrowser.status, 400);
      assert.match(
        (relativeDirectoryBrowser.body as { error: string }).error,
        /fully qualified/,
      );

      await mkdir(path.join(dataDir, ".hidden-project"));

      const directoryBrowser = await request(app).get(`/api/workspaces/directories?path=${encodeURIComponent(dataDir)}`);
      assert.equal(directoryBrowser.status, 200);
      const browsed = directoryBrowser.body as { directories: Array<{ name: string; hidden?: boolean }>; path: string };
      assert.equal(browsed.path, await realpath(dataDir));
      assert.ok(browsed.directories.some((item) => item.name === "project-one" && item.hidden !== true));
      assert.ok(browsed.directories.some((item) => item.name === "project-two"));
      assert.ok(browsed.directories.some((item) => item.name === ".hidden-project" && item.hidden === true));
      assert.equal((directoryBrowser.body as { truncated: boolean }).truncated, false);
      assert.ok(Array.isArray((directoryBrowser.body as { crumbs: unknown }).crumbs));

      const created = await request(app).post("/api/workspaces/directories").send({ path: dataDir, name: "created-folder" });
      assert.equal(created.status, 201);
      assert.equal((created.body as { path: string }).path, path.join(await realpath(dataDir), "created-folder"));
      const duplicate = await request(app).post("/api/workspaces/directories").send({ path: dataDir, name: "created-folder" });
      assert.equal(duplicate.status, 409);
      const badName = await request(app).post("/api/workspaces/directories").send({ path: dataDir, name: "../escape" });
      assert.equal(badName.status, 400);

      const added = await request(app).post("/api/workspaces").send({ path: secondRoot });
      assert.equal(added.status, 201);
      const second = (added.body as { workspace: { id: string } }).workspace;
      const session = await request(app).post("/api/sessions").send({ workspaceId: second.id });
      assert.equal(session.status, 201);
      assert.equal((session.body as { workspaceId: string }).workspaceId, second.id);
      const presentation = await request(app).patch(`/api/sessions/${session.body.id}/presentation`).send({ title: "Project two", pinned: true });
      assert.equal(presentation.status, 200);
      const summary = await request(app).get("/api/sessions");
      const summarySession = (summary.body as { sessions: Array<{ id: string; title: string; pinned: boolean }> }).sessions.find((item) => item.id === session.body.id);
      assert.equal(summarySession?.title, "Project two");
      assert.equal(summarySession?.pinned, true);

      const listing = await request(app).get(`/api/workspace/list?sessionId=${session.body.id}`);
      assert.equal(listing.status, 200);
      assert.equal((listing.body as { entries: Array<{ name: string }> }).entries[0]?.name, "project.txt");
      const preview = await request(app).get(`/api/workspace/file?sessionId=${session.body.id}&path=project.txt`);
      assert.equal(preview.status, 200);
      assert.equal((preview.body as { content: string }).content, "two");
      const mismatchedScope = await request(app)
        .get(`/api/workspace/file?sessionId=${session.body.id}&workspaceId=${first.id}&path=project.txt`);
      assert.equal(mismatchedScope.status, 409);
      await access(path.join(
        dataDir,
        "sessions",
        "projects",
        projectDirectoryName(await realpath(secondRoot)),
        session.body.id,
        "events.jsonl",
      ));
      const summaries = await request(app).get("/api/sessions");
      assert.equal((summaries.body as { sessions: Array<{ workspaceId: string }> }).sessions[0]?.workspaceId, second.id);

      const restoredApp = createAgentServer({ llm, tools: [], workspace: firstRoot, dataDir });
      const restoredWorkspaces = await request(restoredApp).get("/api/workspaces");
      assert.ok((restoredWorkspaces.body as { workspaces: Array<{ id: string }> }).workspaces.some((item) => item.id === second.id));
      const restoredPreview = await request(restoredApp).get(`/api/workspace/file?sessionId=${session.body.id}&path=project.txt`);
      assert.equal((restoredPreview.body as { content: string }).content, "two");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("migrates legacy flat sessions into the selected project's session directory", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "mini-agent-session-migration-"));
    const workspace = path.join(dataDir, "project");
    await mkdir(workspace);
    try {
      const legacy = new SessionManager({ dataDir: path.join(dataDir, "sessions") });
      await legacy.save({
        id: "legacy-session",
        createdAt: 123,
        lastActiveAt: 456,
        messages: [{ role: "user", content: "legacy prompt" }],
      });

      const app = createAgentServer({ llm, tools: [], workspace, dataDir });
      const restored = await request(app).get("/api/sessions/legacy-session");
      assert.equal(restored.status, 200);
      assert.match(restored.text, /legacy prompt/);
      const projectSession = path.join(
        dataDir,
        "sessions",
        "projects",
        projectDirectoryName(await realpath(workspace)),
        "legacy-session",
        "events.jsonl",
      );
      await access(projectSession);
      await assert.rejects(access(path.join(dataDir, "sessions", "legacy-session", "events.jsonl")));
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("builds local read tools against each session workspace", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "mini-agent-workspace-tools-"));
    const firstRoot = path.join(dataDir, "first");
    const secondRoot = path.join(dataDir, "second");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    await writeFile(path.join(firstRoot, "same.txt"), "from first");
    await writeFile(path.join(secondRoot, "same.txt"), "from second");
    let calls = 0;
    const readResults: string[] = [];
    const app = createAgentServer({
      llm,
      workspace: firstRoot,
      dataDir,
      permissionMode: "bypass",
      chat: async (_config, messages) => {
        calls += 1;
        if (calls === 1 || calls === 3) {
          return { role: "assistant", content: "", toolCalls: [{ id: `read-${calls}`, name: "read", arguments: { path: "same.txt" } }] };
        }
        const result = [...messages].reverse().find((message) => message.role === "tool");
        readResults.push(result ? contentAsString(result.content) : "missing tool result");
        return { role: "assistant", content: "done" };
      },
    });
    try {
      const workspaces = await request(app).get("/api/workspaces");
      const secondWorkspace = await request(app).post("/api/workspaces").send({ path: secondRoot });
      const firstId = (workspaces.body as { workspaces: Array<{ id: string }> }).workspaces[0]!.id;
      const secondId = (secondWorkspace.body as { workspace: { id: string } }).workspace.id;
      const firstSession = await request(app).post("/api/sessions").send({ workspaceId: firstId });
      const secondSession = await request(app).post("/api/sessions").send({ workspaceId: secondId });
      for (const session of [firstSession, secondSession]) {
        const id = (session.body as { id: string }).id;
        const response = await request(app).post(`/api/sessions/${id}/messages`).field("prompt", "read same.txt");
        assert.equal(response.status, 200);
      }
      assert.match(readResults[0]!, /from first/);
      assert.match(readResults[1]!, /from second/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects the removed approval environment mode instead of silently defaulting", () => {
    const previous = process.env.MINI_AGENT_PERMISSION_MODE;
    process.env.MINI_AGENT_PERMISSION_MODE = "approval";
    try {
      assert.throws(
        () => createAgentServer({ llm, tools: [], permissionMode: undefined }),
        /approval.*removed.*plan.*bypass/i,
      );
    } finally {
      if (previous === undefined) delete process.env.MINI_AGENT_PERMISSION_MODE;
      else process.env.MINI_AGENT_PERMISSION_MODE = previous;
    }
  });
  it("exposes session permission mode and approval APIs", async () => {
    const app = createAgentServer({
      llm,
      tools: [],
      chat: async () => ({ role: "assistant", content: "ok" }),
      permissionMode: "plan",
    });
    const globalMode = await request(app).get("/api/permission-mode");
    assert.equal(globalMode.status, 404);

    const created = await request(app).post("/api/sessions");
    const sessionId = (created.body as { id: string }).id;
    const sessionMode = await request(app).get(`/api/sessions/${sessionId}/permission-mode`);
    assert.equal(sessionMode.status, 200);
    assert.equal((sessionMode.body as { mode: string }).mode, "plan");
    const changed = await request(app)
      .put(`/api/sessions/${sessionId}/permission-mode`)
      .send({ mode: "bypass" });
    assert.equal(changed.status, 200);
    assert.equal((changed.body as { mode: string }).mode, "bypass");
    const invalid = await request(app)
      .put(`/api/sessions/${sessionId}/permission-mode`)
      .send({ mode: "manual" });
    assert.equal(invalid.status, 400);
    const alsoInvalid = await request(app)
      .put(`/api/sessions/${sessionId}/permission-mode`)
      .send({ mode: "unknown" });
    assert.equal(alsoInvalid.status, 400);
    const removedApproval = await request(app)
      .put(`/api/sessions/${sessionId}/permission-mode`)
      .send({ mode: "approval" });
    assert.equal(removedApproval.status, 400);
    assert.match(removedApproval.body.error, /approval.*removed.*plan.*bypass/i);
    const decision = await request(app)
      .post(`/api/sessions/${sessionId}/permissions/request-id`)
      .send({ decision: "allow" });
    assert.equal(decision.status, 404);
  });

  it("atomically interrupts an active request and persists the new mode", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "mini-agent-permission-switch-"));
    let releaseModel: (() => void) | undefined;
    let modelCalls = 0;
    let nextSystemPrompt = "";
    let executions = 0;
    const writeTool: Tool = {
      name: "write",
      description: "write",
      parameters: { type: "object" },
      execute: async () => {
        executions += 1;
        return { content: "written" };
      },
    };
    const app = createAgentServer({
      llm,
      tools: [writeTool],
      permissionMode: "plan",
      dataDir,
      chat: async (_config, messages) => {
        modelCalls += 1;
        const system = messages.find((message) => message.role === "system");
        if (modelCalls === 2) {
          nextSystemPrompt = system && typeof system.content === "string" ? system.content : "";
        }
        if (modelCalls === 1) {
          await new Promise<void>((resolve) => { releaseModel = resolve; });
          return {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "stale-write", name: "write", arguments: {} }],
          };
        }
        if (modelCalls === 2) {
          return {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "new-write", name: "write", arguments: {} }],
          };
        }
        return { role: "assistant", content: "done" };
      },
    });

    try {
      const created = await request(app).post("/api/sessions");
      const sessionId = (created.body as { id: string }).id;
      const responsePromise = new Promise<{ status: number; text: string }>((resolve, reject) => {
        request(app)
          .post(`/api/sessions/${sessionId}/messages`)
          .field("prompt", "write this")
          .end((error, response) => {
            if (error) reject(error);
            else resolve({ status: response.status, text: response.text });
          });
      });

      let busy = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const session = await request(app).get(`/api/sessions/${sessionId}`);
        busy = Boolean((session.body as { busy?: boolean }).busy);
        if (busy && modelCalls === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(busy, true);
      assert.equal(modelCalls, 1, "the first model call must be active before switching mode");

      const changed = await request(app)
        .put(`/api/sessions/${sessionId}/permission-mode`)
        .send({ mode: "bypass" });
      assert.equal(changed.status, 200);
      assert.deepEqual(changed.body, {
        mode: "bypass",
        previousMode: "plan",
        changed: true,
        interrupted: true,
      });
      releaseModel?.();

      const interrupted = await responsePromise;
      assert.equal(interrupted.status, 200);
      const interruptedEvents = interrupted.text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      const aborted = interruptedEvents.find((event) => event.type === "aborted");
      assert.equal(aborted?.reason, "permission_mode_changed");
      assert.equal(aborted?.previousMode, "plan");
      assert.equal(aborted?.permissionMode, "bypass");
      assert.equal(executions, 0);

      const next = await request(app)
        .post(`/api/sessions/${sessionId}/messages`)
        .field("prompt", "continue");
      assert.equal(next.status, 200);
      assert.match(nextSystemPrompt, /mode=bypass/);
      assert.doesNotMatch(nextSystemPrompt, /mode=plan/);
      assert.equal(executions, 1);

      const restoredApp = createAgentServer({ llm, tools: [], chat: async () => ({ role: "assistant", content: "unused" }), dataDir });
      const restored = await request(restoredApp).get(`/api/sessions/${sessionId}/permission-mode`);
      assert.equal(restored.status, 200);
      assert.equal((restored.body as { mode: string }).mode, "bypass");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("reports only whether DeepWiki is enabled", async () => {
    const app = createAgentServer({
      llm,
      tools: [],
      chat: async () => ({ role: "assistant", content: "ok" }),
            deepWikiEnabled: true,
    });
    const config = await request(app).get("/api/config");
    assert.deepEqual((config.body as { deepWiki: unknown }).deepWiki, { enabled: true });
    assert.doesNotMatch(config.text, /mcp\.deepwiki\.com/);
  });

  it("keeps a multi-turn session and streams safe NDJSON events", async () => {
    let mcpState: "ready" | "reconnecting" = "ready";
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
            mcpStatuses: () => [{
        id: "fixture",
        transport: "stdio",
        required: false,
        state: mcpState,
        toolCount: 2,
      }],
    });

    const config = await request(app).get("/api/config");
    assert.equal(config.status, 200);
    assert.doesNotMatch(config.text, /must-not-leak/);
    assert.equal((config.body as { mcp: { enabled: boolean } }).mcp.enabled, true);
    assert.equal((config.body as { deepWiki: { enabled: boolean } }).deepWiki.enabled, false);
    mcpState = "reconnecting";
    const reconnectingConfig = await request(app).get("/api/config");
    assert.equal((reconnectingConfig.body as { mcp: { enabled: boolean } }).mcp.enabled, false);
    assert.equal(
      (reconnectingConfig.body as { mcp: { servers: Array<{ state: string }> } }).mcp.servers[0]?.state,
      "reconnecting",
    );

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
    const listed = await request(app).get("/api/sessions");
    assert.equal((listed.body as { sessions: Array<{ preview: string }> }).sessions[0]?.preview, "first");

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

  it("supports stable message IDs for fork and rewind while keeping index compatibility", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "mini-agent-server-message-ids-"));
    try {
      const app = createAgentServer({
        llm,
        tools: [],
        dataDir,
        chat: async (_config, messages) => ({
          role: "assistant",
          content: `reply ${messages.filter((message) => message.role === "user").length}`,
        }),
      });
      const created = await request(app).post("/api/sessions");
      const sessionId = (created.body as { id: string }).id;

      await request(app).post(`/api/sessions/${sessionId}/messages`).field("prompt", "first");
      await request(app).post(`/api/sessions/${sessionId}/messages`).field("prompt", "second");

      const history = await request(app).get(`/api/sessions/${sessionId}`);
      const messages = (history.body as { messages: Array<{ id?: string; role: string; content: string }> }).messages;
      assert.equal(messages.every((message) => typeof message.id === "string" && message.id.length > 0), true);
      const firstUser = messages.find((message) => message.role === "user" && message.content === "first");
      const firstAssistant = messages.find((message) => message.role === "assistant" && message.content === "reply 1");
      assert.ok(firstUser?.id);
      assert.ok(firstAssistant?.id);

      const forked = await request(app)
        .post(`/api/sessions/${sessionId}/fork`)
        .send({ messageId: firstAssistant.id });
      assert.equal(forked.status, 201);
      assert.equal((forked.body as { forkedFromMessage: number }).forkedFromMessage, 2);
      assert.equal((forked.body as { forkedFromMessageId: string }).forkedFromMessageId, firstAssistant.id);
      const forkHistory = await request(app).get(`/api/sessions/${(forked.body as { id: string }).id}`);
      assert.deepEqual(
        (forkHistory.body as { messages: Array<{ role: string; content: string }> }).messages.map((message) => message.content),
        ["first", "reply 1"],
      );

      const rewound = await request(app)
        .post(`/api/sessions/${sessionId}/rewind`)
        .send({ messageId: firstUser.id });
      assert.equal(rewound.status, 200);
      assert.equal((rewound.body as { messageId: string }).messageId, firstUser.id);
      const afterRewind = await request(app).get(`/api/sessions/${sessionId}`);
      assert.deepEqual(
        (afterRewind.body as { messages: Array<{ role: string; content: string }> }).messages.map((message) => message.content),
        ["first"],
      );

      const indexedFork = await request(app)
        .post(`/api/sessions/${sessionId}/fork`)
        .send({ messageIndex: 0 });
      assert.equal(indexedFork.status, 201);
      assert.equal((indexedFork.body as { forkedFromMessage: number }).forkedFromMessage, 0);

      const conflict = await request(app)
        .post(`/api/sessions/${sessionId}/rewind`)
        .send({ messageId: firstUser.id, messageIndex: 1 });
      assert.equal(conflict.status, 400);
      assert.match(conflict.text, /mutually exclusive/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("binds todo updates to sessions, persists them, and inherits them on fork", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "mini-agent-server-todos-"));
    const seenToolNames: string[][] = [];
    let chatCalls = 0;
    const chat = async (
      _config: typeof llm,
      _messages: AgentMessage[],
      tools: Tool[] = [],
    ): Promise<AssistantMessage> => {
      seenToolNames.push(tools.map((tool) => tool.name));
      chatCalls += 1;
      if (chatCalls === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "todo-write-1",
            name: "todo_write",
            arguments: {
              todos: [{ id: "inspect", content: "Inspect code", status: "in_progress" }],
            },
          }],
        };
      }
      return { role: "assistant", content: "Todo saved" };
    };

    try {
      const firstApp = createAgentServer({ llm, tools: [], chat, dataDir, permissionMode: "bypass" });
      const created = await request(firstApp).post("/api/sessions");
      const sessionId = (created.body as { id: string }).id;
      const response = await request(firstApp)
        .post(`/api/sessions/${sessionId}/messages`)
        .field("prompt", "inspect the code");

      assert.equal(response.status, 200);
      const events = response.text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; content?: string; name?: string });
      assert.deepEqual(events.map((event) => event.type), [
        "user",
        "assistant",
        "tool_start",
        "tool_end",
        "assistant",
        "done",
      ]);
      assert.equal(events[2]?.name, "todo_write");
      assert.equal(events[4]?.content, "Todo saved");
      assert.ok(seenToolNames[0]?.includes("todo_write"));
      assert.equal(seenToolNames[0]?.includes("caller_tool"), false);

      const session = await request(firstApp).get(`/api/sessions/${sessionId}`);
      assert.equal(session.status, 200);
      assert.deepEqual((session.body as { todos: unknown[] }).todos, [
        { id: "inspect", content: "Inspect code", status: "in_progress" },
      ]);
      assert.equal((session.body as { todoVersion: number }).todoVersion, 1);

      const secondApp = createAgentServer({ llm, tools: [], chat, dataDir, permissionMode: "bypass" });
      const restored = await request(secondApp).get(`/api/sessions/${sessionId}`);
      assert.equal(restored.status, 200);
      assert.deepEqual((restored.body as { todos: unknown[] }).todos, [
        { id: "inspect", content: "Inspect code", status: "in_progress" },
      ]);
      assert.equal((restored.body as { todoVersion: number }).todoVersion, 1);

      const forked = await request(secondApp).post(`/api/sessions/${sessionId}/fork`);
      assert.equal(forked.status, 201);
      const forkId = (forked.body as { id: string }).id;
      const fork = await request(secondApp).get(`/api/sessions/${forkId}`);
      assert.deepEqual((fork.body as { todos: unknown[] }).todos, [
        { id: "inspect", content: "Inspect code", status: "in_progress" },
      ]);
      assert.equal((fork.body as { todoVersion: number }).todoVersion, 1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("applies /think commands on the first request and removes them from session messages", async () => {
    let capturedLevel: string | undefined;
    let capturedUser: string | undefined;
    const reasoningLlm = makeLlmConfig({
      apiKey: "reasoning-key",
      baseUrl: "http://localhost/v1",
      model: "faux",
      reasoning: true,
      thinkingLevel: "medium",
    });
    const app = createAgentServer({
      llm: reasoningLlm,
      tools: [],
      chat: async (config, messages) => {
        capturedLevel = config.thinkingLevel;
        const user = messages.find((message) => message.role === "user");
        capturedUser = user && typeof user.content === "string" ? user.content : undefined;
        return { role: "assistant", content: "done" };
      },
    });

    const created = await request(app).post("/api/sessions");
    const sessionId = (created.body as { id: string }).id;
    const response = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .field("prompt", "/think:high inspect this");

    assert.equal(response.status, 200);
    assert.equal(capturedLevel, "high");
    assert.equal(capturedUser, "inspect this");
    assert.match(response.text, /"type":"user","content":"inspect this"/);

    const history = await request(app).get(`/api/sessions/${sessionId}`);
    const historyMessages = (history.body as { messages: Array<{ role: string; content: string }> }).messages;
    assert.equal(historyMessages.find((message) => message.role === "user")?.content, "inspect this");
    assert.doesNotMatch(history.text, /\/think:high/);
  });

  it("publishes model-specific thinking levels and persists a validated selection", async () => {
    const previousKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    try {
      const deepseekLlm = makeLlmConfig({
        apiKey: "test-deepseek-key",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
      });
      const app = createAgentServer({
        llm: deepseekLlm,
        tools: [],
        chat: async () => ({ role: "assistant" as const, content: "done" }),
      });

      const catalog = await request(app).get("/api/models");
      const deepseek = (catalog.body as { models: Array<{ qualifiedId: string; thinkingLevels: string[] }> }).models
        .find((model) => model.qualifiedId === "deepseek/deepseek-v4-flash");
      assert.deepEqual(deepseek?.thinkingLevels, ["off", "high", "max"]);

      const created = await request(app).post("/api/sessions");
      const sessionId = (created.body as { id: string }).id;
      const selected = await request(app)
        .put(`/api/sessions/${sessionId}/thinking-level`)
        .send({ thinkingLevel: "high" });
      assert.equal(selected.status, 200);
      assert.equal((selected.body as { thinkingLevel: string }).thinkingLevel, "high");

      const unsupported = await request(app)
        .put(`/api/sessions/${sessionId}/thinking-level`)
        .send({ thinkingLevel: "low" });
      assert.equal(unsupported.status, 400);

      const session = await request(app).get(`/api/sessions/${sessionId}`);
      assert.equal((session.body as { thinkingLevel: string }).thinkingLevel, "high");
    } finally {
      if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previousKey;
    }
  });

  it("resolves a dynamic tool provider for each HTTP message", async () => {
    const makeTool = (name: string): Tool => ({
      name,
      description: name,
      parameters: { type: "object" },
      execute: async () => ({ content: name }),
    });
    let catalog = [makeTool("first")];
    const app = createAgentServer({
      llm,
      tools: () => catalog,
      chat: async (_config, _messages, tools = []) => ({
        role: "assistant",
        content: tools.map((tool) => tool.name).join(","),
      }),
          });
    const created = await request(app).post("/api/sessions");
    const sessionId = (created.body as { id: string }).id;
    const first = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .field("prompt", "first");
    assert.match(first.text, /first/);
    catalog = [makeTool("second")];
    const second = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .field("prompt", "second");
    assert.match(second.text, /second/);
    assert.doesNotMatch(second.text, /\bfirst\b/);
  });

  it("restores sessions after the server instance is recreated", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "mini-agent-session-persist-"));
    try {
      const chat = async () => ({ role: "assistant" as const, content: "persisted reply" });
      const firstApp = createAgentServer({ llm, tools: [], chat, dataDir });
      const created = await request(firstApp).post("/api/sessions");
      const sessionId = (created.body as { id: string }).id;
      await request(firstApp)
        .post(`/api/sessions/${sessionId}/messages`)
        .field("prompt", "remember this");

      const secondApp = createAgentServer({ llm, tools: [], chat, dataDir });
      const restored = await request(secondApp).get(`/api/sessions/${sessionId}`);
      assert.equal(restored.status, 200);
      assert.match(restored.text, /remember this/);
      assert.match(restored.text, /persisted reply/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("restores a turn-start prompt when the model fails before replying", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "mini-agent-session-turn-start-"));
    try {
      const firstApp = createAgentServer({
        llm,
        tools: [],
        dataDir,
        chat: async () => {
          throw new Error("provider unavailable");
        },
      });
      const created = await request(firstApp).post("/api/sessions");
      const sessionId = (created.body as { id: string }).id;
      const failed = await request(firstApp)
        .post(`/api/sessions/${sessionId}/messages`)
        .field("prompt", "keep this prompt");

      assert.equal(failed.status, 200);
      assert.match(failed.text, /provider unavailable/);

      const restoredApp = createAgentServer({
        llm,
        tools: [],
        dataDir,
        chat: async () => ({ role: "assistant" as const, content: "unused" }),
      });
      const restored = await request(restoredApp).get(`/api/sessions/${sessionId}`);
      assert.equal(restored.status, 200);
      assert.equal(
        (restored.body as { messages: Array<{ role: string; content: string }> }).messages
          .find((message) => message.role === "user")?.content,
        "keep this prompt",
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects an empty multipart message", async () => {
    const app = createAgentServer({
      llm,
      tools: [],
      chat: async () => ({ role: "assistant", content: "unused" }),
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
      permissionMode: "bypass",
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
