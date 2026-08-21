import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SandboxType, SandboxConfig } from "./types.ts";

const execFileAsync = promisify(execFile);

export async function detectDocker(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("docker", ["--version"], {
      timeout: 2000,
    });
    return stdout.includes("Docker version");
  } catch {
    return false;
  }
}

export async function detectPodman(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("podman", ["--version"], {
      timeout: 2000,
    });
    return stdout.includes("podman version");
  } catch {
    return false;
  }
}

export async function detectBestSandboxType(
  config: SandboxConfig,
): Promise<SandboxType> {
  if (!config.enabled || config.mode === "disabled" || config.type === "none") {
    return "none";
  }

  if (config.type === "docker") {
    const hasDocker = await detectDocker();
    if (!hasDocker) {
      throw new Error("Docker sandbox requested but Docker is not available");
    }
    return "docker";
  }

  if (config.type === "node") {
    if (config.mode === "required") {
      throw new Error("Secure sandbox required but Node process isolation was requested");
    }
    return "node";
  }

  // Auto detection
  if (await detectDocker()) {
    return "docker";
  }

  if (await detectPodman()) {
    return "docker"; // Podman is Docker-compatible
  }

  if (config.mode === "required") {
    throw new Error("Secure sandbox required but Docker/Podman is not available");
  }
  return "node";
}
