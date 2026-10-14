/**
 * Wire types for the mini-agent-loop HTTP API.
 *
 * Shapes verified against src/server.ts and src/server/routes/ on the
 * feature/claude-code-terminal branch. The stream event type stays open:
 * plan-act events are emitted WITHOUT a `type` field (they carry `eventType`
 * instead), and new event types may appear server-side at any time.
 */

export type SessionSummary = {
  id: string;
  workspaceId?: string;
  workspaceName?: string;
  createdAt: number;
  lastActiveAt: number;
  busy: boolean;
  parentSessionId: string | null;
  forkedFromMessage: string | null;
  forkedFromMessageId: string | null;
  messageCount: number;
  preview?: string;
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  permissionMode?: string;
  modelId?: string | null; // absent until the session overrides the default model
  thinkingLevel: string;
  thinkingMode: string;
};

export type CreateSessionResponse = {
  id: string;
  workspaceId?: string;
  createdAt: number;
  permissionMode: string;
};

/**
 * A message as returned by GET /api/sessions/:id (safeMessage shape).
 * - user: content is normalized to a string
 * - assistant: content may be a ContentPart[]; toolCalls are redacted
 * - tool: toolCallId links it back to the assistant's tool call
 */
export type HistoryMessage = {
  role: "user" | "assistant" | "tool";
  id?: string;
  content: unknown;
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
  toolCallId?: string;
  name?: string;
  isError?: boolean;
};

export type SessionDetail = {
  id: string;
  busy: boolean;
  activeJobId: string | null;
  modelId?: string | null; // absent until the session overrides the default model
  model: string;
  thinkingMode: string;
  permissionMode: string;
  planStatus: string | null;
  thinkingLevel: string;
  messages: HistoryMessage[];
};

/** One NDJSON record streamed from POST /api/sessions/:id/messages. */
export type WireEvent = {
  type?: string;
  eventType?: string;
  [key: string]: unknown;
};

// ── Workspace (P4) ────────────────────────────────────────────────────────────

export type WorkspaceEntry = {
  name: string;
  path: string;
  type: "file" | "dir";
};

export type WorkspaceRecord = { id: string; name: string; path: string };

export type WorkspaceListResponse = {
  path: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
};

export type WorkspaceFilePreview = {
  path: string;
  name: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  /** text, or an image the preview can draw from a same-origin URL. */
  kind?: "text" | "image";
  content: string;
  /** 1-based line number of content[0]. */
  startLine: number;
  eof?: boolean;
};

// ── Models (P4) ───────────────────────────────────────────────────────────────

export type ModelOption = {
  id: string;
  name: string;
  provider: string;
  qualifiedId: string;
  capabilities: string[];
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  thinkingLevels: string[];
};

export type ModelsListResponse = {
  models: ModelOption[];
  defaultModel: string;
};

export type ModelSelectionResponse = {
  model: string;
  qualifiedId: string;
  provider: string;
  thinkingLevel: string;
};

export type ThinkingLevelResponse = {
  thinkingLevel: string;
  thinkingLevels: string[];
};

// ── Plan-Act events (P4) ──────────────────────────────────────────────────────

export type PlanStepSummary = {
  index: number;
  text: string;
  status: string;
  files?: string[];
};

export type PlanSummary = {
  id: string;
  status: string;
  prompt: string;
  approvedBy?: string;
  updatedAt?: number;
  files?: string[];
  steps?: PlanStepSummary[];
  changedFiles?: string[];
  missingPlannedFiles?: string[];
  unplannedFiles?: string[];
  auditReport?: string;
};
