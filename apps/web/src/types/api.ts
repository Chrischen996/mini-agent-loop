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

export type WebRunStatus = "running" | "completed" | "paused" | "interrupted" | "failed";
export type WebRunReason =
  | "step_limit"
  | "budget_exhausted"
  | "safety_cap_reached"
  | "context_exhausted"
  | "stalled"
  | "waiting_user"
  | "user_stop"
  | "disconnected"
  | "server_restart"
  | "model_error"
  | "persistence_error";

export type WebRunBudgetUsage = {
  tokensUsed?: number;
  toolCallsUsed?: number;
  writeCallsUsed?: number;
  elapsedMs?: number;
};

export type WebRunPolicy = {
  tokenBudget?: number;
  toolCallBudget?: number;
  writeCallBudget?: number;
  deadlineMs?: number;
  maxCompactions?: number;
  emergencyIterationCap?: number;
  stallPolicy?: { sameActionLimit?: number; noProgressLimit?: number };
};

export type ContinueRunRequest = Pick<WebRunPolicy, "tokenBudget" | "toolCallBudget" | "writeCallBudget" | "deadlineMs"> & {
  budgetMode?: "new" | "remaining";
};

export type WebRunState = {
  runId: string;
  status: WebRunStatus;
  reason?: WebRunReason;
  details?: string;
  stepsUsed: number;
  maxSteps: number;
  budgetUsage?: WebRunBudgetUsage;
  cumulativeBudgetUsage?: WebRunBudgetUsage;
  budgetPolicy?: WebRunPolicy;
  budgetMode?: "new" | "remaining";
  lastFingerprint?: string;
  checkpointRevision: number;
  savedAt?: number;
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
  runState?: WebRunState | null;
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
  defaultThinkingLevel?: ThinkingLevel;
};

export type ModelsListResponse = {
  models: ModelOption[];
  defaultModel: string;
};

export type ModelProviderProtocol = "openai-completions" | "openai-responses" | "anthropic-messages";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type ThinkingCompat = {
  thinkingFormat?: "openai" | "deepseek" | "openrouter" | "qwen" | "qwen-chat-template" | "zai" | "together" | "string-thinking" | "ant-ling";
  supportsReasoningEffort?: boolean;
};
export type CustomModelDefinition = {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  tools?: boolean;
  reasoning?: boolean;
  reasoningEfforts?: false | Partial<Record<ThinkingLevel, string | null>>;
  defaultThinkingLevel?: ThinkingLevel;
  compat?: ThinkingCompat;
};

export type ModelProviderSummary = {
  provider: string;
  displayName?: string;
  baseUrl: string;
  protocol: ModelProviderProtocol;
  keyConfigured: boolean;
  compat?: ThinkingCompat;
  models: CustomModelDefinition[];
};

export type ModelProviderInput = {
  provider: string;
  displayName?: string;
  baseUrl: string;
  protocol: ModelProviderProtocol;
  apiKey?: string;
  compat?: ThinkingCompat;
  models: CustomModelDefinition[];
};

export type ModelProviderListResponse = {
  providers: ModelProviderSummary[];
};

export type ModelProviderDiscoveryResponse = {
  compat?: ThinkingCompat;
  models: CustomModelDefinition[];
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
  defaultThinkingLevel?: ThinkingLevel;
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
