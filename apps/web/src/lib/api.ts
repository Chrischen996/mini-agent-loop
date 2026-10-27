import type { ContinueRunRequest } from "../types/api.ts";
import type {
  CreateSessionResponse,
  ModelOption,
  ModelProviderDiscoveryResponse,
  ModelProviderInput,
  ModelProviderListResponse,
  ModelSelectionResponse,
  ModelsListResponse,
  PlanSummary,
  ForeignSessionCandidate,
  ForeignSessionListResponse,
  ImportSessionResponse,
  SessionDetail,
  SessionSummary,
  ThinkingLevelResponse,
  WorkspaceEntry,
  WorkspaceFilePreview,
  WorkspaceListResponse,
  WorkspaceRecord,
} from "../types/api.ts";

export class ApiError extends Error {
  readonly matches: ForeignSessionCandidate[];

  constructor(message: string, matches: ForeignSessionCandidate[] = []) {
    super(message);
    this.name = "ApiError";
    this.matches = matches;
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    let matches: ForeignSessionCandidate[] = [];
    try {
      const body = (await response.json()) as { error?: unknown; matches?: unknown };
      if (body && typeof body.error === "string") message = body.error;
      if (Array.isArray(body.matches)) matches = body.matches as ForeignSessionCandidate[];
    } catch {
      // Body was not JSON; keep the status-based message.
    }
    throw new ApiError(message, matches);
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

  listForeignSessions: (source: "claude" | "codex", workspaceId?: string): Promise<ForeignSessionListResponse> =>
    requestJson(`/api/foreign-sessions?source=${source}${workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : ""}`),

  importForeignSession: (source: "claude" | "codex", reference: string, workspaceId?: string): Promise<ImportSessionResponse> =>
    requestJson("/api/sessions/import", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ source, reference, workspaceId }),
    }),

  createSession: (workspaceId?: string): Promise<CreateSessionResponse> =>
    requestJson<CreateSessionResponse>("/api/sessions", {
      method: "POST",
      headers: json,
      body: JSON.stringify(workspaceId ? { workspaceId } : {}),
    }),

  listWorkspaces: async (): Promise<WorkspaceRecord[]> => {
    const body = await requestJson<{ workspaces: WorkspaceRecord[] }>("/api/workspaces");
    return body.workspaces;
  },

  addWorkspace: (path: string): Promise<{ workspace: WorkspaceRecord }> =>
    requestJson("/api/workspaces", { method: "POST", headers: json, body: JSON.stringify({ path }) }),

  browseWorkspaceDirectories: (path?: string): Promise<{
    path: string;
    parent: string | null;
    home: string;
    crumbs: Array<{ name: string; path: string }>;
    directories: Array<{ name: string; path: string; hidden?: boolean }>;
    truncated?: boolean;
  }> =>
    requestJson(`/api/workspaces/directories${path ? `?path=${encodeURIComponent(path)}` : ""}`),

  createWorkspaceDirectory: (path: string, name: string): Promise<{ path: string }> =>
    requestJson("/api/workspaces/directories", { method: "POST", headers: json, body: JSON.stringify({ path, name }) }),

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

  updateSessionPresentation: (id: string, patch: { title?: string; pinned?: boolean; archived?: boolean }): Promise<{ title: string; pinned: boolean; archived: boolean }> =>
    requestJson(`/api/sessions/${encodeURIComponent(id)}/presentation`, {
      method: "PATCH", headers: json, body: JSON.stringify(patch),
    }),

  setModel: (id: string, model: string): Promise<ModelSelectionResponse> =>
    requestJson<ModelSelectionResponse>(`/api/sessions/${encodeURIComponent(id)}/model`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ model }),
    }),

  setThinkingLevel: (id: string, thinkingLevel: string): Promise<ThinkingLevelResponse> =>
    requestJson<ThinkingLevelResponse>(`/api/sessions/${encodeURIComponent(id)}/thinking-level`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ thinkingLevel }),
    }),

  getPermissionMode: (id: string): Promise<{ mode: string }> =>
    requestJson<{ mode: string }>(`/api/sessions/${encodeURIComponent(id)}/permission-mode`),

  setPermissionMode: (id: string, mode: "plan" | "bypass"): Promise<unknown> =>
    requestJson(`/api/sessions/${encodeURIComponent(id)}/permission-mode`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ mode }),
    }),

  getSessionSkills: (id: string): Promise<{ available: Array<{ name: string; description: string }>; active: string[]; missing: string[] }> =>
    requestJson(`/api/sessions/${encodeURIComponent(id)}/skills`),

  updateSessionSkills: (id: string, patch: { add?: string[]; remove?: string[] }): Promise<{ available: Array<{ name: string; description: string }>; active: string[]; missing: string[] }> =>
    requestJson(`/api/sessions/${encodeURIComponent(id)}/skills`, { method: "PUT", headers: json, body: JSON.stringify(patch) }),

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
  sendPrompt: (id: string, prompt: string, files: File[] = [], signal?: AbortSignal): Promise<Response> => {
    if (files.length === 0) {
      return fetch(`/api/sessions/${encodeURIComponent(id)}/messages`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ prompt }),
        signal,
      });
    }
    const body = new FormData();
    body.set("prompt", prompt);
    for (const file of files) {
      const isImage = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type) || /\.(png|jpe?g|gif|webp)$/i.test(file.name);
      body.append(isImage ? "images" : "documents", file, file.name);
    }
    return fetch(`/api/sessions/${encodeURIComponent(id)}/messages`, { method: "POST", body, signal });
  },

  /** Continue from a checkpoint; omitted budgets allocate the configured default budget. */
  continueSession: (id: string, signal?: AbortSignal, budget: ContinueRunRequest = {}): Promise<Response> =>
    fetch(`/api/sessions/${encodeURIComponent(id)}/continue`, {
      method: "POST",
      headers: json,
      body: JSON.stringify(budget),
      signal,
    }),

  // ── Workspace (P4) ───────────────────────────────────────────────────────

  listWorkspace: (relativePath = "", sessionId?: string, workspaceId?: string): Promise<WorkspaceListResponse> =>
    requestJson<WorkspaceListResponse>(
      `/api/workspace/list?path=${encodeURIComponent(relativePath)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : ""}`,
    ),

  readWorkspaceFile: (
    relativePath: string,
    sessionId?: string,
    workspaceId?: string,
    window?: { offset?: number; limit?: number },
  ): Promise<WorkspaceFilePreview> => {
    const query = new URLSearchParams({ path: relativePath });
    if (sessionId) query.set("sessionId", sessionId);
    else if (workspaceId) query.set("workspaceId", workspaceId);
    if (window?.offset) query.set("offset", String(window.offset));
    if (window?.limit) query.set("limit", String(window.limit));
    return requestJson<WorkspaceFilePreview>(`/api/workspace/file?${query.toString()}`);
  },

  // ── Models (P4) ──────────────────────────────────────────────────────────

  listModels: (): Promise<ModelsListResponse> =>
    requestJson<ModelsListResponse>("/api/models"),

  listModelProviders: (): Promise<ModelProviderListResponse> =>
    requestJson<ModelProviderListResponse>("/api/model-providers"),

  createModelProvider: (input: ModelProviderInput): Promise<ModelProviderListResponse["providers"][number]> =>
    requestJson<ModelProviderListResponse["providers"][number]>("/api/model-providers", {
      method: "POST",
      headers: json,
      body: JSON.stringify(input),
    }),

  updateModelProvider: (provider: string, input: ModelProviderInput): Promise<ModelProviderListResponse["providers"][number]> =>
    requestJson<ModelProviderListResponse["providers"][number]>(`/api/model-providers/${encodeURIComponent(provider)}`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify(input),
    }),

  deleteModelProvider: async (provider: string): Promise<void> => {
    const response = await fetch(`/api/model-providers/${encodeURIComponent(provider)}`, { method: "DELETE" });
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

  discoverModelProvider: (input: Pick<ModelProviderInput, "baseUrl" | "protocol"> & { provider?: string; apiKey?: string }): Promise<ModelProviderDiscoveryResponse> =>
    requestJson<ModelProviderDiscoveryResponse>("/api/model-providers/discover", {
      method: "POST",
      headers: json,
      body: JSON.stringify(input),
    }),

  // ── Plan (P4) ────────────────────────────────────────────────────────────

  getSessionPlan: (id: string): Promise<{ plan: PlanSummary | null }> =>
    requestJson<{ plan: PlanSummary | null }>(
      `/api/sessions/${encodeURIComponent(id)}/plan`,
    ),
};
