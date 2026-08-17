#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { imagePart, textPart } from "./content.ts";
import { loadLlmConfigFromEnv } from "./llm/index.ts";
import { MaxTurnsExceededError, previewContent, runAgentLoop, type AgentRuntimeRef, type LoopEvent } from "./loop.ts";
import { loadAgentsMd } from "./agents-md.ts";
import { savePlan, loadPlan, clearPlan, approvePlanAt } from "./plan-persist.ts";
import { parsePlan, formatPlanPreview, type PlanSummary } from "./plan-formatter.ts";
import { approvePlan, type ApprovalDecision } from "./plan-approval.ts";
import {
  createVisionPreprocessor,
  loadVisionConfigFromEnv,
} from "./preprocessors/index.ts";
import { createTools, type ToolName } from "./tools/index.ts";
import { createMcpRuntimeFromEnv } from "./mcp/runtime.ts";
import { createCodebaseRuntimeFromEnv } from "./codebase/runtime.ts";
import {
  createSubagentTool,
  createSubagentBatchTool,
  defaultProfiles,
  loadAutoSubagentOptionsFromEnv,
} from "./subagent/index.ts";
import { resolveToolProvider, type Tool } from "./tools/types.ts";
import type { ContentPart, MessageContent } from "./types.ts";
import { buildIntenseLlm, parseThinkingCommandMode, parseThinkingIntensityPrompt } from "./think-intensity.ts";
import { loadThinkingModeFromEnv } from "./thinking-policy.ts";
import {
  PermissionManager,
  isPermissionMode,
  type PermissionMode,
  type PermissionRequest,
  type PermissionTurnContext,
} from "./permissions.ts";

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
    case "thinking_policy":
      console.error(`[thinking] mode=adaptive phase=${event.phase} level=${event.level} reasons=${event.reasons.join(",")}`);
      break;
    case "max_turns":
      console.error(`[max_turns] reached limit ${event.maxTurns}; partial history preserved`);
      break;
    case "done":
      console.error(`[done] messages=${event.messages.length}`);
      break;
    case "subagent_start":
      console.error(`[subagent_start] id=${event.id} depth=${event.depth} model=${event.runtime.model} provider=${event.runtime.provider} thinking=${event.runtime.thinkingMode} task=${event.task.slice(0, 80)}${event.profile ? ` profile=${event.profile}` : ""}`);
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
      console.error(`[subagent_end] id=${event.id} depth=${event.depth} success=${event.success} model=${event.runtime.model} turns=${event.turns} tokens=${event.totalTokens}${event.errors?.length ? ` errors=${event.errors.map((error) => error.kind).join(",")}` : ""}`);
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
  mode: PermissionMode;
  planOnly: boolean;
  planExecute: boolean;
  planYes: boolean;
} {
  const imagePaths: string[] = [];
  const rest: string[] = [];
  let tools: ToolName[] | undefined;
  let excludeTools: ToolName[] | undefined;
  let allowMcpTools = false;
  let mode: PermissionMode = "auto";
  let planOnly = false;
  let planExecute = false;
  let planYes = false;
  const validTools = new Set<ToolName>([
    "read", "bash", "edit", "write", "grep", "find", "ls",
    "codebase_open", "codebase_search", "codebase_read", "codebase_explain",
    "web_search", "fetch_content", "get_search_content", "source_check",
    "subagent", "git_status", "git_diff", "git_checkpoint", "git_undo", "git_branch_isolate",
    "validate_workspace",
  ]);
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
    if (arg === "--plan") {
      planOnly = true;
      continue;
    }
    if (arg === "--plan-execute") {
      planExecute = true;
      continue;
    }
    if (arg === "--yes") {
      planYes = true;
      continue;
    }
    if (arg === "--mode") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("--mode requires an argument: plan, manual, auto, or bypass");
      }
      if (!isPermissionMode(next)) {
        throw new Error("Invalid mode: use 'plan', 'manual', 'auto', or 'bypass'");
      }
      mode = next as PermissionMode;
      i += 1;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (!isPermissionMode(value)) {
        throw new Error("Invalid mode: use 'plan', 'manual', 'auto', or 'bypass'");
      }
      mode = value as PermissionMode;
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

  return { prompt: rest.join(" ").trim(), imagePaths, tools, excludeTools, allowMcpTools, mode, planOnly, planExecute, planYes };
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

  const { prompt: rawPrompt, imagePaths, tools: selectedTools, excludeTools, allowMcpTools, mode, planOnly, planExecute, planYes } = parsed;
  const thinking = parseThinkingIntensityPrompt(rawPrompt);
  const prompt = thinking.prompt;
  if (!prompt && imagePaths.length === 0) {
    console.error(
      'Usage: npx tsx src/cli.ts "<prompt>" [--image path.png]...',
    );
    process.exit(1);
  }

  const cwd = process.cwd();
  const agentsMd = await loadAgentsMd(cwd);

  // --plan flag: force plan mode and append plan-only instruction
  const effectiveMode = planOnly ? "plan" : planExecute ? "bypass" : mode;
  let planSuffix = planOnly
    ? "\n\n⚠️ PLAN-ONLY MODE: produce a detailed execution plan only. Do NOT call write/edit/bash tools. Output your plan as markdown and stop."
    : "";

  // --plan-execute: load saved plan, verify approval, prepend to prompt
  if (planExecute) {
    const savedPlan = await loadPlan(cwd);
    if (!savedPlan) {
      console.error("No saved plan found. Run with --plan first.");
      process.exit(1);
    }
    if (savedPlan.approval === "rejected") {
      console.error("[plan] REJECTED — cannot execute a rejected plan.");
      process.exit(1);
    }
    if (savedPlan.approval !== "approved" && !planYes) {
      // Auto-approve if --yes flag is set, otherwise require explicit approval
      const summary = parsePlan(savedPlan.prompt, savedPlan.plan);
      console.error("[plan] Plan exists but not approved. Run with --plan first to generate, or add --yes to auto-approve.");
      console.error(formatPlanPreview(summary));
      console.error("");
      console.error("Approve? (y/n): ");
      const rl = await import("node:readline").then((m) => m.createInterface({ input: process.stdin, output: process.stdout }));
      const answer = await new Promise<string>((resolve) => {
        rl.question("  > ", (a) => { rl.close(); resolve(a.trim().toLowerCase()); });
      });
      if (answer !== "y" && answer !== "yes") {
        console.error("[plan] Execution cancelled by user.");
        process.exit(0);
      }
      await approvePlanAt(cwd, "user");
      console.error("[plan] Approved.");
    }
    planSuffix = `\n\n## Saved Plan (approved)\n${savedPlan.plan}\n\nExecute the above plan. Do not deviate from it.`;
    console.error(`[plan] loaded plan for: ${savedPlan.prompt}`);
    await clearPlan(cwd);
  }
  const llm = loadLlmConfigFromEnv();
  const requestLlm = thinking.intensity
    ? buildIntenseLlm(llm, thinking.intensity)
    : llm;
  const thinkingMode = thinking.intensity
    ? "fixed"
    : parseThinkingCommandMode(rawPrompt) ?? loadThinkingModeFromEnv();
  const vision = loadVisionConfigFromEnv();
  console.error(
    `[config] model=${requestLlm.model} thinking=${requestLlm.thinkingLevel ?? "off"} vision=${requestLlm.capabilities.input.includes("image")} policy=${requestLlm.imagePolicy} preprocessor=${vision?.model ?? "disabled"}`,
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
  const parentRuntime: AgentRuntimeRef = {};
  try {
    const configuredTools = mcpRuntime.toolProvider(createTools(cwd, {
      tools: selectedTools,
      excludeTools,
      codebase: process.env.EXTERNAL_CODEBASE_ENABLED !== "0",
      codebaseStore: codebaseRuntime.store,
      codebaseProvider: codebaseRuntime.semanticProvider,
    }));
    tools = () => {
      const available = resolveToolProvider(configuredTools);
      return allowMcpTools ? available : available.filter((tool) => tool.source?.kind !== "mcp");
    };
    tools();
  } catch (error) {
    await Promise.all([mcpRuntime.close(), codebaseRuntime.close()]);
    throw error;
  }
  for (const status of mcpRuntime.statuses()) {
    console.error(`[mcp] server=${status.id} state=${status.state} tools=${status.toolCount}${status.error ? ` error=${status.error}` : ""}`);
  }
  console.error(`[deepwiki] enabled=${codebaseRuntime.deepWikiEnabled}`);

  const permissionManager = new PermissionManager(effectiveMode);
  let permissionTurn: PermissionTurnContext | undefined;
  const onPermissionRequest = (request: PermissionRequest) => {
      console.error(
        `[permission] mode=${permissionTurn?.mode ?? mode} tool=${request.tool} risk=${request.risk} request_id=${request.id}`,
      );
      if (permissionTurn?.mode === "manual" || permissionTurn?.mode === "auto") {
        // Non-interactive CLI cannot prompt. Deny immediately instead of hanging.
        permissionManager.resolve("cli_session", request.id, "deny");
        console.error(
          `[permission] denied in non-interactive CLI; use TUI/Web or --mode=bypass for unattended runs`,
        );
      }
  };

  // ── Add subagent tool if enabled ────────────────────────────────────────────
  const enableSubagent = process.env.MINI_AGENT_SUBAGENT !== "0";
  if (enableSubagent) {
    const baseTools = resolveToolProvider(tools);
    const subagentTool = createSubagentTool({
      parentLlm: requestLlm,
      parentTools: baseTools,
      profiles: defaultProfiles,
      preprocessors: vision ? [createVisionPreprocessor(vision)] : [],
      onSubagentEvent: (subEvent) => logEvent(subEvent),
      getPermissionTurn: () => permissionTurn,
      thinkingMode,
      parentRuntime,
    });
    const subagentBatchTool = createSubagentBatchTool({
      parentLlm: requestLlm,
      parentTools: baseTools,
      profiles: defaultProfiles,
      preprocessors: vision ? [createVisionPreprocessor(vision)] : [],
      onSubagentEvent: (subEvent) => logEvent(subEvent),
      getPermissionTurn: () => permissionTurn,
      thinkingMode,
      parentRuntime,
    });
    const enrichedTools = [...baseTools, subagentTool as Tool, subagentBatchTool as Tool];
    tools = () => enrichedTools;
  }

  let messages;
  console.error(`[config] mode=${effectiveMode}`);
  const activePermissionTurn = permissionManager.beginTurn("cli_session", onPermissionRequest);
  permissionTurn = activePermissionTurn;
  try {
    messages = await runAgentLoop(prompt + planSuffix || "Please analyze the attached image(s).", {
      llm: requestLlm,
      tools,
      autoSubagent: loadAutoSubagentOptionsFromEnv(),
      userContent,
      preprocessors: vision ? [createVisionPreprocessor(vision)] : [],
      permissionTurn: activePermissionTurn,
      autoValidate: process.env.MINI_AGENT_AUTO_VALIDATE === "1",
      validationWorkspace: process.cwd(),
      autoCheckpoint: process.env.MINI_AGENT_AUTO_CHECKPOINT === "1",
      thinkingMode,
      runtimeRef: parentRuntime,
      onEvent: logEvent,
      agentsMd,
    });
  } catch (error) {
    if (!(error instanceof MaxTurnsExceededError)) throw error;
    messages = error.messages;
    console.error(`[max_turns] reached limit ${error.maxTurns}; returning partial history`);
  } finally {
    activePermissionTurn.close();
    await Promise.all([mcpRuntime.close(), codebaseRuntime.close()]);
  }

  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");

  if (lastAssistant && lastAssistant.role === "assistant") {
    const answer = typeof lastAssistant.content === "string"
      ? lastAssistant.content
      : lastAssistant.content.map((p: any) => p.type === "text" ? p.text : "").join("");

    // --plan: save the generated plan to disk, show preview, ask for approval
    if (planOnly) {
      const planPath = await savePlan(cwd, prompt, answer, { approval: "pending" });
      console.log(answer);
      console.error(`\n[plan] saved to ${planPath}`);

      // Show formatted preview
      const summary = parsePlan(prompt, answer);
      console.error(formatPlanPreview(summary));

      if (planYes) {
        // Auto-approve in --yes mode
        await approvePlanAt(cwd, "auto--yes");
        console.error("[plan] auto-approved (--yes flag).");
        console.error("Run again with --plan-execute to execute this plan.");
      } else {
        console.error("");
        console.error("Plan saved. Review the summary above, then run:");
        console.error("  npx mini-agent-loop --plan-execute \"execute the plan\"");
        console.error("Or auto-approve with: --plan --yes");
      }
      return;
    }

    console.log(answer);
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
