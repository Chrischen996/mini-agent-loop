export type SandboxType = "docker" | "node" | "none";
export type SandboxIsolation = "secure-sandbox" | "process-isolation" | "none";

export interface SandboxExecOptions {
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  timeout?: number;
  allowNetwork?: boolean;
  allowWrite?: boolean;
  cpuLimit?: number;
  memoryLimit?: string;
  stdin?: string;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  signal?: string;
}

export interface SandboxRunner {
  readonly type: SandboxType;
  readonly isolation: SandboxIsolation;
  execute(options: SandboxExecOptions): Promise<SandboxResult>;
  cleanup(): Promise<void>;
}

export interface SandboxConfig {
  enabled: boolean;
  /** preferred preserves the legacy Node fallback; required fails closed. */
  mode?: "required" | "preferred" | "disabled";
  type?: "auto" | "docker" | "node" | "none";
  dockerImage?: string;
  allowNetwork?: boolean;
  cpuLimit?: number;
  memoryLimit?: string;
  timeout?: number;
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enabled: true,
  type: "auto",
  dockerImage: "mini-agent-sandbox:latest",
  allowNetwork: false,
  cpuLimit: 1.0,
  memoryLimit: "512m",
  timeout: 30000,
};
