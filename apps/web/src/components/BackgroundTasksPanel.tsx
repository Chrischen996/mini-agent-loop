import { useCallback, useEffect, useMemo, useState } from "react";
import type { BgTaskSummary } from "../../../src/bg-tasks/manager.js";
import type { WorkspacePanelScope } from "../lib/workspace-scope.ts";

type Props = WorkspacePanelScope & { active?: boolean };

function taskQuery(scope: WorkspacePanelScope): string {
  const query = new URLSearchParams();
  if (scope.sessionId) query.set("sessionId", scope.sessionId);
  if (scope.workspaceId) query.set("workspaceId", scope.workspaceId);
  return query.toString();
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

export default function BackgroundTasksPanel({ active = true, ...scope }: Props) {
  const [tasks, setTasks] = useState<BgTaskSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [logs, setLogs] = useState("");
  const [logOffset, setLogOffset] = useState(0);
  const [command, setCommand] = useState("");
  const [taskName, setTaskName] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useMemo(() => taskQuery(scope), [scope.sessionId, scope.workspaceId]);

  const refresh = useCallback(async () => {
    try {
      const data = await apiRequest<{ tasks: BgTaskSummary[] }>(`/api/background-tasks${query ? `?${query}` : ""}`);
      setTasks(data.tasks);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [query]);

  const loadLogs = useCallback(async (taskId: string, reset = false) => {
    try {
      const offset = reset ? 0 : logOffset;
      const data = await apiRequest<{ chunk: { text: string; nextOffset: number } }>(`/api/background-tasks/${encodeURIComponent(taskId)}/logs?offset=${offset}&limitBytes=16384`);
      setLogs((current) => reset ? data.chunk.text : current + data.chunk.text);
      setLogOffset(data.chunk.nextOffset);
      setSelectedId(taskId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [logOffset]);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  useEffect(() => {
    setLogs("");
    setLogOffset(0);
    setSelectedId(null);
  }, [query]);

  useEffect(() => {
    if (!active || !selectedId) return;
    const timer = setInterval(() => void loadLogs(selectedId), 2500);
    return () => clearInterval(timer);
  }, [active, selectedId, loadLogs]);

  const startTask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!command.trim()) return;
    setBusy(true);
    try {
      await apiRequest(`/api/background-tasks${query ? `?${query}` : ""}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: command.trim(), ...(taskName.trim() ? { name: taskName.trim() } : {}) }),
      });
      setCommand(""); setTaskName("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  const mutate = async (taskId: string, action: "input" | "kill") => {
    try {
      await apiRequest(`/api/background-tasks/${encodeURIComponent(taskId)}/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "input" ? { text: input, enter: true } : {}),
      });
      if (action === "input") setInput("");
      await refresh();
      if (action === "input") await loadLogs(taskId, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const selectedTask = tasks.find((task) => task.taskId === selectedId);
  return <section className="bg-tasks" aria-label="Background tasks">
    <form className="bg-tasks__start" onSubmit={(event) => void startTask(event)}>
      <input aria-label="Task name" placeholder="Task name (optional)" value={taskName} onChange={(event) => setTaskName(event.target.value)} />
      <textarea aria-label="Command" placeholder="Command" rows={2} value={command} onChange={(event) => setCommand(event.target.value)} />
      <button type="submit" disabled={busy || !command.trim()}>{busy ? "Starting…" : "Start task"}</button>
    </form>
    {error && <p role="alert" className="bg-tasks__error">{error}</p>}
    <div className="bg-tasks__list" aria-live="polite">
      {!tasks.length && <p className="bg-tasks__empty">No background tasks in this workspace.</p>}
      {tasks.map((task) => <article key={task.taskId} className={`bg-task${selectedId === task.taskId ? " bg-task--selected" : ""}`}>
        <button type="button" className="bg-task__select" onClick={() => { setLogs(""); setLogOffset(0); void loadLogs(task.taskId, true); }}>
          <span className="bg-task__title">{task.name || task.command}</span>
          <span className={`bg-task__status bg-task__status--${task.status}`}>{task.status.replaceAll("_", " ")}</span>
          <span className="bg-task__meta">{task.taskId.slice(0, 12)} · {Math.round(task.durationMs / 1000)}s</span>
        </button>
        <div className="bg-task__actions">
          {task.status === "running" && <button type="button" title="Terminate task" aria-label="Terminate task" onClick={() => void mutate(task.taskId, "kill")}>Stop</button>}
        </div>
      </article>)}
    </div>
    {selectedTask && <section className="bg-tasks__details" aria-label={`Task details: ${selectedTask.name}`}>
      <div className="bg-tasks__detail-heading"><strong>{selectedTask.name || selectedTask.taskId}</strong><button type="button" onClick={() => void loadLogs(selectedTask.taskId, true)}>Refresh logs</button></div>
      <pre className="bg-tasks__logs" aria-live="polite">{logs || "No output yet."}</pre>
      {selectedTask.status === "running" && <form className="bg-tasks__input" onSubmit={(event) => { event.preventDefault(); void mutate(selectedTask.taskId, "input"); }}>
        <input aria-label="Send input to task" placeholder="Send text to process" value={input} onChange={(event) => setInput(event.target.value)} />
        <button type="submit" disabled={!input}>Send</button>
      </form>}
    </section>}
  </section>;
}
