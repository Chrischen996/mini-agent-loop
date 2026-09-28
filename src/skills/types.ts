/**
 * Skill module — lightweight, composable capability extensions.
 *
 * A Skill is a named bundle that can contribute:
 * - System prompt fragments
 * - Additional tools
 * - Message preprocessors
 * - Optional lifecycle hooks
 *
 * Skills are lighter than Subagents (no nested loop) but more structured
 * than raw tools.
 */

import type { ToolProvider } from "../tools/types.ts";
import type { MessagePreprocessor } from "../preprocessors/index.ts";
import type { TurnContext } from "../loop.ts";

export type SkillHookContext = TurnContext;

export type SkillHooks = {
  beforeTurn?: (ctx: SkillHookContext) => void | Promise<void>;
  afterTurn?: (ctx: SkillHookContext) => void | Promise<void>;
};

export type Skill = {
  /** Unique identifier for the skill */
  name: string;
  /** Human-readable description for LLMs and debugging */
  description: string;
  /** Text fragment to append to the system prompt */
  systemPromptFragment?: string;
  /** Absolute directory that contained SKILL.md, when loaded from disk. */
  sourceDir?: string;
  /** Filenames discovered under scripts/. */
  scripts?: string[];
  /** Filenames discovered under references/. */
  references?: string[];
  /** Tools provided by this skill */
  tools?: ToolProvider;
  /** Preprocessors contributed by this skill */
  preprocessors?: MessagePreprocessor[];
  /** Optional lifecycle hooks */
  hooks?: SkillHooks;
};

export type SkillRegistry = {
  register(skill: Skill): void;
  get(name: string): Skill | undefined;
  list(): Skill[];
  resolve(names: string[]): Skill[];
  unregister(name: string): boolean;
};
