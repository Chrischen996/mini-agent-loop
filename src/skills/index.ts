import type { Skill, SkillRegistry } from "./types.ts";
import { InMemorySkillRegistry, defaultSkillRegistry } from "./registry.ts";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export { InMemorySkillRegistry, defaultSkillRegistry } from "./registry.ts";
export type { Skill, SkillRegistry, SkillHooks, SkillHookContext } from "./types.ts";

export function loadSkillNamesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.MINI_AGENT_SKILLS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function parseSkillDocument(text: string, directoryName: string): Skill {
  let body = text.trim();
  let name = directoryName;
  let description = `Skill loaded from ${directoryName}/SKILL.md`;
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end >= 0) {
      const frontmatter = body.slice(3, end).split(/\r?\n/);
      for (const line of frontmatter) {
        const match = /^(name|description):\s*(.+?)\s*$/.exec(line);
        if (!match) continue;
        if (match[1] === "name") name = match[2]!;
        else description = match[2]!;
      }
      body = body.slice(end + 4).trim();
    }
  }
  return { name, description, systemPromptFragment: body };
}

export async function loadSkillsFromDirectory(directory: string): Promise<Skill[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(directory, entry.name, "SKILL.md");
    try {
      skills.push(parseSkillDocument(await readFile(skillPath, "utf8"), entry.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return skills;
}

export async function registerSkillsFromDirectory(
  directory: string,
  registry: SkillRegistry = defaultSkillRegistry,
): Promise<Skill[]> {
  const skills = await loadSkillsFromDirectory(directory);
  for (const skill of skills) registry.register(skill);
  return skills;
}

/**
 * Auto-discover skills from .grok/skills/ in the given directory.
 * Returns the discovered skills without registering them (call registerSkillsFromDirectory to register).
 */
export async function discoverGrokSkills(cwd: string, registry: SkillRegistry = defaultSkillRegistry): Promise<Skill[]> {
  const grokSkillsDir = path.join(cwd, ".grok", "skills");
  return registerSkillsFromDirectory(grokSkillsDir, registry);
}

/**
 * Helper to create a simple skill with just a system prompt fragment.
 */
export function createPromptSkill(
  name: string,
  description: string,
  systemPromptFragment: string,
): Skill {
  return {
    name,
    description,
    systemPromptFragment,
  };
}

/**
 * Helper to create a skill that provides additional tools.
 */
export function createToolSkill(
  name: string,
  description: string,
  tools: import("../tools/types.ts").ToolProvider,
  systemPromptFragment?: string,
): Skill {
  return {
    name,
    description,
    systemPromptFragment,
    tools,
  };
}
