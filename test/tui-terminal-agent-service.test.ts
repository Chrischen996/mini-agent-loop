import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmConfig } from "../src/llm/index.ts";
import { PermissionManager, type PermissionRequest, type PermissionTurnContext } from "../src/permissions.ts";
import { createInitialState, createTuiStore } from "../src/tui/state.ts";
import { TerminalAgentService } from "../src/tui/terminal-agent-service.ts";

function testLlm(): LlmConfig {
  return {
    apiKey: "test",
    provider: "test",
    baseUrl: "http://localhost",
    model: "test-model",
    capabilities: { input: ["text"], tools: false },
    contextWindow: 4096,
    maxTokens: 256,
    reasoning: false,
    imagePolicy: "strip",
    toolCallFormat: "openai",
  };
}

class RecordingPermissionManager extends PermissionManager {
  readonly sessionIds: string[] = [];

  override beginTurn(
    sessionId: string,
    onRequest: (request: PermissionRequest) => void,
    externalSignal?: AbortSignal,
  ): PermissionTurnContext {
    this.sessionIds.push(sessionId);
    return super.beginTurn(sessionId, onRequest, externalSignal);
  }
}

describe("terminal agent service", () => {
  it("resolves the permission namespace from the active session", async () => {
    const store = createTuiStore(createInitialState("test-model"));
    const permissionManager = new RecordingPermissionManager("bypass");
    let activeSessionId = "session-one";
    const service = new TerminalAgentService({
      store,
      llm: testLlm(),
      tools: [],
      permissionManager,
      getPermissionSessionId: () => activeSessionId,
      chat: async () => ({ role: "assistant", content: "answer" }),
    });

    await service.submit("first");
    activeSessionId = "session-two";
    await service.submit("second");

    assert.deepEqual(permissionManager.sessionIds, ["session-one", "session-two"]);
  });

  it("persists the prompt before invoking the model", async () => {
    const store = createTuiStore(createInitialState("test-model"));
    const phases: string[] = [];
    const service = new TerminalAgentService({
      store,
      llm: testLlm(),
      tools: [],
      permissionManager: new PermissionManager("bypass"),
      permissionSessionId: "start-hook-session",
      onTurnStarted: ({ history }) => {
        phases.push(history.at(-1)?.role ?? "missing");
      },
      chat: async () => {
        phases.push("model");
        return { role: "assistant", content: "answer" };
      },
    });

    await service.submit("hello");

    assert.deepEqual(phases, ["user", "model"]);
  });

  it("waits for an aborted turn to finish persistence hooks", async () => {
    const store = createTuiStore(createInitialState("test-model"));
    let releaseChat!: () => void;
    const chatStarted = new Promise<void>((resolve) => {
      releaseChat = resolve;
    });
    let finalized = false;
    const service = new TerminalAgentService({
      store,
      llm: testLlm(),
      tools: [],
      permissionManager: new PermissionManager("bypass"),
      permissionSessionId: "shutdown-session",
      chat: async () => {
        await chatStarted;
        throw new Error("cancelled");
      },
      onTurnFinished: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        finalized = true;
      },
    });

    const turn = service.submit("hello");
    await new Promise((resolve) => setTimeout(resolve, 0));
    service.abort();
    const idle = service.waitForIdle();
    releaseChat();
    await idle;

    assert.equal(finalized, true);
    await turn;
  });

  it("keeps one loop history while projecting events into the store", async () => {
    const store = createTuiStore(createInitialState("test-model"));
    const service = new TerminalAgentService({
      store,
      llm: testLlm(),
      tools: [],
      permissionManager: new PermissionManager("bypass"),
      permissionSessionId: "test-session",
      chat: async () => ({ role: "assistant", content: "answer" }),
    });

    await service.submit("hello");

    const state = store.getState();
    assert.equal(state.messages.filter((message) => message.kind === "user").length, 1);
    assert.equal(state.messages.filter((message) => message.kind === "assistant").length, 1);
    const assistant = state.messages.find((message) => message.kind === "assistant");
    assert.equal(assistant?.kind, "assistant");
    assert.equal(assistant?.text, "answer");
    assert.equal(state.busy, false);
    assert.equal(service.getHistory().filter((message) => message.role === "user").length, 1);
    assert.equal(service.getHistory().filter((message) => message.role === "assistant").length, 1);
  });

  it("keeps tool calls and results on the same loop history", async () => {
    const store = createTuiStore(createInitialState("test-model"));
    let responses = 0;
    const call = { id: "call-1", name: "echo", arguments: { value: "ok" } };
    const service = new TerminalAgentService({
      store,
      llm: testLlm(),
      tools: [{
        name: "echo",
        description: "echo",
        parameters: { type: "object" },
        execute: async () => ({ content: "tool result" }),
      }],
      permissionManager: new PermissionManager("bypass"),
      permissionSessionId: "test-session",
      chat: async () => responses++ === 0
        ? { role: "assistant", content: "", toolCalls: [call] }
        : { role: "assistant", content: "final answer" },
    });

    await service.submit("run tool");

    const stateTool = store.getState().messages.find((message) => message.kind === "tool_call");
    assert.equal(stateTool?.kind, "tool_call");
    assert.equal(stateTool?.result, "tool result");
    assert.equal(service.getHistory().filter((message) => message.role === "tool").length, 1);
    assert.equal(service.getHistory().filter((message) => message.role === "assistant").length, 2);
  });

  it("blocks on approval and resumes after the permission panel decision", async () => {
    const store = createTuiStore(createInitialState("test-model"));
    let responses = 0;
    const service = new TerminalAgentService({
      store,
      llm: testLlm(),
      tools: [{
        name: "write",
        description: "write",
        parameters: { type: "object" },
        execute: async () => ({ content: "written" }),
      }],
      permissionManager: new PermissionManager("approval"),
      permissionSessionId: "approval-session",
      chat: async () => responses++ === 0
        ? { role: "assistant", content: "", toolCalls: [{ id: "write-1", name: "write", arguments: { path: "a" } }] }
        : { role: "assistant", content: "finished" },
    });

    const turn = service.submit("write file");
    for (let attempt = 0; attempt < 50 && !store.getState().pendingPermission; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const pending = store.getState().pendingPermission;
    assert.equal(pending?.tool, "write");
    assert.equal(service.resolvePermission("allow"), true);
    const result = await turn;
    assert.equal(result.succeeded, true);
    assert.equal(store.getState().messages.find((message) => message.kind === "tool_call")?.status, "done");
  });

  it("drains prompts submitted while a turn is running", async () => {
    const store = createTuiStore(createInitialState("test-model"));
    let calls = 0;
    const service = new TerminalAgentService({
      store,
      llm: testLlm(),
      tools: [],
      permissionManager: new PermissionManager("bypass"),
      permissionSessionId: "queue-session",
      chat: async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5);
        });
        calls++;
        return { role: "assistant", content: `answer-${calls}` };
      },
    });
    const first = service.submit("first");
    const second = service.submit("second");
    assert.equal((await first).succeeded, true);
    assert.equal((await second).succeeded, true);
    assert.deepEqual(
      store.getState().messages.filter((message) => message.kind === "user").map((message) => message.text),
      ["first", "second"],
    );
  });

  it("records direct tool turns for the same persistence hook", async () => {
    const store = createTuiStore(createInitialState("test-model"));
    const snapshots: string[][] = [];
    const service = new TerminalAgentService({
      store,
      llm: testLlm(),
      tools: [],
      permissionManager: new PermissionManager("bypass"),
      permissionSessionId: "direct-session",
      onTurnFinished: ({ history }) => {
        snapshots.push(history.map((message) => message.role));
      },
    });

    const result = await service.recordDirectToolTurn(
      "/read src/index.ts",
      { id: "direct-1", name: "read", arguments: { path: "src/index.ts" } },
      { content: "file contents" },
    );

    assert.equal(result.succeeded, true);
    assert.deepEqual(snapshots, [["system", "user", "assistant", "tool"]]);
    assert.equal(service.getHistory().at(-1)?.role, "tool");
  });

  it("prepares @file references and image attachments in one user content", async () => {
    const root = await mkdtemp(join(tmpdir(), "mini-agent-terminal-content-"));
    const imagePath = join(root, "pixel.png");
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    await writeFile(imagePath, image);
    let seenUserContent: unknown;
    try {
      const store = createTuiStore(createInitialState("test-model"));
      const service = new TerminalAgentService({
        store,
        llm: testLlm(),
        tools: [{
          name: "read",
          description: "read",
          parameters: { type: "object" },
          execute: async () => ({ content: "referenced file" }),
        }],
        permissionManager: new PermissionManager("bypass"),
        permissionSessionId: "content-session",
        chat: async (_config, messages) => {
          seenUserContent = messages.at(-1)?.content;
          return { role: "assistant", content: "received" };
        },
      });

      await service.submit("inspect @notes.txt", {
        images: [{ path: imagePath, mimeType: "image/png", size: image.byteLength }],
      });

      assert.ok(Array.isArray(seenUserContent));
      const parts = seenUserContent as Array<{ type: string; text?: string }>;
      assert.equal(parts.some((part) => part.type === "image"), true);
      assert.equal(parts.some((part) => part.type === "text" && part.text?.includes("referenced file")), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
