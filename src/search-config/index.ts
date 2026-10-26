/**
 * Search provider configuration — persisted alongside model profiles.
 *
 * Path: `MINI_AGENT_SEARCH_CONFIG` (default `~/.mini-agent/search.json`).
 *
 * Schema (version 1):
 * {
 *   "version": 1,
 *   "provider": "tavily" | "brave" | "exa" | "searxng" | "duckduckgo" | "mcp" | "auto",
 *   "apiKey": "...",
 *   "baseUrl": "...",
 *   "models": ["gemini-3.6-flash"]
 * }
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type SearchProviderSelection =
  | "tavily" | "brave" | "exa" | "searxng" | "duckduckgo" | "mcp" | "auto";

export type SearchConfigProfile = {
  version: 1;
  provider?: SearchProviderSelection;
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
};

export function resolveSearchConfigPath(): string {
  return process.env.MINI_AGENT_SEARCH_CONFIG ?? path.join(os.homedir(), ".mini-agent", "search.json");
}

export function loadSearchConfigSync(pathStr?: string): SearchConfigProfile | null {
  const target = pathStr ?? resolveSearchConfigPath();
  if (!existsSync(target)) return null;
  try {
    const text = readFileSync(target, "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const provider = typeof obj.provider === "string" ? obj.provider.trim() : undefined;
    const apiKey = typeof obj.apiKey === "string" ? obj.apiKey.trim() : undefined;
    const baseUrl = typeof obj.baseUrl === "string" ? obj.baseUrl.trim() : undefined;
    const models = Array.isArray(obj.models)
      ? obj.models.filter((m): m is string => typeof m === "string" && m.trim().length > 0)
      : undefined;
    return {
      version: 1,
      ...(provider ? { provider: provider as SearchProviderSelection } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(models && models.length > 0 ? { models } : {}),
    };
  } catch {
    return null;
  }
}

export async function saveSearchConfig(
  profile: Partial<SearchConfigProfile>,
  pathStr?: string,
): Promise<SearchConfigProfile> {
  const target = pathStr ?? resolveSearchConfigPath();
  const existing = loadSearchConfigSync(target) ?? { version: 1 };
  const updated: SearchConfigProfile = {
    ...existing,
    ...profile,
    version: 1,
  };
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify(updated, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temp, target);
  await chmod(target, 0o600);
  return updated;
}
