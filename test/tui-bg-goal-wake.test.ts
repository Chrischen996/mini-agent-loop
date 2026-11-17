/// <reference types="../ink-testing-library.d.ts" />
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

describe("TUI background goal completion wake", () => {
  let cwd: string;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "mini-agent-bg-goal-"));
    process.env.AGENT_DATA_DIR = cwd;
    process.env.MINI_AGENT_WORKTREE_DIR = path.join(cwd, "worktrees");
    process.env.MINI_AGENT_UPDATE_CHECK = "0";
    process.env.OPENAI_MODEL = "todo-test-model";
    process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
    process.env.OPENAI_API_KEY = "not-a-real-key";
    process.env.MINI_AGENT_MODEL_CONFIG = path.join(cwd, "models.json");
    process.env.MINI_AGENT_AUTO_SUBAGENT = "0";
    process.env.MINI_AGENT_AUTO_WAKE = "1";
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(cwd, { recursive: true, force: true });
    for (const name of ["AGENT_DATA_DIR", "MINI_AGENT_WORKTREE_DIR", "MINI_AGENT_UPDATE_CHECK", "OPENAI_MODEL", "OPENAI_API_KEY", "MINI_AGENT_MODEL_CONFIG", "MINI_AGENT_AUTO_SUBAGENT", "MINI_AGENT_AUTO_WAKE", "OPENAI_BASE_URL"]) {
      delete process.env[name];
    }
  });

  for (const finishBeforeMount of [true, false]) {
    it(`wakes the owner session when a detached goal worker finishes (prefinished=${finishBeforeMount})`, async () => {
    const sessionId = "bg-goal-owner";
    const taskId = "sub_33333333-3333-4333-8333-333333333333";
    const registry = new SubagentTaskRegistry(cwd);
    const record = {
      taskId,
      ownerSessionId: sessionId,
      task: "refactor in background",
      args: { task: "refactor in background", runInBackground: true },
      status: finishBeforeMount ? "completed" as const : "running" as const,
      runInBackground: true,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      ...(finishBeforeMount ? { result: "goal-worker completed marker" } : {}),
      killed: false,
      blockWaited: false,
      completionConsumed: false,
      wakeDelivered: false,
    };
    await registry.start(record);

    const requests: Array<{ messages?: Array<{ role: string; content?: string }> }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content?: string }> };
      requests.push(request);
      return new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "goal-worker-wake-reviewed" }, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
        "data: [DONE]",
        "",
      ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const view = render!(React.createElement(App, {
      cwd,
      agentTools: [],
      allTools: [],
      worktreeIsolation: false,
      startupSessionRequest: { sessionId, resume: false, continueSession: false, fork: false },
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    if (!finishBeforeMount) {
      await registry.finish(taskId, {
        status: "completed",
        result: "goal-worker completed marker",
        isError: false,
        messages: [],
      });
    }
    try {
      for (let attempt = 0; attempt < 100 && !(view.lastFrame() ?? "").includes("goal-worker-wake-reviewed"); attempt += 1) {
        await waitForRender();
      }
      assert.match(view.lastFrame() ?? "", /goal-worker-wake-reviewed/);
      assert.ok(requests.some((request) =>
        request.messages?.some((message) =>
          message.role === "user" && message.content?.includes("goal-worker completed marker"))),
      );
    } finally {
      view.cleanup();
    }
    });
  }
});
