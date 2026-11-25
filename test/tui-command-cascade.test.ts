import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { Dispatch } from "react";
import { loadLlmConfigFromEnv, type LlmConfig } from "../src/llm/index.ts";
import { createInitialState, type TuiAction } from "../src/tui/state.ts";
import {
  runCommandCascade,
  type CommandCascadeContext,
} from "../src/tui/session/command-cascade.ts";
import { createTuiAgentHistory } from "../src/tui/system-prompt.ts";
import { PermissionManager } from "../src/permissions.ts";

type Harness = {
  ctx: CommandCascadeContext;
  actions: TuiAction[];
  notices: () => { title: string; text: string }[];
  input: () => string;
  acMode: () => string | null;
  opened: { modelPicker: number; effortPicker: number; profileList: number; dashboard: number };
  cleanup: () => Promise<void>;
};

/**
 * Build a cascade context with spy callbacks. Command routing is pure enough to
 * exercise without Ink: every branch only dispatches actions or calls the
 * injected callbacks.
 */
async function makeHarness(overrides: Partial<CommandCascadeContext> = {}): Promise<Harness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "mini-agent-cascade-"));
  const llm = loadLlmConfigFromEnv();
  const actions: TuiAction[] = [];
  let input = "";
  let acMode: string | null = null;
  const opened = { modelPicker: 0, effortPicker: 0, profileList: 0, dashboard: 0 };

  const dispatch: Dispatch<TuiAction> = (action) => {
    actions.push(action);
  };

  const ctx: CommandCascadeContext = {
    cwd,
    state: createInitialState(llm.model),
    dispatch,
    setInput: (value) => { input = value; },
    llm,
    llmRef: { current: llm } as { current: LlmConfig },
    historyRef: { current: createTuiAgentHistory("plan", {}) },
    activeTodosRef: { current: undefined },
    localRoleLlmConfigsRef: { current: {} },
    pendingImagesRef: { current: [] },
    skillNamesRef: { current: [] },
    thinkingPolicyModeRef: { current: "fixed" },
    sessionProvenanceRef: { current: {} },
    planCaptureRef: { current: null },
    execCaptureRef: { current: null },
    diffFilesRef: { current: [] },
    resizeRefreshRef: { current: 80 },
    sessionManagerRef: { current: null },
    acModeRef: { current: null },
    modelPickerSectionRef: { current: "catalog" },
    allToolsRef: { current: {} as CommandCascadeContext["allToolsRef"]["current"] },
    modelContextWindows: {},
    systemPromptContext: {},
    getBgManager: () => null,
    getPermissionManager: () => new PermissionManager("plan"),
    getSessionManager: () => {
      throw new Error("session manager should not be used by this command");
    },
    refreshBgTaskCount: async () => undefined,
    persistSessionSnapshot: async () => undefined,
    resumeSession: async () => false,
    importForeign: async () => undefined,
    copyResolvedText: async () => undefined,
    addPendingImageRef: () => true,
    handlePasteImageRef: async () => true,
    runDirectToolRef: async () => undefined,
    runTodosCommand: async () => undefined,
    selectModelRef: () => undefined,
    openProfileListRef: async () => {
      opened.profileList += 1;
    },
    openModelPicker: () => { opened.modelPicker += 1; },
    openEffortPicker: () => { opened.effortPicker += 1; },
    handleEffortConfirm: () => undefined,
    setSkillNames: () => undefined,
    setConversationId: () => undefined,
    setAcMode: (mode) => { acMode = mode; },
    setAcIndex: () => undefined,
    setBgPanelOpen: () => undefined,
    setTasksPaneOpen: () => undefined,
    setThemeDialogOpen: () => undefined,
    setDiffFileCandidates: () => undefined,
    exit: () => undefined,
    ...overrides,
  };

  return {
    ctx,
    actions,
    notices: () =>
      actions.flatMap((action) =>
        action.type === "ADD_NOTICE"
          ? [{ title: action.title ?? "", text: action.text }]
          : [],
      ),
    input: () => input,
    acMode: () => acMode,
    opened,
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
}

describe("runCommandCascade", () => {
  it("passes an ordinary prompt through to the agent turn", async () => {
    const h = await makeHarness();
    try {
      const result = await runCommandCascade(h.ctx, "fix the failing test");
      assert.equal(result.handled, false);
      assert.equal(result.handled === false ? result.planTurnOverride : "unset", undefined);
      assert.deepEqual(h.notices(), []);
    } finally {
      await h.cleanup();
    }
  });

  it("handles /help with the command catalog", async () => {
    const h = await makeHarness();
    try {
      const result = await runCommandCascade(h.ctx, "/help");
      assert.equal(result.handled, true);
      assert.equal(h.notices()[0]?.title, "Available commands");
      assert.match(h.notices()[0]?.text ?? "", /\/clear/);
      assert.equal(h.input(), "");
    } finally {
      await h.cleanup();
    }
  });

  it("reports unknown slash commands instead of sending them to the model", async () => {
    const h = await makeHarness();
    try {
      const result = await runCommandCascade(h.ctx, "/definitely-not-a-command");
      assert.equal(result.handled, true);
      assert.equal(h.notices()[0]?.title, "Unknown command");
    } finally {
      await h.cleanup();
    }
  });

  it("routes /model with no reference to the model picker", async () => {
    const h = await makeHarness();
    try {
      const result = await runCommandCascade(h.ctx, "/model");
      assert.equal(result.handled, true);
      assert.equal(h.opened.modelPicker, 1);
    } finally {
      await h.cleanup();
    }
  });

  it("routes /effort with no level to the effort picker", async () => {
    const h = await makeHarness();
    try {
      const result = await runCommandCascade(h.ctx, "/effort");
      assert.equal(result.handled, true);
      assert.equal(h.opened.effortPicker, 1);
    } finally {
      await h.cleanup();
    }
  });

  it("routes /profiles to the profile list", async () => {
    const h = await makeHarness();
    try {
      const result = await runCommandCascade(h.ctx, "/profiles");
      assert.equal(result.handled, true);
      assert.equal(h.opened.profileList, 1);
    } finally {
      await h.cleanup();
    }
  });

  it("handles /clear by resetting the transcript and session", async () => {
    const h = await makeHarness({
      getSessionManager: () =>
        ({
          save: async () => undefined,
        }) as unknown as CommandCascadeContext["getSessionManager"] extends () => infer T ? T : never,
      setConversationId: () => undefined,
    });
    try {
      const result = await runCommandCascade(h.ctx, "/clear");
      assert.equal(result.handled, true);
      assert.ok(h.actions.some((action) => action.type === "RESET"));
    } finally {
      await h.cleanup();
    }
  });

  it("keeps /context a notice-only query", async () => {
    const h = await makeHarness();
    try {
      const result = await runCommandCascade(h.ctx, "/context");
      assert.equal(result.handled, true);
      assert.equal(h.notices()[0]?.title, "Context usage");
    } finally {
      await h.cleanup();
    }
  });

  it("clears todo items through /tasks clear", async () => {
    const h = await makeHarness();
    try {
      const result = await runCommandCascade(h.ctx, "/tasks clear");
      assert.equal(result.handled, true);
      assert.ok(h.actions.some((action) => action.type === "CLEAR_TODO_ITEMS"));
    } finally {
      await h.cleanup();
    }
  });

  it("reports a missing background-task manager for /bg-tasks", async () => {
    const h = await makeHarness();
    try {
      const result = await runCommandCascade(h.ctx, "/bg-tasks");
      assert.equal(result.handled, true);
      assert.equal(h.notices()[0]?.title, "Background tasks");
    } finally {
      await h.cleanup();
    }
  });

  it("returns the plan override for /plan <task> so a turn runs", async () => {
    const h = await makeHarness();
    try {
      const result = await runCommandCascade(h.ctx, "/plan add caching");
      assert.equal(result.handled, false);
      assert.equal(result.handled === false ? result.planTurnOverride?.forceMode : undefined, "plan");
      assert.equal(h.ctx.planCaptureRef.current?.prompt, "add caching");
    } finally {
      await h.cleanup();
    }
  });

  // ── Behavior-lock tests for each command family, added before any split of
  // runCommandCascade into domain handlers. Each pins the observable effects
  // (dispatch, input, refs, callbacks) so a refactor cannot silently drop a
  // branch or reorder the cascade.

  it("routes /exit and /quit through exit()", async () => {
    for (const command of ["/exit", "/quit"]) {
      let exited = 0;
      const h = await makeHarness({ exit: () => { exited += 1; } });
      try {
        const result = await runCommandCascade(h.ctx, command);
        assert.equal(result.handled, true, command);
        assert.equal(exited, 1, command);
        assert.deepEqual(h.notices(), []);
      } finally {
        await h.cleanup();
      }
    }
  });

  it("routes /resume without a prefix back into the input for the overlay", async () => {
    const h = await makeHarness();
    try {
      let resumedWith = "";
      const ctx = { ...h.ctx, resumeSession: async (prefix: string) => { resumedWith = prefix; return true; } };
      const result = await runCommandCascade(ctx, "/resume");
      assert.equal(result.handled, true);
      assert.equal(h.input(), "/resume");
      assert.equal(resumedWith, "");
    } finally {
      await h.cleanup();
    }
  });

  it("resumes a session through /resume <prefix>", async () => {
    const h = await makeHarness();
    try {
      const resumed: string[] = [];
      const ctx = { ...h.ctx, resumeSession: async (prefix: string) => { resumed.push(prefix); return true; } };
      const result = await runCommandCascade(ctx, "/resume abc123");
      assert.equal(result.handled, true);
      assert.deepEqual(resumed, ["abc123"]);
      assert.equal(h.input(), "");
    } finally {
      await h.cleanup();
    }
  });

  it("imports a foreign transcript through /resume-claude <ref>", async () => {
    const h = await makeHarness();
    try {
      const imports: Array<{ source: string; reference: string }> = [];
      const ctx = { ...h.ctx, importForeign: async (source: "claude" | "codex", reference: string) => { imports.push({ source, reference }); } };
      const result = await runCommandCascade(ctx, "/resume-claude login-bug");
      assert.equal(result.handled, true);
      assert.deepEqual(imports, [{ source: "claude", reference: "login-bug" }]);
    } finally {
      await h.cleanup();
    }
  });

  it("reports missing MCP status through /mcp without a server id", async () => {
    const h = await makeHarness();
    try {
      const result = await runCommandCascade(h.ctx, "/mcp");
      assert.equal(result.handled, true);
      const notice = h.notices()[0];
      assert.equal(notice?.title, "MCP status");
      // No mcpStatuses injected: formatMcpStatusDetails reports unavailability.
      assert.match(notice?.text ?? "", /unavailable in this session/);
    } finally {
      await h.cleanup();
    }
  });

  it("copies the last response through /copy last", async () => {
    const h = await makeHarness();
    try {
      const targets: string[] = [];
      const ctx = { ...h.ctx, copyResolvedText: async (target?: string) => { targets.push(target ?? "auto"); } };
      const result = await runCommandCascade(ctx, "/copy last");
      assert.equal(result.handled, true);
      assert.deepEqual(targets, ["last"]);
    } finally {
      await h.cleanup();
    }
  });

  it("queues a pending image through /image <path> and clears with /image clear", async () => {
    const added: string[] = [];
    let cleared = false;
    const missingPath = path.join(await (async () => {
      const h = await makeHarness();
      await h.cleanup();
      return h.ctx.cwd;
    })(), "does-not-exist.png");
    const h = await makeHarness({
      addPendingImageRef: () => { added.push("ok"); return true; },
      pendingImagesRef: { current: [] } as never,
    });
    try {
      const result = await runCommandCascade(h.ctx, "/image clear");
      assert.equal(result.handled, true);
      assert.ok(h.actions.some((action) => action.type === "CLEAR_PENDING_IMAGES"));
      // A missing file must produce an attachment error action, not a crash
      // (the action carries the message; ADD_NOTICE is not used here).
      const h2 = await makeHarness();
      try {
        const result2 = await runCommandCascade(h2.ctx, `/image ${missingPath}`);
        assert.equal(result2.handled, true);
        const attachmentError = h2.actions.find((action) => action.type === "ATTACHMENT_ERROR");
        assert.ok(attachmentError, "expected ATTACHMENT_ERROR action");
        assert.match(attachmentError.type === "ATTACHMENT_ERROR" ? attachmentError.message : "", /Unable to attach image/);
      } finally {
        await h2.cleanup();
      }
    } finally {
      await h.cleanup();
    }
  });

  it("reports no changed files for /diff in a clean workspace", async () => {
    const h = await makeHarness();
    try {
      const result = await runCommandCascade(h.ctx, "/diff");
      assert.equal(result.handled, true);
      assert.equal(h.notices()[0]?.title, "Git diff");
    } finally {
      await h.cleanup();
    }
  });

  it("opens the theme dialog for /theme without a name", async () => {
    const h = await makeHarness();
    try {
      let openCount = 0;
      const ctx = { ...h.ctx, setThemeDialogOpen: () => { openCount += 1; } };
      const result = await runCommandCascade(ctx, "/theme");
      assert.equal(result.handled, true);
      assert.equal(openCount, 1);
    } finally {
      await h.cleanup();
    }
  });

  it("rejects an unknown theme name with the catalog", async () => {
    const h = await makeHarness();
    try {
      const result = await runCommandCascade(h.ctx, "/theme not-a-theme");
      assert.equal(result.handled, true);
      const notice = h.notices()[0];
      assert.equal(notice?.title, "Theme");
      assert.match(notice?.text ?? "", /Unknown theme/);
    } finally {
      await h.cleanup();
    }
  });

  it("routes todos-run through runTodosCommand without dispatching a user message", async () => {
    const h = await makeHarness();
    try {
      const calls: string[] = [];
      const ctx = { ...h.ctx, runTodosCommand: async (input: string) => { calls.push(input); } };
      const result = await runCommandCascade(ctx, "/tasks run --parallel");
      assert.equal(result.handled, true);
      assert.deepEqual(calls, ["/tasks run --parallel"]);
      assert.ok(!h.actions.some((action) => action.type === "USER_MESSAGE"));
    } finally {
      await h.cleanup();
    }
  });

  it("dispatches direct tool calls for /read, /bash, /ls, /find, /grep", async () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ["/read package.json", "read", { path: "package.json" }],
      ["/bash echo hi", "bash", { command: "echo hi" }],
      ["/ls src", "ls", { path: "src" }],
      ["/find TODO src", "find", { pattern: "TODO", path: "src" }],
      ["/grep name src", "grep", { pattern: "name", path: "src" }],
    ];
    for (const [input, tool, args] of cases) {
      const h = await makeHarness();
      try {
        const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
        const ctx = { ...h.ctx, runDirectToolRef: async (toolName: string, callArgs: Record<string, unknown>) => { calls.push({ name: toolName, args: callArgs }); } };
        const result = await runCommandCascade(ctx, input);
        assert.equal(result.handled, true, input);
        assert.ok(h.actions.some((action) => action.type === "USER_MESSAGE"), input);
        assert.deepEqual(calls, [{ name: tool, args }], input);
        assert.ok(h.actions.some((action) => action.type === "LOOP_EVENT"), input);
      } finally {
        await h.cleanup();
      }
    }
  });

  it("keeps /tasks-pane open only the tasks pane", async () => {
    const h = await makeHarness();
    try {
      let tasksPane = 0;
      let bgPanel = 0;
      const ctx = {
        ...h.ctx,
        setTasksPaneOpen: () => { tasksPane += 1; },
        setBgPanelOpen: () => { bgPanel += 1; },
      };
      const result = await runCommandCascade(ctx, "/tasks-pane");
      assert.equal(result.handled, true);
      assert.equal(tasksPane, 1);
      assert.equal(bgPanel, 0);
      assert.equal(ctx.acModeRef.current ?? h.acMode(), null);
    } finally {
      await h.cleanup();
    }
  });

  it("sends input to an exact background-task match", async () => {
    const h = await makeHarness();
    try {
      const sent: Array<{ taskId: string; text: string }> = [];
      const manager = {
        initialize: async () => undefined,
        list: async () => [{ taskId: "task-abc12345", name: "watcher", status: "running", durationMs: 1000, exitCode: null }],
        send: async (taskId: string, payload: { text: string }) => { sent.push({ taskId, text: payload.text }); },
      };
      const ctx = { ...h.ctx, getBgManager: () => manager as never };
      // References are taskId prefixes: "abc12345" does NOT prefix "task-abc12345",
      // so use a prefix that matches from the start of the id.
      const result = await runCommandCascade(ctx, "/bg-tasks task-abc send check the logs");
      assert.equal(result.handled, true);
      assert.deepEqual(sent, [{ taskId: "task-abc12345", text: "check the logs" }]);
      assert.equal(h.notices()[0]?.title, "Background task");
    } finally {
      await h.cleanup();
    }
  });

  it("reports ambiguous background-task references instead of guessing", async () => {
    const h = await makeHarness();
    try {
      let sentCount = 0;
      const manager = {
        initialize: async () => undefined,
        list: async () => [
          { taskId: "task-abc11111", name: "one", status: "running", durationMs: 1, exitCode: null },
          { taskId: "task-abc22222", name: "two", status: "running", durationMs: 1, exitCode: null },
        ],
        send: async () => { sentCount += 1; },
      };
      const ctx = { ...h.ctx, getBgManager: () => manager as never };
      const result = await runCommandCascade(ctx, "/bg-tasks task-abc send x");
      assert.equal(result.handled, true);
      assert.equal(sentCount, 0);
      assert.match(h.notices()[0]?.text ?? "", /ambiguous/);
    } finally {
      await h.cleanup();
    }
  });

  it("activates skill names through /skill <name>", async () => {
    const h = await makeHarness();
    try {
      const setNames: string[][] = [];
      const ctx = { ...h.ctx, setSkillNames: (names: string[]) => { setNames.push(names); } };
      const result = await runCommandCascade(ctx, "/skill test-driven-development");
      assert.equal(result.handled, true);
      const notice = h.notices()[0];
      assert.equal(notice?.title, "Skills");
      assert.ok(Array.isArray(setNames[0]));
    } finally {
      await h.cleanup();
    }
  });
});
