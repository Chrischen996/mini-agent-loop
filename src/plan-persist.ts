/**
 * Plan persistence — saves agent plans to disk for the two-stage
 * plan-then-execute workflow.
 *
 * Stage 1 (--plan): agent runs in plan mode, output + metadata saved
 * Stage 2 (--plan-execute): reads saved plan, runs in bypass mode with plan context
 */

import { readFile, writeFile, existsSync } from "node:fs";
import { readFile as readFileAsync, writeFile as writeFileAsync } from "node:fs/promises";
import path from "node:path";

export type PlanFile = {
  version: 1;
  prompt: string;
  plan: string;
  mode: "plan";
  cwd: string;
  timestamp: string;
};

const PLAN_FILENAME = ".mini-agent-plan.json";

export async function savePlan(cwd: string, prompt: string, plan: string): Promise<string> {
  const planPath = path.join(cwd, PLAN_FILENAME);
  const planFile: PlanFile = {
    version: 1,
    prompt,
    plan,
    mode: "plan",
    cwd,
    timestamp: new Date().toISOString(),
  };
  await writeFileAsync(planPath, JSON.stringify(planFile, null, 2), "utf8");
  return planPath;
}

export async function loadPlan(cwd: string): Promise<PlanFile | null> {
  const planPath = path.join(cwd, PLAN_FILENAME);
  if (!existsSync(planPath)) return null;
  try {
    const raw = await readFileAsync(planPath, "utf8");
    return JSON.parse(raw) as PlanFile;
  } catch {
    return null;
  }
}

export async function clearPlan(cwd: string): Promise<void> {
  const planPath = path.join(cwd, PLAN_FILENAME);
  if (existsSync(planPath)) {
    await writeFileAsync(planPath, "", "utf8");
  }
}
