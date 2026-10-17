/** Presentation model for a conversation tool row. Display only. */

export type ToolArgs = Record<string, unknown>;

export type ToolCardKind = "read" | "bash" | "search" | "mutate" | "generic";

export type ToolCardInput = {
  name: string;
  status: "running" | "ok" | "error";
  preview: string;
  path?: string;
  startLine?: number;
  args?: ToolArgs;
  inputBytes?: number;
};

export type ToolChange = { kind: "removed" | "added"; text: string };

export type ToolCard = {
  kind: ToolCardKind;
  title: string;
  summary: string;
  summaryTone: "normal" | "error";
  suffix?: string;
  statusLabel: "Running" | "Failed" | "Done";
  expandable: boolean;
  command?: string;
  input?: string;
  output?: string;
  lines?: { number: number; text: string }[];
  notice?: string;
  changes?: ToolChange[];
};

const STRING_CAP = 240;
const CONTENT_KEYS = new Set(["content", "oldText", "newText", "old_string", "new_string"]);

const TITLES: Record<string, string> = {
  read: "Read",
  bash: "Bash",
  write: "Write",
  edit: "Edit",
  grep: "Grep",
  find: "Find",
  search: "Search",
  ls: "List",
};

function asRecord(value: unknown): ToolArgs | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as ToolArgs;
}

function clip(value: string, cap = STRING_CAP): string {
  return value.length > cap ? `${value.slice(0, cap)}…` : value;
}

function stringField(args: ToolArgs | undefined, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Keep argument text small enough to live in the view model. */
export function captureToolArgs(args: unknown): { args?: ToolArgs; inputBytes?: number } {
  const record = asRecord(args);
  if (!record) return {};
  let bytes = 0;
  let counted = false;
  const slim: ToolArgs = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") {
      if (CONTENT_KEYS.has(key)) {
        bytes += value.length;
        counted = true;
      }
      slim[key] = clip(value, CONTENT_KEYS.has(key) ? STRING_CAP : 500);
    } else if (typeof value === "number" || typeof value === "boolean") {
      slim[key] = value;
    } else if (key === "edits" && Array.isArray(value)) {
      slim.edits = value.slice(0, 8).map((edit) => {
        const row = asRecord(edit);
        const oldText = typeof row?.oldText === "string" ? row.oldText : "";
        const newText = typeof row?.newText === "string" ? row.newText : "";
        bytes += oldText.length + newText.length;
        counted = true;
        return { oldText: clip(oldText), newText: clip(newText) };
      });
    }
  }
  return { args: slim, ...(counted ? { inputBytes: bytes } : {}) };
}

function kindOf(name: string): ToolCardKind {
  const key = name.trim().toLowerCase();
  if (key === "read") return "read";
  if (key === "bash") return "bash";
  if (key === "grep" || key === "find" || key === "search") return "search";
  if (key === "write" || key === "edit") return "mutate";
  return "generic";
}

function titleOf(name: string): string {
  const key = name.trim().toLowerCase();
  return TITLES[key] ?? (name.trim() || "Tool");
}

function splitNotice(preview: string): { body: string; notice?: string } {
  const match = preview.match(/\n\n\[notice: ([\s\S]+)\]\s*$/);
  if (!match || match.index === undefined) return { body: preview };
  return { body: preview.slice(0, match.index), notice: match[1] };
}

function readLines(preview: string, startLine = 1): { lines: { number: number; text: string }[]; notice?: string } {
  const { body, notice } = splitNotice(preview.replace(/\r\n?/g, "\n"));
  const lines = body.split("\n").map((text, index) => ({ number: startLine + index, text }));
  return { lines, notice };
}

function changesFrom(args: ToolArgs | undefined): ToolChange[] | undefined {
  const edits = args?.edits;
  if (!Array.isArray(edits) || edits.length === 0) return undefined;
  const changes: ToolChange[] = [];
  for (const edit of edits.slice(0, 4)) {
    const row = asRecord(edit);
    if (typeof row?.oldText === "string" && row.oldText) changes.push({ kind: "removed", text: oneLine(row.oldText) });
    if (typeof row?.newText === "string" && row.newText) changes.push({ kind: "added", text: oneLine(row.newText) });
  }
  return changes.length ? changes : undefined;
}

function inputText(kind: ToolCardKind, args: ToolArgs | undefined): string | undefined {
  if (!args || kind === "read" || kind === "bash") return undefined;
  const lines = Object.entries(args)
    .filter(([key]) => !CONTENT_KEYS.has(key) && key !== "edits")
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  const text = lines.join("\n").trim();
  return text || undefined;
}

function suffixFor(item: ToolCardInput, kind: ToolCardKind): string | undefined {
  if (item.status === "error" || kind !== "mutate" || item.inputBytes === undefined) return undefined;
  return `${Math.max(1, Math.ceil(item.inputBytes / 1024))}KB`;
}

/** Build the row and the card body from a tool view item. */
export function toolCard(item: ToolCardInput): ToolCard {
  const kind = kindOf(item.name);
  const args = item.args;
  const path = item.path || stringField(args, "path") || stringField(args, "file_path");
  const command = stringField(args, "command");
  const pattern = stringField(args, "pattern") || stringField(args, "query") || stringField(args, "url");
  const summary = kind === "bash"
    ? (command ? oneLine(command) : "")
    : kind === "search"
      ? (pattern ?? path ?? "")
      : (path ?? pattern ?? command ?? "");
  const errorLine = item.status === "error"
    ? oneLine(item.preview).slice(0, 160)
    : "";
  const output = item.preview.trim() ? item.preview : undefined;
  const read = kind === "read" && output ? readLines(output, item.startLine ?? 1) : undefined;
  const changes = kind === "mutate" ? changesFrom(args) : undefined;
  const input = inputText(kind, args);
  const expandable = Boolean(read?.lines.length || output || command || input || changes?.length);
  return {
    kind,
    title: titleOf(item.name),
    summary: errorLine || summary,
    summaryTone: errorLine ? "error" : "normal",
    suffix: errorLine ? undefined : suffixFor(item, kind),
    statusLabel: item.status === "running" ? "Running" : item.status === "error" ? "Failed" : "Done",
    expandable,
    command: kind === "bash" ? command : undefined,
    input,
    output: kind === "read" ? undefined : output,
    lines: read?.lines,
    notice: read?.notice,
    changes,
  };
}
