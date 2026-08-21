import type { JobId, SessionId, TaskId, WorkspaceId } from "./ids.ts";

export type RuntimePermissionMode = "plan" | "approval" | "bypass" | "unsafe-host";
export type SandboxMode = "required" | "preferred" | "disabled";
export type NetworkPolicy = "none" | "allowlist" | "full";
export type SandboxIsolation = "secure-sandbox" | "process-isolation" | "none";

export type PolicySnapshot = {
  revision: number;
  permissionMode: RuntimePermissionMode;
  sandboxMode: SandboxMode;
  network: NetworkPolicy;
  allowedHosts?: string[];
  allowedTools: string[];
  expiresAt?: string;
};

/** Stable identity and policy fields shared by every execution boundary. */
export type RuntimeExecutionContext = {
  taskId?: TaskId | string;
  jobId?: JobId | string;
  sessionId?: SessionId | string;
  workspaceId?: WorkspaceId | string;
  policyRevision?: number;
  sandboxMode?: SandboxMode;
  sandboxIsolation?: SandboxIsolation;
  network?: NetworkPolicy;
  allowedHosts?: string[];
  allowedTools?: string[];
  getPolicyRevision?: () => number;
};

export class PolicyRevisionChangedError extends Error {
  readonly expectedRevision: number;
  readonly currentRevision: number;

  constructor(expectedRevision: number, currentRevision: number) {
    super(`Policy revision changed from ${expectedRevision} to ${currentRevision}`);
    this.name = "PolicyRevisionChangedError";
    this.expectedRevision = expectedRevision;
    this.currentRevision = currentRevision;
  }
}

export class SandboxPolicyError extends Error {
  readonly sandboxMode: SandboxMode;
  readonly isolation: SandboxIsolation | undefined;

  constructor(sandboxMode: SandboxMode, isolation: SandboxIsolation | undefined) {
    super(
      `Sandbox policy requires secure isolation, but the active runner is ${isolation ?? "unavailable"}`,
    );
    this.name = "SandboxPolicyError";
    this.sandboxMode = sandboxMode;
    this.isolation = isolation;
  }
}

export class NetworkPolicyError extends Error {
  readonly network: NetworkPolicy;

  constructor(network: NetworkPolicy) {
    super(`Network policy ${network} does not allow this tool execution`);
    this.name = "NetworkPolicyError";
    this.network = network;
  }
}

export class ToolPolicyError extends Error {
  readonly toolName: string;

  constructor(toolName: string) {
    super(`Tool ${toolName} is not allowed by the active runtime policy`);
    this.name = "ToolPolicyError";
    this.toolName = toolName;
  }
}
