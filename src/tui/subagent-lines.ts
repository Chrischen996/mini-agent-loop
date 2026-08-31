import type { ChatMessage, SubagentInnerEvent } from "./state.ts";
import type { RenderLine } from "./render-lines.ts";
import { toolArgumentSummary } from "./claude-style.ts";
import { toolVisualName } from "./tool-lines.ts";
import { terminalStringWidth } from "./terminal-width.ts";

type SubagentMessage = Extract<ChatMessage, { kind: "subagent_call" }>;

export type SubagentRenderOptions = {
  /** Number of recent progress rows shown in the collapsed view. */
  maxProgress?: number;
  /** Use a compact one-line summary when the terminal is constrained. */
  compact?: boolean;
  /** Available terminal columns for keeping the agent title on one row. */
  width?: number;
};

const DEFAULT_MAX_PROGRESS = 3;
const SUBAGENT_TOOL_NAMES = new Set(["subagent", "subagent_batch"]);

export function isSubagentToolName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (SUBAGENT_TOOL_NAMES.has(normalized)) return true;
  // Providers may namespace tools as `functions.subagent` or
  // `mcp.subagent_batch`. Keep those protocol rows hidden as well; the
  // lifecycle event below is the user-facing representation.
  return /(?:^|[.:/])subagent(?:_batch)?$/.test(normalized);
}

/**
 * Some OpenAI-compatible gateways flatten a function call into assistant text
 * instead of populating `toolCalls`. Treat only the unmistakable serialized
 * subagent form as protocol noise; normal assistant prose remains visible.
 */
export function isSubagentProtocolText(text: string): boolean {
  const value = text.trim();
  // Keep provider namespaces (`functions.subagent`, `mcp.subagent_batch`)
  // out of the transcript too. The strict call-shaped prefix prevents normal
  // prose such as "Please explain subagent(...)" from being hidden.
  return /^(?:(?:[a-z0-9_-]+[.:/])*)(?:subagent|subagent_batch)\s*\(/i.test(value)
    && /\btask\s*[:=]/i.test(value);
}

/** Hide the auto-preflight scaffold and keep the actual user task as the title. */
export function displaySubagentTask(task: string): string {
  let value = task
    .replace(/\\r?n/g, "\n")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!value) return "";

  // Some OpenAI-compatible gateways preserve the serialized argument wrapper
  // when they emit a lifecycle event. It is protocol chrome, not the task the
  // user should see.
  value = value.replace(/^(?:task|prompt)\s*[:=]\s*/i, "").trim();

  // The preflight builder is intentionally private to the agent loop, but
  // gateways can normalize whitespace or change the colon to a full-width
  // variant. Match the semantic boundary instead of requiring one exact
  // serialized prompt.
  const requestMarker = /(?:^|\n)\s*(?:user\s+request|user\s+task|request|用户请求|用户任务)\s*[:：]\s*/i.exec(value);
  const firstLine = value.split("\n", 1)[0] ?? "";
  const hasScaffoldHeader = /^\s*you are .*subagent\b/i.test(firstLine);
  if (requestMarker && hasScaffoldHeader) {
    const suffix = value.slice(requestMarker.index + requestMarker[0].length).trim();
    return compactTask(suffix);
  }

  // A few providers omit the final marker while retaining the known
  // preflight instructions. Strip only those exact scaffold lines; arbitrary
  // user prompts containing "subagent" remain untouched.
  const lines = value.split("\n");
  if (/^\s*you are .*subagent\b/i.test(lines[0] ?? "")) {
    const visible = lines.filter((line) => !isScaffoldLine(line));
    return compactTask(visible.join(" "));
  }
  return compactTask(value);
}

function isScaffoldLine(line: string): boolean {
  const normalized = line.trim();
  return /^(?:you are .*subagent\b|focus only on .* for this request\.?|gather only the key facts.*\.?|prefer targeted read\/grep\/find over broad exploration\.?|if the full request is large, .* first\.?|finish with a plain-text (?:findings|review) summary.*\.?|do not implement code changes\.?|inspect the most relevant files only; avoid exhaustive repo walks\.?|finish with a plain-text review summary:.*)$/i.test(normalized);
}

/** Keep the title stable and single-line while preserving the user's task. */
function compactTask(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  // A subagent row is progress chrome, not a second prompt. Keep enough of the
  // task to identify the worker while leaving room for tool/token stats.
  const max = 96;
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

/** Claude Code-style compact token formatting. */
export function formatSubagentNumber(value: number): string {
  if (value >= 1_000_000) return `${trimNumber(value / 1_000_000)}m`;
  if (value >= 1_000) return `${trimNumber(value / 1_000)}k`;
  return String(Math.max(0, Math.round(value)));
}

function trimNumber(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
}

function toolEventText(event: SubagentInnerEvent): string {
  if (event.type === "tool_start" || event.type === "tool_end") {
    const raw = event.label.replace(/^[▶✓✗]\s*/, "");
    const [name, ...rest] = raw.split(/\s+/, 2);
    const visualName = toolVisualName(name || "tool");
    const detail = event.detail?.trim();
    if (detail) {
      const summary = toolArgumentSummary(name || "tool", {}, detail).replace(/^\$\s*/, "");
      return `${visualName}${summary ? `(${summary})` : rest.join(" ") ? ` ${rest.join(" ")}` : ""}`;
    }
    return `${visualName}${rest.length ? ` ${rest.join(" ")}` : ""}`;
  }
  return event.label.replace(/^[▶✓✗]\s*/, "");
}

function latestActivity(message: SubagentMessage): string {
  if (message.lastToolInfo) return message.lastToolInfo;
  const last = [...message.innerEvents].reverse().find((event) => event.type === "tool_start" || event.type === "tool_end")
    ?? message.innerEvents.at(-1);
  return last ? toolEventText(last) : "Initializing…";
}

function stats(message: SubagentMessage): string {
  // A running tool has a start event before its end event. Count it in the
  // progress label so the live row never says "0 tool uses" while work is
  // visibly happening.
  const observedToolStarts = message.innerEvents.filter((event) => event.type === "tool_start").length;
  const toolCount = Math.max(message.toolCallCount, observedToolStarts);
  const parts = [`${toolCount} tool ${toolCount === 1 ? "use" : "uses"}`];
  if (message.totalTokens !== undefined && message.totalTokens > 0) {
    parts.push(`${formatSubagentNumber(message.totalTokens)} tokens`);
  }
  return parts.join(" · ");
}

function duration(message: SubagentMessage): string {
  if (message.durationMs === undefined) return "";
  if (message.durationMs < 1_000) return `${message.durationMs}ms`;
  return `${(message.durationMs / 1_000).toFixed(1).replace(/\.0$/, "")}s`;
}

function compactResult(value: string, max = 150): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  const recovered = /^No final assistant summary was produced\.\s*Recovered recent tool output:\s*/i.exec(oneLine);
  const visible = recovered ? `Recovered: ${oneLine.slice(recovered[0].length)}` : oneLine;
  return visible.length <= max ? visible : `${visible.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Project one subagent lifecycle state into Claude Code-style transcript rows.
 * This function is presentation-only: it never changes the agent history or
 * the reducer state, and is shared by Ink and the ANSI terminal entrypoint.
 */
export function subagentRenderLines(
  message: SubagentMessage,
  indexOrKey: number | string,
  options: SubagentRenderOptions = {},
): RenderLine[] {
  const key = String(indexOrKey);
  const isRunning = message.status === "running";
  const isError = message.status === "error";
  const maxProgress = Math.max(1, options.maxProgress ?? DEFAULT_MAX_PROGRESS);
  const agentName = message.profile ?? "Agent";
  const task = fitTaskToWidth(displaySubagentTask(message.task), options.width);
  const title = `${agentName}${task ? ` (${task})` : ""}`;
  const marker = isError ? "✗ " : "⏺ ";

  if (options.compact) {
    return [{
      key: `message-${key}-subagent`,
      text: `${title} · ${stats(message)}`,
      prefix: marker,
      style: "tool",
      tone: undefined,
      prefixTone: isError ? "error" : isRunning ? "running" : "success",
      bold: false,
      dim: isRunning,
      ephemeral: isRunning,
    }];
  }

  const lines: RenderLine[] = [{
    key: `message-${key}-subagent`,
    text: `${title} · ${stats(message)}`,
    prefix: marker,
    style: "tool",
    // Keep the title informational even when the worker failed. The red
    // marker and status communicate failure; colouring the whole task title
    // makes a long diagnostic dominate the transcript.
    tone: undefined,
    prefixTone: isError ? "error" : isRunning ? "running" : "success",
    bold: false,
    dim: isRunning,
    // The progress row is part of the live tail until the worker resolves.
    // Without this marker, a changing tool count creates a second committed
    // copy in main-screen scrollback on every inner event.
    ephemeral: isRunning,
  }];

  const events = message.innerEvents;
  if (message.expanded) {
    // Assistant lifecycle notifications are internal bookkeeping. Claude Code
    // keeps the expanded subagent view focused on concrete tool activity and
    // errors, so do not surface a noisy "💬 assistant" row for every turn.
    const visibleEvents = events.filter((event) => event.type !== "assistant");
    const visible = visibleEvents.slice(-Math.max(maxProgress, visibleEvents.length));
    visible.forEach((event, eventIndex) => {
      const isLast = eventIndex === visible.length - 1;
      lines.push({
        key: `message-${key}-subagent-event-${eventIndex}`,
        text: toolEventText(event),
        prefix: `  ${isLast ? "└─" : "├─"} ⎿ `,
        style: event.type === "error" ? "error" : "muted",
        tone: event.type === "error" ? "error" : undefined,
        dim: event.type !== "error",
      });
    });
  }

  if (!message.expanded && isRunning) {
    lines.push({
      key: `message-${key}-subagent-status`,
      text: latestActivity(message),
      prefix: "  ⎿ ",
      style: "muted",
      prefixTone: "running",
      dim: true,
    });
  } else if (!message.expanded && !isRunning) {
    const completion = isError ? "Failed" : `Done (${[stats(message), duration(message)].filter(Boolean).join(" · ")})`;
    lines.push({
      key: `message-${key}-subagent-status`,
      text: completion,
      prefix: "  ⎿ ",
      style: isError ? "error" : "muted",
      tone: isError ? "error" : "success",
      dim: !isError,
    });
    if (!message.result) return lines;
    lines.push({
      key: `message-${key}-subagent-result`,
      text: compactResult(message.result),
      prefix: "     ",
      // Keep the failure marker/status red; the recovered diagnostic itself is
      // secondary information and should not paint the whole transcript red.
      style: "muted",
      tone: undefined,
      dim: true,
    });
  } else if (!message.expanded || events.length === 0) {
    lines.push({
      key: `message-${key}-subagent-status`,
      text: isError ? "Failed" : isRunning ? latestActivity(message) : "Done",
      prefix: "  ⎿ ",
      style: isError ? "error" : "muted",
      tone: isError ? "error" : "success",
      prefixTone: isRunning ? "running" : undefined,
      dim: !isError,
    });
  }

  return lines;
}

function fitTaskToWidth(task: string, width?: number): string {
  if (!task || width === undefined) return task;
  // Leave room for the marker, profile name, stats and a small gutter. This
  // keeps the progress row stable while the worker's events update below it.
  const budget = Math.max(16, width - 34);
  if (terminalStringWidth(task) <= budget) return task;
  let result = "";
  let used = 0;
  for (const grapheme of [...task]) {
    const glyphWidth = Math.max(1, terminalStringWidth(grapheme));
    if (used + glyphWidth > Math.max(1, budget - 1)) break;
    result += grapheme;
    used += glyphWidth;
  }
  return `${result.trimEnd()}…`;
}

export function subagentRenderLineCount(message: SubagentMessage, options: SubagentRenderOptions = {}): number {
  return subagentRenderLines(message, "measure", options).length;
}
