import { GitWorkflow } from "../git/workflow.ts";
import type { Tool } from "./types.ts";

function textResult(content: string) {
  return { content: content || "(no output)" };
}

export function createGitTools(cwd: string): Tool[] {
  const workflow = new GitWorkflow(cwd);
  return [
    {
      name: "git_status",
      description: "Show the current Git branch, dirty state, and staged/unstaged/untracked counts.",
      source: { kind: "local" },
      annotations: { readOnlyHint: true, idempotentHint: true },
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => textResult(JSON.stringify(await workflow.status(), null, 2)),
    },
    {
      name: "git_diff",
      description: "Show the current Git diff, optionally staged or limited to a relative path.",
      source: { kind: "local" },
      annotations: { readOnlyHint: true, idempotentHint: true },
      parameters: {
        type: "object",
        properties: { staged: { type: "boolean" }, path: { type: "string" } },
        additionalProperties: false,
      },
      execute: async (args) => textResult(await workflow.diff(args as { staged?: boolean; path?: string })),
    },
    {
      name: "git_checkpoint",
      description: "Create a recoverable snapshot of tracked and untracked workspace changes before editing.",
      source: { kind: "local" },
      annotations: { idempotentHint: false },
      parameters: { type: "object", properties: { label: { type: "string" } }, additionalProperties: false },
      execute: async (args) => textResult(JSON.stringify(await workflow.createCheckpoint(String((args as { label?: string }).label ?? "agent-change")), null, 2)),
    },
    {
      name: "git_undo",
      description: "Restore the workspace and index to a previously created mini-agent Git checkpoint.",
      source: { kind: "local" },
      annotations: { destructiveHint: true },
      parameters: { type: "object", required: ["checkpointId"], properties: { checkpointId: { type: "string" } }, additionalProperties: false },
      execute: async (args) => textResult(JSON.stringify(await workflow.undo(String((args as { checkpointId: string }).checkpointId)), null, 2)),
    },
    {
      name: "git_branch_isolate",
      description: "Create a clean isolated Git worktree branch for a new coding task.",
      source: { kind: "local" },
      annotations: { destructiveHint: false },
      parameters: { type: "object", properties: { label: { type: "string" } }, additionalProperties: false },
      execute: async (args) => textResult(JSON.stringify(await workflow.createIsolatedBranch(String((args as { label?: string }).label ?? "task")), null, 2)),
    },
  ];
}
