import type { RunnerPlan } from "./types.ts";
import { lockFor } from "./classify.ts";

/**
 * Render the dispatch plan as TUI notice lines. Each locked task (install,
 * test, build, migration …) is annotated with its resource class and a
 * "[shared]" marker so the user can see which tasks serialize behind a
 * workspace mutation lock.
 */
export function renderDryRun(plan: RunnerPlan): string[] {
  const lines: string[] = [
    "Dispatch plan:",
    "",
  ];
  const byId = new Map(plan.tasks.map((task) => [task.todoId, task]));
  plan.batches.forEach((batch, index) => {
    const locked = new Set<string>();
    for (const id of batch) {
      const task = byId.get(id);
      if (task && lockFor(task.resourceClass) !== null) locked.add(task.resourceClass);
    }
    lines.push(`Batch ${index}:`);
    for (const id of batch) {
      const task = byId.get(id);
      if (!task) continue;
      const lock = locked.has(task.resourceClass) ? " [shared]" : "";
      lines.push(
        `  ${task.label.padEnd(20)} ${task.content.slice(0, 40).padEnd(40)} ${task.runner} ${task.resourceClass}${lock}`,
      );
    }
  });
  return lines;
}

export function formatDryRun(plan: RunnerPlan): string {
  return renderDryRun(plan).join("\n");
}
