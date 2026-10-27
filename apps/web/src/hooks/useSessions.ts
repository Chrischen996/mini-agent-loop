import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../lib/api.ts";
import type { ForeignSessionCandidate, SessionSummary } from "../types/api.ts";

export function useSessions() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importMatches, setImportMatches] = useState<ForeignSessionCandidate[]>([]);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.listSessions();
      setSessions(list);
      // Keep the current selection when possible; otherwise pick the newest.
      setActiveId((current) => current ?? list[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const importForeignSession = useCallback(async (
    source: "claude" | "codex",
    reference: string,
    workspaceId?: string,
  ): Promise<string | null> => {
    setCreating(true);
    setImportMatches([]);
    try {
      const imported = await api.importForeignSession(source, reference, workspaceId);
      await refresh();
      setActiveId(imported.id);
      return imported.id;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setImportMatches(err instanceof ApiError ? err.matches : []);
      return null;
    } finally {
      setCreating(false);
    }
  }, [refresh]);

  const createSession = useCallback(async (workspaceId?: string): Promise<string | null> => {
    setCreating(true);
    try {
      const created = await api.createSession(workspaceId);
      await refresh();
      setActiveId(created.id);
      return created.id;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setCreating(false);
    }
  }, [refresh]);

  return { sessions, activeId, setActiveId, refresh, createSession, importForeignSession, importMatches, creating, loading, error };
}
