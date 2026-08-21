/**
 * AGENTS.md loader — reads repo-level agent instructions.
 *
 * Looks for .agents.md or AGENTS.md in the workspace root and returns
 * the content as a string. Returns undefined if not found.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const AGENTS_FILENAMES = [".agents.md", "AGENTS.md"];

export type InstructionSource = {
  path: string;
  content: string;
  level: "global" | "directory";
};

export type InstructionBundle = {
  content: string;
  sources: InstructionSource[];
};

async function readInstructionFile(directory: string): Promise<InstructionSource | undefined> {
  for (const filename of AGENTS_FILENAMES) {
    const filePath = path.join(directory, filename);
    try {
      const content = (await readFile(filePath, "utf8")).trim();
      if (content) return { path: filePath, content, level: "directory" };
    } catch {
      // Try the next supported filename.
    }
  }
  return undefined;
}

/** Load global and ancestor instructions in low-to-high precedence order. */
export async function loadInstructionBundle(
  cwd: string,
  options: { homeDirectory?: string; includeGlobal?: boolean } = {},
): Promise<InstructionBundle> {
  const resolvedCwd = path.resolve(cwd);
  const directories: string[] = [];
  let current = resolvedCwd;
  for (;;) {
    directories.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const sources: InstructionSource[] = [];
  if (options.includeGlobal !== false) {
    const home = options.homeDirectory ?? process.env.MINI_AGENT_HOME ?? process.env.HOME;
    if (home) {
      const global = await readInstructionFile(path.join(home, ".mini-agent"));
      if (global) sources.push({ ...global, level: "global" });
    }
  }
  for (const directory of directories) {
    const source = await readInstructionFile(directory);
    if (source) sources.push(source);
  }

  return {
    content: sources.length === 1
      ? sources[0]!.content
      : sources.map((source) => `[Instructions from ${source.path}]\n${source.content}`).join("\n\n"),
    sources,
  };
}

export async function loadAgentsMd(cwd: string): Promise<string | undefined> {
  const bundle = await loadInstructionBundle(cwd, { includeGlobal: false });
  return bundle.content || undefined;
}
