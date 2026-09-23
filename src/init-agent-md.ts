/**
 * AGENT.MD generator.
 *
 * Creates a project-local AGENT.MD instruction file in the current
 * workspace. The default path is a generic project skeleton (no LLM, no
 * hardcoded mini-agent internals) plus a few light heuristic hints
 * derived from files that already exist in the target directory.
 *
 * An opt-in LLM-enhanced path (`llm: true`) generates the file from a
 * project snapshot (package.json, README, top-level layout) using the
 * caller-supplied LLM config. Any failure on that path falls back to
 * the deterministic template, so /init always produces a file.
 *
 * The write path is intentionally conservative:
 * - only writes `path.join(cwd, "AGENT.MD")` (never a caller-supplied path);
 * - default writes use the exclusive `wx` flag so two concurrent `/init`
 *   invocations cannot race into a silent overwrite;
 * - `force` overwrites an existing file with a plain write.
 */

import { access, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { completeChat } from "./llm/chat.ts";
import type { LlmConfig } from "./llm/index.ts";
import type { AgentMessage } from "./types.ts";

export const AGENT_FILENAME = "AGENT.MD";

/** Minimal completion seam so tests can inject a fake LLM. */
export type LlmComplete = (
  config: LlmConfig,
  messages: AgentMessage[],
) => Promise<string>;

export type InitAgentMdOptions = {
  cwd: string;
  force?: boolean;
  print?: boolean;
  /** Opt in to LLM-enhanced generation. Default stays the deterministic template. */
  llm?: boolean;
  /** LLM config used when `llm` is true. Omit to load from the environment. */
  llmConfig?: LlmConfig;
  /** Test seam for the LLM completion call. Defaults to completeChat. */
  llmComplete?: LlmComplete;
};

export type InitAgentMdResult = {
  path: string;
  content: string;
  created: boolean;
  overwritten: boolean;
  /** How the final content was produced. */
  generatedBy: "template" | "llm";
  /** True when LLM generation was requested but failed and we fell back to the template. */
  llmFallback: boolean;
};

const TEMPLATE = `# Agent Instructions

## Project Overview

<!-- Describe the project purpose, important architecture, and business domain here. -->

## Technology Stack

<!-- List the primary language, runtime, package manager, and key frameworks. -->

## Development Commands

\`\`\`bash
# Replace with the commands used to install dependencies, build, test, and lint.
\`\`\`

## Code Style and Guidelines

- Follow the project's existing language-level settings (strict typing, linters, formatters).
- Keep tool, permission, and workspace boundaries intact when making changes.
- Do not commit secrets, local environment files, or generated build output.

## Testing and Verification

<!-- Describe how changes should be validated, including which tests or checks to run. -->
`;

// ─── LLM-enhanced generation ───────────────────────────────────────────────

const LLM_SYSTEM_PROMPT = [
  "You generate the AGENT.MD instruction file for a software project.",
  "Given a snapshot of the project's key files, write a complete AGENT.MD in Markdown.",
  "",
  "Rules:",
  '- Start with the heading "# Agent Instructions".',
  "Include these sections, in order:",
  "## Project Overview",
  "## Technology Stack",
  "## Development Commands",
  "## Code Style and Guidelines",
  "## Testing and Verification",
  "- Fill every section with concrete facts taken from the snapshot. Use bash code blocks for commands.",
  "- Never invent commands, tools, or conventions that are not present in the snapshot.",
  "- If something is unknown, state that briefly instead of leaving placeholder comments.",
  "- Output the raw Markdown file only: no preamble, no commentary, no outer code fence.",
].join("\n");

const LLM_CONTEXT_MAX_CHARS = 12_000;
const LLM_README_MAX_CHARS = 8_000;

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Build the bounded project snapshot fed to the LLM. */
async function collectProjectContext(cwd: string): Promise<string> {
  const absCwd = path.resolve(cwd);
  const sections: string[] = [];

  const packageJsonRaw = await readIfExists(path.join(absCwd, "package.json"));
  if (packageJsonRaw) {
    sections.push("package.json:", packageJsonRaw.slice(0, 4_000));
  }
  const readme = await readIfExists(path.join(absCwd, "README.md"));
  if (readme) {
    sections.push(
      "README.md (truncated):",
      readme.slice(0, LLM_README_MAX_CHARS),
    );
  }
  for (const manifest of ["go.mod", "Cargo.toml", "pyproject.toml", "requirements.txt"]) {
    const raw = await readIfExists(path.join(absCwd, manifest));
    if (raw) sections.push(`${manifest}:`, raw.slice(0, 2_000));
  }
  let topLevel: string[] = [];
  try {
    topLevel = (await readdir(absCwd))
      .filter((name) => name !== "node_modules" && name !== ".git")
      .sort()
      .slice(0, 60);
  } catch {
    topLevel = [];
  }
  if (topLevel.length > 0) {
    sections.push("Top-level entries:", topLevel.join(", "));
  }
  const context = sections.join("\n\n");
  return context.length > LLM_CONTEXT_MAX_CHARS
    ? context.slice(0, LLM_CONTEXT_MAX_CHARS) + "\n\n[snapshot truncated]"
    : context;
}

function extractLlmMarkdown(raw: string): string {
  let text = raw.trim();
  // Strip an outer code fence if the model wrapped the answer anyway.
  if (text.startsWith("```")) {
    const firstNewline = text.indexOf("\n");
    if (firstNewline !== -1) text = text.slice(firstNewline + 1);
    const lastFence = text.lastIndexOf("```");
    if (lastFence !== -1) text = text.slice(0, lastFence);
    text = text.trim();
  }
  return text;
}

async function generateAgentMdWithLlm(
  cwd: string,
  config: LlmConfig,
  complete: LlmComplete,
): Promise<string> {
  const context = await collectProjectContext(cwd);
  const messages: AgentMessage[] = [
    { role: "system", content: LLM_SYSTEM_PROMPT },
    { role: "user", content: `Project snapshot:\n${context}` },
  ];
  const raw = await complete(config, messages);
  const content = extractLlmMarkdown(raw);
  if (!content.trim()) {
    throw new Error("LLM returned an empty AGENT.MD");
  }
  return content;
}

async function defaultLlmComplete(config: LlmConfig, messages: AgentMessage[]): Promise<string> {
  const response = await completeChat(config, messages);
  return response.content;
}

async function loadLlmConfigForInit(): Promise<LlmConfig> {
  const { loadLlmConfigFromEnv } = await import("./llm/index.ts");
  return loadLlmConfigFromEnv();
}

export async function buildAgentMdContent(cwd: string): Promise<string> {
  const sections = TEMPLATE.split("\n");
  const hints: string[] = [];
  const absCwd = path.resolve(cwd);

  const packageJsonRaw = await readIfExists(path.join(absCwd, "package.json"));
  if (packageJsonRaw) {
    hints.push("- Detected: Node.js / JavaScript / TypeScript project (`package.json` present).");
    try {
      const parsed = JSON.parse(packageJsonRaw) as {
        scripts?: Record<string, string>;
        devDependencies?: Record<string, string>;
        dependencies?: Record<string, string>;
      };
      const scripts = Object.entries(parsed.scripts ?? {}).filter(([name]) => {
        return name === "test" || name === "build" || name === "lint" || name === "typecheck";
      });
      if (scripts.length > 0) {
        const lines = scripts.map(([name, cmd]) => `- \`${name}\`: \`${cmd}\``);
        sections.splice(sections.indexOf("## Development Commands"), 0, ...lines, "");
      }
      const allDeps = { ...parsed.devDependencies, ...parsed.dependencies };
      if (allDeps["typescript"]) hints.push("- Detected: TypeScript compiler present.");
    } catch {
      // Invalid JSON: keep the generic template and only surface the package.json hint.
    }
  }
  if (await fileExists(path.join(absCwd, "go.mod"))) {
    hints.push("- Detected: Go module project (`go.mod` present).");
  }
  if (await fileExists(path.join(absCwd, "Cargo.toml"))) {
    hints.push("- Detected: Rust project (`Cargo.toml` present).");
  }
  if (await fileExists(path.join(absCwd, "pyproject.toml")) || (await fileExists(path.join(absCwd, "requirements.txt")))) {
    hints.push("- Detected: Python project.");
  }
  if (hints.length > 0) {
    const detectedSection = [`## Detected Project Signals`, "", ...hints, ""].join("\n");
    const stackIndex = sections.indexOf("## Technology Stack");
    sections.splice(stackIndex + 1, 0, ...detectedSection.split("\n"));
  }
  return sections.join("\n");
}

export async function initAgentMd(options: InitAgentMdOptions): Promise<InitAgentMdResult> {
  const targetPath = path.join(path.resolve(options.cwd), AGENT_FILENAME);

  let content: string;
  let generatedBy: "template" | "llm" = "template";
  let llmFallback = false;

  if (options.llm) {
    try {
      const config = options.llmConfig ?? (await loadLlmConfigForInit());
      const complete = options.llmComplete ?? defaultLlmComplete;
      content = await generateAgentMdWithLlm(options.cwd, config, complete);
      generatedBy = "llm";
    } catch {
      // LLM unavailable / failed: fall back to the deterministic template
      // so /init always produces a usable file.
      content = await buildAgentMdContent(options.cwd);
      llmFallback = true;
    }
  } else {
    content = await buildAgentMdContent(options.cwd);
  }

  if (options.print) {
    return { path: targetPath, content, created: false, overwritten: false, generatedBy, llmFallback };
  }

  if (options.force) {
    await writeFile(targetPath, content, "utf8");
    return { path: targetPath, content, created: false, overwritten: true, generatedBy, llmFallback };
  }

  try {
    await writeFile(targetPath, content, { encoding: "utf8", flag: "wx" });
    return { path: targetPath, content, created: true, overwritten: false, generatedBy, llmFallback };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new Error(`${AGENT_FILENAME} already exists. Use /init --force to overwrite.`);
    }
    throw error;
  }
}
