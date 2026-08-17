/**
 * Plan document store — dual-write to v2 current.json and legacy plan file.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  documentToLegacyPlanFile,
  legacyPlanFileToDocument,
  type PlanDocument,
  type PlanFile,
} from "./document.ts";

export const LEGACY_PLAN_FILENAME = ".mini-agent-plan.json";
export const PLAN_DIR = path.join(".mini-agent", "plan");
export const HISTORY_DIR = path.join(PLAN_DIR, "history");
export const CURRENT_PLAN_FILENAME = "current.json";

export function currentPlanPath(cwd: string): string {
  return path.join(cwd, PLAN_DIR, CURRENT_PLAN_FILENAME);
}

export function legacyPlanPath(cwd: string): string {
  return path.join(cwd, LEGACY_PLAN_FILENAME);
}

export function historyPlanPath(cwd: string, id: string): string {
  return path.join(cwd, HISTORY_DIR, `${id}.json`);
}

function isPlanDocument(value: unknown): value is PlanDocument {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.version === 2 && typeof v.id === "string" && typeof v.rawMarkdown === "string";
}

function isLegacyPlanFile(value: unknown): value is PlanFile {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && typeof v.plan === "string" && typeof v.prompt === "string";
}

async function readJsonIfExists(filePath: string): Promise<unknown | null> {
  if (!existsSync(filePath)) return null;
  try {
    const raw = await readFile(filePath, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export async function loadPlanDocument(cwd: string): Promise<PlanDocument | null> {
  const current = await readJsonIfExists(currentPlanPath(cwd));
  if (isPlanDocument(current)) return current;
  if (isLegacyPlanFile(current)) return legacyPlanFileToDocument(current);

  const legacy = await readJsonIfExists(legacyPlanPath(cwd));
  if (isPlanDocument(legacy)) return legacy;
  if (isLegacyPlanFile(legacy)) return legacyPlanFileToDocument(legacy);

  return null;
}

export async function savePlanDocument(cwd: string, doc: PlanDocument): Promise<string> {
  const currentPath = currentPlanPath(cwd);
  const legacyPath = legacyPlanPath(cwd);
  await mkdir(path.dirname(currentPath), { recursive: true });

  const payload = JSON.stringify(doc, null, 2);
  await writeFile(currentPath, payload, "utf8");

  const legacy = documentToLegacyPlanFile(doc);
  await writeFile(legacyPath, JSON.stringify(legacy, null, 2), "utf8");

  return currentPath;
}

export async function clearPlanDocument(cwd: string): Promise<void> {
  // History under .mini-agent/plan/history is intentionally preserved.
  const currentPath = currentPlanPath(cwd);
  const legacyPath = legacyPlanPath(cwd);

  if (existsSync(currentPath)) {
    try {
      await unlink(currentPath);
    } catch {
      await writeFile(currentPath, "", "utf8");
    }
  }

  if (existsSync(legacyPath)) {
    // Preserve previous clearPlan behavior for legacy path: empty string
    await writeFile(legacyPath, "", "utf8");
  }
}

export async function archivePlanDocument(
  cwd: string,
  doc: PlanDocument,
): Promise<string> {
  const historyPath = historyPlanPath(cwd, doc.id);
  await mkdir(path.dirname(historyPath), { recursive: true });
  await writeFile(historyPath, JSON.stringify(doc, null, 2), "utf8");
  return historyPath;
}

export async function listPlanHistory(cwd: string): Promise<PlanDocument[]> {
  const dir = path.join(cwd, HISTORY_DIR);
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const docs: PlanDocument[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const raw = await readJsonIfExists(path.join(dir, name));
    if (isPlanDocument(raw)) docs.push(raw);
  }

  docs.sort((a, b) => {
    const ta = Date.parse(a.updatedAt) || 0;
    const tb = Date.parse(b.updatedAt) || 0;
    return tb - ta;
  });
  return docs;
}

export async function updatePlanDocument(
  cwd: string,
  mutator: (doc: PlanDocument) => PlanDocument | void,
): Promise<PlanDocument> {
  const existing = await loadPlanDocument(cwd);
  if (!existing) throw new Error("No plan found");
  const next = mutator(existing) ?? existing;
  next.updatedAt = new Date().toISOString();
  await savePlanDocument(cwd, next);
  return next;
}
