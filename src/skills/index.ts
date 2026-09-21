import type { Skill, SkillRegistry } from "./types.ts";
import { InMemorySkillRegistry, defaultSkillRegistry } from "./registry.ts";
import { homedir } from "node:os";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export { InMemorySkillRegistry, defaultSkillRegistry } from "./registry.ts";
export type { Skill, SkillRegistry, SkillHooks, SkillHookContext } from "./types.ts";

export const WORKSPACE_SKILL_DIRECTORIES = [
  "skills",
  path.join(".grok", "skills"),
  path.join(".claude", "skills"),
] as const;

export function userSkillDirectories(home = homedir()): string[] {
  return [
    path.join(home, ".grok", "skills"),
    path.join(home, ".claude", "skills"),
  ];
}

export function uniqueSkillNames(names: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export function loadSkillNamesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return uniqueSkillNames((env.MINI_AGENT_SKILLS ?? "").split(","));
}

function parseSkillDocument(text: string, directoryName: string, extras: Partial<Skill> = {}): Skill {
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
  return { name, description, systemPromptFragment: body, ...extras };
}

async function listSkillResourceFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
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
    const sourceDir = path.join(directory, entry.name);
    const skillPath = path.join(sourceDir, "SKILL.md");
    try {
      const [scripts, references] = await Promise.all([
        listSkillResourceFiles(path.join(sourceDir, "scripts")),
        listSkillResourceFiles(path.join(sourceDir, "references")),
      ]);
      skills.push(parseSkillDocument(await readFile(skillPath, "utf8"), entry.name, {
        sourceDir,
        scripts,
        references,
      }));
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
 * Auto-discover skills from .grok/skills/ in the given directory
 * and register them into the provided registry.
 */
export async function discoverGrokSkills(cwd: string, registry: SkillRegistry = defaultSkillRegistry): Promise<Skill[]> {
  const grokSkillsDir = path.join(cwd, ".grok", "skills");
  return registerSkillsFromDirectory(grokSkillsDir, registry);
}

export type DiscoveredWorkspaceSkills = {
  skills: Skill[];
  directories: string[];
};

export async function discoverWorkspaceSkills(
  cwd: string,
  registry: SkillRegistry = defaultSkillRegistry,
  home = homedir(),
): Promise<DiscoveredWorkspaceSkills> {
  const directories: string[] = [];
  const skills: Skill[] = [];
  const searchDirs = [
    ...WORKSPACE_SKILL_DIRECTORIES.map((relative) => path.join(cwd, relative)),
    ...userSkillDirectories(home),
  ];
  for (const directory of searchDirs) {
    const loaded = await registerSkillsFromDirectory(directory, registry);
    if (loaded.length > 0) {
      directories.push(directory);
      skills.push(...loaded);
    }
  }
  return { skills, directories };
}

export function formatSkillCatalog(skills: Iterable<Skill>): string {
  const items = [...skills];
  if (items.length === 0) return "";
  const lines = items.map((skill) => `- ${skill.name}: ${skill.description}`);
  return [
    "# Available Skills",
    "Discovered skills are listed below. Activate one with MINI_AGENT_SKILLS, /skill, or the session skills API before following its full instructions.",
    ...lines,
  ].join("\n");
}

export function formatActivatedSkillPrompt(skill: Skill): string {
  const parts = [`# Skill: ${skill.name}`, skill.description];
  if (skill.systemPromptFragment) parts.push(skill.systemPromptFragment);
  if (skill.sourceDir) {
    parts.push(`Skill directory: ${skill.sourceDir}`);
    if (skill.scripts && skill.scripts.length > 0) {
      parts.push(`Scripts: ${skill.scripts.join(", ")}`);
    }
    if (skill.references && skill.references.length > 0) {
      parts.push(`References: ${skill.references.join(", ")}`);
    }
    parts.push("Use read/bash to open these files when needed. Do not invent missing files. Do not execute scripts unless the current permission mode allows it.");
  }
  return parts.filter(Boolean).join("\n\n");
}

export type ActivatedSkills = {
  available: Skill[];
  activeNames: string[];
  requestedNames: string[];
  missingNames: string[];
};

export function activateSkillNames(
  requestedNames: Iterable<string>,
  registry: SkillRegistry = defaultSkillRegistry,
): ActivatedSkills {
  const requested = uniqueSkillNames(requestedNames);
  const resolved = registry.resolve(requested);
  const resolvedNames = new Set(resolved.map((skill) => skill.name));
  return {
    available: registry.list(),
    activeNames: resolved.map((skill) => skill.name),
    requestedNames: requested,
    missingNames: requested.filter((name) => !resolvedNames.has(name)),
  };
}

export function formatSkillStatus(activation: ActivatedSkills): string {
  const available = activation.available.length === 0
    ? "(none discovered)"
    : activation.available
      .map((skill) => {
        const mark = activation.activeNames.includes(skill.name) ? "*" : " ";
        return `${mark} ${skill.name} — ${skill.description}`;
      })
      .join("\n");
  const active = activation.activeNames.length > 0 ? activation.activeNames.join(", ") : "(none)";
  const missing = activation.missingNames.length > 0
    ? `\nMissing: ${activation.missingNames.join(", ")}`
    : "";
  return `Active: ${active}\nAvailable:\n${available}${missing}`;
}

export type SkillCommandResult = {
  activation: ActivatedSkills;
  message: string;
};

export function applySkillCommand(
  input: string,
  currentNames: Iterable<string>,
  registry: SkillRegistry = defaultSkillRegistry,
): SkillCommandResult | undefined {
  const trimmed = input.trim();
  const match = trimmed.match(/^\/skills?(?:\s+(.*))?$/i);
  if (!match) return undefined;

  const rest = (match[1] ?? "").trim();
  const tokens = rest ? rest.split(/[\s,]+/).filter(Boolean) : [];
  const verb = tokens[0]?.toLowerCase();
  const current = uniqueSkillNames(currentNames);

  let next = current;
  if (!verb || verb === "list" || verb === "status" || verb === "ls") {
    next = current;
  } else if (verb === "clear" || verb === "none" || (verb === "off" && tokens.length === 1)) {
    next = [];
  } else if (verb === "on" || verb === "enable" || verb === "add") {
    next = uniqueSkillNames([...current, ...tokens.slice(1)]);
  } else if (verb === "off" || verb === "disable" || verb === "remove" || verb === "rm") {
    const remove = new Set(uniqueSkillNames(tokens.slice(1)));
    next = current.filter((name) => !remove.has(name));
  } else if (verb === "only" || verb === "set") {
    next = uniqueSkillNames(tokens.slice(1));
  } else {
    next = uniqueSkillNames([...current, ...tokens]);
  }

  const activation = activateSkillNames(next, registry);
  return { activation, message: formatSkillStatus(activation) };
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
