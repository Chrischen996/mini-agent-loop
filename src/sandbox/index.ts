import type { SandboxRunner, SandboxConfig } from "./types.ts";
import { DEFAULT_SANDBOX_CONFIG } from "./types.ts";
import { detectBestSandboxType } from "./detect.ts";
import { NodeSandboxRunner } from "./node-runner.ts";
import { DockerSandboxRunner } from "./docker-runner.ts";

export * from "./types.ts";
export { detectBestSandboxType, detectDocker, detectPodman } from "./detect.ts";
export { NodeSandboxRunner } from "./node-runner.ts";
export { DockerSandboxRunner } from "./docker-runner.ts";

class NoopSandboxRunner implements SandboxRunner {
  readonly type = "none" as const;

  async execute(options: any): Promise<any> {
    throw new Error("Sandbox is disabled");
  }

  async cleanup(): Promise<void> {}
}

export async function createSandboxRunner(
  config: Partial<SandboxConfig> = {},
): Promise<SandboxRunner> {
  const fullConfig = { ...DEFAULT_SANDBOX_CONFIG, ...config };
  const sandboxType = await detectBestSandboxType(fullConfig);

  switch (sandboxType) {
    case "docker":
      return new DockerSandboxRunner(fullConfig.dockerImage);
    case "node":
      return new NodeSandboxRunner();
    case "none":
      return new NoopSandboxRunner();
  }
}
