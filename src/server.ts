import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import multer from "multer";
import { contentAsString, imagePart, textPart } from "./content.ts";
import { loadLlmConfigFromEnv, type ChatFn, type LlmConfig } from "./llm.ts";
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
import { createDefaultTools } from "./tools/index.ts";
import type { Tool } from "./tools/types.ts";
import type { AgentMessage, ContentPart } from "./types.ts";
import {
  listWorkspaceDirectory,
  validateReferencedPaths,
} from "./workspace.ts";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 5;
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
  serveWeb?: boolean;
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
              arguments: call.arguments,
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
    case "assistant":
      return {
        type: "assistant",
        content: event.message.content,
        tools: event.message.toolCalls?.map((call) => call.name) ?? [],
      };
    case "tool_start":
      return {
        type: "tool_start",
        id: event.call.id,
        name: event.call.name,
        arguments: event.call.arguments,
      };
    case "tool_end":
      return {
        type: "tool_end",
        id: event.call.id,
        name: event.call.name,
        isError: Boolean(event.result.isError),
        preview: contentAsString(event.result.content).slice(0, 500),
      };
    case "done":
      return { type: "done", messageCount: event.messages.length };
  }
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
): Promise<{
  displayPrompt: string;
  modelPrompt: string;
  images: ContentPart[];
  imageNames: string[];
  referencedPaths: string[];
}> {
  const prompt = String(request.body?.prompt ?? "").trim();
  const files = (request.files ?? []) as Express.Multer.File[];
  const images: ContentPart[] = [];
  const imageNames: string[] = [];

  for (const file of files) {
    const mimeType = sniffImageMime(file.buffer);
    if (!mimeType) {
      throw new Error(`Unsupported or invalid image: ${file.originalname}`);
    }
    const source = file.originalname || `upload-${images.length + 1}`;
    images.push(imagePart(mimeType, file.buffer.toString("base64"), source));
    imageNames.push(source);
  }

  const rawRefs = parseReferencedPathsField(request.body?.referencedPaths);
  const referencedPaths = await validateReferencedPaths(workspace, rawRefs);

  if (!prompt && images.length === 0 && referencedPaths.length === 0) {
    throw new Error("A prompt, image, or referenced path is required");
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
    referencedPaths,
  };
}

export function createAgentServer(options: AgentServerOptions): Express {
  const workspace = path.resolve(options.workspace ?? process.cwd());
  const sessions = new Map<string, Session>();
  const tools = options.tools ?? createDefaultTools(workspace);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { files: MAX_IMAGES, fileSize: MAX_IMAGE_BYTES, fields: 10 },
  });
  const app = express();
  app.disable("x-powered-by");

  app.get("/api/health", (_request, response) => response.json({ ok: true }));
  app.get("/api/config", (_request, response) => response.json({
    model: options.llm.model,
    modelVision: options.llm.capabilities.input.includes("image"),
    visionPreprocessor: options.preprocessors?.length ? "enabled" : "disabled",
    workspace: path.basename(workspace),
    workspaceLabel: path.basename(workspace),
    maxImages: MAX_IMAGES,
    maxImageBytes: MAX_IMAGE_BYTES,
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

  app.post("/api/sessions", (_request, response) => {
    const id = randomUUID();
    const session: Session = {
      id,
      messages: createAgentHistory(),
      createdAt: Date.now(),
      busy: false,
    };
    sessions.set(id, session);
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

  app.delete("/api/sessions/:id", (request, response) => {
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
    response.status(204).end();
  });

  app.post(
    "/api/sessions/:id/messages",
    upload.array("images", MAX_IMAGES),
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
        input = await parseMessageRequest(request, workspace);
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
      const send = (payload: Record<string, unknown>): void => {
        response.write(`${JSON.stringify(payload)}\n`);
      };
      send({
        type: "user",
        content: input.displayPrompt,
        images: input.imageNames,
        referencedPaths: input.referencedPaths,
      });

      try {
        const userContent: ContentPart[] | undefined = input.images.length
          ? [textPart(input.modelPrompt), ...input.images]
          : undefined;
        session.messages = await runAgentTurn(
          session.messages,
          input.modelPrompt,
          {
            llm: options.llm,
            tools,
            preprocessors: options.preprocessors ?? [],
            chat: options.chat,
            userContent,
            onEvent: (event) => send(safeEvent(event)),
          },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: "error", message, retryable: isRetryableError(message) });
      } finally {
        session.busy = false;
        response.end();
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
  const app = createAgentServer({
    llm,
    workspace,
    preprocessors: vision ? [createVisionPreprocessor(vision)] : [],
  });
  const port = Number(process.env.PORT ?? 3001);
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  console.log(`Mini Agent server: http://127.0.0.1:${port}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
