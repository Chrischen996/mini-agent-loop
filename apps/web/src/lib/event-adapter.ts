import type { HistoryMessage, PlanSummary, WireEvent } from "../types/api.ts";
import { runStopText } from "./run-state.ts";
import type { LoadingActivity } from "./loading.ts";
import { captureToolArgs, type ToolArgs } from "./tool-card.ts";

/**
 * Frontend view model for the chat area (doc 1.md §7.2-7.3).
 *
 * The adapter converts backend wire events into a flat list of display items.
 * Unknown event types are ignored so newer server events never break the UI.
 */
export type ChatItem =
  | { id: string; kind: "user"; text: string; attachments?: string[] }
  | { id: string; kind: "assistant"; text: string; reasoning: string; streaming: boolean }
  | {
      id: string;
      kind: "tool";
      toolCallId: string;
      name: string;
      status: "running" | "ok" | "error";
      preview: string;
      /** Workspace path for file rows. Presentation only. */
      path?: string;
      /** 1-based line the read call started from. Presentation only. */
      startLine?: number;
      /** Slim tool arguments for the row summary and expanded card. */
      args?: ToolArgs;
      /** Decoded input length used for write/edit size labels. */
      inputBytes?: number;
    }
  | { id: string; kind: "permission"; requestId: string; tool: string; risk: string; status: "pending" | "resolved" }
  | { id: string; kind: "note"; tone: "info" | "warn" | "error"; text: string; action?: "continue" };

export type StreamPhase = "idle" | "streaming" | "done" | "error" | "aborted" | "stopped" | "paused";

let nextId = 0;
function uid(): string {
  nextId += 1;
  return `i${nextId}`;
}

/** Extract display text from a message content (string or ContentPart[]). */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const record = part as Record<string, unknown>;
          if (typeof record.text === "string") return record.text;
          if (record.type === "image") return "[image]";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const record = part as Record<string, unknown>;
    if (record.type !== "text" || typeof record.text !== "string") return "";
    return record.text.replace(/\[Attached document:[\s\S]*?\[End attached document:[^\]]+\]/g, "").trim();
  }).filter(Boolean).join("\n").trim();
}

function attachmentNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const names = content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const record = part as Record<string, unknown>;
    if (record.type === "image" && typeof record.source === "string") return [record.source];
    if (record.type === "text" && typeof record.text === "string") {
      const name = record.text.match(/^\[Attached document:\s*([^,\]\n]+)/)?.[1];
      return name ? [name] : [];
    }
    return [];
  });
  return [...new Set(names)];
}


function toolPresentation(name: string, args: unknown): Pick<Extract<ChatItem, { kind: "tool" }>, "path" | "startLine" | "args" | "inputBytes"> {
  const captured = captureToolArgs(args);
  const record = captured.args;
  const isRead = name.trim().toLowerCase() === "read";
  const path = typeof record?.path === "string" && record.path.trim()
    ? record.path
    : typeof record?.file_path === "string" && record.file_path.trim()
      ? record.file_path
      : undefined;
  const offset = isRead && typeof record?.offset === "number" && Number.isFinite(record.offset)
    ? Math.max(1, Math.floor(record.offset))
    : undefined;
  return {
    ...captured,
    ...(path ? { path } : {}),
    ...(isRead && path ? { startLine: offset ?? 1 } : {}),
  };
}

function applyPresentation(item: Extract<ChatItem, { kind: "tool" }>, name: string, args: unknown): void {
  const presentation = toolPresentation(name, args);
  if (presentation.path) item.path = presentation.path;
  if (presentation.startLine) item.startLine = presentation.startLine;
  if (presentation.args) item.args = presentation.args;
  if (presentation.inputBytes !== undefined) item.inputBytes = presentation.inputBytes;
}

/** Convert persisted session history (GET /api/sessions/:id) into view items. */
export function historyToItems(messages: HistoryMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = extractUserText(message.content);
      const attachments = attachmentNames(message.content);
      if (text || attachments.length) items.push({ id: message.id ?? uid(), kind: "user", text, attachments });
    } else if (message.role === "assistant") {
      const text = extractText(message.content);
      if (text) {
        items.push({
          id: message.id ?? uid(),
          kind: "assistant",
          text,
          reasoning: "",
          streaming: false,
        });
      }
      for (const call of message.toolCalls ?? []) {
        // Refined later when the matching tool result message arrives.
        items.push({
          id: `t-${call.id}`,
          kind: "tool",
          toolCallId: call.id,
          name: call.name,
          status: "ok",
          preview: "",
          ...toolPresentation(call.name, call.arguments),
        });
      }
    } else {
      const preview = extractText(message.content).slice(0, 500);
      const status = message.isError ? "error" : "ok";
      const existing = items.find(
        (item): item is Extract<ChatItem, { kind: "tool" }> =>
          item.kind === "tool" && Boolean(message.toolCallId) && item.toolCallId === message.toolCallId,
      );
      if (existing) {
        existing.status = status;
        existing.preview = preview;
      } else {
        items.push({
          id: message.id ?? uid(),
          kind: "tool",
          toolCallId: message.toolCallId ?? "",
          name: message.name ?? "tool",
          status,
          preview,
        });
      }
    }
  }
  return items;
}

/** Incremental state machine applied to a single message stream. */
export class ChatStreamState {
  items: ChatItem[] = [];
  phase: StreamPhase = "idle";
  activity: LoadingActivity | null = null;
  private activeTools = new Map<string, string>();
  /** Latest plan summary from a `plan_updated` event; null when no plan exists. */
  currentPlan: PlanSummary | null = null;

  /** Replace view state with persisted history (session (re)activation). */
  loadHistory(messages: HistoryMessage[]): void {
    this.items = historyToItems(messages);
    this.phase = "idle";
    this.currentPlan = null;
    this.activity = null;
    this.activeTools.clear();
  }

  beginTurn(now = Date.now()): void {
    this.phase = "streaming";
    this.activity = { label: "Working", startedAt: now, labelStartedAt: now };
    this.activeTools.clear();
  }

  private updateActivity(label: string): void {
    const now = Date.now();
    if (!this.activity) this.beginTurn(now);
    if (this.activity!.label !== label) this.activity = { ...this.activity!, label, labelStartedAt: now };
  }

  private refreshToolActivity(): void {
    const running = [...this.activeTools.values()].at(-1);
    this.updateActivity(running ? `Running ${running}` : "Working");
  }

  apply(event: WireEvent): void {
    switch (event.type) {
      case "user": {
        if (!this.activity) this.beginTurn();
        const text = extractText(event.content);
        const attachments = [...(Array.isArray(event.images) ? event.images : []), ...(Array.isArray(event.documents) ? event.documents : [])].filter((name): name is string => typeof name === "string");
        if (text || attachments.length) this.items.push({ id: uid(), kind: "user", text, attachments });
        this.phase = "streaming";
        break;
      }
      case "assistant_delta": {
        this.updateActivity(event.kind === "reasoning" ? "Thinking" : "Responding");
        const item = this.ensureAssistant();
        if (event.kind === "reasoning") item.reasoning += String(event.text ?? "");
        else item.text += String(event.text ?? "");
        this.phase = "streaming";
        break;
      }
      case "assistant_deltas": {
        this.updateActivity(event.answer ? "Responding" : "Thinking");
        const item = this.ensureAssistant();
        if (typeof event.reasoning === "string") item.reasoning += event.reasoning;
        if (typeof event.answer === "string") item.text += event.answer;
        this.phase = "streaming";
        break;
      }
      case "assistant": {
        this.updateActivity("Working");
        // A full assistant message boundary. If no deltas streamed (non-streaming
        // or empty-delta response), fall back to the event content so the reply
        // still renders. Deltas already set item.text, so only fill when empty.
        const text = extractText(event.content);
        const last = this.items[this.items.length - 1];
        if (text && last && last.kind === "assistant" && last.streaming && !last.text) {
          last.text = text;
        } else if (text && !(last && last.kind === "assistant")) {
          this.items.push({ id: uid(), kind: "assistant", text, reasoning: "", streaming: false });
        }
        this.closeAssistant();
        break;
      }
      case "tool_start": {
        const toolCallId = String(event.id ?? "");
        if (!this.activity) this.beginTurn();
        this.activeTools.set(toolCallId, String(event.name ?? "tool"));
        const existing = this.items.find(
          (item): item is Extract<ChatItem, { kind: "tool" }> =>
            item.kind === "tool" && item.toolCallId === toolCallId,
        );
        if (existing) {
          existing.status = "running";
          applyPresentation(existing, String(event.name ?? existing.name), event.arguments);
        } else {
          this.items.push({
            id: `t-${toolCallId}`,
            kind: "tool",
            toolCallId,
            name: String(event.name ?? "tool"),
            status: "running",
            preview: "",
            ...toolPresentation(String(event.name ?? "tool"), event.arguments),
          });
        }
        this.refreshToolActivity();
        break;
      }
      case "tool_end": {
        const toolCallId = String(event.id ?? "");
        this.activeTools.delete(toolCallId);
        const item = this.items.find(
          (candidate): candidate is Extract<ChatItem, { kind: "tool" }> =>
            candidate.kind === "tool" && candidate.toolCallId === toolCallId,
        );
        if (item) {
          item.status = event.isError ? "error" : "ok";
          item.preview = String(event.preview ?? "").slice(0, 500);
          applyPresentation(item, String(event.name ?? item.name), event.arguments);
        }
        this.refreshToolActivity();
        break;
      }
      case "permission_required": {
        this.updateActivity("Waiting for permission");
        const requestId = String(event.requestId ?? "");
        const existing = this.items.find(
          (candidate): candidate is Extract<ChatItem, { kind: "permission" }> =>
            candidate.kind === "permission" && candidate.requestId === requestId,
        );
        if (existing) {
          existing.status = "pending";
        } else {
          this.items.push({
            id: `p-${requestId}`,
            kind: "permission",
            requestId,
            tool: String(event.tool ?? ""),
            risk: String(event.risk ?? ""),
            status: "pending",
          });
        }
        break;
      }
      case "error":
        this.activity = null;
        this.closeAssistant();
        this.phase = "error";
        this.items.push({ id: uid(), kind: "note", tone: "error", text: String(event.message ?? "Unknown error") });
        break;
      case "aborted":
        this.activity = null;
        this.closeAssistant();
        this.phase = "aborted";
        this.items.push({ id: uid(), kind: "note", tone: "info", text: String(event.message ?? "Generation stopped") });
        break;
      case "done":
        this.activity = null;
        this.closeAssistant();
        this.phase = "done";
        break;
      case "context_compacted":
        this.updateActivity("Working");
        this.items.push({
          id: uid(),
          kind: "note",
          tone: "info",
          text: `Context compacted: ${String(event.beforeTokens)} -> ${String(event.afterTokens)} tokens (${String(event.reason ?? "")})`,
        });
        break;
      case "max_turns":
        this.activity = null;
        this.closeAssistant();
        this.phase = "paused";
        this.items.push({
          id: uid(),
          kind: "note",
          tone: "warn",
          text: (event as { message?: string }).message ?? `Auto-continue limit reached (${String(event.maxTurns)} model turns); progress saved. Use Continue to resume.`,
          action: "continue",
        });
        break;
      case "run_stopped": {
        this.activity = null;
        this.closeAssistant();
        this.phase = "paused";
        this.items.push({
          id: uid(),
          kind: "note",
          tone: "warn",
          text: runStopText({ ...event, reason: event.stopReason }),
          action: "continue",
        });
        break;
      }
      case "auto_continue":
        this.updateActivity("Continuing");
        this.closeAssistant();
        this.phase = "streaming";
        this.items.push({
          id: uid(),
          kind: "note",
          tone: "info",
          text: (event as { message?: string }).message ?? "Turn limit reached, continuing...",
        });
        break;
      case "request_retry":
        this.updateActivity("Reconnecting");
        break;
      case "retry_attempt":
        this.updateActivity("Reconnecting");
        this.items.push({
          id: uid(),
          kind: "note",
          tone: "warn",
          text: `Retrying (${String(event.attempt)}/${String(event.maxRetries)}): ${String(event.errorMessage ?? "")}`,
        });
        break;
      case "model_switched":
        this.items.push({
          id: uid(),
          kind: "note",
          tone: "info",
          text: `Model switched: ${String(event.previousModel)} -> ${String(event.nextModel)}`,
        });
        break;
      case "attempt_reset":
        this.updateActivity("Reconnecting");
        this.items.push({
          id: uid(),
          kind: "note",
          tone: "info",
          text: `Attempt reset (${String(event.reason)})`,
        });
        break;
      case "subagent_start":
        this.items.push({
          id: uid(),
          kind: "note",
          tone: "info",
          text: `Subagent started (${String(event.profile ?? "")}): ${String(event.task ?? "").slice(0, 120)}`,
        });
        break;
      case "budget_warning":
        this.items.push({
          id: uid(),
          kind: "note",
          tone: "warn",
          text: `Token budget ${String(event.percentage ?? "")}% used (${String(event.used)}/${String(event.limit)})`,
        });
        break;
      case "plan_updated":
        // The plan summary is embedded in the `plan` field.
        this.currentPlan = (event.plan ?? null) as PlanSummary | null;
        if (this.currentPlan) {
          this.items.push({
            id: uid(),
            kind: "note",
            tone: "info",
            text: `Plan ${this.currentPlan.status}: ${String(this.currentPlan.prompt ?? "").slice(0, 60)}`,
          });
        }
        break;
      default:
        // Plan-act events arrive as { eventType, ... } without `type`
        // (doc §7.2: adapt to the real protocol, do not fabricate events).
        // The PlanPanel in P4 will interpret these; P3 surfaces them minimally.
        if (typeof event.eventType === "string") {
          this.items.push({ id: uid(), kind: "note", tone: "info", text: `Plan event: ${event.eventType}` });
        }
        // Unknown event types are intentionally ignored (forward-compatible).
    }
  }

  private ensureAssistant(): Extract<ChatItem, { kind: "assistant" }> {
    const last = this.items[this.items.length - 1];
    if (last && last.kind === "assistant" && last.streaming) return last;
    const item: Extract<ChatItem, { kind: "assistant" }> = {
      id: uid(),
      kind: "assistant",
      text: "",
      reasoning: "",
      streaming: true,
    };
    this.items.push(item);
    return item;
  }

  private closeAssistant(): void {
    // The streaming assistant item is not necessarily the last item (tool
    // activity can be interleaved), so search backwards for it.
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const item = this.items[i]!;
      if (item.kind === "assistant" && item.streaming) {
        item.streaming = false;
        break;
      }
    }
  }
}
