/**
 * Session CRUD and per-session configuration routes, split out of the
 * `createAgentServer` factory in `src/server.ts` (whose single 2000-line body
 * inlined every domain). Covers goal get/put/delete, per-session model &
 * thinking-level switching, session list/create/fork/rewind/tree/get/delete,
 * and foreign-session listing/import.
 *
 * The deepest turn runners (`plan/generate`, `plan/execute`, `plan/retry`,
 * `/messages`, `/continue`) stay in the factory: they close over the session
 * loop wiring (`runSessionTurn`, `createSessionLoopOptions`, subagent tool
 * sets) and need the live factory state, so factoring them would require
 * re-plumbing the whole turn pipeline.
 *
 * Each handler receives a narrow `SessionRoutesContext` describing only the
 * collaborators it needs, mirroring `./plan-act.ts` — a domain can be read,
 * tested, and changed without loading the whole server factory.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Express, Request, Response } from "express";
import { buildSystemPrompt, createAgentHistory, restoreAgentHistory } from "../../loop.ts";
import { planManager } from "../../plan-act/plan-manager.ts";
import type { PlanDocument } from "../../plan/document.ts";
import { loadPlanDocument } from "../../plan/index.ts";
import { loadInstructionBundle } from "../../agents-md.ts";
import { contentAsString } from "../../content.ts";
import { adaptHistoryForModel, mergeConsecutiveSameRole } from "../../message-adapter.ts";
import { resolveModel, type ModelRef } from "../../models.ts";
import {
  ForeignSessionError,
  formatForeignSessionList,
  importForeignSession,
  listForeignSessions,
  type ForeignSessionSource,
} from "../../foreign-session.ts";
import { PermissionManager, type PermissionMode } from "../../permissions.ts";
import { getSelectableThinkingLevels, withThinkingLevel } from "../../think-intensity.ts";
import type { LlmConfig } from "../../llm/index.ts";
import { loadThinkingModeFromEnv, type ThinkingMode } from "../../thinking-policy.ts";
import type { ModelThinkingLevel } from "../../pi-ai/types.ts";
import type { SessionExecutionLease } from "../../orchestration/session-gate.ts";
import type { SessionManager } from "../../session-manager.ts";
import type { PersistedSession } from "../../session-store.ts";
import type { DocumentStore } from "../../documents.ts";
import type { WorkspaceRegistry, WorkspaceRecord } from "../../workspaces.ts";
import {
  goalSnapshot,
  isGoalStatus,
  type GoalFeatureConfig,
  type GoalSessionContext,
} from "../../goal/index.ts";
import type { Session } from "../../server.ts";
import {
  truncateSessionMessages,
  visibleMessageCount,
  resolveMessageBoundary,
  messageIdAtBoundary,
} from "../prompt.ts";
import type { SessionPresentationStore } from "../session-presentation.ts";
import { safeMessage } from "../serialization.ts";

export type SessionRoutesContext = {
  sessions: Map<string, Session>;
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "list">;
  defaultWorkspace: () => WorkspaceRecord;
  workspace: string;
  dataRoot: string;
  sessionPresentation: SessionPresentationStore;
  goalConfig: GoalFeatureConfig;
  goalSessions: Map<string, GoalSessionContext>;
  goalSessionFor: (sessionId: string) => GoalSessionContext | undefined;
  isSessionBusy: (session: Session) => boolean;
  reserveSession: (session: Session, owner: string) => SessionExecutionLease | undefined;
  releaseSession: (session: Session, lease: SessionExecutionLease) => void;
  saveSession: (session: Session) => Promise<void>;
  persistedSession: (session: Session) => PersistedSession;
  sessionManagerForSession: (session: Session) => SessionManager;
  sessionManagerForWorkspace: (record: WorkspaceRecord) => SessionManager;
  documentStore: Pick<DocumentStore, "createSession" | "removeSession">;
  sessionLlmConfig: (session: Session) => LlmConfig;
  resolveSessionModel: (reference: string, current: LlmConfig) => LlmConfig;
  customProviderForModel: (reference: string) => { model: ModelRef; apiKey: string } | undefined;
  workspaceIdForSession: (session: Session) => string;
  workspaceForSession: (session: Session) => string;
  resolveSessionSkillNames: (session: Session) => string[];
  defaultPermissionMode: PermissionMode;
  defaultSkillNames: string[];
  /** `options.thinkingMode ?? loadThinkingModeFromEnv()` — read once by the factory. */
  defaultThinkingMode: ThinkingMode;
  /** Live value (filled by instruction discovery), read at request time. */
  instructionContent: () => string;
  /** Live value (filled by memory discovery), read at request time. */
  memorySectionContent: () => string;
  /** Server default LLM, used as the thinking-level fallback in list views. */
  defaultLlm: LlmConfig;
};

export function registerSessionRoutes(app: Express, context: SessionRoutesContext): void {
  const {
    sessions,
    workspaceRegistry,
    defaultWorkspace,
    sessionPresentation,
    goalConfig,
    goalSessions,
    goalSessionFor,
    isSessionBusy,
    reserveSession,
    releaseSession,
    saveSession,
    sessionLlmConfig,
    resolveSessionModel,
    customProviderForModel,
    workspaceIdForSession,
    defaultPermissionMode,
  } = context;

  /** Persistent thread goal; enabled by default, disable via MINI_AGENT_GOALS=0. */
  app.get("/api/sessions/:id/goal", async (request: Request, response: Response) => {
    const session = sessions.get(String(request.params.id));
    if (!session) { response.status(404).json({ error: "Session not found" }); return; }
    if (!goalConfig.enabled) { response.status(403).json({ error: "Goals are disabled" }); return; }
    const current = await goalSessionFor(session.id)!.manager.get();
    response.json({ goal: current ? goalSnapshot(current.raw) : null });
  });

  app.put("/api/sessions/:id/goal", async (request: Request, response: Response) => {
    const session = sessions.get(String(request.params.id));
    if (!session) { response.status(404).json({ error: "Session not found" }); return; }
    if (!goalConfig.enabled) { response.status(403).json({ error: "Goals are disabled" }); return; }
    const body = request.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      response.status(400).json({ error: "Expected a goal object" }); return;
    }
    if (body.status !== undefined && !isGoalStatus(body.status)) {
      response.status(400).json({ error: "Invalid goal status" }); return;
    }
    try {
      const updated = await goalSessionFor(session.id)!.manager.setFromUser({
        ...(body.clear === true ? { clear: true } : {}),
        ...(typeof body.objective === "string" ? { objective: body.objective } : {}),
        ...(isGoalStatus(body.status) ? { status: body.status } : {}),
        ...(body.tokenBudget === null || typeof body.tokenBudget === "number"
          ? { tokenBudget: body.tokenBudget as number | null } : {}),
      });
      response.json({ goal: updated ? goalSnapshot(updated) : null });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/sessions/:id/goal", async (request: Request, response: Response) => {
    const session = sessions.get(String(request.params.id));
    if (!session) { response.status(404).json({ error: "Session not found" }); return; }
    if (!goalConfig.enabled) { response.status(403).json({ error: "Goals are disabled" }); return; }
    await goalSessionFor(session.id)!.manager.setFromUser({ clear: true });
    response.json({ ok: true });
  });

  app.put("/api/sessions/:id/model", async (request: Request, response: Response) => {
    const session = sessions.get(String(request.params.id));
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const modelId = String(request.body?.model ?? "").trim();
    if (!modelId) {
      response.status(400).json({ error: "model is required" });
      return;
    }
    const lease = reserveSession(session, "model");
    if (!lease) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }
    try {
      const previousLlm = sessionLlmConfig(session);
      const newLlm = resolveSessionModel(modelId, previousLlm);
      // Persist a provider-safe transcript at the switch boundary. This is
      // important for a later request/restart: the next model must not be
      // handed tool calls or images it cannot consume.
      session.messages = mergeConsecutiveSameRole(adaptHistoryForModel(session.messages, {
        targetCapabilities: newLlm.capabilities,
        sourceCapabilities: previousLlm.capabilities,
      }));
      session.modelId = `${newLlm.provider}/${newLlm.model}`;
      session.llmOverride = newLlm;
      session.thinkingLevel = newLlm.thinkingLevel;
      await saveSession(session);
      const resolved = customProviderForModel(session.modelId)?.model
        ?? resolveModel(newLlm.model, newLlm.baseUrl);
      response.json({
        model: newLlm.model,
        qualifiedId: session.modelId,
        provider: newLlm.provider,
        capabilities: newLlm.capabilities,
        contextWindow: resolved.contextWindow,
        maxTokens: newLlm.maxTokens,
        thinkingLevel: newLlm.thinkingLevel ?? (newLlm.reasoning ? "medium" : "off"),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      response.status(400).json({ error: message });
    } finally {
      releaseSession(session, lease);
    }
  });

  app.put("/api/sessions/:id/thinking-level", async (request: Request, response: Response) => {
    const session = sessions.get(String(request.params.id));
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const level = String(request.body?.thinkingLevel ?? "").trim() as ModelThinkingLevel;
    const lease = reserveSession(session, "thinking-level");
    if (!lease) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }
    try {
      const currentLlm = sessionLlmConfig(session);
      const availableLevels = getSelectableThinkingLevels(currentLlm);
      if (!availableLevels.includes(level)) {
        response.status(400).json({ error: "thinkingLevel is not supported by the selected model" });
        return;
      }
      const updatedLlm = withThinkingLevel(currentLlm, level);
      session.llmOverride = updatedLlm;
      session.thinkingLevel = updatedLlm.thinkingLevel;
      await saveSession(session);
      response.json({
        thinkingLevel: updatedLlm.thinkingLevel,
        thinkingLevels: availableLevels,
      });
    } finally {
      releaseSession(session, lease);
    }
  });

  app.get("/api/sessions", (request: Request, response: Response) => {
    const requestedWorkspaceId = typeof request.query.workspaceId === "string"
      ? request.query.workspaceId
      : undefined;
    if (requestedWorkspaceId && !workspaceRegistry.get(requestedWorkspaceId)) {
      response.status(404).json({ error: "Workspace not found" });
      return;
    }
    const items = [...sessions.values()]
      .filter((session) => !requestedWorkspaceId || workspaceIdForSession(session) === requestedWorkspaceId)
      .sort((a, b) =>
        (b.lastActiveAt ?? b.createdAt) - (a.lastActiveAt ?? a.createdAt),
      )
      .map((session) => {
        sessionLlmConfig(session);
        return {
          id: session.id,
          workspaceId: workspaceIdForSession(session),
          workspaceName: workspaceRegistry.get(workspaceIdForSession(session))?.name ?? path.basename(context.workspace),
          ...sessionPresentation.get(session.id),
          permissionMode: session.permissionManager.getMode(),
          createdAt: session.createdAt,
          lastActiveAt: session.lastActiveAt ?? session.createdAt,
          busy: isSessionBusy(session),
          parentSessionId: session.parentSessionId ?? null,
          forkedFromMessage: session.forkedFromMessage ?? null,
          forkedFromMessageId: session.forkedFromMessageId ?? null,
          messageCount: visibleMessageCount(session.messages),
          preview: contentAsString(session.messages.find((message) => message.role === "user")?.content ?? "").slice(0, 80),
          modelId: session.modelId,
          thinkingLevel: session.thinkingLevel ?? (session.llmOverride ?? context.defaultLlm).thinkingLevel ?? "off",
          thinkingMode: session.thinkingMode ?? loadThinkingModeFromEnv(),
        };
      });
    response.json({ sessions: items });
  });

  app.get("/api/foreign-sessions", async (request: Request, response: Response) => {
    const source = request.query.source === "codex" ? "codex" : request.query.source === "claude" ? "claude" : undefined;
    if (!source) {
      response.status(400).json({ error: "source must be claude or codex" });
      return;
    }
    const selected = typeof request.query.workspaceId === "string"
      ? workspaceRegistry.get(request.query.workspaceId)
      : defaultWorkspace();
    if (!selected) {
      response.status(404).json({ error: "Workspace not found" });
      return;
    }
    try {
      const listed = await listForeignSessions(source, selected.path);
      response.json({
        source,
        cwd: selected.path,
        configDir: listed.configDir,
        configDirExists: listed.configDirExists,
        sessions: listed.sessions,
      });
    } catch (error) {
      const status = error instanceof ForeignSessionError && error.exitCode === 2 ? 409 : 400;
      response.status(status).json({
        error: error instanceof Error ? error.message : String(error),
        matches: error instanceof ForeignSessionError ? error.matches : [],
      });
    }
  });

  app.post("/api/sessions/import", async (request: Request, response: Response) => {
    const source = request.body?.source === "codex" ? "codex" as const : request.body?.source === "claude" ? "claude" as const : undefined;
    if (!source) {
      response.status(400).json({ error: "source must be claude or codex" });
      return;
    }
    const selected = request.body?.workspaceId
      ? workspaceRegistry.get(String(request.body.workspaceId))
      : defaultWorkspace();
    if (!selected) {
      response.status(400).json({ error: "Unknown workspaceId" });
      return;
    }
    const reference = typeof request.body?.reference === "string" ? request.body.reference : "";
    try {
      const imported = await importForeignSession(
        context.sessionManagerForWorkspace(selected),
        source satisfies ForeignSessionSource,
        selected.path,
        reference,
        selected.id,
      );
      const existing = sessions.get(imported.session.id);
      if (!imported.created && existing) {
        response.status(200).json({
          id: existing.id,
          created: false,
          workspaceId: workspaceIdForSession(existing),
          sourceSessionId: imported.transcript.session_id,
          title: imported.transcript.title,
          preview: imported.transcript.summary.last_user_request ?? "",
        });
        return;
      }
      const instructions = selected.path === context.workspace
        ? context.instructionContent()
        : (await loadInstructionBundle(selected.path)).content;
      const session: Session = {
        id: imported.session.id,
        workspaceId: selected.id,
        cwd: selected.path,
        messages: restoreAgentHistory(
          imported.session.messages,
          buildSystemPrompt(defaultPermissionMode, instructions || undefined, context.memorySectionContent() || undefined),
        ),
        createdAt: imported.session.createdAt,
        lastActiveAt: imported.session.lastActiveAt,
        busy: false,
        permissionManager: new PermissionManager("plan"),
        skillNames: [...context.defaultSkillNames],
        todos: [],
        todoVersion: 0,
        origin: imported.session.origin,
      };
      sessions.set(session.id, session);
      response.status(imported.created ? 201 : 200).json({
        id: session.id,
        created: imported.created,
        workspaceId: session.workspaceId,
        sourceSessionId: imported.transcript.session_id,
        title: imported.transcript.title,
        preview: formatForeignSessionList(source, [{
          tool: source,
          source: imported.transcript.source,
          session_id: imported.transcript.session_id,
          path: imported.transcript.path,
          title: imported.transcript.title,
        }]).split("\n").slice(1).join("\n"),
      });
    } catch (error) {
      const status = error instanceof ForeignSessionError && error.exitCode === 2 ? 409 : 400;
      response.status(status).json({
        error: error instanceof Error ? error.message : String(error),
        matches: error instanceof ForeignSessionError ? error.matches : [],
      });
    }
  });

  app.post("/api/sessions", async (request: Request, response: Response) => {
    const selectedWorkspace = request.body?.workspaceId
      ? workspaceRegistry.get(String(request.body.workspaceId))
      : defaultWorkspace();
    if (!selectedWorkspace) {
      response.status(400).json({ error: "Unknown workspaceId" });
      return;
    }
    const id = randomUUID();
    const instructions = selectedWorkspace.path === context.workspace
      ? context.instructionContent()
      : (await loadInstructionBundle(selectedWorkspace.path)).content;
    const session: Session = {
      id,
      workspaceId: selectedWorkspace.id,
      cwd: selectedWorkspace.path,
      messages: createAgentHistory(
        buildSystemPrompt(
          defaultPermissionMode,
          instructions || undefined,
          context.memorySectionContent() || undefined,
        ),
        defaultPermissionMode,
      ),
      createdAt: Date.now(),
      busy: false,
      thinkingMode: context.defaultThinkingMode,
      permissionManager: new PermissionManager(defaultPermissionMode),
      skillNames: [...context.defaultSkillNames],
      todos: [],
      todoVersion: 0,
    };
    sessions.set(id, session);
    await context.sessionManagerForSession(session).save(context.persistedSession(session));
    void context.documentStore.createSession(id);
    response.status(201).json({ id, workspaceId: session.workspaceId, createdAt: session.createdAt, permissionMode: session.permissionManager.getMode() });
  });

  app.post("/api/sessions/:id/fork", async (request: Request, response: Response) => {
    const parent = sessions.get(String(request.params.id));
    if (!parent) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const visibleMessages = parent.messages.filter((message) => message.role !== "system");
    const boundary = resolveMessageBoundary(visibleMessages, request.body, true);
    if ("error" in boundary) {
      response.status(400).json({ error: boundary.error });
      return;
    }
    const messageIndex = boundary.messageIndex;
    const lease = reserveSession(parent, "fork");
    if (!lease) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }
    try {
      // Keep the fork fully independent: later tool/result updates must not
      // mutate message content or nested tool arguments in the parent.
      const messages = structuredClone(truncateSessionMessages(parent.messages, messageIndex));
      const safeMessageIndex = visibleMessageCount(messages);
      const forkedFromMessageId = messageIdAtBoundary(messages, safeMessageIndex);
      const id = randomUUID();
      const childPlan = parent.currentPlan
        ? planManager.clonePlan(parent.currentPlan, id)
        : undefined;
      const child: Session = {
        id,
        workspaceId: context.workspaceIdForSession(parent),
        cwd: context.workspaceForSession(parent),
        messages,
        createdAt: Date.now(),
        busy: false,
        modelId: parent.modelId,
        llmOverride: parent.llmOverride,
        thinkingLevel: parent.thinkingLevel,
        thinkingMode: parent.thinkingMode,
        permissionManager: new PermissionManager(parent.permissionManager.getMode()),
        phase: parent.phase,
        currentPlan: childPlan,
        todos: (parent.todos ?? []).map((todo) => ({ ...todo })),
        todoVersion: parent.todoVersion,
        parentSessionId: parent.id,
        forkedFromMessage: safeMessageIndex,
        forkedFromMessageId,
        skillNames: [...(parent.skillNames ?? [])],
      };
      try {
        await context.sessionManagerForSession(child).save(context.persistedSession(child));
      } catch (error) {
        if (childPlan) planManager.deletePlan(childPlan.id);
        throw error;
      }
      sessions.set(id, child);
      await context.documentStore.createSession(id);
      response.status(201).json({
        id,
        parentSessionId: parent.id,
        forkedFromMessage: safeMessageIndex,
        forkedFromMessageId: forkedFromMessageId ?? null,
        createdAt: child.createdAt,
        messageCount: safeMessageIndex,
      });
    } finally {
      releaseSession(parent, lease);
    }
  });

  app.post("/api/sessions/:id/rewind", async (request: Request, response: Response) => {
    const session = sessions.get(String(request.params.id));
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const visibleMessages = session.messages.filter((message) => message.role !== "system");
    const boundary = resolveMessageBoundary(visibleMessages, request.body, false);
    if ("error" in boundary) {
      response.status(400).json({ error: boundary.error });
      return;
    }
    const messageIndex = boundary.messageIndex;
    const lease = reserveSession(session, "rewind");
    if (!lease) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }
    try {
      session.messages = truncateSessionMessages(session.messages, messageIndex);
      const safeMessageIndex = visibleMessageCount(session.messages);
      await saveSession(session);
      response.json({
        id: session.id,
        messageIndex: safeMessageIndex,
        messageId: messageIdAtBoundary(session.messages, safeMessageIndex) ?? null,
        messageCount: safeMessageIndex,
      });
    } finally {
      releaseSession(session, lease);
    }
  });

  app.get("/api/sessions/tree", (_request: Request, response: Response) => {
    const nodes = [...sessions.values()].map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      parentSessionId: session.parentSessionId ?? null,
      forkedFromMessage: session.forkedFromMessage ?? null,
      forkedFromMessageId: session.forkedFromMessageId ?? null,
      messageCount: visibleMessageCount(session.messages),
      busy: isSessionBusy(session),
      children: [] as string[],
    }));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const roots: string[] = [];
    for (const node of nodes) {
      const parent = node.parentSessionId ? byId.get(node.parentSessionId) : undefined;
      if (parent && parent !== node) parent.children.push(node.id);
      else roots.push(node.id);
    }
    response.json({ sessions: nodes, roots });
  });

  app.get("/api/sessions/:id", async (request: Request, response: Response) => {
    const session = sessions.get(String(request.params.id));
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const effectiveLlm = sessionLlmConfig(session);
    const resolved = customProviderForModel(`${effectiveLlm.provider}/${effectiveLlm.model}`)?.model
      ?? resolveModel(effectiveLlm.model, effectiveLlm.baseUrl);
    let planStatus: string | null = null;
    try {
      const plan = await loadPlanDocument(path.join(context.dataRoot, "session-plans", session.id));
      planStatus = plan?.status ?? null;
    } catch {
      planStatus = null;
    }
    response.json({
      id: session.id,
      workspaceId: workspaceIdForSession(session),
      busy: isSessionBusy(session),
      activeJobId: session.activeJobId ?? null,
      modelId: session.modelId,
      thinkingMode: session.thinkingMode ?? loadThinkingModeFromEnv(),
      parentSessionId: session.parentSessionId ?? null,
      forkedFromMessage: session.forkedFromMessage ?? null,
      forkedFromMessageId: session.forkedFromMessageId ?? null,
      permissionMode: session.permissionManager.getMode(),
      planStatus,
      model: effectiveLlm.model,
      thinkingLevel: effectiveLlm.thinkingLevel ?? (effectiveLlm.reasoning ? "medium" : "off"),
      contextWindow: resolved.contextWindow,
      capabilities: effectiveLlm.capabilities,
      skillNames: context.resolveSessionSkillNames(session),
      todos: session.todos,
      todoVersion: session.todoVersion,
      runState: session.runState ?? null,
      messages: session.messages
        .filter((message) => message.role !== "system")
        .map(safeMessage),
    });
  });

  app.delete("/api/sessions/:id", async (request: Request, response: Response) => {
    const session = sessions.get(String(request.params.id));
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const lease = reserveSession(session, "session:delete");
    if (!lease) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }
    try {
      sessions.delete(String(request.params.id));
      await goalSessions.get(String(request.params.id))?.store.clear(String(request.params.id));
      goalSessions.delete(String(request.params.id));
      await context.sessionManagerForSession(session).remove(String(request.params.id));
      await sessionPresentation.remove(String(request.params.id));
      void context.documentStore.removeSession(String(request.params.id));
      response.status(204).end();
    } finally {
      releaseSession(session, lease);
    }
  });
}

export type { PlanDocument };
