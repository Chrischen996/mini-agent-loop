import React, { useState, useEffect, useCallback } from "react";
import type { BgTaskSummary, LogChunk } from "../../../src/bg-tasks/manager.js";

export default function BackgroundTasksPanel() {
  const [tasks, setTasks] = useState<BgTaskSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [logs, setLogs] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/background-tasks");
      const data = await res.json();
      setTasks(data.tasks || []);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [refresh]);

  const loadLogs = async (taskId: string) => {
    try {
      const res = await fetch(`/api/background-tasks/${taskId}/logs?limit=50`);
      const data = await res.json();
      setLogs(data.content || "");
      setSelectedId(taskId);
    } catch (e) {
      setError(String(e));
    }
  };

  const sendInput = async (taskId: string) => {
    await fetch(`/api/background-tasks/${taskId}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "\n", enter: true })
    });
  };

  const killTask = async (taskId: string) => {
    await fetch(`/api/background-tasks/${taskId}/kill`, { method: "POST" });
    refresh();
  };

  return (
    <div style={{ border: "1px solid #ccc", padding: 12, fontFamily: "monospace" }}>
      <h3>Background Tasks ({tasks.length})</h3>
      {error && <div style={{ color: "red" }}>{error}</div>}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr><th>ID</th><th>Name</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {tasks.map(t => (
            <tr key={t.taskId} style={{ background: selectedId === t.taskId ? "#e6f7ff" : "" }}>
              <td>{t.taskId}</td>
              <td>{t.name || t.command}</td>
              <td>{t.status}</td>
              <td>
                <button onClick={() => loadLogs(t.taskId)}>Logs</button>
                <button onClick={() => killTask(t.taskId)}>Kill</button>
                <button onClick={() => sendInput(t.taskId)}>Send</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {selectedId && (
        <pre style={{ background: "#f5f5f5", padding: 8, maxHeight: 200, overflow: "auto" }}>
          {logs}
        </pre>
      )}
    </div>
  );
}
