export type WorkspacePanelScope = {
  sessionId?: string;
  workspaceId?: string;
};

/** Keep file browsing on the selected project when it differs from the active session. */
export function workspacePanelScope(
  activeSessionId: string | null,
  activeWorkspaceId: string | undefined,
  selectedWorkspaceId: string,
): WorkspacePanelScope {
  if (activeSessionId && activeWorkspaceId && selectedWorkspaceId === activeWorkspaceId) {
    return { sessionId: activeSessionId };
  }
  if (selectedWorkspaceId) return { workspaceId: selectedWorkspaceId };
  if (activeSessionId && activeWorkspaceId) return { sessionId: activeSessionId };
  return {};
}
