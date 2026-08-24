import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SLASH_COMMANDS } from "../src/tui/components/FileAutocomplete.tsx";
import {
  createAndSavePlan,
  loadPlanDocument,
} from "../src/plan/index.ts";
import {
  finalizeExecCapture,
  parsePlanTurnOverride,
} from "../src/tui/plan-commands.ts";
import { PermissionManager } from "../src/permissions.ts";
import type { TuiAction } from "../src/tui/state.ts";

describe("TUI plan slash commands", () => {
  const names = SLASH_COMMANDS.map((cmd) => cmd.name);

  it("registers plan workflow commands before help/exit", () => {
    const required = [
      "plan",
      "plan-show",
      "plan-approve",
      "plan-reject",
      "plan-run",
      "plan-retry",
      "plan-history",
      "plan-archive",
    ];
    for (const name of required) {
      assert.ok(names.includes(name), `missing slash command: ${name}`);
    }

    const helpIndex = names.indexOf("help");
    const planIndex = names.indexOf("plan");
    assert.ok(planIndex >= 0 && helpIndex >= 0);
    assert.ok(planIndex < helpIndex, "plan commands should appear before help");
  });

  it("exposes Chinese usage descriptions for plan commands", () => {
    const plan = SLASH_COMMANDS.find((cmd) => cmd.name === "plan");
    assert.equal(plan?.usage, "/plan [task]");
    assert.match(plan?.description ?? "", /plan mode|计划/i);

    const run = SLASH_COMMANDS.find((cmd) => cmd.name === "plan-run");
    assert.equal(run?.usage, "/plan-run");
  });

  it("keeps ordinary prompts in the agent-turn path", async () => {
    const result = await parsePlanTurnOverride("inspect the workspace", {
      cwd: "/tmp",
      dispatch: () => {},
      setInput: () => {},
      planCaptureRef: { current: null },
      execCaptureRef: { current: null },
      permissionManager: new PermissionManager("plan"),
    });
    assert.equal(result, undefined);
  });

  it("registers skill commands before help", () => {
    const helpIndex = names.indexOf("help");
    const skillIndex = names.indexOf("skill");
    const skillsIndex = names.indexOf("skills");
    assert.ok(skillIndex >= 0 && skillsIndex >= 0);
    assert.ok(skillIndex < helpIndex);
    assert.ok(skillsIndex < helpIndex);
    const skill = SLASH_COMMANDS.find((cmd) => cmd.name === "skill");
    assert.equal(skill?.usage, "/skill [on|off|list|clear] [name]");
  });

  it("keeps the Todo state synchronized through approve and execute", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "mini-agent-tui-plan-"));
    try {
      await createAndSavePlan(cwd, "task", "1. Read\n2. Summarize");
      const actions: TuiAction[] = [];
      const permissionManager = new PermissionManager("plan");
      const deps = {
        cwd,
        dispatch: (action: TuiAction) => actions.push(action),
        setInput: (_value: string) => {},
        planCaptureRef: { current: null },
        execCaptureRef: { current: null },
        permissionManager,
      } as const;

      await parsePlanTurnOverride("/plan-show", deps);
      const shown = actions.find((action) => action.type === "SET_TODO_PLAN");
      assert.equal(shown?.type, "SET_TODO_PLAN");
      assert.equal(shown?.plan?.status, "pending");

      actions.length = 0;
      await parsePlanTurnOverride("/plan-approve", deps);
      const approved = actions.find((action) => action.type === "SET_TODO_PLAN");
      assert.equal(approved?.type, "SET_TODO_PLAN");
      assert.equal(approved?.plan?.status, "approved");

      actions.length = 0;
      const override = await parsePlanTurnOverride("/plan-run", deps);
      assert.equal(override?.forceMode, "bypass");
      const executing = actions.find((action) => action.type === "SET_TODO_PLAN");
      assert.equal(executing?.type, "SET_TODO_PLAN");
      assert.equal(executing?.plan?.status, "executing");
      assert.equal(permissionManager.getMode(), "bypass");
      assert.ok(actions.some((action) => action.type === "SET_PERMISSION_MODE" && action.mode === "bypass"));

      const execCaptureRef = { current: { mode: "run" as const } };
      await finalizeExecCapture({
        cwd,
        execCaptureRef,
        history: [{ role: "assistant", content: "done" }],
        succeeded: true,
        dispatch: (action) => actions.push(action),
      });
      const completed = actions.filter((action) => action.type === "SET_TODO_PLAN").at(-1);
      assert.equal(completed?.type, "SET_TODO_PLAN");
      assert.equal(completed?.plan?.status, "completed");
      assert.equal((await loadPlanDocument(cwd))?.status, "completed");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
