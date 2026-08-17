/**
 * AGENTS.md loader — reads repo-level agent instructions.
 *
 * Looks for .agents.md or AGENTS.md in the workspace root and returns
 * the content as a string. Returns undefined if not found.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const AGENTS_FILENAMES = [".agents.md", "AGENTS.md"];

export async function loadAgentsMd(cwd: string): Promise<string | undefined> {
  for (const filename of AGENTS_FILENAMES) {
    const filePath = path.join(cwd, filename);
    try {
      const content = await readFile(filePath, "utf8");
      if (content.trim()) return content.trim();
    } catch {
      // File doesn't exist — try next
    }
  }
  return undefined;
}
