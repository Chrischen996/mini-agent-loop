import {
  type Skill,
  type SkillRegistry,
} from "../skills/types.ts";
import { formatActivatedSkillPrompt, formatSkillCatalog } from "../skills/index.ts";
import { resolveToolProvider, type Tool } from "../tools/types.ts";
import type { MessagePreprocessor } from "../preprocessors/index.ts";
import type { AgentMessage, AssistantMessage, ToolResultMessage } from "../types.ts";
import type { LlmConfig } from "../llm/index.ts";

export function resolveActiveSkills(
  skills: Skill[],
  skillRegistry: SkillRegistry,
  skillNames: string[],
): {
  activeSkills: Skill[];
  skillPromptFragments: string[];
  skillTools: Tool[];
  skillPreprocessors: MessagePreprocessor[];
} {
  const resolvedFromNames = skillRegistry.resolve(skillNames);
  const activeSkills: Skill[] = [...skills, ...resolvedFromNames];

  // Merge skill-provided system prompt fragments.
  // Discovered-but-inactive skills only contribute a short catalog.
  // Activated skills get the full instructions plus resource paths.
  const catalogSkills = skillRegistry.list().filter(
    (skill) => !activeSkills.some((active) => active.name === skill.name),
  );
  const skillPromptFragments = [
    formatSkillCatalog(catalogSkills),
    ...activeSkills.map((skill) => formatActivatedSkillPrompt(skill)),
  ].filter(Boolean) as string[];

  // Merge skill-provided tools
  const skillTools: Tool[] = activeSkills.flatMap((s) =>
    s.tools ? resolveToolProvider(s.tools) : [],
  );

  // Merge skill-provided preprocessors
  const skillPreprocessors: MessagePreprocessor[] = activeSkills.flatMap(
    (s) => s.preprocessors ?? [],
  );

  return { activeSkills, skillPromptFragments, skillTools, skillPreprocessors };
}

export function applySkillPromptFragments(
  messages: AgentMessage[],
  skillPromptFragments: string[],
): void {
  if (skillPromptFragments.length === 0 || messages.length === 0) return;
  const systemMsg = messages[0];
  if (systemMsg && systemMsg.role === "system" && typeof systemMsg.content === "string") {
    const existing = systemMsg.content;
    const alreadyInjected = skillPromptFragments.every((frag) => existing.includes(frag));
    if (!alreadyInjected) {
      systemMsg.content = `${existing}\n\n${skillPromptFragments.join("\n\n")}`;
    }
  }
}

export async function runSkillHooks(
  activeSkills: Skill[],
  phase: "beforeTurn" | "afterTurn",
  ctx: {
    turn: number;
    currentLlm: LlmConfig;
    assistantMessage: AssistantMessage;
    toolResults: ToolResultMessage[];
    messages: AgentMessage[];
  },
): Promise<void> {
  for (const skill of activeSkills) {
    await skill.hooks?.[phase]?.(ctx);
  }
}
