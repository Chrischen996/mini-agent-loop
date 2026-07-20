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
import { SessionStore } from "./session-store.ts";
import { PermissionManager } from "./permissions.ts";
import { isAbortError, loadLlmConfigFromEnv, type ChatFn, type LlmConfig } from "./llm.ts";
import { resolveModel } from "./models.ts";
import {
  createAgentHistory,
  runAgentTurn,
  type LoopEvent,
} from "./loop.ts";
import {
  createVisionPreprocessor,
  loadVisionConfigFromEnv,
  type MessagePreprocessor,
} from "./preprocessors/index.ts";
import { createTools } from "./tools/index.ts";
import { createRepositoryStoreFromEnv, RepositoryStore } from "./codebase/repository-store.ts";
import { createDocumentEditTool } from "./tools/document-edit.ts";
import type { Tool } from "./tools/types.ts";
import type { AgentMessage, ContentPart } from "./types.ts";
import { createMcpRuntimeFromEnv, mergeToolSets } from "./mcp/runtime.ts";
import type { McpServerStatus } from "./mcp/types.ts";
import {
  listWorkspaceDirectory,
  validateReferencedPaths,
} from "./workspace.ts";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 5;
const MAX_ATTACHMENTS = 5;
const DEFAULT_IMAGE_PROMPT = "Please analyze the attached image(s).";
const DEFAULT_REFERENCE_PROMPT = "请阅读引用的文件并说明要点";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Session = {
  id: string;
  messages: AgentMessage[];
  createdAt: number;
  busy: boolean;
};

export type AgentServerOptions = {
  llm: LlmConfig;
  tools?: Tool[];
  preprocessors?: MessagePreprocessor[];
  chat?: ChatFn;
  workspace?: string;
  dataDir?: string;
  serveWeb?: boolean;
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
  mcpTools?: Tool[];
  mcpStatuses?: McpServerStatus[];
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
      };
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

export function buildModelPrompt(input: {
  prompt: string;
  referencedPaths: string[];
  hasImages: boolean;
}): { displayPrompt: string; modelPrompt: string } {
  const text = input.prompt.trim();
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

  return { displayPrompt, modelPrompt };
}

async function parseMessageRequest(
  request: Request,
  workspace: string,
  documentStore: DocumentStore,
  sessionId: string,
): Promise<{
  displayPrompt: string;
  modelPrompt: string;
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

  if (!prompt && images.length === 0 && documents.length === 0 && referencedPaths.length === 0) {
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
  const dataRoot = path.resolve(options.dataDir ?? path.join(os.homedir(), ".mini-agent"));
  const codebaseEnabled = options.codebaseEnabled ?? process.env.EXTERNAL_CODEBASE_ENABLED !== "0";
  const codebaseStore = options.codebaseStore ?? (codebaseEnabled ? createRepositoryStoreFromEnv(path.join(dataRoot, "codebases")) : undefined);
  const tools = options.tools ?? mergeToolSets(
    createTools(workspace, { codebase: codebaseEnabled, codebaseStore }),
    options.mcpTools ?? [],
  );
  const documentStore = new DocumentStore(path.join(dataRoot, "documents"));
  const permissionManager = new PermissionManager();
  const sessionStore = new SessionStore(path.join(dataRoot, "sessions"));
  const restorePromise = sessionStore.loadAll().then((restored) => {
    return Promise.all([...restored.values()].map(async (persisted) => {
      sessions.set(persisted.id, {
        id: persisted.id,
        messages: persisted.messages,
        createdAt: persisted.createdAt,
        busy: false,
      });
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
    void restorePromise.then(() => next()).catch(next);
  });

  app.get("/api/health", (_request, response) => response.json({ ok: true }));
  app.get("/api/config", (_request, response) => response.json({
    model: options.llm.model,
    modelVision: options.llm.capabilities.input.includes("image"),
    visionPreprocessor: options.preprocessors?.length ? "enabled" : "disabled",
    contextWindow: resolveModel(options.llm.model, options.llm.baseUrl).contextWindow,
    maxTokens: options.llm.maxTokens,
    workspace: path.basename(workspace),
    workspaceLabel: path.basename(workspace),
    maxImages: MAX_IMAGES,
    maxImageBytes: MAX_IMAGE_BYTES,
    maxAttachments: MAX_ATTACHMENTS,
    externalCodebase: {
      enabled: codebaseEnabled,
      allowedHosts: codebaseEnabled ? ["github.com"] : [],
    },
    mcp: {
      enabled: options.mcpStatuses?.some((status) => status.state === "ready") ?? false,
      servers: options.mcpStatuses ?? [],
    },
  }));

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

  app.post("/api/sessions", async (_request, response) => {
    const id = randomUUID();
    const session: Session = {
      id,
      messages: createAgentHistory(),
      createdAt: Date.now(),
      busy: false,
    };
    sessions.set(id, session);
    await sessionStore.create(session);
    void documentStore.createSession(id);
    response.status(201).json({ id, createdAt: session.createdAt });
  });

  app.get("/api/sessions/:id", (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    response.json({
      id: session.id,
      busy: session.busy,
      messages: session.messages
        .filter((message) => message.role !== "system")
        .map(safeMessage),
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
    permissionManager.rejectSession(request.params.id);
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

  app.post("/api/sessions/:id/permissions/:requestId", (request, response) => {
    if (!sessions.has(request.params.id)) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const decision = request.body?.decision;
    if (decision !== "allow" && decision !== "deny") {
      response.status(400).json({ error: "decision must be allow or deny" });
      return;
    }
    if (!permissionManager.resolve(request.params.id, request.params.requestId, decision)) {
      response.status(404).json({ error: "Permission request not found" });
      return;
    }
    response.status(204).end();
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
      const onClientClose = () => {
        if (!abortController.signal.aborted) abortController.abort();
      };
      request.on("close", onClientClose);
      const send = (payload: Record<string, unknown>): void => {
        if (!response.writableEnded) {
          response.write(`${JSON.stringify(payload)}\n`);
        }
      };
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

      try {
        const operationScope = randomUUID();
        session.messages = await runAgentTurn(
          session.messages,
          input.modelPrompt,
          {
            llm: options.llm,
            tools: [...tools, createDocumentEditTool(documentStore, String(request.params.id), operationScope) as Tool],
            preprocessors: options.preprocessors ?? [],
            chat: options.chat,
            userContent,
            signal: abortController.signal,
            prepareNextTurn: options.prepareNextTurn,
            authorizeTool: options.chat
              ? undefined
              : (tool, args, signal) =>
                  permissionManager.authorize(
                    String(request.params.id),
                    tool,
                    args,
                    signal,
                    (permission) => send(safeEvent({ type: "permission_required", request: permission })),
                  ),
            onEvent: (event) => {
              send(safeEvent(event));
              if (event.type === "tool_end" && event.result.files) {
                for (const file of event.result.files) {
                  send({ type: "file_ready", ...file, downloadUrl: `/api/sessions/${request.params.id}/files/${file.id}` });
                }
              }
            },
          },
        );
        await sessionStore.save(session);
      } catch (err) {
        const currentUserContent: ContentPart[] | string = userContent ?? input.modelPrompt;
        if (session.messages.length === 0 || session.messages[session.messages.length - 1]?.role !== "user") {
          session.messages = [
            ...session.messages,
            { role: "user", content: currentUserContent },
          ];
        }
        await sessionStore.save(session);
        if (isAbortError(err)) {
          send({ type: "aborted", message: "已停止生成" });
        } else {
          const message = err instanceof Error ? err.message : String(err);
          send({ type: "error", message, retryable: isRetryableError(message) });
        }
      } finally {
        request.off("close", onClientClose);
        session.busy = false;
        if (!response.writableEnded) response.end();
      }
    },
  );

  const webRoot = path.join(PACKAGE_ROOT, "web", "dist");
  if (options.serveWeb !== false && existsSync(webRoot)) {
    app.use(express.static(webRoot));
    app.use((request, response, next) => {
      if (request.path.startsWith("/api/")) {
        next();
        return;
      }
      response.sendFile(path.join(webRoot, "index.html"));
    });
  }

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
  const mcpRuntime = await createMcpRuntimeFromEnv(workspace);
  let app: Express;
  try {
    app = createAgentServer({
      llm,
      workspace,
      mcpTools: mcpRuntime.snapshot(),
      mcpStatuses: mcpRuntime.statuses(),
      preprocessors: vision ? [createVisionPreprocessor(vision)] : [],
    });
  } catch (error) {
    await mcpRuntime.close();
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
    await mcpRuntime.close();
    throw error;
  }
  server.on("close", () => void mcpRuntime.close());
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
