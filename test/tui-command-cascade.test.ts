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
});
