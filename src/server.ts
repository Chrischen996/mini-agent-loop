import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import multer from "multer";
import { documentTextPart, MAX_ATTACHMENT_BYTES } from "./attachments.ts";
import { contentAsString, imagePart, textPart } from "./content.ts";
import { DocumentStore } from "./documents.ts";
import { SessionStore, type PersistedSession } from "./session-store.ts";
import { isAbortError, loadLlmConfigFromEnv, switchLlmModel, type ChatFn, type LlmConfig } from "./llm/index.ts";
import { getAvailableModels, resolveModel, searchModels } from "./models.ts";
import { getActiveProfile, loadProfileStore } from "./profile-store.ts";
import {
  createAgentHistory,
  runAgentTurn,
  type AgentRuntimeRef,
  type LoopEvent,
} from "./loop.ts";
import {
  createVisionPreprocessor,
  loadVisionConfigFromEnv,
  type MessagePreprocessor,
} from "./preprocessors/index.ts";
import { createTools } from "./tools/index.ts";
import { createRepositoryStoreFromEnv, RepositoryStore } from "./codebase/repository-store.ts";
import { createCodebaseRuntimeFromEnv } from "./codebase/runtime.ts";
import type { CodebaseSemanticProvider } from "./codebase/deepwiki-provider.ts";
import { createDocumentEditTool } from "./tools/document-edit.ts";
import { resolveToolProvider, type Tool, type ToolProvider } from "./tools/types.ts";
import type { AgentMessage, ContentPart } from "./types.ts";
import { createMcpRuntimeFromEnv, mergeToolSets } from "./mcp/runtime.ts";
import type { McpServerStatus } from "./mcp/types.ts";
import {
  createSubagentTool,
  createSubagentBatchTool,
  defaultProfiles,
  loadAutoSubagentOptionsFromEnv,
  type AutoSubagentOptions,
  type SubagentProfile,
} from "./subagent/index.ts";
import {
  activateSkillNames,
  defaultSkillRegistry,
  discoverWorkspaceSkills,
  loadSkillNamesFromEnv,
  uniqueSkillNames,
  type Skill,
  type SkillRegistry,
} from "./skills/index.ts";
import {
  listWorkspaceDirectory,
  validateReferencedPaths,
} from "./workspace.ts";
import {
  intensityToModelThinkingLevel,
  parseThinkingCommandMode,
  parseThinkingIntensityPrompt,
  withThinkingLevel,
} from "./think-intensity.ts";
import { loadThinkingModeFromEnv, type ThinkingMode } from "./thinking-policy.ts";
import type { ModelThinkingLevel } from "./pi-ai/types.ts";
import { PermissionManager, isPermissionMode, type PermissionDecision, type PermissionMode } from "./permissions.ts";
import { GitWorkflow } from "./git/workflow.ts";
import { formatValidationReport, runValidation, type ValidationStepName } from "./validation.ts";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 5;
const MAX_ATTACHMENTS = 5;
const DEFAULT_IMAGE_PROMPT = "Please analyze the attached image(s).";
const DEFAULT_REFERENCE_PROMPT = "请阅读引用的文件并说明要点";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sessionPlanRoot(dataRoot: string, sessionId: string): string {
  return path.join(dataRoot, "session-plans", sessionId);
}

function planSummaryPayload(plan: PlanDocument): Record<string, unknown> {
  return {
    id: plan.id,
    status: plan.status,
    prompt: plan.prompt.slice(0, 200),
    approvedBy: plan.approvedBy,
    updatedAt: plan.updatedAt,
    files: plan.files,
    steps: plan.steps?.map((s) => ({
      index: s.index,
      text: s.text.slice(0, 120),
      status: s.status ?? "todo",
      files: s.files,
    })),
    changedFiles: plan.execution?.changedFiles,
    missingPlannedFiles: plan.execution?.missingPlannedFiles,
    unplannedFiles: plan.execution?.unplannedFiles,
    auditReport: plan.execution?.auditReport,
  };
}

function planHttpError(error: unknown): { status: number; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (/no (saved )?plan/i.test(message) || /no plan found/i.test(message)) {
    return { status: 404, message };
  }
  if (/not approved|rejected|cannot execute/i.test(message)) {
    return { status: 400, message };
  }
  return { status: 500, message };
}

type Session = {
  id: string;
  messages: AgentMessage[];
  createdAt: number;
  busy: boolean;
  /** Per-session model identifier (e.g. "openai/gpt-4o-mini"). */
  modelId?: string;
  /** Per-session LLM config, overrides the server default when set. */
  llmOverride?: LlmConfig;
  /** Persisted per-session thinking level, if changed by /think. */
  thinkingLevel?: ModelThinkingLevel;
  /** Fixed or adaptive effort selection for subsequent session messages. */
  thinkingMode?: ThinkingMode;
  permissionManager: PermissionManager;
  parentSessionId?: string;
  forkedFromMessage?: number;
};

export type AgentServerOptions = {
  llm: LlmConfig;
  tools?: ToolProvider;
  preprocessors?: MessagePreprocessor[];
  chat?: ChatFn;
  workspace?: string;
  dataDir?: string;
  /**
   * Called after each inner turn (assistant response + tool results).
   * Return a {@link import("./loop.ts").NextTurnUpdate} to switch models or
   * adjust context options, or return `undefined` to keep current settings.
   */
  prepareNextTurn?: import("./loop.ts").AgentLoopOptions["prepareNextTurn"];
  /**
   * Optional relay registry.  When provided, `switchLlmModel()` calls inside
   * `prepareNextTurn` will automatically apply matching relay configuration
   * (baseUrl + key resolver) to the new model without extra boilerplate.
   *
   * Populated automatically from `MINI_AGENT_RELAY` when the server starts;
   * callers can also supply a programmatic registry here.
   */
  relayRegistry?: import("./relay.ts").RelayRegistry;
  codebaseEnabled?: boolean;
  codebaseStore?: RepositoryStore;
  codebaseProvider?: CodebaseSemanticProvider;
  deepWikiEnabled?: boolean;
  mcpTools?: ToolProvider;
  mcpStatuses?: McpServerStatus[] | (() => McpServerStatus[]);
  /** Pre-defined subagent profiles. When non-empty the `subagent` tool is registered. */
  subagentProfiles?: SubagentProfile[];
  /** Enable the subagent tool even without explicit profiles. Default: false. */
  subagentEnabled?: boolean;
  /** Optional code-level preflight delegation. Disabled unless enabled. */
  autoSubagent?: AutoSubagentOptions;
  autoValidate?: boolean;
  autoCheckpoint?: boolean;
  thinkingMode?: ThinkingMode;
  maxThinkingEscalations?: number;
  /** Default permission mode for new and restored Web sessions. */
  permissionMode?: PermissionMode;
  /** Skills to register before serving requests. */
  skills?: Skill[];
  /** Skill names to activate for new sessions. Combined with MINI_AGENT_SKILLS. */
  skillNames?: string[];
  /** Skill registry used for discovery and name resolution. */
  skillRegistry?: SkillRegistry;
  /** Optional home directory used when discovering user-level skills. */
  skillHome?: string;
};

function safeMessage(message: AgentMessage): Record<string, unknown> {
  if (message.role === "system" || message.role === "assistant") {
    return {
      role: message.role,
      content: message.content,
      ...(message.role === "assistant" && message.toolCalls
        ? {
            toolCalls: message.toolCalls.map((call) => ({
              id: call.id,
              name: call.name,
              arguments: redactSensitiveArguments(call.arguments),
            })),
          }
        : {}),
    };
  }
  if (message.role === "user") {
    return { role: "user", content: contentAsString(message.content) };
  }
  return {
    role: "tool",
    toolCallId: message.toolCallId,
    name: message.name,
    content: contentAsString(message.content),
    isError: Boolean(message.isError),
  };
}

function safeEvent(event: LoopEvent): Record<string, unknown> {
  switch (event.type) {
    case "assistant_delta":
      return {
        type: "assistant_delta",
        text: event.text,
        kind: event.kind,
      };
    case "context_compacted":
      return {
        type: "context_compacted",
        beforeTokens: event.beforeTokens,
        afterTokens: event.afterTokens,
        reason: event.reason,
      };
    case "assistant":
      return {
        type: "assistant",
        content: event.message.content,
        tools: event.message.toolCalls?.map((call) => call.name) ?? [],
      };
    case "error":
      return { type: "error", message: event.message };
    case "max_turns":
      return {
        type: "max_turns",
        maxTurns: event.maxTurns,
        messageCount: event.messages.length,
      };
    case "tool_start":
      return {
        type: "tool_start",
        id: event.call.id,
        name: event.call.name,
        arguments: redactSensitiveArguments(event.call.arguments),
      };
    case "tool_end":
      return {
        type: "tool_end",
        id: event.call.id,
        name: event.call.name,
        isError: Boolean(event.result.isError),
        preview: contentAsString(event.result.content).slice(0, 500),
      };
    case "auto_subagent":
      return {
        type: "auto_subagent",
        shouldDelegate: event.shouldDelegate,
        executed: event.executed,
        coordinatorMode: event.coordinatorMode,
        score: event.score,
        profile: event.profile,
        reasons: event.reasons.slice(0, 12),
      };
    case "coordinator_mode":
      return {
        type: "coordinator_mode",
        active: event.active,
        profile: event.profile,
        preflightExecuted: event.preflightExecuted,
        maxDirectExploration: event.maxDirectExploration,
        directExplorationUsed: event.directExplorationUsed,
        reasons: event.reasons.slice(0, 12),
      };
    case "thinking_policy":
      return {
        type: "thinking_policy",
        mode: event.mode,
        phase: event.phase,
        previousLevel: event.previousLevel,
        level: event.level,
        score: event.score,
        reasons: event.reasons.slice(0, 12),
      };
    case "permission_required":
      return {
        type: "permission_required",
        requestId: event.request.id,
        tool: event.request.tool,
        arguments: redactSensitiveArguments(event.request.arguments),
        risk: event.request.risk,
        source: event.request.source,
      };
    case "aborted":
      return {
        type: "aborted",
        message: "已停止生成",
        messageCount: event.messages.length,
        ...(event.reason ? {
          reason: event.reason,
          previousMode: event.previousMode,
          permissionMode: event.permissionMode,
        } : {}),
      };
    case "plan_act_event":
      return { type: "plan_act_event", event: safePlanActEvent(event.event) };
    case "plan_act_event":
      return { type: "plan_act_event", eventType: event.event.type, ...event.event };
    case "done":
      return { type: "done", messageCount: event.messages.length };
    case "model_switched":
      return {
        type: "model_switched",
        previousModel: event.previousModel,
        nextModel: event.nextModel,
        turn: event.turn,
      };
    case "retry_attempt":
      return {
        type: "retry_attempt",
        errorType: event.errorType,
        attempt: event.attempt,
        maxRetries: event.maxRetries,
        delayMs: event.delayMs,
        errorMessage: event.errorMessage.slice(0, 200),
      };
    case "subagent_start":
      return {
        type: "subagent_start",
        id: event.id,
        task: event.task.slice(0, 500),
        profile: event.profile,
        depth: event.depth,
        runtime: event.runtime,
      };
    case "subagent_event":
      return {
        type: "subagent_event",
        id: event.id,
        depth: event.depth,
        inner: safeEvent(event.inner),
      };
    case "subagent_end":
      return {
        type: "subagent_end",
        id: event.id,
        success: event.success,
        depth: event.depth,
        turns: event.turns,
        totalTokens: event.totalTokens,
        resultPreview: event.result.slice(0, 300),
        runtime: event.runtime,
        autoDelegationInherited: event.autoDelegationInherited,
        ...(event.errors ? {
          errors: event.errors.map((error) => ({
            kind: error.kind,
            message: error.message.slice(0, 500),
          })),
        } : {}),
      };
  }
}

function redactSensitiveArguments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveArguments);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
    key,
    /authorization|cookie|password|secret|token|api[_-]?key/i.test(key)
      ? "[REDACTED]"
      : redactSensitiveArguments(child),
  ]));
}

function isRetryableError(message: string): boolean {
  return /Vision provider .* is busy|Vision network error|Vision HTTP (429|502|503|504)/i.test(
    message,
  );
}

function sniffImageMime(buffer: Buffer): string | undefined {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}


function parseReferencedPathsField(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === "") return [];
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item));
  }
  if (typeof raw !== "string") {
    throw new Error("referencedPaths must be a JSON string array");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("referencedPaths must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("referencedPaths must be a JSON array");
  }
  return parsed.map((item) => String(item));
}

function formatReferencedBlock(paths: string[]): string {
  return [
    "Referenced workspace files (use the read tool; do not invent contents):",
    ...paths.map((item) => `- ${item}`),
  ].join("\n");
}

export function truncateSessionMessages(messages: AgentMessage[], visibleCount: number): AgentMessage[] {
  const system = messages.filter((message) => message.role === "system");
  const visible = messages.filter((message) => message.role !== "system").slice(0, visibleCount);
  for (let index = 0; index < visible.length; index += 1) {
    const message = visible[index];
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;
    const expected = new Set(message.toolCalls.map((call) => call.id));
    const found = new Set<string>();
    for (const candidate of visible.slice(index + 1)) {
      if (candidate.role === "tool") found.add(candidate.toolCallId);
      if (candidate.role === "user" || candidate.role === "assistant") break;
    }
    if ([...expected].some((id) => !found.has(id))) {
      visible.splice(index);
      break;
    }
  }
  return [...system, ...visible];
}

function visibleMessageCount(messages: AgentMessage[]): number {
  return messages.filter((message) => message.role !== "system").length;
}

export function buildModelPrompt(input: {
  prompt: string;
  referencedPaths: string[];
  hasImages: boolean;
}): {
  displayPrompt: string;
  modelPrompt: string;
  thinkingLevel: ModelThinkingLevel | null;
  thinkingMode: ThinkingMode | null;
} {
  const thinking = parseThinkingIntensityPrompt(input.prompt.trim());
  const text = thinking.prompt;
  const refs = input.referencedPaths;

  let displayPrompt = text;
  if (!displayPrompt) {
    if (refs.length > 0) displayPrompt = DEFAULT_REFERENCE_PROMPT;
    else if (input.hasImages) displayPrompt = "分析图片";
    else displayPrompt = "";
  }

  let base = text;
  if (!base) {
    if (refs.length > 0) base = DEFAULT_REFERENCE_PROMPT;
    else if (input.hasImages) base = DEFAULT_IMAGE_PROMPT;
  }

  const modelPrompt = refs.length > 0
    ? `${base}\n\n${formatReferencedBlock(refs)}`
    : base;

  return {
    displayPrompt,
    modelPrompt,
    thinkingLevel: thinking.intensity
      ? intensityToModelThinkingLevel(thinking.intensity)
      : null,
    thinkingMode: thinking.intensity ? "fixed" : parseThinkingCommandMode(input.prompt) ?? null,
  };
}

async function parseMessageRequest(
  request: Request,
  workspace: string,
  documentStore: DocumentStore,
  sessionId: string,
): Promise<{
  displayPrompt: string;
  modelPrompt: string;
  thinkingLevel: ModelThinkingLevel | null;
  thinkingMode: ThinkingMode | null;
  images: ContentPart[];
  imageNames: string[];
  documents: ContentPart[];
  documentNames: string[];
  referencedPaths: string[];
}> {
  const prompt = String(request.body?.prompt ?? "").trim();
  const fileFields = (request.files ?? {}) as Record<string, Express.Multer.File[]>;
  const imageFiles = fileFields.images ?? [];
  const documentFiles = fileFields.documents ?? [];
  const images: ContentPart[] = [];
  const imageNames: string[] = [];
  const documents: ContentPart[] = [];
  const documentNames: string[] = [];

  for (const file of imageFiles) {
    const mimeType = sniffImageMime(file.buffer);
    if (!mimeType) {
      throw new Error(`Unsupported or invalid image: ${file.originalname}`);
    }
    const source = file.originalname || `upload-${images.length + 1}`;
    images.push(imagePart(mimeType, file.buffer.toString("base64"), source));
    imageNames.push(source);
  }

  for (const file of documentFiles) {
    const parsed = await documentStore.addUpload(
      sessionId,
      file.originalname || "document",
      file.buffer,
      file.mimetype,
    );
    documents.push(textPart(documentTextPart(parsed, parsed.id)));
    documentNames.push(parsed.name);
  }

  const rawRefs = parseReferencedPathsField(request.body?.referencedPaths);
  const referencedPaths = await validateReferencedPaths(workspace, rawRefs);

  if (
    !parseThinkingIntensityPrompt(prompt).prompt &&
    images.length === 0 &&
    documents.length === 0 &&
    referencedPaths.length === 0
  ) {
    throw new Error("A prompt, image, document, or referenced path is required");
  }

  const built = buildModelPrompt({
    prompt,
    referencedPaths,
    hasImages: images.length > 0,
  });

  return {
    displayPrompt: built.displayPrompt,
    modelPrompt: built.modelPrompt,
    thinkingLevel: built.thinkingLevel,
    thinkingMode: built.thinkingMode,
    images,
    imageNames,
    documents,
    documentNames,
    referencedPaths,
  };
}

export function createAgentServer(options: AgentServerOptions): Express {
  const workspace = path.resolve(options.workspace ?? process.cwd());
  const sessions = new Map<string, Session>();
  const skillRegistry = options.skillRegistry ?? defaultSkillRegistry;
  if (options.skills) {
    for (const skill of options.skills) skillRegistry.register(skill);
  }
  const defaultSkillNames = uniqueSkillNames([
    ...(options.skillNames ?? []),
    ...loadSkillNamesFromEnv(),
  ]);
  const resolveSessionSkillNames = (session: Session): string[] =>
    activateSkillNames(session.skillNames, skillRegistry).activeNames;
  const skillDiscovery = discoverWorkspaceSkills(workspace, skillRegistry, options.skillHome);
  const envPermissionMode = process.env.MINI_AGENT_PERMISSION_MODE;
  // All entry points use plan unless an explicit mode is configured.
  const defaultPermissionMode: PermissionMode = options.permissionMode
    ?? (isPermissionMode(envPermissionMode) ? envPermissionMode : "plan");
  const dataRoot = path.resolve(options.dataDir ?? path.join(os.homedir(), ".mini-agent"));
  const codebaseEnabled = options.codebaseEnabled ?? process.env.EXTERNAL_CODEBASE_ENABLED !== "0";
  const codebaseStore = options.codebaseStore ?? (codebaseEnabled ? createRepositoryStoreFromEnv(path.join(dataRoot, "codebases")) : undefined);
  let tools: ToolProvider;
  if (options.tools) {
    tools = options.tools;
  } else {
    const localTools = createTools(workspace, {
      codebase: codebaseEnabled,
      codebaseStore,
      codebaseProvider: options.codebaseProvider,
    });
    tools = () => mergeToolSets(
      localTools,
      resolveToolProvider(options.mcpTools ?? []),
    );
  }
  const documentStore = new DocumentStore(path.join(dataRoot, "documents"));
  const sessionStore = new SessionStore(path.join(dataRoot, "sessions"));
  const gitWorkflow = new GitWorkflow(workspace);
  const persistedSession = (session: Session): PersistedSession => ({
    id: session.id,
    createdAt: session.createdAt,
    modelId: session.modelId,
    thinkingLevel: session.thinkingLevel,
    thinkingMode: session.thinkingMode,
    permissionMode: session.permissionManager.getMode(),
    phase: session.phase,
    currentPlan: session.currentPlan,
    messages: session.messages,
    parentSessionId: session.parentSessionId,
    forkedFromMessage: session.forkedFromMessage,
  });
  const saveSession = (session: Session): Promise<void> => sessionStore.save(persistedSession(session));
  const restorePromise = sessionStore.loadAll().then((restored) => {
    return Promise.all([...restored.values()].map(async (persisted) => {
      const session: Session = {
        id: persisted.id,
        messages: persisted.messages,
        createdAt: persisted.createdAt,
        busy: false,
        permissionManager: new PermissionManager(persisted.permissionMode ?? defaultPermissionMode),
        modelId: persisted.modelId,
        thinkingLevel: persisted.thinkingLevel,
        thinkingMode: persisted.thinkingMode,
        parentSessionId: persisted.parentSessionId,
        forkedFromMessage: persisted.forkedFromMessage,
      };
      // Restore the model choice first, then apply the persisted effort level
      // even when the session stayed on the server default model.
      let restoredLlm = options.llm;
      if (persisted.modelId) {
        try {
          restoredLlm = switchLlmModel(
            options.llm,
            persisted.modelId,
            {},
            options.relayRegistry,
          );
        } catch {
          // Model no longer available — fall back to server default
          session.modelId = undefined;
        }
      }
      if (persisted.modelId || persisted.thinkingLevel) {
        session.llmOverride = persisted.thinkingLevel
          ? withThinkingLevel(restoredLlm, persisted.thinkingLevel)
          : restoredLlm;
      }
      sessions.set(persisted.id, session);
      await documentStore.restoreSession(persisted.id);
    }));
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { files: MAX_ATTACHMENTS, fileSize: MAX_ATTACHMENT_BYTES, fields: 10 },
  });
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  app.use((_request, _response, next) => {
    void Promise.all([restorePromise, skillDiscovery]).then(() => next()).catch(next);
  });

  app.get("/api/health", (_request, response) => response.json({ ok: true }));
  app.get("/api/config", async (_request, response) => {
    const mcpStatuses = typeof options.mcpStatuses === "function"
      ? options.mcpStatuses()
      : options.mcpStatuses ?? [];
    // Resolve active profile name (never expose apiKey)
    let activeProfileName: string | null = null;
    try {
      const store = await loadProfileStore();
      activeProfileName = store.activeProfile;
    } catch { /* non-fatal */ }

    response.json({
      model: options.llm.model,
      modelVision: options.llm.capabilities.input.includes("image"),
      visionPreprocessor: options.preprocessors?.length ? "enabled" : "disabled",
      contextWindow: resolveModel(options.llm.model, options.llm.baseUrl).contextWindow,
      maxTokens: options.llm.maxTokens,
      thinkingLevel: options.llm.thinkingLevel ?? (options.llm.reasoning ? "medium" : "off"),
      thinkingMode: options.thinkingMode ?? loadThinkingModeFromEnv(),
      workspace: path.basename(workspace),
      workspaceLabel: path.basename(workspace),
      maxImages: MAX_IMAGES,
      maxImageBytes: MAX_IMAGE_BYTES,
      maxAttachments: MAX_ATTACHMENTS,
      externalCodebase: {
        enabled: codebaseEnabled,
        allowedHosts: codebaseEnabled ? ["github.com"] : [],
      },
      deepWiki: {
        enabled: options.deepWikiEnabled ?? Boolean(options.codebaseProvider),
      },
      mcp: {
        enabled: mcpStatuses.some((status) => status.state === "ready"),
        servers: mcpStatuses,
      },
      permissionMode: defaultPermissionMode,
      activeProfile: activeProfileName,
      skills: {
        available: skillRegistry.list().map((skill) => ({
          name: skill.name,
          description: skill.description,
        })),
        active: activateSkillNames(defaultSkillNames, skillRegistry).activeNames,
      },
    });
  });

  app.get("/api/workspace/list", async (request, response) => {
    const relativePath = String(request.query.path ?? "");
    try {
      const result = await listWorkspaceDirectory(workspace, relativePath);
      response.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status =
        err && typeof err === "object" && "status" in err
          ? Number((err as { status: unknown }).status) || 400
          : 400;
      response.status(status).json({ error: message });
    }
  });

  app.get("/api/git/status", async (_request, response) => {
    try { response.json(await gitWorkflow.status()); }
    catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.get("/api/git/diff", async (request, response) => {
    try {
      response.type("text/plain").send(await gitWorkflow.diff({
        staged: String(request.query.staged ?? "") === "true",
        path: request.query.path ? String(request.query.path) : undefined,
      }));
    } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.get("/api/git/checkpoints", async (_request, response) => {
    try { response.json({ checkpoints: await gitWorkflow.listCheckpoints() }); }
    catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/git/checkpoints", async (request, response) => {
    try {
      const checkpoint = await gitWorkflow.createCheckpoint(String(request.body?.label ?? "agent-change"));
      response.status(201).json(checkpoint);
    } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/git/undo", async (request, response) => {
    const checkpointId = String(request.body?.checkpointId ?? "");
    if (!checkpointId) { response.status(400).json({ error: "checkpointId is required" }); return; }
    try { response.json(await gitWorkflow.undo(checkpointId)); }
    catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/git/branches", async (request, response) => {
    try { response.status(201).json(await gitWorkflow.createIsolatedBranch(String(request.body?.label ?? "task"))); }
    catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/validation", async (request, response) => {
    const requested = Array.isArray(request.body?.steps) ? request.body.steps : undefined;
    const steps = requested?.filter((value: unknown): value is ValidationStepName =>
      value === "test" || value === "typecheck" || value === "build");
    try {
      const report = await runValidation({ workspace, steps, timeoutMs: typeof request.body?.timeoutMs === "number" ? request.body.timeoutMs : undefined });
      response.status(report.ok ? 200 : 422).json({ ...report, summary: formatValidationReport(report) });
    } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  // ── Model discovery & per-session switching ─────────────────────────────────

  app.get("/api/models", (request, response) => {
    const query = String(request.query.q ?? "").trim();
    const available = getAvailableModels();
    const models = query ? searchModels(query, available) : available;
    response.json({
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        provider: model.provider,
        qualifiedId: `${model.provider}/${model.id}`,
        capabilities: model.capabilities,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reasoning: model.reasoning,
      })),
      defaultModel: options.llm.model,
    });
  });

  app.put("/api/sessions/:id/model", (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    if (session.busy) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }
    const modelId = String(request.body?.model ?? "").trim();
    if (!modelId) {
      response.status(400).json({ error: "model is required" });
      return;
    }
    try {
      const newLlm = switchLlmModel(
        session.llmOverride ?? options.llm,
        modelId,
        {},
        options.relayRegistry,
      );
      session.modelId = `${newLlm.provider}/${newLlm.model}`;
      session.llmOverride = newLlm;
      session.thinkingLevel = newLlm.thinkingLevel;
      // Persist the model switch
      void saveSession(session);
      const resolved = resolveModel(newLlm.model, newLlm.baseUrl);
      response.json({
        model: newLlm.model,
        qualifiedId: session.modelId,
        provider: newLlm.provider,
        capabilities: newLlm.capabilities,
        contextWindow: resolved.contextWindow,
        maxTokens: newLlm.maxTokens,
        thinkingLevel: newLlm.thinkingLevel ?? (newLlm.reasoning ? "medium" : "off"),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      response.status(400).json({ error: message });
    }
  });

  // ── Subagent profile hot-update API ────────────────────────────────────────

  app.get("/api/subagent/profiles", (_request, response) => {
    const profiles = options.subagentProfiles ?? defaultProfiles;
    response.json({
      profiles: profiles.map((p) => ({
        name: p.name,
        description: p.description,
        allowedTools: p.allowedTools,
        maxTurns: p.maxTurns,
        timeout: p.timeout,
        hasCustomLlm: Boolean(p.llm),
      })),
    });
  });

  app.put("/api/subagent/profiles/:name", (request, response) => {
    const name = request.params.name;
    const body = request.body as Partial<SubagentProfile> | undefined;
    if (!body || typeof body.description !== "string" || typeof body.systemPrompt !== "string") {
      response.status(400).json({ error: "description and systemPrompt are required" });
      return;
    }
    const profiles = options.subagentProfiles ?? defaultProfiles;
    const existing = profiles.findIndex((p) => p.name === name);
    const newProfile: SubagentProfile = {
      name,
      description: body.description,
      systemPrompt: body.systemPrompt,
      allowedTools: Array.isArray(body.allowedTools) ? body.allowedTools : undefined,
      maxTurns: typeof body.maxTurns === "number" ? body.maxTurns : undefined,
      timeout: typeof body.timeout === "number" ? body.timeout : undefined,
    };
    if (existing >= 0) {
      profiles[existing] = newProfile;
    } else {
      profiles.push(newProfile);
    }
    // Update the options reference so new sessions pick up the change
    options.subagentProfiles = profiles;
    response.json({
      name: newProfile.name,
      description: newProfile.description,
      allowedTools: newProfile.allowedTools,
      maxTurns: newProfile.maxTurns,
    });
  });

  app.delete("/api/subagent/profiles/:name", (_request, response) => {
    const name = _request.params.name;
    const profiles = options.subagentProfiles ?? defaultProfiles;
    const index = profiles.findIndex((p) => p.name === name);
    if (index < 0) {
      response.status(404).json({ error: `Profile "${name}" not found` });
      return;
    }
    profiles.splice(index, 1);
    options.subagentProfiles = profiles;
    response.status(204).end();
  });

  // ── Sessions ────────────────────────────────────────────────────────────────

  app.get("/api/sessions", (_request, response) => {
    const items = [...sessions.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((session) => ({
        id: session.id,
        createdAt: session.createdAt,
        busy: session.busy,
        parentSessionId: session.parentSessionId ?? null,
        forkedFromMessage: session.forkedFromMessage ?? null,
        messageCount: visibleMessageCount(session.messages),
        modelId: session.modelId,
        thinkingLevel: session.thinkingLevel ?? (session.llmOverride ?? options.llm).thinkingLevel ?? "off",
        thinkingMode: session.thinkingMode ?? loadThinkingModeFromEnv(),
      }));
    response.json({ sessions: items });
  });

  app.post("/api/sessions", async (_request, response) => {
    const id = randomUUID();
    const session: Session = {
      id,
      messages: createAgentHistory(undefined, defaultPermissionMode),
      createdAt: Date.now(),
      busy: false,
      thinkingMode: options.thinkingMode ?? loadThinkingModeFromEnv(),
      permissionManager: new PermissionManager(defaultPermissionMode),
    };
    sessions.set(id, session);
    await sessionStore.create(persistedSession(session));
    void documentStore.createSession(id);
    response.status(201).json({ id, createdAt: session.createdAt, permissionMode: session.permissionManager.getMode() });
  });

  app.post("/api/sessions/:id/fork", async (request, response) => {
    const parent = sessions.get(request.params.id);
    if (!parent) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    if (parent.busy) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }
    const requestedIndex = request.body?.messageIndex;
    const visibleMessages = parent.messages.filter((message) => message.role !== "system");
    const messageIndex = requestedIndex === undefined
      ? visibleMessages.length
      : Number(requestedIndex);
    if (!Number.isInteger(messageIndex) || messageIndex < 0 || messageIndex > visibleMessages.length) {
      response.status(400).json({ error: `messageIndex must be an integer between 0 and ${visibleMessages.length}` });
      return;
    }
    const messages = truncateSessionMessages(parent.messages, messageIndex);
    const safeMessageIndex = visibleMessageCount(messages);
    const id = randomUUID();
    const child: Session = {
      id,
      messages,
      createdAt: Date.now(),
      busy: false,
      modelId: parent.modelId,
      llmOverride: parent.llmOverride,
        thinkingLevel: parent.thinkingLevel,
        thinkingMode: parent.thinkingMode,
      permissionManager: new PermissionManager(parent.permissionManager.getMode()),
      parentSessionId: parent.id,
      forkedFromMessage: safeMessageIndex,
    };
    sessions.set(id, child);
    await sessionStore.create(persistedSession(child));
    await documentStore.createSession(id);
    response.status(201).json({
      id,
      parentSessionId: parent.id,
      forkedFromMessage: safeMessageIndex,
      createdAt: child.createdAt,
      messageCount: safeMessageIndex,
    });
  });

  app.post("/api/sessions/:id/rewind", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    if (session.busy) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }
    const visibleMessages = session.messages.filter((message) => message.role !== "system");
    const messageIndex = Number(request.body?.messageIndex);
    if (!Number.isInteger(messageIndex) || messageIndex < 0 || messageIndex > visibleMessages.length) {
      response.status(400).json({ error: `messageIndex must be an integer between 0 and ${visibleMessages.length}` });
      return;
    }
    session.messages = truncateSessionMessages(session.messages, messageIndex);
    const safeMessageIndex = visibleMessageCount(session.messages);
    await saveSession(session);
    response.json({ id: session.id, messageIndex: safeMessageIndex, messageCount: safeMessageIndex });
  });

  app.get("/api/sessions/tree", (_request, response) => {
    const nodes = [...sessions.values()].map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      parentSessionId: session.parentSessionId ?? null,
      forkedFromMessage: session.forkedFromMessage ?? null,
      messageCount: visibleMessageCount(session.messages),
      busy: session.busy,
      children: [] as string[],
    }));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const roots: string[] = [];
    for (const node of nodes) {
      const parent = node.parentSessionId ? byId.get(node.parentSessionId) : undefined;
      if (parent && parent !== node) parent.children.push(node.id);
      else roots.push(node.id);
    }
    response.json({ sessions: nodes, roots });
  });

  app.get("/api/sessions/:id/permission-mode", (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    response.json({ mode: session.permissionManager.getMode() });
  });

  app.put("/api/sessions/:id/permission-mode", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const mode = request.body?.mode;
    if (!isPermissionMode(mode)) {
      response.status(400).json({ error: "mode must be plan or bypass" });
      return;
    }
    const change = session.permissionManager.setMode(mode);
    await saveSession(session);
    response.json({
      mode: change.mode,
      previousMode: change.previousMode,
      changed: change.changed,
      interrupted: change.interrupted,
    });
  });

  app.post("/api/sessions/:id/permissions/:requestId", (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const decision = request.body?.decision;
    if (decision !== "allow" && decision !== "deny") {
      response.status(400).json({ error: "decision must be allow or deny" });
      return;
    }
    const resolved = session.permissionManager.resolve(
      session.id,
      request.params.requestId,
      decision as PermissionDecision,
    );
    if (!resolved) {
      response.status(404).json({ error: "Permission request not found" });
      return;
    }
    response.json({ resolved: true, decision });
  });

  // ─── Plan-Act Workflow API ──────────────────────────────────────────────────

  /** GET /api/sessions/:id/phase - Get current phase */
  app.get("/api/sessions/:id/phase", (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    response.json({ phase: session.phase });
  });

  /** PUT /api/sessions/:id/phase - Transition phase */
  app.put("/api/sessions/:id/phase", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const targetPhase = request.body?.phase as SessionPhase | undefined;
    if (!targetPhase) {
      response.status(400).json({ error: "phase is required" });
      return;
    }
    const result = validatePhaseTransition(session.phase, targetPhase, request.body);
    if (!result.allowed) {
      response.status(400).json({ error: result.reason });
      return;
    }
    const previousPhase = session.phase;
    session.phase = targetPhase;
    await saveSession(session);
    response.json({ from: previousPhase, to: targetPhase, reason: result.reason });
  });

  /** POST /api/sessions/:id/plans - Generate new plan */
  app.post("/api/sessions/:id/plans", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    if (session.busy) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }
    const output = request.body?.output as string | undefined;
    const summary = request.body?.summary as string | undefined;
    if (!output) {
      response.status(400).json({ error: "output is required" });
      return;
    }
    const plan = planGenerator.generateAndStore(output, session.id, summary);
    if (!plan) {
      response.status(400).json({ error: "Failed to parse plan from output" });
      return;
    }
    session.currentPlan = plan;
    session.planHistory.push(plan);
    session.phase = "review";
    await saveSession(session);
    response.status(201).json(plan);
  });

  /** GET /api/sessions/:id/plans - List plans for session */
  app.get("/api/sessions/:id/plans", (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const plans = planManager.getSessionPlans(session.id);
    response.json(plans);
  });

  /** GET /api/sessions/:id/plans/:planId - Get plan details */
  app.get("/api/sessions/:id/plans/:planId", (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const plan = planManager.getPlan(request.params.planId);
    if (!plan) {
      response.status(404).json({ error: "Plan not found" });
      return;
    }
    if (plan.sessionId !== session.id) {
      response.status(403).json({ error: "Plan does not belong to this session" });
      return;
    }
    response.json(plan);
  });

  /** POST /api/sessions/:id/plans/:planId/approve - Approve plan */
  app.post("/api/sessions/:id/plans/:planId/approve", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const plan = planManager.getPlan(request.params.planId);
    if (!plan) {
      response.status(404).json({ error: "Plan not found" });
      return;
    }
    if (plan.sessionId !== session.id) {
      response.status(403).json({ error: "Plan does not belong to this session" });
      return;
    }
    const approved = planManager.approvePlan(plan.id, request.body);
    if (!approved) {
      response.status(400).json({ error: "Failed to approve plan" });
      return;
    }
    session.currentPlan = approved;
    session.phase = "acting";
    await saveSession(session);
    response.json(approved);
  });

  /** POST /api/sessions/:id/plans/:planId/reject - Reject plan */
  app.post("/api/sessions/:id/plans/:planId/reject", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const plan = planManager.getPlan(request.params.planId);
    if (!plan) {
      response.status(404).json({ error: "Plan not found" });
      return;
    }
    if (plan.sessionId !== session.id) {
      response.status(403).json({ error: "Plan does not belong to this session" });
      return;
    }
    const reason = request.body?.reason as string | undefined;
    const rejected = planManager.rejectPlan(plan.id, reason);
    if (!rejected) {
      response.status(400).json({ error: "Failed to reject plan" });
      return;
    }
    session.currentPlan = undefined;
    session.phase = "cancelled";
    await saveSession(session);
    response.json(rejected);
  });

  /** POST /api/sessions/:id/plans/:planId/modify - Request modifications */
  app.post("/api/sessions/:id/plans/:planId/modify", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const plan = planManager.getPlan(request.params.planId);
    if (!plan) {
      response.status(404).json({ error: "Plan not found" });
      return;
    }
    if (plan.sessionId !== session.id) {
      response.status(403).json({ error: "Plan does not belong to this session" });
      return;
    }
    const modified = planManager.updatePlanStatus(plan.id, "modified");
    if (!modified) {
      response.status(400).json({ error: "Failed to modify plan" });
      return;
    }
    session.currentPlan = modified;
    session.phase = "planning";
    await saveSession(session);
    response.json(modified);
  });

  /** DELETE /api/sessions/:id/plans/:planId - Delete plan */
  app.delete("/api/sessions/:id/plans/:planId", (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const plan = planManager.getPlan(request.params.planId);
    if (!plan) {
      response.status(404).json({ error: "Plan not found" });
      return;
    }
    if (plan.sessionId !== session.id) {
      response.status(403).json({ error: "Plan does not belong to this session" });
      return;
    }
    planManager.deletePlan(plan.id);
    if (session.currentPlan?.id === plan.id) {
      session.currentPlan = undefined;
    }
    response.status(204).end();
  });

  // ── Session plan API (per-session plan kernel root) ─────────────────────────

  app.get("/api/sessions/:id/plan", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const plan = await loadPlanDocument(sessionPlanRoot(dataRoot, session.id));
    response.json({ plan });
  });

  app.post("/api/sessions/:id/plan", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const prompt = typeof request.body?.prompt === "string" ? request.body.prompt.trim() : "";
    const planMarkdown = typeof request.body?.plan === "string" ? request.body.plan : "";
    if (!prompt) {
      response.status(400).json({ error: "prompt is required" });
      return;
    }
    if (!planMarkdown.trim()) {
      response.status(400).json({ error: "plan is required" });
      return;
    }
    const autoApprove = Boolean(request.body?.autoApprove);
    const planRoot = sessionPlanRoot(dataRoot, session.id);
    const plan = await createAndSavePlan(planRoot, prompt, planMarkdown, {
      autoApprove,
      approvedBy: autoApprove ? "api" : undefined,
    });
    response.status(201).json({ plan });
  });

  app.post("/api/sessions/:id/plan/approve", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const by = typeof request.body?.by === "string" && request.body.by.trim()
      ? request.body.by.trim()
      : "api";
    try {
      const plan = await approveCurrentPlan(sessionPlanRoot(dataRoot, session.id), by);
      response.json({ plan });
    } catch (error) {
      const { status, message } = planHttpError(error);
      response.status(status).json({ error: message });
    }
  });

  app.post("/api/sessions/:id/plan/reject", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    try {
      const plan = await rejectCurrentPlan(sessionPlanRoot(dataRoot, session.id));
      response.json({ plan });
    } catch (error) {
      const { status, message } = planHttpError(error);
      response.status(status).json({ error: message });
    }
  });

  app.post("/api/sessions/:id/plan/edit", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const planMarkdown = typeof request.body?.plan === "string" ? request.body.plan : "";
    if (!planMarkdown.trim()) {
      response.status(400).json({ error: "plan is required" });
      return;
    }
    try {
      const plan = await editCurrentPlan(sessionPlanRoot(dataRoot, session.id), planMarkdown);
      response.json({ plan });
    } catch (error) {
      const { status, message } = planHttpError(error);
      response.status(status).json({ error: message });
    }
  });

  app.post("/api/sessions/:id/plan/archive", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    try {
      const result = await archiveCurrentPlan(sessionPlanRoot(dataRoot, session.id));
      response.json({ plan: result.document, archivedPath: result.archivedPath });
    } catch (error) {
      const { status, message } = planHttpError(error);
      response.status(status).json({ error: message });
    }
  });

  app.get("/api/sessions/:id/plan/history", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const plans = await listPlanHistory(sessionPlanRoot(dataRoot, session.id));
    response.json({ plans });
  });

  app.post("/api/sessions/:id/plan/generate", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    if (session.busy) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }
    const prompt = typeof request.body?.prompt === "string" ? request.body.prompt.trim() : "";
    if (!prompt) {
      response.status(400).json({ error: "prompt is required" });
      return;
    }

    session.busy = true;
    const planRoot = sessionPlanRoot(dataRoot, session.id);
    const previousMode = session.permissionManager.getMode();
    let modeChanged = false;
    const abortController = new AbortController();
    const onClientAbort = () => {
      if (!abortController.signal.aborted) abortController.abort();
    };
    request.on("aborted", onClientAbort);
    request.on("close", () => {
      if (!response.headersSent) onClientAbort();
    });

    try {
      if (previousMode !== "plan") {
        session.permissionManager.setMode("plan");
        modeChanged = true;
      }

      const permissionTurn = session.permissionManager.beginTurn(
        session.id,
        () => {
          /* plan generation is non-interactive */
        },
        abortController.signal,
      );

      const sessionLlm = session.llmOverride ?? options.llm;
      const parentRuntime: AgentRuntimeRef = {};
      const generatePrompt = prompt + PLAN_ONLY_SUFFIX;

      try {
        session.messages = await runAgentTurn(
          session.messages,
          generatePrompt,
          {
            llm: sessionLlm,
            tools,
            autoSubagent: options.autoSubagent,
            preprocessors: options.preprocessors ?? [],
            chat: options.chat,
            signal: abortController.signal,
            permissionTurn,
            autoValidate: false,
            validationWorkspace: workspace,
            autoCheckpoint: false,
            thinkingMode: session.thinkingMode ?? options.thinkingMode ?? loadThinkingModeFromEnv(),
            maxThinkingEscalations: options.maxThinkingEscalations,
            runtimeRef: parentRuntime,
            skillNames: resolveSessionSkillNames(session),
            skillRegistry,
            prepareNextTurn: async (context) => {
              const update = await options.prepareNextTurn?.(context);
              if (update?.llm) {
                session.llmOverride = update.llm;
                session.modelId = `${update.llm.provider}/${update.llm.model}`;
                session.thinkingLevel = update.llm.thinkingLevel;
              }
              return update;
            },
          },
        );
      } finally {
        permissionTurn.close();
      }

      const lastAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
      const answer =
        lastAssistant && lastAssistant.role === "assistant"
          ? String(lastAssistant.content)
          : "";
      if (!answer.trim()) {
        response.status(502).json({ error: "Agent did not return a plan" });
        return;
      }

      const plan = await createAndSavePlan(planRoot, prompt, answer);
      await saveSession(session);
      response.json({ plan, answer });
    } catch (error) {
      if (isAbortError(error)) {
        response.status(499).json({ error: "Plan generation aborted" });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: message });
    } finally {
      request.off("aborted", onClientAbort);
      if (modeChanged) {
        session.permissionManager.setMode(previousMode);
      }
      session.busy = false;
    }
  });

  const runPlanExecution = async (request: Request, response: Response, isRetry: boolean): Promise<void> => {
    const sessionId = String(request.params.id);
    const session = sessions.get(sessionId);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    if (session.busy) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }

    const planRoot = sessionPlanRoot(dataRoot, session.id);
    let prepared: Awaited<ReturnType<typeof preparePlanForExecution>>;
    try {
      prepared = await preparePlanForExecution(planRoot, {
        yes: Boolean(request.body?.yes),
        force: Boolean(request.body?.force),
        workspaceRoot: workspace,
      });
    } catch (error) {
      const { status, message } = planHttpError(error);
      response.status(status).json({ error: message });
      return;
    }

    session.busy = true;
    const previousMode = session.permissionManager.getMode();
    let modeChanged = false;
    if (previousMode !== "bypass") {
      session.permissionManager.setMode("bypass");
      modeChanged = true;
    }

    response.status(200);
    response.set({
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    response.flushHeaders();

    const abortController = new AbortController();
    const onClientAbort = () => {
      if (!abortController.signal.aborted) abortController.abort();
    };
    const onResponseClose = () => {
      if (!response.writableFinished) onClientAbort();
    };
    request.on("aborted", onClientAbort);
    response.on("close", onResponseClose);

    const send = (payload: Record<string, unknown>): void => {
      if (!response.writableEnded) {
        response.write(`${JSON.stringify(payload)}\n`);
      }
    };

    const permissionTurn = session.permissionManager.beginTurn(
      session.id,
      (permissionRequest) => send(safeEvent({ type: "permission_required", request: permissionRequest })),
      abortController.signal,
    );

    send({
      type: "plan_execution_started",
      planId: prepared.document.id,
      status: prepared.document.status,
      prompt: prepared.document.prompt.slice(0, 200),
      retry: isRetry,
    });
    send({ type: "plan_updated", plan: planSummaryPayload(prepared.document) });

    const executionUserText = `Execute the approved plan.${prepared.executionPromptSuffix}`;
    const parentRuntime: AgentRuntimeRef = {};

    try {
      const operationScope = randomUUID();
      const documentTool = createDocumentEditTool(
        documentStore,
        String(request.params.id),
        operationScope,
      ) as Tool;
      const sessionLlm = session.llmOverride ?? options.llm;
      const baseToolProvider: ToolProvider = () => [...resolveToolProvider(tools), documentTool];
      const enableSubagent = options.subagentEnabled || (options.subagentProfiles && options.subagentProfiles.length > 0);
      const sessionTools: ToolProvider = enableSubagent
        ? () => {
            const base = resolveToolProvider(baseToolProvider);
            const subagentOpts = {
              parentLlm: sessionLlm,
              parentTools: base,
              profiles: options.subagentProfiles ?? defaultProfiles,
              preprocessors: options.preprocessors ?? [],
              signal: abortController.signal,
              onSubagentEvent: (subEvent: import("./subagent/types.ts").SubagentEvent) => send(safeEvent(subEvent)),
              permissionTurn,
              thinkingMode: session.thinkingMode ?? options.thinkingMode ?? loadThinkingModeFromEnv(),
              maxThinkingEscalations: options.maxThinkingEscalations,
              parentRuntime,
            };
            return [
              ...base,
              createSubagentTool(subagentOpts) as Tool,
              createSubagentBatchTool(subagentOpts) as Tool,
            ];
          }
        : baseToolProvider;

      session.messages = await runAgentTurn(
        session.messages,
        executionUserText,
        {
          llm: sessionLlm,
          tools: sessionTools,
          autoSubagent: options.autoSubagent,
          preprocessors: options.preprocessors ?? [],
          chat: options.chat,
          signal: abortController.signal,
          permissionTurn,
          autoValidate: options.autoValidate ?? process.env.MINI_AGENT_AUTO_VALIDATE === "1",
          validationWorkspace: workspace,
          autoCheckpoint: options.autoCheckpoint ?? process.env.MINI_AGENT_AUTO_CHECKPOINT === "1",
          thinkingMode: session.thinkingMode ?? options.thinkingMode ?? loadThinkingModeFromEnv(),
          maxThinkingEscalations: options.maxThinkingEscalations,
          runtimeRef: parentRuntime,
          skillNames: resolveSessionSkillNames(session),
          skillRegistry,
          prepareNextTurn: async (context) => {
            const update = await options.prepareNextTurn?.(context);
            if (update?.llm) {
              session.llmOverride = update.llm;
              session.modelId = `${update.llm.provider}/${update.llm.model}`;
              session.thinkingLevel = update.llm.thinkingLevel;
            }
            return update;
          },
          onEvent: (event) => {
            if (event.type === "thinking_policy") {
              session.thinkingLevel = event.level;
              session.llmOverride = withThinkingLevel(session.llmOverride ?? sessionLlm, event.level);
            }
            send(safeEvent(event));
            if (event.type === "tool_end" && event.result.files) {
              for (const file of event.result.files) {
                send({
                  type: "file_ready",
                  ...file,
                  downloadUrl: `/api/sessions/${request.params.id}/files/${file.id}`,
                });
              }
            }
          },
        },
      );

      const lastAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
      const summary =
        lastAssistant && lastAssistant.role === "assistant"
          ? String(lastAssistant.content).slice(0, 500)
          : undefined;
      const completed = await markPlanExecutionResult(planRoot, {
        ok: true,
        summary,
        workspaceRoot: workspace,
      });
      await saveSession(session);
      send({ type: "plan_updated", plan: planSummaryPayload(completed) });
      send({
        type: "plan_execution_finished",
        status: completed.status,
        plan: planSummaryPayload(completed),
        changedFiles: completed.execution?.changedFiles ?? [],
        missingPlannedFiles: completed.execution?.missingPlannedFiles ?? [],
        unplannedFiles: completed.execution?.unplannedFiles ?? [],
        auditReport: completed.execution?.auditReport,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        const failed = await markPlanExecutionResult(planRoot, {
          ok: false,
          error: message,
          workspaceRoot: workspace,
        });
        send({ type: "plan_updated", plan: planSummaryPayload(failed) });
        send({
          type: "plan_execution_finished",
          status: failed.status,
          plan: planSummaryPayload(failed),
          error: message,
          changedFiles: failed.execution?.changedFiles ?? [],
          missingPlannedFiles: failed.execution?.missingPlannedFiles ?? [],
          unplannedFiles: failed.execution?.unplannedFiles ?? [],
          auditReport: failed.execution?.auditReport,
        });
      } catch {
        // ignore secondary plan write failures
      }
      if (isAbortError(err)) {
        send({ type: "aborted", message: "已停止生成" });
      } else {
        send({ type: "error", message, retryable: isRetryableError(message) });
      }
      await saveSession(session);
    } finally {
      permissionTurn.close();
      request.off("aborted", onClientAbort);
      response.off("close", onResponseClose);
      if (modeChanged) {
        session.permissionManager.setMode(previousMode);
      }
      session.busy = false;
      if (!response.writableEnded) response.end();
    }
  };

  app.post("/api/sessions/:id/plan/execute", async (request, response) => {
    await runPlanExecution(request, response, false);
  });

  app.post("/api/sessions/:id/plan/retry", async (request, response) => {
    await runPlanExecution(request, response, true);
  });

  app.get("/api/sessions/:id", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const effectiveLlm = session.llmOverride ?? options.llm;
    const resolved = resolveModel(effectiveLlm.model, effectiveLlm.baseUrl);
    let planStatus: string | null = null;
    try {
      const plan = await loadPlanDocument(sessionPlanRoot(dataRoot, session.id));
      planStatus = plan?.status ?? null;
    } catch {
      planStatus = null;
    }
    response.json({
      id: session.id,
      busy: session.busy,
      modelId: session.modelId,
      thinkingMode: session.thinkingMode ?? loadThinkingModeFromEnv(),
      parentSessionId: session.parentSessionId ?? null,
      forkedFromMessage: session.forkedFromMessage ?? null,
      permissionMode: session.permissionManager.getMode(),
      planStatus,
      model: effectiveLlm.model,
      thinkingLevel: effectiveLlm.thinkingLevel ?? (effectiveLlm.reasoning ? "medium" : "off"),
      contextWindow: resolved.contextWindow,
      capabilities: effectiveLlm.capabilities,
      skillNames: resolveSessionSkillNames(session),
      messages: session.messages
        .filter((message) => message.role !== "system")
        .map(safeMessage),
    });
  });

  app.get("/api/sessions/:id/skills", (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const activation = activateSkillNames(session.skillNames, skillRegistry);
    response.json({
      available: activation.available.map((skill) => ({
        name: skill.name,
        description: skill.description,
      })),
      active: activation.activeNames,
      missing: activation.missingNames,
    });
  });

  app.put("/api/sessions/:id/skills", (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    if (session.busy) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }
    const body = (request.body ?? {}) as {
      skillNames?: unknown;
      add?: unknown;
      remove?: unknown;
    };
    const requested = Array.isArray(body.skillNames)
      ? body.skillNames.filter((name): name is string => typeof name === "string")
      : session.skillNames;
    const add = Array.isArray(body.add)
      ? body.add.filter((name): name is string => typeof name === "string")
      : [];
    const remove = new Set(
      Array.isArray(body.remove)
        ? body.remove.filter((name): name is string => typeof name === "string")
        : [],
    );
    const merged = uniqueSkillNames([...requested, ...add]).filter((name) => !remove.has(name));
    const activation = activateSkillNames(merged, skillRegistry);
    session.skillNames = activation.activeNames;
    response.json({
      available: activation.available.map((skill) => ({
        name: skill.name,
        description: skill.description,
      })),
      active: activation.activeNames,
      missing: activation.missingNames,
    });
  });

  app.delete("/api/sessions/:id", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    if (session.busy) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }
    sessions.delete(request.params.id);
    await sessionStore.remove(request.params.id);
    void documentStore.removeSession(request.params.id);
    response.status(204).end();
  });

  app.get("/api/sessions/:id/files/:fileId", async (request, response) => {
    if (!sessions.has(request.params.id)) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    try {
      const output = documentStore.getOutput(request.params.id, request.params.fileId);
      if (!existsSync(output.path)) {
        response.status(404).json({ error: "File not found" });
        return;
      }
      response.setHeader("Content-Type", output.artifact.mimeType);
      response.setHeader("Content-Length", String(output.artifact.size));
      response.setHeader("Content-Disposition", `attachment; filename="${output.artifact.name}"`);
      createReadStream(output.path).on("error", (error) => {
        if (!response.headersSent) response.status(404).json({ error: error.message });
        else response.destroy(error);
      }).pipe(response);
    } catch (error) {
      response.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post(
    "/api/sessions/:id/messages",
    upload.fields([
      { name: "images", maxCount: MAX_IMAGES },
      { name: "documents", maxCount: MAX_ATTACHMENTS },
    ]),
    async (request, response) => {
      const session = sessions.get(String(request.params.id));
      if (!session) {
        response.status(404).json({ error: "Session not found" });
        return;
      }
      if (session.busy) {
        response.status(409).json({ error: "Session is busy" });
        return;
      }
      session.busy = true;

      let input: Awaited<ReturnType<typeof parseMessageRequest>>;
      try {
        input = await parseMessageRequest(request, workspace, documentStore, String(request.params.id));
      } catch (err) {
        session.busy = false;
        const message = err instanceof Error ? err.message : String(err);
        response.status(400).json({ error: message });
        return;
      }

      response.status(200);
      response.set({
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      response.flushHeaders();
      const abortController = new AbortController();
      // `request.close` can fire when the request body finishes and does not
      // mean the user cancelled generation. Abort only on a genuinely aborted
      // request or when the streaming response closes before it finishes.
      const onClientAbort = () => {
        if (!abortController.signal.aborted) abortController.abort();
      };
      const onResponseClose = () => {
        if (!response.writableFinished) onClientAbort();
      };
      request.on("aborted", onClientAbort);
      response.on("close", onResponseClose);
      const send = (payload: Record<string, unknown>): void => {
        if (!response.writableEnded) {
          response.write(`${JSON.stringify(payload)}\n`);
        }
      };
      const permissionTurn = session.permissionManager.beginTurn(
        session.id,
        (request) => send(safeEvent({ type: "permission_required", request })),
        abortController.signal,
      );
      send({
        type: "user",
        content: input.displayPrompt,
        images: input.imageNames,
        documents: input.documentNames,
        referencedPaths: input.referencedPaths,
      });
      const attachments = [...input.documents, ...input.images];
      const userContent: ContentPart[] | undefined = attachments.length
        ? [textPart(input.modelPrompt), ...attachments]
        : undefined;
      const parentRuntime: AgentRuntimeRef = {};

      try {
        const operationScope = randomUUID();
        const documentTool = createDocumentEditTool(
          documentStore,
          String(request.params.id),
          operationScope,
        ) as Tool;
        // Use the per-session model and thinking level, otherwise fall back to
        // the server default. A /think command is applied before the first
        // model request and is retained for subsequent messages in this session.
        const sessionLlm = session.llmOverride ?? options.llm;
        const effectiveLlm = input.thinkingLevel
          ? withThinkingLevel(sessionLlm, input.thinkingLevel)
          : sessionLlm;
        if (input.thinkingLevel) {
          session.llmOverride = effectiveLlm;
          session.thinkingLevel = effectiveLlm.thinkingLevel;
        }
        if (input.thinkingMode) session.thinkingMode = input.thinkingMode;
        // Build the tool set, optionally including the subagent tool
        const baseToolProvider: ToolProvider = () => [...resolveToolProvider(tools), documentTool];
        const enableSubagent = options.subagentEnabled || (options.subagentProfiles && options.subagentProfiles.length > 0);
        const sessionTools: ToolProvider = enableSubagent
          ? () => {
              const base = resolveToolProvider(baseToolProvider);
              const subagentOpts = {
                parentLlm: effectiveLlm,
                parentTools: base,
                profiles: options.subagentProfiles ?? defaultProfiles,
                preprocessors: options.preprocessors ?? [],
                signal: abortController.signal,
                onSubagentEvent: (subEvent: import("./subagent/types.ts").SubagentEvent) => send(safeEvent(subEvent)),
                permissionTurn,
                thinkingMode: session.thinkingMode ?? options.thinkingMode ?? loadThinkingModeFromEnv(),
                maxThinkingEscalations: options.maxThinkingEscalations,
                parentRuntime,
              };
              return [
                ...base,
                createSubagentTool(subagentOpts) as Tool,
                createSubagentBatchTool(subagentOpts) as Tool,
              ];
            }
          : baseToolProvider;
        session.messages = await runAgentTurn(
          session.messages,
          input.modelPrompt,
          {
            llm: effectiveLlm,
            tools: sessionTools,
            autoSubagent: options.autoSubagent,
            preprocessors: options.preprocessors ?? [],
            chat: options.chat,
            userContent,
            signal: abortController.signal,
            permissionTurn,
            autoValidate: options.autoValidate ?? process.env.MINI_AGENT_AUTO_VALIDATE === "1",
            validationWorkspace: workspace,
            autoCheckpoint: options.autoCheckpoint ?? process.env.MINI_AGENT_AUTO_CHECKPOINT === "1",
            thinkingMode: input.thinkingMode ?? session.thinkingMode ?? options.thinkingMode ?? loadThinkingModeFromEnv(),
            maxThinkingEscalations: options.maxThinkingEscalations,
            runtimeRef: parentRuntime,
            skillNames: resolveSessionSkillNames(session),
            skillRegistry,
            prepareNextTurn: async (context) => {
              const update = await options.prepareNextTurn?.(context);
              if (update?.llm) {
                session.llmOverride = update.llm;
                session.modelId = `${update.llm.provider}/${update.llm.model}`;
                session.thinkingLevel = update.llm.thinkingLevel;
              }
              return update;
            },
            onEvent: (event) => {
              if (event.type === "thinking_policy") {
                session.thinkingLevel = event.level;
                session.llmOverride = withThinkingLevel(session.llmOverride ?? effectiveLlm, event.level);
              }
              send(safeEvent(event));
              if (event.type === "tool_end" && event.result.files) {
                for (const file of event.result.files) {
                  send({ type: "file_ready", ...file, downloadUrl: `/api/sessions/${request.params.id}/files/${file.id}` });
                }
              }
            },
          },
        );
        await saveSession(session);
      } catch (err) {
        const currentUserContent: ContentPart[] | string = userContent ?? input.modelPrompt;
        if (session.messages.length === 0 || session.messages[session.messages.length - 1]?.role !== "user") {
          session.messages = [
            ...session.messages,
            { role: "user", content: currentUserContent },
          ];
        }
        await saveSession(session);
        if (isAbortError(err)) {
          send({ type: "aborted", message: "已停止生成" });
        } else {
          const message = err instanceof Error ? err.message : String(err);
          send({ type: "error", message, retryable: isRetryableError(message) });
        }
      } finally {
        permissionTurn.close();
        request.off("aborted", onClientAbort);
        response.off("close", onResponseClose);
        session.busy = false;
        if (!response.writableEnded) response.end();
      }
    },
  );

  app.use((request, response) => {
    response.status(404).json({ error: "Not found", path: request.path });
  });
  app.use(
    (err: unknown, _request: Request, response: Response, _next: NextFunction) => {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof multer.MulterError ? 400 : 500;
      response.status(status).json({ error: message });
    },
  );
  return app;
}

async function startServer(): Promise<void> {
  const llm = loadLlmConfigFromEnv();
  const vision = loadVisionConfigFromEnv();
  const workspace = path.resolve(process.env.AGENT_WORKSPACE ?? process.cwd());
  const codebaseRuntime = createCodebaseRuntimeFromEnv();
  const mcpRuntime = await createMcpRuntimeFromEnv(workspace).catch(async (error) => {
    await codebaseRuntime.close();
    throw error;
  });

  let app: Express;
  try {
    app = createAgentServer({
      llm,
      workspace,
      codebaseStore: codebaseRuntime.store,
      codebaseProvider: codebaseRuntime.semanticProvider,
      deepWikiEnabled: codebaseRuntime.deepWikiEnabled,
      mcpTools: () => mcpRuntime.snapshot(),
      mcpStatuses: () => mcpRuntime.statuses(),
      preprocessors: vision ? [createVisionPreprocessor(vision)] : [],
      subagentEnabled: process.env.MINI_AGENT_SUBAGENT !== "0",
      subagentProfiles: defaultProfiles,
      autoSubagent: loadAutoSubagentOptionsFromEnv(),
    });
  } catch (error) {
    await Promise.all([mcpRuntime.close(), codebaseRuntime.close()]);
    throw error;
  }
  const port = Number(process.env.PORT ?? 3001);
  let server: ReturnType<typeof app.listen>;
  try {
    server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
      const listener = app.listen(port, "127.0.0.1", () => resolve(listener));
      listener.on("error", reject);
    });
  } catch (error) {
    await Promise.all([mcpRuntime.close(), codebaseRuntime.close()]);
    throw error;
  }
  server.on("close", () => void Promise.all([mcpRuntime.close(), codebaseRuntime.close()]));
  const shutdown = () => server.close();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.log(`Mini Agent server: http://127.0.0.1:${port}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
