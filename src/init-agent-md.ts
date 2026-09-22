/**
 * AGENT.MD generator.
 *
 * Creates a project-local AGENT.MD instruction file in the current
 * workspace. The template is a generic project skeleton (no LLM, no
 * hardcoded mini-agent internals) plus a few light heuristic hints
 * derived from files that already exist in the target directory.
 *
 * The write path is intentionally conservative:
 * - only writes `path.join(cwd, "AGENT.MD")` (never a caller-supplied path);
 * - default writes use the exclusive `wx` flag so two concurrent `/init`
 *   invocations cannot race into a silent overwrite;
 * - `force` overwrites an existing file with a plain write.
 */

import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const AGENT_FILENAME = "AGENT.MD";

export type InitAgentMdOptions = {
  cwd: string;
  force?: boolean;
  print?: boolean;
};

export type InitAgentMdResult = {
  path: string;
  content: string;
  created: boolean;
  overwritten: boolean;
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

/** Light, filesystem-only heuristics. No LLM, no secret scanning. */
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
  const content = await buildAgentMdContent(options.cwd);

  if (options.print) {
    return { path: targetPath, content, created: false, overwritten: false };
  }

  if (options.force) {
    await writeFile(targetPath, content, "utf8");
    return { path: targetPath, content, created: false, overwritten: true };
  }

  try {
    await writeFile(targetPath, content, { encoding: "utf8", flag: "wx" });
    return { path: targetPath, content, created: true, overwritten: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new Error(`${AGENT_FILENAME} already exists. Use /init --force to overwrite.`);
    }
    throw error;
  }
}
