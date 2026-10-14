#!/usr/bin/env node

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type WebLauncherOptions = {
  port: number;
  workspace?: string;
  openBrowser: boolean;
};

export type ParsedWebLauncherArgs = WebLauncherOptions & {
  help: boolean;
};

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

export function parseWebLauncherArgs(argv: string[]): ParsedWebLauncherArgs {
  const options: ParsedWebLauncherArgs = {
    port: Number(process.env.PORT ?? 3001),
    workspace: process.env.AGENT_WORKSPACE,
    openBrowser: true,
    help: false,
  };

  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--no-open") {
      options.openBrowser = false;
      continue;
    }
    if (arg === "--port" || arg.startsWith("--port=")) {
      const value = arg === "--port" ? argv[++index] : arg.slice("--port=".length);
      if (!value || value.startsWith("--")) throw new Error("--port requires a value");
      options.port = parsePort(value);
      continue;
    }
    if (arg === "--workspace" || arg.startsWith("--workspace=")) {
      const value = arg === "--workspace" ? argv[++index] : arg.slice("--workspace=".length);
      if (!value || value.startsWith("--")) throw new Error("--workspace requires a path");
      options.workspace = value;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

export function webLauncherHelp(): string {
  return [
    "Usage: mini-agent-loop-web [options]",
    "",
    "Starts the local Mini Agent server and opens the Web UI.",
    "",
    "Options:",
    "  --workspace <path>  Project directory used by new sessions",
    "  --port <number>     HTTP port (default: 3001)",
    "  --no-open           Do not open a browser automatically",
    "  --help              Show this help",
  ].join("\n");
}

function serverProcess(): { command: string; args: string[] } {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const bundledServer = path.join(currentDirectory, "server.js");
  if (existsSync(bundledServer)) {
    return { command: process.execPath, args: [bundledServer] };
  }

  const sourceServer = path.join(currentDirectory, "server.ts");
  return { command: process.execPath, args: ["--import", "tsx", sourceServer] };
}

function browserCommand(url: string): { command: string; args: string[] } {
  if (process.platform === "darwin") return { command: "open", args: [url] };
  if (process.platform === "win32") return { command: "cmd.exe", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

export function openBrowser(url: string): void {
  const command = browserCommand(url);
  const browser = spawn(command.command, command.args, {
    detached: true,
    stdio: "ignore",
  });
  browser.unref();
}

export async function startWebServer(options: WebLauncherOptions): Promise<{ child: ChildProcess; url: string }> {
  const server = serverProcess();
  const child = spawn(server.command, server.args, {
    env: {
      ...process.env,
      PORT: String(options.port),
      ...(options.workspace ? { AGENT_WORKSPACE: options.workspace } : {}),
    },
    stdio: ["inherit", "pipe", "inherit"],
  });

  return await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Timed out waiting for the Web server to start. Output: ${output.trim()}`));
    }, 15_000);

    const fail = (error: Error): void => {
      clearTimeout(timeout);
      reject(error);
    };

    child.once("error", fail);
    child.once("exit", (code, signal) => {
      if (code !== 0 || signal) {
        fail(new Error(`Web server exited before startup (code=${code ?? "none"}, signal=${signal ?? "none"})`));
      }
    });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      output += text;
      process.stdout.write(text);
      const match = output.match(/Mini Agent server:\s+(http:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve({ child, url: match[1]! });
    });
  });
}

async function main(): Promise<void> {
  const options = parseWebLauncherArgs(process.argv.slice(2));
  if (options.help) {
    console.log(webLauncherHelp());
    return;
  }

  const { child, url } = await startWebServer(options);
  console.log(`Mini Agent Web UI: ${url}`);
  if (options.openBrowser) openBrowser(url);

  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
