import { createHash } from "node:crypto";

export const TODO_WRITE_TOOL_NAME = "TodoWrite" as const;
export const MAX_TODO_ITEMS = 50;
export const MAX_TODO_TEXT_LENGTH = 500;

let todoRevisionCounter = 0;

/** Return a process-wide monotonic revision for session task updates. */
export function nextTodoRevision(): number {
  todoRevisionCounter += 1;
  return todoRevisionCounter;
}

export function isTodoRevisionNewer(currentRevision: number | undefined, incomingRevision: number): boolean {
  return incomingRevision > (currentRevision ?? 0);
}

export type TodoStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

/** The model-facing shape is compatible with Claude Code's TodoWrite input. */
export type TodoWriteInputItem = {
  content: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed";
};

export type TodoItem = {
  id: string;
  content: string;
  activeForm: string;
  status: TodoStatus;
  source: "model" | "plan";
  error?: string;
};

export type TodoViewMode = "hidden" | "compact" | "expanded";

export function normalizeTodoText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function todoId(content: string): string {
  const digest = createHash("sha256").update(content).digest("hex").slice(0, 12);
  return `todo-${digest}`;
}

function invalid(message: string): never {
  throw new Error(`Invalid TodoWrite input: ${message}`);
}

/** Validate and normalize a complete TodoWrite replacement payload. */
export function normalizeTodoWriteInput(value: unknown): TodoItem[] {
  if (!value || typeof value !== "object") invalid("input must be an object");
  const todos = (value as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) invalid("todos must be an array");
  if (todos.length > MAX_TODO_ITEMS) invalid(`at most ${MAX_TODO_ITEMS} todos are allowed`);

  const seen = new Set<string>();
  let inProgress = 0;
  const normalized = todos.map((item, index) => {
    if (!item || typeof item !== "object") invalid(`todos[${index}] must be an object`);
    const raw = item as Record<string, unknown>;
    const content = typeof raw.content === "string" ? normalizeTodoText(raw.content) : "";
    const activeForm = typeof raw.activeForm === "string" ? normalizeTodoText(raw.activeForm) : "";
    const status = raw.status;
    if (!content) invalid(`todos[${index}].content is required`);
    if (!activeForm) invalid(`todos[${index}].activeForm is required`);
    if (content.length > MAX_TODO_TEXT_LENGTH) invalid(`todos[${index}].content is too long`);
    if (activeForm.length > MAX_TODO_TEXT_LENGTH) invalid(`todos[${index}].activeForm is too long`);
    if (status !== "pending" && status !== "in_progress" && status !== "completed") {
      invalid(`todos[${index}].status must be pending, in_progress, or completed`);
    }
    const normalizedStatus = status as TodoWriteInputItem["status"];
    const duplicateKey = content.toLowerCase();
    if (seen.has(duplicateKey)) invalid(`todos[${index}].content is duplicated`);
    seen.add(duplicateKey);
    if (normalizedStatus === "in_progress") inProgress += 1;
    return { id: todoId(content), content, activeForm, status: normalizedStatus, source: "model" as const };
  });
  if (inProgress > 1) invalid("only one todo may be in_progress");
  return normalized;
}

export function todoSummary(items: readonly TodoItem[]): {
  total: number;
  completed: number;
  inProgress: number;
  open: number;
  failed: number;
} {
  return items.reduce(
    (summary, item) => {
      if (item.status === "completed") summary.completed += 1;
      if (item.status === "in_progress") summary.inProgress += 1;
      if (item.status === "failed") summary.failed += 1;
      if (item.status === "pending" || item.status === "in_progress") summary.open += 1;
      return summary;
    },
    { total: items.length, completed: 0, inProgress: 0, open: 0, failed: 0 },
  );
}
