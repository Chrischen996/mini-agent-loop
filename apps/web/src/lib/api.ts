import type {
  CreateSessionResponse,
  ModelOption,
  ModelsListResponse,
  PlanSummary,
  SessionDetail,
  SessionSummary,
  WorkspaceEntry,
  WorkspaceListResponse,
} from "../types/api.ts";

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (body && typeof body.error === "string") message = body.error;
    } catch {
      // Body was not JSON; keep the status-based message.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

const json = { "Content-Type": "application/json" };

/**
 * Typed fetch wrappers for the backend (doc 1.md §6).
 * Same-origin only: in dev the Vite proxy forwards /api, in prod Express
 * serves the UI and API on one host. No CORS configuration is involved.
 */
export const api = {
  health: (): Promise<{ ok: boolean }> => requestJson<{ ok: boolean }>("/api/health"),

  listSessions: async (): Promise<SessionSummary[]> => {
    const body = await requestJson<{ sessions: SessionSummary[] }>("/api/sessions");
    return body.sessions;
  },

  createSession: (): Promise<CreateSessionResponse> =>
    requestJson<CreateSessionResponse>("/api/sessions", {
      method: "POST",
      headers: json,
      body: "{}",
    }),

  getSession: (id: string): Promise<SessionDetail> =>
    requestJson<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),

  /** DELETE returns 204 with no body, so it cannot go through requestJson. */
  deleteSession: async (id: string): Promise<void> => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok && response.status !== 204) {
      let message = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { error?: unknown };
        if (body && typeof body.error === "string") message = body.error;
      } catch {
        // non-JSON body
      }
      throw new Error(message);
    }
  },

  setModel: (id: string, model: string): Promise<unknown> =>
    requestJson(`/api/sessions/${encodeURIComponent(id)}/model`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ model }),
    }),

  getPermissionMode: (id: string): Promise<{ mode: string }> =>
    requestJson<{ mode: string }>(`/api/sessions/${encodeURIComponent(id)}/permission-mode`),

  setPermissionMode: (id: string, mode: "plan" | "bypass"): Promise<unknown> =>
    requestJson(`/api/sessions/${encodeURIComponent(id)}/permission-mode`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ mode }),
    }),

  /** P4 wires approve/deny buttons to this; the server always re-validates (doc §9.2). */
  resolvePermission: (id: string, requestId: string, decision: "allow" | "deny"): Promise<{ resolved: boolean }> =>
    requestJson<{ resolved: boolean }>(
      `/api/sessions/${encodeURIComponent(id)}/permissions/${encodeURIComponent(requestId)}`,
      { method: "POST", headers: json, body: JSON.stringify({ decision }) },
    ),

  /**
   * POST a user message. The response is an NDJSON stream
   * (application/x-ndjson); pass the Response to lib/stream.ts readNdjson.
   * Aborting `signal` cancels the backend task (server maps the closed
   * request to its internal AbortController).
   */
  sendPrompt: (id: string, prompt: string, signal?: AbortSignal): Promise<Response> =>
    fetch(`/api/sessions/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ prompt }),
      signal,
    }),

  // ── Workspace (P4) ───────────────────────────────────────────────────────

  listWorkspace: (relativePath = ""): Promise<WorkspaceListResponse> =>
    requestJson<WorkspaceListResponse>(
      `/api/workspace/list?path=${encodeURIComponent(relativePath)}`,
    ),

  // ── Models (P4) ──────────────────────────────────────────────────────────

  listModels: (): Promise<ModelsListResponse> =>
    requestJson<ModelsListResponse>("/api/models"),

  // ── Plan (P4) ────────────────────────────────────────────────────────────

  getSessionPlan: (id: string): Promise<{ plan: PlanSummary | null }> =>
    requestJson<{ plan: PlanSummary | null }>(
      `/api/sessions/${encodeURIComponent(id)}/plan`,
    ),
};
