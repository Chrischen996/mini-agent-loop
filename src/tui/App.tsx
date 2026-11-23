// TUI root container.
//
// Owns the multi-agent list: one mounted `AgentSessionApp` per conversation
// (the visible one plus any background agents), the agent dashboard overlay,
// and per-agent worktree isolation. Single-conversation behavior lives in
// `AgentSessionApp.tsx`.
//
// `App` is exported from this module because the entry point and the tests
// import it from here.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { randomUUID } from "node:crypto";
import { AgentDashboard, type DashboardAgent } from "./components/AgentDashboard.tsx";
import { AgentSessionApp } from "./AgentSessionApp.tsx";
import { useTerminalSize } from "./hooks/useTerminalSize.ts";
import { getTuiViewportHeight } from "./layout.ts";
import { bootProbe } from "./boot-trace.ts";
import { GitWorkflow } from "../git/workflow.ts";
import { startupSessionCwd } from "./session-workspace.ts";
import type { AppProps, DashboardAgentSnapshot } from "./session/props.ts";

type ManagedAgent = DashboardAgent & {
  initialSessionId: string;
  initialPrompt?: string;
  cwd?: string;
  launching?: boolean;
};

export function App(props: AppProps): React.ReactElement {
  bootProbe("root-render");
  const projectCwd = props.projectCwd ?? props.cwd;
  const terminalSize = useTerminalSize();
  const initialAgentIdRef = useRef<string | undefined>(undefined);
  if (!initialAgentIdRef.current) initialAgentIdRef.current = randomUUID();
  const initialAgentId = initialAgentIdRef.current;
  const initialSessionId = props.startupSessionRequest?.sessionId
    ?? process.env.MINI_AGENT_SESSION_ID
    ?? initialAgentId;
  const shouldResolveStartupCwd = Boolean(props.startupSessionRequest
    && (props.startupSessionRequest.resume || props.startupSessionRequest.continueSession || props.startupSessionRequest.fork));
  const [agents, setAgents] = useState<ManagedAgent[]>(() => [{
    id: initialAgentId,
    initialSessionId,
    name: "Main agent",
    task: "No request submitted",
    status: shouldResolveStartupCwd ? "Preparing" : "Idle",
    activity: shouldResolveStartupCwd ? "Restoring workspace" : "Ready",
    active: false,
    failed: false,
    cwd: shouldResolveStartupCwd ? undefined : props.cwd,
    workspace: shouldResolveStartupCwd ? undefined : props.cwd,
    launching: shouldResolveStartupCwd,
  }]);
  const [activeAgentId, setActiveAgentId] = useState(initialAgentId);
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [worktreeIsolation, setWorktreeIsolation] = useState(props.worktreeIsolation ?? true);
  const nextAgentNumberRef = useRef(2);

  useEffect(() => {
    const request = props.startupSessionRequest;
    if (!request || !shouldResolveStartupCwd) return;
    let cancelled = false;
    void startupSessionCwd(projectCwd, request).then((cwd) => {
      if (cancelled) return;
      setAgents((current) => current.map((agent) => agent.id === initialAgentId
        ? { ...agent, cwd, workspace: cwd, launching: false, status: "Idle", activity: "Ready" }
        : agent));
    }).catch(() => {
      if (cancelled) return;
      setAgents((current) => current.map((agent) => agent.id === initialAgentId
        ? { ...agent, cwd: props.cwd, workspace: props.cwd, launching: false, status: "Idle", activity: "Ready" }
        : agent));
    });
    return () => { cancelled = true; };
  }, [initialAgentId, projectCwd, props.cwd, props.startupSessionRequest, shouldResolveStartupCwd]);

  const updateAgentSnapshot = useCallback((snapshot: DashboardAgentSnapshot) => {
    setAgents((current) => current.map((agent) => agent.id === snapshot.id
      ? { ...agent, ...snapshot }
      : agent));
  }, []);
  const updateAgentWorkspace = useCallback((agentId: string, cwd: string, branch?: string) => {
    setAgents((current) => current.map((agent) => agent.id === agentId
      ? { ...agent, cwd, workspace: cwd, branch, launching: false }
      : agent));
  }, []);
  const openDashboard = useCallback(() => setDashboardOpen(true), []);
  const closeDashboard = useCallback(() => setDashboardOpen(false), []);

  /** Attach a dispatched agent and leave the dashboard, if requested. */
  const attachAgent = useCallback((id: string, attach: boolean) => {
    if (!attach) return;
    setActiveAgentId(id);
    setDashboardOpen(false);
  }, []);

  const dispatchAgent = useCallback((prompt: string, attach: boolean) => {
    const id = randomUUID();
    const agentNumber = nextAgentNumberRef.current++;
    const isolate = worktreeIsolation;
    setAgents((current) => [{
      id,
      initialSessionId: id,
      initialPrompt: prompt,
      name: `Agent ${agentNumber}`,
      task: prompt,
      status: isolate ? "Preparing" : "Working",
      activity: isolate ? "Creating isolated worktree" : "Starting",
      active: !isolate,
      failed: false,
      startedAt: Date.now(),
      cwd: isolate ? undefined : props.cwd,
      workspace: isolate ? undefined : props.cwd,
      launching: isolate,
    }, ...current]);

    if (!isolate) {
      attachAgent(id, attach);
      return;
    }

    void new GitWorkflow(projectCwd).createIsolatedBranch(`agent-${agentNumber}-${id.slice(0, 8)}`).then((isolated) => {
      setAgents((current) => current.map((agent) => agent.id === id
        ? {
          ...agent,
          cwd: isolated.path,
          workspace: isolated.path,
          branch: isolated.branch,
          launching: false,
          status: "Working",
          activity: "Starting",
          active: true,
        }
        : agent));
      attachAgent(id, attach);
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setAgents((current) => current.map((agent) => agent.id === id
        ? {
          ...agent,
          launching: false,
          status: "Failed",
          activity: "Worktree setup failed",
          active: false,
          failed: true,
          setupError: message,
        }
        : agent));
    });
  }, [attachAgent, projectCwd, props.cwd, worktreeIsolation]);

  const openAgent = useCallback((id: string) => {
    const agent = agents.find((candidate) => candidate.id === id);
    if (!agent?.cwd) return;
    setActiveAgentId(id);
    setDashboardOpen(false);
  }, [agents]);
  const toggleWorktreeIsolation = useCallback(() => {
    setWorktreeIsolation((current) => !current);
  }, []);

  return (
    <>
      {agents.filter((agent) => Boolean(agent.cwd) && !agent.launching).map((agent) => (
        <AgentSessionApp
          key={agent.id}
          {...props}
          cwd={agent.cwd!}
          projectCwd={projectCwd}
          startupSessionRequest={agent.id === initialAgentId ? props.startupSessionRequest : undefined}
          agentId={agent.id}
          initialSessionId={agent.initialSessionId}
          initialPrompt={agent.initialPrompt}
          active={activeAgentId === agent.id && !dashboardOpen}
          dashboardOpen={dashboardOpen}
          onOpenDashboard={openDashboard}
          onCloseDashboard={closeDashboard}
          onSnapshot={updateAgentSnapshot}
          onWorkspaceChange={updateAgentWorkspace}
        />
      ))}
      {dashboardOpen && (
        <AgentDashboard
          agents={agents}
          activeAgentId={activeAgentId}
          width={terminalSize.columns}
          height={getTuiViewportHeight(terminalSize.rows)}
          onClose={closeDashboard}
          onDispatch={dispatchAgent}
          onOpenAgent={openAgent}
          worktreeIsolation={worktreeIsolation}
          onToggleWorktreeIsolation={toggleWorktreeIsolation}
        />
      )}
    </>
  );
}
// 