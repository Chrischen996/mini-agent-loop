import type { PermissionMode, PermissionTurnContext } from "../permissions.ts";
import type { Dispatch, MutableRefObject } from "react";
import type { TuiAction } from "./state.ts";
import type { AgentMessage } from "../types.ts";
import {
  PLAN_ONLY_SUFFIX,
  approveCurrentPlan,
  archiveCurrentPlan,
  createAndSavePlan,
  formatPlanDocumentPreview,
  listPlanHistory,
  loadPlanDocument,
  markPlanExecutionResult,
  preparePlanForExecution,
  rejectCurrentPlan,
} from "../plan/index.ts";
import { lastAssistantMessage, assistantContentAsString } from "./messages-utils.ts";
import { switchPermissionMode } from "./permission-utils.ts";

export type PlanOverrideResult = {
  displayText: string;
  prompt: string;
  forceMode?: PermissionMode;
  restoreMode?: PermissionMode;
};

export type PlanTurnOverrideDeps = {
  cwd: string;
  dispatch: Dispatch<TuiAction>;
  setInput: (value: string) => void;
  planCaptureRef: MutableRefObject<{ prompt: string } | null>;
  execCaptureRef: MutableRefObject<{ mode: "run" | "retry" } | null>;
  permissionManager: import("../permissions.ts").PermissionManager;
};

/**
 * Parse a /plan* slash command and return the override payload (if any).
 * Pure read of the command; writes are delegated to dispatch.
 */
export async function parsePlanTurnOverride(
  trimmed: string,
  deps: PlanTurnOverrideDeps,
): Promise<PlanOverrideResult | null | undefined> {
  const { cwd, dispatch, setInput, planCaptureRef, execCaptureRef, permissionManager } = deps;

  // /plan-show /plan-approve /plan-reject /plan-history /plan-archive — no agent turn
  if (trimmed === "/plan-show") {
    setInput("");
    try {
      const doc = await loadPlanDocument(cwd);
      if (!doc) {
        dispatch({ type: "ADD_NOTICE", title: "计划", text: "当前没有保存的计划。使用 /plan <任务> 生成。" });
      } else {
        dispatch({ type: "ADD_NOTICE", title: "当前计划", text: formatPlanDocumentPreview(doc) });
      }
    } catch (err) {
      dispatch({ type: "ADD_NOTICE", title: "计划错误", text: err instanceof Error ? err.message : String(err) });
    }
    return null;
  }

  if (trimmed === "/plan-approve") {
    setInput("");
    try {
      const doc = await approveCurrentPlan(cwd, "user");
      dispatch({
        type: "ADD_NOTICE",
        title: "计划已批准",
        text: `id=${doc.id} status=${doc.status}\n\n${formatPlanDocumentPreview(doc)}`,
      });
    } catch (err) {
      dispatch({ type: "ADD_NOTICE", title: "计划错误", text: err instanceof Error ? err.message : String(err) });
    }
    return null;
  }

  if (trimmed === "/plan-reject") {
    setInput("");
    try {
      const doc = await rejectCurrentPlan(cwd);
      dispatch({ type: "ADD_NOTICE", title: "计划已拒绝", text: `id=${doc.id} status=${doc.status}` });
    } catch (err) {
      dispatch({ type: "ADD_NOTICE", title: "计划错误", text: err instanceof Error ? err.message : String(err) });
    }
    return null;
  }

  if (trimmed === "/plan-history") {
    setInput("");
    try {
      const history = await listPlanHistory(cwd);
      if (history.length === 0) {
        dispatch({ type: "ADD_NOTICE", title: "计划历史", text: "尚无归档计划。" });
      } else {
        const lines = history.map((doc: any) => {
          const promptSlice = doc.prompt.length > 60 ? `${doc.prompt.slice(0, 60)}…` : doc.prompt;
          return `${doc.id}  ${doc.status.padEnd(10)}  ${doc.updatedAt}  ${promptSlice}`;
        });
        dispatch({ type: "ADD_NOTICE", title: "计划历史", text: lines.join("\n") });
      }
    } catch (err) {
      dispatch({ type: "ADD_NOTICE", title: "计划错误", text: err instanceof Error ? err.message : String(err) });
    }
    return null;
  }

  if (trimmed === "/plan-archive") {
    setInput("");
    try {
      const { archivedPath, document } = await archiveCurrentPlan(cwd);
      dispatch({
        type: "ADD_NOTICE",
        title: "计划已归档",
        text: `id=${document.id}\npath=${archivedPath}`,
      });
    } catch (err) {
      dispatch({ type: "ADD_NOTICE", title: "计划错误", text: err instanceof Error ? err.message : String(err) });
    }
    return null;
  }

  // /plan [task] — generate a plan via agent turn in plan mode
  const planMatch = trimmed.match(/^\/plan(?:\s+(.*))?$/i);
  if (planMatch && !trimmed.startsWith("/plan-")) {
    const task = (planMatch[1] ?? "").trim();
    if (!task) {
      setInput("");
      try {
        const doc = await loadPlanDocument(cwd);
        if (doc) {
          dispatch({ type: "ADD_NOTICE", title: "当前计划", text: formatPlanDocumentPreview(doc) });
        } else {
          dispatch({ type: "ADD_NOTICE", title: "计划", text: "用法: /plan <任务>" });
        }
      } catch (err) {
        dispatch({ type: "ADD_NOTICE", title: "计划错误", text: err instanceof Error ? err.message : String(err) });
      }
      return null;
    }
    planCaptureRef.current = { prompt: task };
    execCaptureRef.current = null;
    if (!switchPermissionMode(permissionManager, "plan")) {
      dispatch({ type: "SET_PERMISSION_MODE", mode: "plan" });
    }
    return {
      displayText: `/plan ${task}`,
      prompt: task + PLAN_ONLY_SUFFIX,
      forceMode: "plan",
    };
  }

  // /plan-run and /plan-retry — execute approved plan in bypass mode
  if (trimmed === "/plan-run" || trimmed === "/plan-retry") {
    const isRetry = trimmed === "/plan-retry";
    let executionPromptSuffix: string;
    try {
      const prepared = await preparePlanForExecution(cwd, {
        yes: false,
        workspaceRoot: cwd,
      });
      executionPromptSuffix = prepared.executionPromptSuffix;
      dispatch({
        type: "ADD_NOTICE",
        title: isRetry ? "重试计划" : "执行计划",
        text: `id=${prepared.document.id} status=executing\nprompt: ${prepared.document.prompt}`,
      });
    } catch (err) {
      setInput("");
      dispatch({ type: "ADD_NOTICE", title: "计划错误", text: err instanceof Error ? err.message : String(err) });
      return null;
    }
    execCaptureRef.current = { mode: isRetry ? "retry" : "run" };
    planCaptureRef.current = null;
    const previousMode = permissionManager.getMode();
    if (!switchPermissionMode(permissionManager, "bypass")) {
      dispatch({ type: "SET_PERMISSION_MODE", mode: "bypass" });
    }
    return {
      displayText: trimmed,
      prompt: `Execute the approved plan.${executionPromptSuffix}`,
      forceMode: "bypass",
      restoreMode: previousMode,
    };
  }

  return undefined;
}

export type FinalizePlanDeps = {
  cwd: string;
  planCaptureRef: MutableRefObject<{ prompt: string } | null>;
  history: AgentMessage[];
  succeeded: boolean;
  dispatch: Dispatch<TuiAction>;
};

export function finalizePlanCapture(deps: FinalizePlanDeps): void {
  const { cwd, planCaptureRef, history, succeeded, dispatch } = deps;
  const capture = planCaptureRef.current;
  if (!capture) return;
  planCaptureRef.current = null;
  if (!succeeded) return;
  const lastAssistant = lastAssistantMessage(history);
  const answer = assistantContentAsString(lastAssistant);
  if (!answer.trim()) {
    dispatch({ type: "ADD_NOTICE", title: "计划", text: "Agent 未返回可保存的计划内容。" });
    return;
  }
  (async () => {
    try {
      const doc = await createAndSavePlan(cwd, capture.prompt, answer);
      dispatch({
        type: "ADD_NOTICE",
        title: "计划已保存",
        text: `id=${doc.id} status=${doc.status}\n\n${formatPlanDocumentPreview(doc)}\n\n使用 /plan-approve 批准，然后 /plan-run 执行。`,
      });
    } catch (err) {
      dispatch({
        type: "ADD_NOTICE",
        title: "计划保存失败",
        text: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

export type FinalizeExecCaptureDeps = {
  cwd: string;
  execCaptureRef: MutableRefObject<{ mode: "run" | "retry" } | null>;
  history: AgentMessage[];
  succeeded: boolean;
  errorMessage?: string;
  dispatch: Dispatch<TuiAction>;
};

export function finalizeExecCapture(deps: FinalizeExecCaptureDeps): void {
  const { cwd, execCaptureRef, history, succeeded, errorMessage, dispatch } = deps;
  const capture = execCaptureRef.current;
  if (!capture) return;
  execCaptureRef.current = null;
  (async () => {
    try {
      if (succeeded) {
        const lastAssistant = lastAssistantMessage(history);
        const summary = assistantContentAsString(lastAssistant).slice(0, 500) || undefined;
        const completed = await markPlanExecutionResult(cwd, {
          ok: true,
          summary,
          workspaceRoot: cwd,
        });
        const audit = completed.execution?.auditReport
          ? `\n${completed.execution.auditReport.slice(0, 400)}`
          : "";
        dispatch({
          type: "ADD_NOTICE",
          title: "计划执行完成",
          text: `id=${completed.id} status=${completed.status}${audit}`,
        });
      } else {
        const failed = await markPlanExecutionResult(cwd, {
          ok: false,
          error: errorMessage ?? "execution failed",
          workspaceRoot: cwd,
        });
        const audit = failed.execution?.auditReport
          ? `\n${failed.execution.auditReport.slice(0, 400)}`
          : "";
        dispatch({
          type: "ADD_NOTICE",
          title: "计划执行失败",
          text: `id=${failed.id} status=${failed.status}\n${errorMessage ?? ""}${audit}`,
        });
      }
    } catch (err) {
      dispatch({
        type: "ADD_NOTICE",
        title: "计划结果记录失败",
        text: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}
