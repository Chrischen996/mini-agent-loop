#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { imagePart, textPart } from "./content.ts";
import { loadLlmConfigFromEnv } from "./llm/index.ts";
import { MaxTurnsExceededError, previewContent, runAgentLoop, type LoopEvent } from "./loop.ts";
import {
  createVisionPreprocessor,
  loadVisionConfigFromEnv,
} from "./preprocessors/index.ts";
import { createTools, type ToolName } from "./tools/index.ts";
import { createMcpApprovalGate } from "./mcp/approval.ts";
import { createMcpRuntimeFromEnv } from "./mcp/runtime.ts";
import { createCodebaseRuntimeFromEnv } from "./codebase/runtime.ts";
import { createSubagentTool, defaultProfiles } from "./subagent/index.ts";
import { resolveToolProvider, type Tool } from "./tools/types.ts";
import type { ContentPart, MessageContent } from "./types.ts";

const IMAGE_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function logEvent(event: LoopEvent): void {
  switch (event.type) {
    case "assistant_delta":
      process.stderr.write(event.text);
      break;
    case "assistant": {
      const names = event.message.toolCalls?.map((c) => c.name).join(", ");
      if (names) {
        process.stderr.write("\n");
        console.error(`[assistant] tools=${names}`);
      } else if (event.message.content) {
        process.stderr.write("\n");
      }
      break;
    }
    case "tool_start":
      console.error(`[tool_start] ${event.call.name} id=${event.call.id}`);
      break;
    case "tool_end": {
      const preview = previewContent(event.result.content, 80);
      console.error(
        `[tool_end] ${event.call.name} isError=${Boolean(event.result.isError)} preview=${preview}`,
      );
      break;
    }
    case "max_turns":
      console.error(`[max_turns] reached limit ${event.maxTurns}; partial history preserved`);
      break;
    case "done":
      console.error(`[done] messages=${event.messages.length}`);
      break;
    case "subagent_start":
      console.error(`[subagent_start] id=${event.id} depth=${event.depth} task=${event.task.slice(0, 80)}${event.profile ? ` profile=${event.profile}` : ""}`);
      break;
    case "subagent_event":
      // Show inner events with indentation based on depth
      if (event.inner.type === "assistant_delta") {
        process.stderr.write(event.inner.text);
      } else if (event.inner.type === "tool_start") {
        console.error(`${'  '.repeat(event.depth)}[sub:tool_start] ${event.inner.call.name}`);
      } else if (event.inner.type === "tool_end") {
        const subPreview = previewContent(event.inner.result.content, 60);
        console.error(`${'  '.repeat(event.depth)}[sub:tool_end] ${event.inner.call.name} preview=${subPreview}`);
      }
      break;
    case "subagent_end":
      console.error(`[subagent_end] id=${event.id} depth=${event.depth} success=${event.success} turns=${event.turns} tokens=${event.totalTokens}`);
      break;
  }
}

function isPathInsideCwd(resolvedPath: string, cwd: string): boolean {
  const relative = path.relative(cwd, resolvedPath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function parseCliArgs(argv: string[]): {
  prompt: string;
  imagePaths: string[];
  tools?: ToolName[];
  excludeTools?: ToolName[];
  allowMcpTools: boolean;
} {
  const imagePaths: string[] = [];
  const rest: string[] = [];
  let tools: ToolName[] | undefined;
  let excludeTools: ToolName[] | undefined;
  let allowMcpTools = false;
  const validTools = new Set<ToolName>(["read", "bash", "edit", "write", "grep", "find", "ls", "codebase_open", "codebase_search", "codebase_read", "codebase_explain", "subagent"]);
  const parseToolList = (value: string, flag: string): ToolName[] => {
    const names = value.split(",").map((name) => name.trim()).filter(Boolean);
    for (const name of names) {
      if (!validTools.has(name as ToolName)) throw new Error(`Unknown tool in ${flag}: ${name}`);
    }
    return names as ToolName[];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--image") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("--image requires a path argument");
      }
      imagePaths.push(next);
      i += 1;
      continue;
    }
    if (arg === "--allow-mcp-tools") {
      allowMcpTools = true;
      continue;
    }
    if (arg.startsWith("--image=")) {
      const p = arg.slice("--image=".length);
      if (!p) throw new Error("--image= requires a path");
      imagePaths.push(p);
      continue;
    }
    if (arg === "--tools" || arg === "--exclude-tools") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) throw new Error(`${arg} requires a comma-separated tool list`);
      if (arg === "--tools") tools = parseToolList(next, arg);
      else excludeTools = parseToolList(next, arg);
      i += 1;
      continue;
    }
    if (arg.startsWith("--tools=") || arg.startsWith("--exclude-tools=")) {
      const isExclude = arg.startsWith("--exclude-tools=");
      const flag = isExclude ? "--exclude-tools" : "--tools";
      const value = arg.slice(flag.length + 1);
      if (!value) throw new Error(`${flag}= requires a comma-separated tool list`);
      if (isExclude) excludeTools = parseToolList(value, flag);
      else tools = parseToolList(value, flag);
      continue;
    }
    rest.push(arg);
  }

  return { prompt: rest.join(" ").trim(), imagePaths, tools, excludeTools, allowMcpTools };
}

async function loadImagePart(
  relPath: string,
  cwd: string,
): Promise<ContentPart> {
  const target = path.resolve(cwd, relPath);
  if (!isPathInsideCwd(target, cwd)) {
    throw new Error(`Image path escapes workspace cwd: ${relPath}`);
  }
  const [realCwd, realTarget] = await Promise.all([
    realpath(cwd),
    realpath(target),
  ]);
  if (!isPathInsideCwd(realTarget, realCwd)) {
    throw new Error(`Image path resolves outside workspace cwd: ${relPath}`);
  }
  const ext = path.extname(target).toLowerCase();
  const mime = IMAGE_EXT[ext];
  if (!mime) {
    throw new Error(
      `Unsupported image type for ${relPath} (use png/jpeg/gif/webp)`,
    );
  }
  const buf = await readFile(realTarget);
  const max = 4 * 1024 * 1024;
  if (buf.byteLength > max) {
    throw new Error(`Image too large: ${relPath} (${buf.byteLength} bytes)`);
  }
  return imagePart(mime, buf.toString("base64"), relPath);
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const { prompt, imagePaths, tools: selectedTools, excludeTools, allowMcpTools } = parsed;
  if (!prompt && imagePaths.length === 0) {
    console.error(
      'Usage: npx tsx src/cli.ts "<prompt>" [--image path.png]...',
    );
    process.exit(1);
  }

  const cwd = process.cwd();
  const llm = loadLlmConfigFromEnv();
  const vision = loadVisionConfigFromEnv();
  console.error(
    `[config] model=${llm.model} vision=${llm.capabilities.input.includes("image")} policy=${llm.imagePolicy} preprocessor=${vision?.model ?? "disabled"}`,
  );

  let userContent: MessageContent | undefined;
  if (imagePaths.length > 0) {
    const parts: ContentPart[] = [
      textPart(
        prompt || "Please analyze the attached image(s).",
      ),
    ];
    for (const p of imagePaths) {
      parts.push(await loadImagePart(p, cwd));
    }
    userContent = parts;
  }

  const codebaseRuntime = createCodebaseRuntimeFromEnv();
  const mcpRuntime = await createMcpRuntimeFromEnv(cwd).catch(async (error) => {
    await codebaseRuntime.close();
    throw error;
  });
  let tools;
  try {
    tools = mcpRuntime.toolProvider(createTools(cwd, {
      tools: selectedTools,
      excludeTools,
      codebase: process.env.EXTERNAL_CODEBASE_ENABLED !== "0",
      codebaseStore: codebaseRuntime.store,
      codebaseProvider: codebaseRuntime.semanticProvider,
    }));
    tools();
  } catch (error) {
    await Promise.all([mcpRuntime.close(), codebaseRuntime.close()]);
    throw error;
  }
  for (const status of mcpRuntime.statuses()) {
    console.error(`[mcp] server=${status.id} state=${status.state} tools=${status.toolCount}${status.error ? ` error=${status.error}` : ""}`);
  }
  console.error(`[deepwiki] enabled=${codebaseRuntime.deepWikiEnabled}`);

  // ── Add subagent tool if enabled ────────────────────────────────────────────
  const enableSubagent = process.env.MINI_AGENT_SUBAGENT !== "0";
  if (enableSubagent) {
    const baseTools = resolveToolProvider(tools);
    const subagentTool = createSubagentTool({
      parentLlm: llm,
      parentTools: baseTools,
      profiles: defaultProfiles,
      preprocessors: vision ? [createVisionPreprocessor(vision)] : [],
      onSubagentEvent: (subEvent) => logEvent(subEvent),
    });
    const enrichedTools = [...baseTools, subagentTool as Tool];
    tools = () => enrichedTools;
  }

  let messages;
  try {
    messages = await runAgentLoop(prompt || "Please analyze the attached image(s).", {
      llm,
      tools,
      userContent,
      preprocessors: vision ? [createVisionPreprocessor(vision)] : [],
      authorizeTool: createMcpApprovalGate({
        allow: allowMcpTools,
        approvalHint: "Rerun with --allow-mcp-tools to approve remote MCP calls for this invocation.",
      }),
      onEvent: logEvent,
    });
  } catch (error) {
    if (!(error instanceof MaxTurnsExceededError)) throw error;
    messages = error.messages;
    console.error(`[max_turns] reached limit ${error.maxTurns}; returning partial history`);
  } finally {
    await Promise.all([mcpRuntime.close(), codebaseRuntime.close()]);
  }

  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");

  if (lastAssistant && lastAssistant.role === "assistant") {
    console.log(lastAssistant.content);
  } else {
    console.error("No assistant message produced.");
    process.exit(1);
  }
}

// Only run when this module is the entry point (not when imported by tests)
const isEntryPoint =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/")) ||
  import.meta.url === `file://${process.argv[1]}`;

if (isEntryPoint) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
