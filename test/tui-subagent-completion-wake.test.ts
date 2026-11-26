/// <reference types="../ink-testing-library.d.ts" />
// App-mount behavior lock for background sub-agent completion wakeups.
//
// The unit suites cover the *decision* (`planSubagentCompletion`) and the
// *router* (`SubagentEventRouter`) in isolation. Neither proves that the
// mounted TUI actually wires a completion into the session the right way:
// queued while a turn is in flight, delivered straight away when idle.
//
// This test drives a real `SubagentTaskRegistry` completion through the
// mounted `App` and asserts the observable outcome (a queued prompt that
// drains, or an immediate submit) instead of inspecting internals. It
// exercises the registry-poller wake path in `useBackgroundWakeups`, which is
// unchanged across the subagent-routing refactor, so the same file passes on
// both the pre-refactor and post-refactor commits — that equivalence is the
// point: it shows the refactor did not alter the user-visible behavior.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import React from "react";
import { App } from "../src/tui/App.tsx";
import { SubagentTaskRegistry } from "../src/subagent/task-registry.ts";

let render: typeof import("ink-testing-library").render | undefined;
try {
  ({ render } = await import("ink-testing-library"));
} catch (error: unknown) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "MODULE_NOT_FOUND") throw error;
}

const waitForRender = () => new Promise<void>((resolve) => setTimeout(resolve, 40));

type RequestBody = { messages?: Array<{ role: string; content?: string }> };

function sse(content: string): Response {
  return new Response([
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
    "data: [DONE]",
    "",
  ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
}

function userTexts(request: RequestBody): string[] {
  return (request.messages ?? []).filter((message) => message.role === "user").map((message) => message.content ?? "");
}

function hasCompletionPrompt(requests: RequestBody[]): boolean {
  return requests.some((request) => userTexts(request).some((text) => text.includes("Background sub-agent")));
}

describe("TUI background sub-agent completion wake (mounted app)", () => {
  let cwd: string;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "mini-agent-wake-mount-"));
    process.env.AGENT_DATA_DIR = cwd;
    process.env.MINI_AGENT_WORKTREE_DIR = path.join(cwd, "worktrees");
    process.env.MINI_AGENT_UPDATE_CHECK = "0";
    process.env.OPENAI_MODEL = "todo-test-model";
    process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
    process.env.OPENAI_API_KEY = "not-a-real-key";
    process.env.MINI_AGENT_MODEL_CONFIG = path.join(cwd, "models.json");
    process.env.MINI_AGENT_AUTO_SUBAGENT = "0";
    process.env.MINI_AGENT_AUTO_WAKE = "1";
    process.env.MINI_AGENT_TUI_LAYOUT = "alternate";
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(cwd, { recursive: true, force: true });
    for (const name of [
      "AGENT_DATA_DIR", "MINI_AGENT_WORKTREE_DIR", "MINI_AGENT_UPDATE_CHECK",
      "OPENAI_MODEL", "OPENAI_API_KEY", "MINI_AGENT_MODEL_CONFIG",
      "MINI_AGENT_AUTO_SUBAGENT", "MINI_AGENT_AUTO_WAKE", "MINI_AGENT_TUI_LAYOUT",
      "OPENAI_BASE_URL",
    ]) {
      delete process.env[name];
    }
  });

  function mount(sessionId: string) {
    return render!(React.createElement(App, {
      cwd,
      agentTools: [],
      allTools: [],
      worktreeIsolation: false,
      layoutMode: "alternate",
      startupSessionRequest: { sessionId, resume: false, continueSession: false, fork: false },
    }));
  }

  function backgroundRecord(taskId: string, sessionId: string, status: "running" | "completed") {
    const now = new Date().toISOString();
    return {
      taskId,
      ownerSessionId: sessionId,
      task: "detached background work",
      args: { task: "detached background work", runInBackground: true },
      status,
      runInBackground: true,
      createdAt: now,
      startedAt: now,
      ...(status === "completed" ? { result: "background result marker" } : {}),
      killed: false,
      blockWaited: false,
      completionConsumed: false,
      wakeDelivered: false,
    };
  }

  it("delivers the completion prompt immediately when the session is idle", async () => {
    const sessionId = "wake-mount-idle";
    const taskId = "sub_aaaaaaaa-1111-4111-8111-111111111111";
    const registry = new SubagentTaskRegistry(cwd);
    await registry.start(backgroundRecord(taskId, sessionId, "completed"));

    const requests: RequestBody[] = [];
    globalThis.fetch = (async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as RequestBody);
      return sse("idle-wake-reviewed");
    }) as typeof fetch;

    const view = mount(sessionId);
    try {
      for (let attempt = 0; attempt < 120 && !(view.lastFrame() ?? "").includes("idle-wake-reviewed"); attempt += 1) {
        await waitForRender();
      }
      assert.match(view.lastFrame() ?? "", /idle-wake-reviewed/);
      assert.ok(hasCompletionPrompt(requests), "the idle session should submit the completion prompt");
    } finally {
      view.cleanup();
    }
  });

  it("queues the completion prompt while a turn is in flight, then drains it", async () => {
    const sessionId = "wake-mount-busy";
    const taskId = "sub_bbbbbbbb-2222-4222-8222-222222222222";
    const registry = new SubagentTaskRegistry(cwd);
    await registry.start(backgroundRecord(taskId, sessionId, "running"));

    let releaseHeld!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => { releaseHeld = resolve; });
    const requests: RequestBody[] = [];
    globalThis.fetch = (async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as RequestBody;
      requests.push(request);
      const texts = userTexts(request);
      if (texts.some((text) => text.includes("Background sub-agent"))) return sse("drained-wake-reviewed");
      if (texts.some((text) => text.includes("Hold the turn open"))) return held;
      throw new Error(`unexpected request in busy-wake test: ${JSON.stringify(texts)}`);
    }) as typeof fetch;

    const view = mount(sessionId);
    try {
      // Start a turn whose stream never closes, so the session stays busy.
      await waitForRender();
      view.stdin.write("Hold the turn open");
      await waitForRender();
      view.stdin.write("\r");
      for (let attempt = 0; attempt < 60 && requests.length === 0; attempt += 1) await waitForRender();
      assert.ok(requests.length > 0, "the held turn should reach the model");

      // Finish the background task while the turn is still in flight.
      await registry.finish(taskId, {
        status: "completed",
        result: "background result marker",
        isError: false,
        messages: [],
        runtime: undefined,
      });

      // The completion must be parked in the queue, not submitted mid-turn.
      for (let attempt = 0; attempt < 120 && !(view.lastFrame() ?? "").includes("Queue 1"); attempt += 1) {
        await waitForRender();
      }
      assert.match(view.lastFrame() ?? "", /Queue 1/, "a busy session should queue the completion prompt");
      assert.equal(hasCompletionPrompt(requests), false, "no completion prompt while the turn is in flight");

      // Releasing the turn lets the queue drain and submit the prompt.
      releaseHeld(sse("held-turn-finished"));
      for (let attempt = 0; attempt < 120 && !(view.lastFrame() ?? "").includes("drained-wake-reviewed"); attempt += 1) {
        await waitForRender();
      }
      assert.match(view.lastFrame() ?? "", /drained-wake-reviewed/);
      assert.ok(hasCompletionPrompt(requests), "the queued completion prompt should submit after the turn ends");
    } finally {
      releaseHeld(sse("cleanup"));
      view.cleanup();
    }
  });
});
