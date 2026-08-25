/**
 * Turn-end automatic memory extraction — modeled on Claude Code's
 * `extractMemories` service.
 *
 * After each completed agent turn, a lightweight single-shot LLM call scans
 * the recent transcript for durable facts worth remembering (user
 * preferences, project decisions, recurring patterns) and upserts them into
 * the shared `MemoryStore`. The main conversation is never blocked: the hook
 * runs fire-and-forget and swallows all errors.
 *
 * Progress is tracked in `<dataRoot>/memory/extraction-state.json` so that
 * repeated turns do not re-analyze already-extracted messages, mirroring how
 * Claude Code skips transcript ranges that already produced memory writes.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { completeChat } from "../llm/chat.ts";
import type { LlmConfig } from "../llm/index.ts";
import type { MemoryStore } from "../orchestration/memory-store.ts";
import { contentAsString } from "../content.ts";
import type { AgentMessage } from "../types.ts";

export type AutoMemoryOptions = {
  /** Minimum number of new messages since the last extraction. Default 4. */
  minNewMessages?: number;
  /** Maximum number of recent messages analyzed per extraction. Default 30. */
  maxAnalyzedMessages?: number;
  /** Maximum characters of transcript text fed to the extractor. Default 12_000. */
  maxTranscriptChars?: number;
};

const DEFAULT_MIN_NEW_MESSAGES = 4;
const DEFAULT_MAX_ANALYZED = 30;
const DEFAULT_MAX_TRANSCRIPT_CHARS = 12_000;

const EXTRACTION_SYSTEM_PROMPT = [
  "You are a memory curator for an AI coding assistant.",
  "Analyze the conversation excerpt and extract durable facts worth remembering across future sessions:",
  "- User preferences (language, style, workflow habits)",
  "- Project conventions and decisions (frameworks, commands, architecture choices)",
  "- Recurring patterns or corrections the user made",
  "",
  "Do NOT save: transient task state, file contents, one-off questions, or anything already covered by existing memories.",
  "",
  'Respond with ONLY a JSON array. Each item: {"key": "<short-slug>", "content": "<one concise sentence>", "action": "add" | "forget"}',
  '- Use "add" to create or update a memory (same key overwrites).',
  '- Use "forget" when the conversation shows an existing memory key is wrong or obsolete.',
  "Return [] when there is nothing worth remembering.",
].join("\n");

type ExtractionAction = "add" | "forget";

type ExtractionItem = {
  key?: unknown;
  content?: unknown;
  action?: unknown;
};

/** Outcome of one extraction pass, for UI display. */
export type ExtractionResult = {
  /** Whether an extraction actually ran (false when gated/skipped). */
  ran: boolean;
  /** Memory keys created or updated this pass. */
  added: string[];
  /** Memory keys marked forgotten this pass. */
  forgotten: string[];
};

const EMPTY_RESULT: ExtractionResult = { ran: false, added: [], forgotten: [] };

function isExtractionItem(value: unknown): value is ExtractionItem {
  if (!value || typeof value !== "object") return false;
  const item = value as ExtractionItem;
  return typeof item.key === "string" && item.key.trim().length > 0;
}

/** Render the transcript tail for analysis (role-tagged, bounded size). */
function renderTranscript(messages: AgentMessage[], maxChars: number): string {
  const lines: string[] = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    const label =
      message.role === "user"
        ? "User"
        : message.role === "assistant"
          ? "Assistant"
          : message.role === "tool"
            ? `Tool(${message.name ?? ""})`
            : undefined;
    if (!label) continue;
    const text = contentAsString(message.content).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const line = `${label}: ${text.slice(0, 600)}`;
    total += line.length + 1;
    if (total > maxChars) break;
    lines.unshift(line);
  }
  return lines.join("\n");
}

export class AutoMemoryExtractor {
  private readonly minNewMessages: number;
  private readonly maxAnalyzedMessages: number;
  private readonly maxTranscriptChars: number;
  private readonly statePath: string;
  private lastProcessedCount = 0;
  private loaded = false;
  /** Serializes extractions so concurrent turns cannot double-write state. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly llm: LlmConfig,
    private readonly memoryStore: MemoryStore,
    options: AutoMemoryOptions = {},
    dataRoot = process.env.AGENT_DATA_DIR ?? path.join(process.env.HOME ?? "", ".mini-agent"),
  ) {
    this.minNewMessages = options.minNewMessages ?? DEFAULT_MIN_NEW_MESSAGES;
    this.maxAnalyzedMessages = options.maxAnalyzedMessages ?? DEFAULT_MAX_ANALYZED;
    this.maxTranscriptChars = options.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS;
    this.statePath = path.join(dataRoot, "memory", "extraction-state.json");
  }

  /**
   * Extract memories from a finished turn's history. Fire-and-forget safe:
   * never throws, returns what happened for UI display.
   */
  async maybeExtract(history: AgentMessage[]): Promise<ExtractionResult> {
    try {
      await this.loadState();
      const conversational = history.filter((message) => message.role !== "system");
      const newCount = conversational.length - this.lastProcessedCount;
      if (newCount < this.minNewMessages) return EMPTY_RESULT;

      // Serialize concurrent invocations.
      const previous = this.queue;
      let release!: () => void;
      this.queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous.catch(() => {});
      try {
        return await this.extract(conversational);
      } finally {
        release();
      }
    } catch {
      // Never let memory extraction break the main conversation.
      return EMPTY_RESULT;
    }
  }

  private async extract(conversational: AgentMessage[]): Promise<ExtractionResult> {
    const result: ExtractionResult = { ran: true, added: [], forgotten: [] };
    const recent = conversational.slice(-this.maxAnalyzedMessages);
    const existingMemories = await this.memoryStore.list({ includeForgotten: false });
    const memoryDigest = existingMemories
      .slice(0, 40)
      .map((record) => `- [${record.key}] ${record.content}`)
      .join("\n");

    const transcript = renderTranscript(recent, this.maxTranscriptChars);
    if (!transcript.trim()) {
      this.lastProcessedCount = conversational.length;
      await this.saveState();
      return result;
    }

    const response = await completeChat(this.llm, [
      { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          memoryDigest ? `Existing memories:\n${memoryDigest}\n` : "Existing memories: (none)\n",
          `Conversation excerpt:\n${transcript}`,
        ].join("\n\n"),
      },
    ]);

    const items = this.parseItems(contentAsString(response.content));
    for (const item of items) {
      const key = (item.key as string).trim().toLowerCase().replace(/\s+/g, "-").slice(0, 64);
      if (item.action === "forget") {
        const match = existingMemories.find((record) => record.key === key && record.status !== "forgotten");
        if (match) {
          await this.memoryStore.forget(match.id);
          result.forgotten.push(key);
        }
        continue;
      }
      const content = String(item.content ?? "").trim();
      if (!content) continue;
      await this.memoryStore.upsertByKey("project", key, content.slice(0, 500), "turn-end-extract");
      if (!result.added.includes(key)) result.added.push(key);
    }

    this.lastProcessedCount = conversational.length;
    await this.saveState();
    return result;
  }

  private parseItems(text: string): ExtractionItem[] {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start < 0 || end <= start) return [];
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed.filter(isExtractionItem) : [];
    } catch {
      return [];
    }
  }

  private async loadState(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.statePath, "utf8")) as { lastProcessedCount?: unknown };
      if (typeof raw.lastProcessedCount === "number") {
        this.lastProcessedCount = raw.lastProcessedCount;
      }
    } catch {
      // First run or unreadable state — start from zero.
    }
  }

  private async saveState(): Promise<void> {
    try {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      const temporary = `${this.statePath}.tmp`;
      await writeFile(temporary, JSON.stringify({ lastProcessedCount: this.lastProcessedCount }), "utf8");
      await rename(temporary, this.statePath);
    } catch {
      // State persistence is best-effort.
    }
  }
}

/** Whether auto-memory extraction is enabled (default on, opt-out via env). */
export function isAutoMemoryEnabled(): boolean {
  const value = process.env.MINI_AGENT_AUTO_MEMORY;
  return value !== "0" && value !== "false";
}

/**
 * Shared singleton wiring for entry points (CLI / TUI / server). Returns a
 * fire-and-forget extraction callback bound to the given LLM config.
 */
export function createAutoMemoryHook(
  llm: LlmConfig,
  memoryStore: MemoryStore,
  options: AutoMemoryOptions = {},
): (history: AgentMessage[]) => Promise<ExtractionResult> {
  const extractor = new AutoMemoryExtractor(llm, memoryStore, options);
  return (history: AgentMessage[]) => extractor.maybeExtract(history);
}
