/**
 * Early-exit plan subcommands for the one-shot CLI, split out of `main()` in
 * src/cli.ts. These run before any LLM turn so they need no loop or session
 * wiring — only the on-disk plan kernel plus editor/file utilities.
 *
 * Each command mirrors the original inline block in `main()`: failures are
 * printed to stderr and exit with status 1, successes return and let the
 * caller stop immediately.
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  approveCurrentPlan,
  archiveCurrentPlan,
  editCurrentPlan,
  formatPlanDiff,
  formatPlanDocumentPreview,
  listPlanHistory,
  loadPlanDocument,
  rejectCurrentPlan,
} from "../plan/index.ts";

/** The parsed flags that trigger an early-exit plan subcommand. */
export type EarlyPlanFlags = {
  planShow: boolean;
  planApprove: boolean;
  planReject: boolean;
  planHistory: boolean;
  planArchive: boolean;
  planEdit: boolean;
  planSetFile?: string;
};

export function hasEarlyPlanCommands(flags: EarlyPlanFlags): boolean {
  return (
    flags.planShow ||
    flags.planApprove ||
    flags.planReject ||
    flags.planHistory ||
    flags.planArchive ||
    flags.planEdit ||
    flags.planSetFile !== undefined
  );
}

export async function runEarlyPlanCommands(cwd: string, flags: EarlyPlanFlags): Promise<void> {
  if (flags.planShow) {
    const doc = await loadPlanDocument(cwd);
    if (!doc) {
      console.error("No saved plan found.");
      process.exit(1);
    }
    console.error(formatPlanDocumentPreview(doc));
    console.log(doc.rawMarkdown);
    return;
  }

  if (flags.planApprove) {
    try {
      const doc = await approveCurrentPlan(cwd, "user");
      console.error(`[plan] approved (id=${doc.id})`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
    return;
  }

  if (flags.planReject) {
    try {
      const doc = await rejectCurrentPlan(cwd);
      console.error(`[plan] rejected (id=${doc.id})`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
    return;
  }

  if (flags.planHistory) {
    const history = await listPlanHistory(cwd);
    if (history.length === 0) {
      console.error("[plan] no archived plans");
      return;
    }
    for (const doc of history) {
      const promptSlice =
        doc.prompt.length > 60 ? `${doc.prompt.slice(0, 60)}…` : doc.prompt;
      console.error(
        `${doc.id}  ${doc.status.padEnd(10)}  ${doc.updatedAt}  ${promptSlice}`,
      );
    }
    return;
  }

  if (flags.planArchive) {
    try {
      const { archivedPath, document } = await archiveCurrentPlan(cwd);
      console.error(`[plan] archived id=${document.id} to ${archivedPath}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
    return;
  }

  if (flags.planSetFile) {
    try {
      const existing = await loadPlanDocument(cwd);
      if (!existing) {
        console.error("No saved plan found.");
        process.exit(1);
      }
      const filePath = path.resolve(cwd, flags.planSetFile);
      const nextMarkdown = await readFile(filePath, "utf8");
      const before = existing.rawMarkdown;
      const doc = await editCurrentPlan(cwd, nextMarkdown);
      console.error(formatPlanDiff(before, doc.rawMarkdown, doc.prompt));
      console.error(formatPlanDocumentPreview(doc));
      console.error(`[plan] updated from file ${flags.planSetFile} (id=${doc.id}, status=${doc.status})`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
    return;
  }

  if (flags.planEdit) {
    try {
      const existing = await loadPlanDocument(cwd);
      if (!existing) {
        console.error("No saved plan found.");
        process.exit(1);
      }
      const editor = process.env.EDITOR || process.env.VISUAL || "vi";
      const tmpDir = await mkdtemp(path.join(tmpdir(), "mini-agent-plan-"));
      const tmpFile = path.join(tmpDir, "plan.md");
      await writeFile(tmpFile, existing.rawMarkdown, "utf8");
      const result = spawnSync(editor, [tmpFile], { stdio: "inherit" });
      if (result.status !== 0) {
        console.error(
          `[plan] editor exited with status ${result.status ?? "unknown"}; aborting without save`,
        );
        process.exit(1);
      }
      const nextMarkdown = await readFile(tmpFile, "utf8");
      const before = existing.rawMarkdown;
      const doc = await editCurrentPlan(cwd, nextMarkdown);
      console.error(formatPlanDiff(before, doc.rawMarkdown, doc.prompt));
      console.error(formatPlanDocumentPreview(doc));
      console.error(`[plan] edited (id=${doc.id}, status=${doc.status})`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
    return;
  }
}
