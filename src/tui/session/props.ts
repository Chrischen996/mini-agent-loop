// Props shared by the TUI root container and the per-session view.
//
// Kept in their own module so `App.tsx` (root / multi-agent container) and
// `AgentSessionApp.tsx` (one conversation) can both reference them without a
// circular import.

import type { ToolProvider, Tool } from "../../tools/types.ts";
import type { BgTaskManager } from "../../bg-tasks/manager.js";
import type { McpServerStatus } from "../../mcp/types.ts";
import type { TuiLayoutMode } from "../layout-mode.ts";
import type { TuiSystemPromptContext } from "../system-prompt.ts";
import type { StartupSessionRequest } from "../session-serialization.ts";
import type { DashboardAgent } from "../components/AgentDashboard.tsx";

export type AppProps = {
  cwd: string;
  /** Stable project identity; a session may execute from an isolated worktree. */
  projectCwd?: string;
  systemPromptContext?: TuiSystemPromptContext;
  startupSessionRequest?: StartupSessionRequest;
  agentTools?: ToolProvider;
  allTools?: ToolProvider;
  agentToolsForCwd?: (cwd: string) => ToolProvider;
  allToolsForCwd?: (cwd: string) => ToolProvider;
  bgManagerForCwd?: (cwd: string) => BgTaskManager | undefined;
  worktreeIsolation?: boolean;
  /** Compact MCP status source for the status bar; polled when present. */
  mcpStatuses?: () => readonly McpServerStatus[];
  /** Current MCP tool catalog, used by `/mcp <server>` details. */
  mcpTools?: () => readonly Tool[];
  /**
   * Resolves after the first frame with the required-MCP failure, if any.
   * Deferred MCP startup (ink-main) keeps the UI alive during handshakes and
   * surfaces a required-server failure as an in-app notice instead of a
   * black-screen abort before the first frame.
   */
  mcpFailure?: { promise: Promise<Error | undefined> };
  /**
   * Terminal layout mode. `inline` renders sealed transcript history into the
   * terminal's native scrollback (no alternate screen); `alternate` keeps the
   * whole UI in the alternate screen buffer. Resolved from
   * `MINI_AGENT_TUI_LAYOUT` when omitted.
   */
  layoutMode?: TuiLayoutMode;
  /**
   * Inline layout only: direct channel to the incremental renderer's static
   * burst emitter. Sealed transcript blocks are written to the terminal's
   * native scrollback through it, bypassing Ink's frame pipeline.
   */
  writeStaticBurst?: (text: string) => void;
  /**
   * Ctrl+L: clear the visible screen while keeping the native scrollback.
   */
  requestClearScreen?: () => void;
  /**
   * Flow layouts only: report how many bottom rows of the dynamic frame are
   * pinned chrome (approval cards, todo panel, input box, status bar). The
   * renderer keeps safe streaming bursts from blanking or re-emitting those
   * rows, so the input box does not flicker while LLM lines commit.
   */
  setPinnedRows?: (rows: number) => void;
};

/** Snapshot the root container consumes from a session for the dashboard. */
export type DashboardAgentSnapshot = Omit<DashboardAgent, "name">;

export type AgentSessionAppProps = AppProps & {
  agentId: string;
  initialSessionId: string;
  initialPrompt?: string;
  projectCwd: string;
  active: boolean;
  dashboardOpen: boolean;
  onOpenDashboard: () => void;
  onCloseDashboard: () => void;
  onSnapshot: (snapshot: DashboardAgentSnapshot) => void;
  onWorkspaceChange: (agentId: string, cwd: string, branch?: string) => void;
};
