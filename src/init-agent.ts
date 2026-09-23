/**
 * LLM-driven AGENT.MD generation for `/init`.
 *
 * Instead of writing a static skeleton, `/init` now runs a short internal
 * agent turn: a fresh loop equipped with read-only tools (ls/read/grep/find)
 * explores the current workspace and produces AGENT.MD content tailored to
 * the actual project. The final answer is captured between explicit markers
 * and written through the same conservative `writeAgentMd` path as the
 * offline template.
 *
 * Fallbacks keep `/init` useful offline:
 * - `--template` skips the LLM entirely and writes the heuristic skeleton
 *   from init-agent-md.ts;
 * - when no provider is configured or generation fails, the template is
 *   written instead and the resolution carries a `warning` explaining why.
 */

import { contentAsString } from "./content.ts";
import { buildAgentMdContent } from "./init-agent-md.ts";
import { isAbortError, loadLlmConfigFromEnv, type ChatFn, type LlmConfig } from "./llm/index.ts";
import { runAgentLoop, type LoopEvent } from "./loop.ts";
import { createFindTool, createGrepTool, createLsTool, createReadTool, type Tool } from "./tools/index.ts";
import type { AgentMessage } from "./types.ts";

/** Hard cap for the internal analysis loop. */
export const DEFAULT_INIT_MAX_TURNS = 12;

/** Minimum accepted length for generated AGENT.MD content. */
export const MIN_AGENT_MD_LENGTH = 80;

export const AGENT_MD_BEGIN_MARKER = "<<<AGENT_MD_START>>>";
export const AGENT_MD_END_MARKER = "<<<AGENT_MD_END>>>";

/** Raised when the analysis loop finishes without usable marked content. */
export class InitGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitGenerationError";
  }
}

const INIT_SYSTEM_PROMPT = `You are the project analyzer behind the /init command.
Your task: explore the project in the current working directory and produce the content for AGENT.MD, the project-instructions file that future agent sessions load before working in this repository.

Exploration rules:
- You only have read-only tools: ls, read, grep, find. You cannot write files or run commands, so do not attempt to.
- Be economical: start with a directory listing, then read the manifest (package.json, pyproject.toml, Cargo.toml, go.mod, ...), the README, and a handful of key source files. Stop exploring once you understand the project well enough; never enumerate every file.
- Skip generated or vendored content: node_modules, dist, build, lockfiles, .git.

Output contract:
- Your FINAL assistant message must contain ONLY the AGENT.MD content wrapped in these exact markers, with no commentary before or after them:

${AGENT_MD_BEGIN_MARKER}
# Agent Instructions
...
${AGENT_MD_END_MARKER}

The content must be concise, specific Markdown covering: project purpose, architecture (key directories and modules), technology stack, development commands exactly as configured (install/build/test/lint), and editing guidelines or invariants a coding agent must respect in THIS project. No placeholder sections, no generic filler.`;

const INIT_USER_PROMPT = "Analyze this project and produce the AGENT.MD content as instructed.";

export type GenerateAgentMdOptions = {
  cwd: string;
  llm: LlmConfig;
  /** Inject a faux model in tests. */
  chat?: ChatFn;
  signal?: AbortSignal;
  maxTurns?: number;
  onEvent?: (event: LoopEvent) => void;
};

export type GeneratedAgentMd = {
  content: string;
  model: string;
  /** Number of assistant turns the analysis loop used. */
  turns: number;
};

/**
 * Extracts AGENT.MD content from the last assistant message that carries
 * both markers. Returns undefined when no message qualifies or the body is
 * too short to be a believable instructions file.
 */
export function extractMarkedAgentMd(messages: AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    const text = contentAsString(message.content);
    const start = text.indexOf(AGENT_MD_BEGIN_MARKER);
    const end = text.lastIndexOf(AGENT_MD_END_MARKER);
    if (start === -1 || end === -1 || end <= start) continue;
    const body = text.slice(start + AGENT_MD_BEGIN_MARKER.length, end).trim();
    if (body.length >= MIN_AGENT_MD_LENGTH) return body;
  }
  return undefined;
}

/**
 * Runs the read-only analysis loop and returns the generated AGENT.MD
 * content. Throws `InitGenerationError` when the model never produces a
 * properly marked document; other errors (network, auth, abort) propagate
 * unchanged.
 */
export async function generateAgentMdWithLlm(options: GenerateAgentMdOptions): Promise<GeneratedAgentMd> {
  const maxTurns = options.maxTurns ?? DEFAULT_INIT_MAX_TURNS;
  const messages = await runAgentLoop(INIT_USER_PROMPT, {
    llm: options.llm,
    tools: [
      createReadTool(options.cwd) as Tool,
      createLsTool(options.cwd) as Tool,
      createGrepTool(options.cwd) as Tool,
      createFindTool(options.cwd) as Tool,
    ],
    systemPrompt: INIT_SYSTEM_PROMPT,
    maxTurns,
    chat: options.chat,
    signal: options.signal,
    onEvent: options.onEvent,
    // Read-only toolset: plan mode keeps any accidental write attempt blocked.
    permissionMode: "plan",
  });

  const content = extractMarkedAgentMd(messages);
  if (!content) {
    throw new InitGenerationError(
      "The analysis finished without returning AGENT.MD content between the required markers.",
    );
  }

  const turns = messages.filter((message) => message.role === "assistant").length;
  return { content, model: options.llm.model, turns };
}

export type InitResolution = {
  content: string;
  source: "llm" | "template";
  model?: string;
  turns?: number;
  /** Present when the LLM path was skipped or failed and the template was used instead. */
  warning?: string;
};

export type ResolveAgentMdOptions = Omit<GenerateAgentMdOptions, "llm"> & {
  /** LLM to analyze with; defaults to loadLlmConfigFromEnv(). */
  llm?: LlmConfig;
  /** Skip the LLM and produce the offline heuristic template. */
  template?: boolean;
};

/**
 * Chooses the AGENT.MD content for `/init`: LLM-generated when possible,
 * template otherwise. Never throws for generation problems — callers always
 * receive writable content plus an explanatory `warning`.
 */
export async function resolveAgentMdContent(options: ResolveAgentMdOptions): Promise<InitResolution> {
  if (options.template) {
    return { content: await buildAgentMdContent(options.cwd), source: "template" };
  }

  let llm = options.llm;
  if (!llm) {
    try {
      llm = loadLlmConfigFromEnv();
    } catch (error) {
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      return {
        content: await buildAgentMdContent(options.cwd),
        source: "template",
        warning: `No LLM provider configured (${reason}). Wrote the generic template instead; rerun /init after configuring an API key, or use /init --template to do this deliberately.`,
      };
    }
  }

  try {
    const generated = await generateAgentMdWithLlm({ ...options, llm });
    return { content: generated.content, source: "llm", model: generated.model, turns: generated.turns };
  } catch (error) {
    if (isAbortError(error)) throw error;
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return {
      content: await buildAgentMdContent(options.cwd),
      source: "template",
      warning: `LLM generation failed (${reason}). Wrote the generic template instead; rerun /init to retry or use /init --template.`,
    };
  }
}
