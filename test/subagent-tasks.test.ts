import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createSubagentBatchTool, createSubagentTaskTools, createSubagentTool, SubagentTaskRegistry } from "../src/subagent/index.ts";
import type { SubagentTaskRecord } from "../src/subagent/task-registry.ts";
import { contentAsString } from "../src/content.ts";
import { makeLlmConfig, type ChatFn } from "../src/llm/index.ts";
import type { AgentMessage, AssistantMessage } from "../src/types.ts";

const llm = makeLlmConfig({ apiKey: "test-key", baseUrl: "http://localhost/v1", model: "faux" });

function makeRecord(taskId: string, ownerSessionId = "session-a"): SubagentTaskRecord {
  const now = new Date().toISOString();
  return {
    taskId,
    ownerSessionId,
    task: "inspect the project",
    args: { task: "inspect the project" },
    status: "running",
    runInBackground: true,
    createdAt: now,
    startedAt: now,
    killed: false,
    blockWaited: false,
    completionConsumed: false,
    wakeDelivered: false,
  };
}

function taskIdFrom(content: string): string {
  const match = content.match(/sub_[a-f0-9-]{36}/i);
  assert.ok(match, `expected a sub-agent task id in: ${content}`);
  return match[0]!;
}

describe("sub-agent background task lifecycle", () => {
  it("starts in the background by default and supports wait/output with consumed completion suppression", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mini-agent-subagents-"));
    try {
      const registry = new SubagentTaskRegistry(workspace);
      const chat: ChatFn = async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { role: "assistant", content: "background answer" } satisfies AssistantMessage;
      };
      const tool = createSubagentTool({ parentLlm: llm, parentTools: [], taskRegistry: registry, chat });
      const started = await tool.execute({ task: "research something" }, undefined, { sessionId: "session-a" });
      const id = taskIdFrom(contentAsString(started.content));
      assert.match(contentAsString(started.content), /Started sub-agent task/);

      const waited = await registry.wait([id], "all", 2_000, undefined, "session-a");
      assert.equal(waited.timedOut, false);
      assert.equal(waited.completed[0]?.status, "completed");
      assert.equal(waited.completed[0]?.result, "background answer");
      assert.equal(await registry.claimAutoWake(id, "session-a", true, false), false);

      const outputTool = (await import("../src/subagent/index.ts")).createSubagentTaskTools(registry)
        .find((candidate) => candidate.name === "subagent_output")!;
      const output = await outputTool.execute({ taskIds: [id] }, undefined, { sessionId: "session-a" });
      assert.match(contentAsString(output.content), /background answer/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("hands CLI-style background tasks to the launcher without running them in the parent", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mini-agent-subagent-launch-"));
    try {
      const registry = new SubagentTaskRegistry(workspace);
      let launchedTaskId: string | undefined;
      const tool = createSubagentTool({
        parentLlm: llm,
        parentTools: [],
        taskRegistry: registry,
        launchBackgroundTask: async ({ taskId }) => {
          launchedTaskId = taskId;
          await registry.setWorkerPid(taskId, process.pid);
        },
        chat: async () => {
          throw new Error("background work must run in the detached worker");
        },
      });
      const started = await tool.execute({ task: "run outside the parent" }, undefined, { sessionId: "session-a" });
      const id = taskIdFrom(contentAsString(started.content));
      const record = await registry.get(id, "session-a");
      assert.equal(launchedTaskId, id);
      assert.equal(record?.status, "queued");
      assert.equal(record?.workerPid, process.pid);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("submits CLI batches to a detached worker by default", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mini-agent-subagent-batch-launch-"));
    try {
      const registry = new SubagentTaskRegistry(workspace);
      let launchedJob: string | undefined;
      const tool = createSubagentBatchTool({
        parentLlm: llm,
        parentTools: [],
        taskRegistry: registry,
        launchAsyncBatch: async ({ jobId }) => { launchedJob = jobId; },
      });
      const result = await tool.execute({ tasks: [{ label: "scan", task: "scan the workspace" }] }, undefined, { sessionId: "session-a" });
      const submitted = JSON.parse(contentAsString(result.content)) as { jobId: string; status: string };

      assert.equal(result.isError, undefined);
      assert.equal(submitted.status, "running");
      assert.equal(launchedJob, submitted.jobId);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("refreshes completion written by an independent worker registry", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mini-agent-subagent-cross-process-"));
    try {
      const parentRegistry = new SubagentTaskRegistry(workspace);
      const task = makeRecord("sub_30000000-0000-4000-8000-000000000001");
      task.status = "queued";
      await parentRegistry.start(task);
      await parentRegistry.setWorkerPid(task.taskId, process.pid);
      await parentRegistry.detach(task.taskId);

      const workerRegistry = new SubagentTaskRegistry(workspace);
      assert.equal((await workerRegistry.get(task.taskId, "session-a"))?.status, "queued");
      await workerRegistry.finish(task.taskId, {
        status: "completed",
        result: "written by another registry",
        isError: false,
        messages: [{ role: "assistant", content: "written by another registry" }],
        runtime: undefined,
      });

      const refreshed = await parentRegistry.get(task.taskId, "session-a");
      assert.equal(refreshed?.status, "completed");
      assert.equal(refreshed?.result, "written by another registry");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("delivers queued input messages across registries only while the task is active", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mini-agent-subagent-input-"));
    try {
      const parentRegistry = new SubagentTaskRegistry(workspace);
      const task = makeRecord("sub_12000000-0000-4000-8000-000000000001");
      await parentRegistry.start(task);

      const sendTool = createSubagentTaskTools(parentRegistry).find((tool) => tool.name === "subagent_send")!;
      const sent = await sendTool.execute({ taskId: task.taskId, message: "Check the boundary case." }, undefined, { sessionId: "session-a" });
      assert.equal(sent.isError, undefined);
      assert.equal(await parentRegistry.sendInputMessage(task.taskId, "wrong owner", "session-b"), false);

      const workerRegistry = new SubagentTaskRegistry(workspace);
      assert.deepEqual(await workerRegistry.takeInputMessages(task.taskId), ["Check the boundary case."]);
      assert.deepEqual(await parentRegistry.takeInputMessages(task.taskId), []);

      await parentRegistry.finish(task.taskId, { status: "completed", result: "done", isError: false, messages: [], runtime: undefined });
      assert.equal(await workerRegistry.sendInputMessage(task.taskId, "too late", "session-a"), false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("serializes token accounting across independent worker registries", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mini-agent-subagent-budget-"));
    try {
      const first = new SubagentTaskRegistry(workspace);
      const second = new SubagentTaskRegistry(workspace);
      const budgetId = "32000000-0000-4000-8000-000000000001";
      const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
        (index % 2 ? first : second).consumeGlobalTokens(budgetId, 5)));

      assert.equal(await first.readGlobalTokenUsage(budgetId), 100);
      assert.equal(Math.max(...results), 100);
      assert.equal(await first.reserveGlobalCalls(budgetId, 2, 3), 2);
      assert.equal(await second.reserveGlobalCalls(budgetId, 2, 3), undefined);
      assert.equal(await second.readGlobalCallUsage(budgetId), 2);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("shares concurrency slots across independent worker registries", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mini-agent-subagent-semaphore-"));
    try {
      const first = new SubagentTaskRegistry(workspace);
      const second = new SubagentTaskRegistry(workspace);
      const scope = "33000000-0000-4000-8000-000000000001";
      await first.acquireGlobalConcurrencySlot(scope, "task-a", 1);
      let acquired = false;
      const waiting = second.acquireGlobalConcurrencySlot(scope, "task-b", 1).then(() => { acquired = true; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(acquired, false);
      await first.releaseGlobalConcurrencySlot(scope, "task-a");
      await waiting;
      assert.equal(acquired, true);
      await second.releaseGlobalConcurrencySlot(scope, "task-b");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps completion wake eligible after a wait timeout", async () => {
    const registry = new SubagentTaskRegistry();
    const task = makeRecord("sub_10000000-0000-4000-8000-000000000001");
    await registry.start(task);
    const timed = await registry.wait([task.taskId], "all", 5, undefined, "session-a");
    assert.equal(timed.timedOut, true);
    await registry.finish(task.taskId, {
      status: "completed",
      result: "finished after timeout",
      isError: false,
      partial: false,
      messages: [{ role: "assistant", content: "finished after timeout" }],
      runtime: undefined,
    });
    assert.equal(await registry.claimAutoWake(task.taskId, "session-a", true, false), true);
  });

  it("clears wait suppression when the parent aborts its wait", async () => {
    const registry = new SubagentTaskRegistry();
    const task = makeRecord("sub_15000000-0000-4000-8000-000000000001");
    await registry.start(task);
    const controller = new AbortController();
    const waiting = registry.wait([task.taskId], "all", 2_000, controller.signal, "session-a");
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort("send_now");
    await assert.rejects(waiting, { name: "AbortError" });
    await registry.finish(task.taskId, {
      status: "completed",
      result: "finished after parent moved on",
      isError: false,
      messages: [],
      runtime: undefined,
    });
    assert.equal(await registry.claimAutoWake(task.taskId, "session-a", true, false), true);
  });

  it("suppresses wake for killed, disabled, goal-active, and duplicate completions", async () => {
    const registry = new SubagentTaskRegistry();
    const completed = makeRecord("sub_20000000-0000-4000-8000-000000000001");
    await registry.start(completed);
    await registry.finish(completed.taskId, { status: "completed", result: "ok", isError: false, messages: [], runtime: undefined });
    assert.equal(await registry.claimAutoWake(completed.taskId, "session-a", true, true), false);

    const disabled = makeRecord("sub_20000000-0000-4000-8000-000000000002");
    await registry.start(disabled);
    await registry.finish(disabled.taskId, { status: "completed", result: "ok", isError: false, messages: [], runtime: undefined });
    assert.equal(await registry.claimAutoWake(disabled.taskId, "session-a", false, false), false);

    const killed = makeRecord("sub_20000000-0000-4000-8000-000000000003");
    const controller = new AbortController();
    await registry.start(killed, controller);
    await registry.kill(killed.taskId, "session-a");
    assert.equal(controller.signal.aborted, true);
    await registry.finish(killed.taskId, { status: "completed", result: "stopped", isError: true, messages: [], runtime: undefined });
    assert.equal((await registry.get(killed.taskId, "session-a"))?.status, "cancelled");
    assert.equal(await registry.claimAutoWake(killed.taskId, "session-a", true, false), false);

    const once = makeRecord("sub_20000000-0000-4000-8000-000000000004");
    await registry.start(once);
    await registry.finish(once.taskId, { status: "completed", result: "ok", isError: false, messages: [], runtime: undefined });
    assert.equal(await registry.claimAutoWake(once.taskId, "session-a", true, false), true);
    assert.equal(await registry.claimAutoWake(once.taskId, "session-a", true, false), false);
  });

  it("reconstructs queued but not yet delivered completion wakes after restart", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mini-agent-subagent-wake-"));
    try {
      const firstRegistry = new SubagentTaskRegistry(workspace);
      const task = makeRecord("sub_25000000-0000-4000-8000-000000000001");
      await firstRegistry.start(task);
      await firstRegistry.finish(task.taskId, { status: "completed", result: "result", isError: false, messages: [], runtime: undefined });
      assert.equal(await firstRegistry.claimAutoWake(task.taskId, "session-a", true, false), true);
      assert.deepEqual(await firstRegistry.pendingWakeups("session-a"), []);

      const restartedRegistry = new SubagentTaskRegistry(workspace);
      const recovered = await restartedRegistry.pendingWakeups("session-a");
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0]?.taskId, task.taskId);
      assert.equal(await restartedRegistry.claimAutoWake(task.taskId, "session-a", true, false), true);
      await restartedRegistry.markAutoWakeDelivered(task.taskId, "session-a");
      assert.deepEqual(await restartedRegistry.pendingWakeups("session-a"), []);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rechecks wake suppression after restart and rejects a wake consumed while queued", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mini-agent-subagent-wake-policy-"));
    try {
      const firstRegistry = new SubagentTaskRegistry(workspace);
      const task = makeRecord("sub_27000000-0000-4000-8000-000000000001");
      await firstRegistry.start(task);
      await firstRegistry.finish(task.taskId, { status: "completed", result: "result", isError: false, messages: [], runtime: undefined });
      assert.equal(await firstRegistry.claimAutoWake(task.taskId, "session-a", true, false), true);

      const restartedRegistry = new SubagentTaskRegistry(workspace);
      assert.equal(await restartedRegistry.claimAutoWake(task.taskId, "session-a", false, false), false);
      assert.equal(await restartedRegistry.markAutoWakeDelivered(task.taskId, "session-a"), false);
      assert.equal((await restartedRegistry.get(task.taskId, "session-a"))?.wakeSuppressed, "disabled");

      const readRegistry = new SubagentTaskRegistry();
      const readTask = makeRecord("sub_27000000-0000-4000-8000-000000000002");
      await readRegistry.start(readTask);
      await readRegistry.finish(readTask.taskId, { status: "completed", result: "read first", isError: false, messages: [], runtime: undefined });
      assert.equal(await readRegistry.claimAutoWake(readTask.taskId, "session-a", true, false), true);
      await readRegistry.readOutput(readTask.taskId, "session-a");
      assert.equal(await readRegistry.markAutoWakeDelivered(readTask.taskId, "session-a"), false);
      assert.equal((await readRegistry.get(readTask.taskId, "session-a"))?.completionConsumed, true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("releases a claimed wake when its delivery job cannot start", async () => {
    const registry = new SubagentTaskRegistry();
    const task = makeRecord("sub_28000000-0000-4000-8000-000000000001");
    await registry.start(task);
    await registry.finish(task.taskId, { status: "completed", result: "retry wake", isError: false, messages: [], runtime: undefined });
    assert.equal(await registry.claimAutoWake(task.taskId, "session-a", true, false), true);
    assert.equal(await registry.markAutoWakeDelivered(task.taskId, "session-a"), true);
    await registry.releaseAutoWake(task.taskId, "session-a");
    assert.equal((await registry.pendingWakeups("session-a")).length, 1);
  });

  it("auto-backgrounds a foreground sub-agent after the configured await budget", async () => {
    const registry = new SubagentTaskRegistry();
    const events: string[] = [];
    let releaseChild!: () => void;
    const childResult = new Promise<void>((resolve) => { releaseChild = resolve; });
    const chat: ChatFn = async () => {
      await childResult;
      return { role: "assistant", content: "finished after backgrounding" } satisfies AssistantMessage;
    };
    const tool = createSubagentTool({
      parentLlm: llm,
      parentTools: [],
      taskRegistry: registry,
      chat,
      subagentAwaitBudgetMs: 5,
      onSubagentEvent: (event) => events.push(event.type),
    });

    const started = await tool.execute({ task: "slow focused work", runInBackground: false }, undefined, { sessionId: "session-a" });
    const id = taskIdFrom(contentAsString(started.content));
    assert.match(contentAsString(started.content), /continues in the background/);
    assert.equal((await registry.get(id, "session-a"))?.runInBackground, true);
    assert.equal((await registry.get(id, "session-a"))?.status, "running");
    assert.ok(events.includes("subagent_backgrounded"));

    releaseChild();
    const completed = await registry.wait([id], "all", 2_000, undefined, "session-a");
    assert.equal(completed.completed[0]?.result, "finished after backgrounding");
  });

  it("recovers interrupted tasks and resumes a completed transcript under the same ID", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mini-agent-subagent-resume-"));
    try {
      const firstRegistry = new SubagentTaskRegistry(workspace);
      const first = makeRecord("sub_30000000-0000-4000-8000-000000000001");
      const checkpoint: AgentMessage[] = [
        { role: "system", content: "You are a focused sub-agent." },
        { role: "user", content: "inspect the project" },
        { role: "assistant", content: "Initial findings." },
      ];
      await firstRegistry.start(first);
      first.processPid = 2_147_483_647;
      await firstRegistry.checkpoint(first.taskId, checkpoint);

      const recoveredRegistry = new SubagentTaskRegistry(workspace);
      const interrupted = await recoveredRegistry.get(first.taskId, "session-a");
      assert.equal(interrupted?.status, "interrupted");
      assert.deepEqual(interrupted?.messages, checkpoint);

      await recoveredRegistry.finish(first.taskId, {
        status: "completed",
        result: "Initial findings.",
        isError: false,
        messages: checkpoint,
        runtime: undefined,
      });
      let chatMessages: AgentMessage[] = [];
      const chat: ChatFn = async (_config, messages) => {
        chatMessages = structuredClone(messages);
        return { role: "assistant", content: "Continued findings." } satisfies AssistantMessage;
      };
      const tool = createSubagentTool({ parentLlm: llm, parentTools: [], taskRegistry: recoveredRegistry, chat });
      const resumed = await tool.execute(
        { task: "check the latest change", resumeFrom: first.taskId, runInBackground: false },
        undefined,
        { sessionId: "session-a" },
      );
      assert.equal(contentAsString(resumed.content), "Continued findings.");
      assert.ok(chatMessages.some((message) => message.role === "assistant" && message.content === "Initial findings."));
      assert.ok(chatMessages.some((message) => message.role === "user" && message.content === "check the latest change"));
      const final = await recoveredRegistry.get(first.taskId, "session-a");
      assert.equal(final?.status, "completed");
      assert.ok(final?.messages?.some((message) => message.role === "assistant" && message.content === "Continued findings."));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("claims an interrupted background task once for automatic restart", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mini-agent-subagent-restart-"));
    try {
      const first = new SubagentTaskRegistry(workspace);
      const task = makeRecord("sub_34000000-0000-4000-8000-000000000001");
      task.status = "interrupted";
      task.messages = [{ role: "assistant", content: "checkpoint" }];
      task.workerOptions = { mode: "bypass", tools: ["read"] };
      await first.start(task);

      const restarted = new SubagentTaskRegistry(workspace);
      const claim = await restarted.claimInterruptedForRestart(task.taskId, "session-a");
      assert.equal(claim?.status, "queued");
      assert.deepEqual(claim?.messages, task.messages);
      assert.deepEqual(claim?.workerOptions, task.workerOptions);
      assert.equal(await first.claimInterruptedForRestart(task.taskId, "session-a"), undefined);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
