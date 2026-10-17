import { spawn, exec, ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type WebUiStatus = "stopped" | "starting" | "running" | "stopping" | "failed";

type WebUiStateInfo = {
  status: WebUiStatus;
  url?: string;
  port: number;
  pid?: number;
  startedAt?: number;
  error?: string;
};

const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_INTERVAL_MS = 500;
const STOP_GRACE_MS = 5_000;
const BUILD_TIMEOUT_MS = 120_000;

/**
 * `spawn("npm")` cannot see the Windows `npm.cmd` shim (ENOENT). Node 24 also
 * rejects `spawn("npm.cmd")` with EINVAL unless a shell is involved. Route the
 * fixed build command through `cmd.exe` instead of enabling `shell: true`.
 */
export function npmInvocation(args: string[], platform = process.platform): { command: string; args: string[] } {
  if (platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", ["npm", ...args].join(" ")] };
  }
  return { command: "npm", args };
}

/** Prefer the local Vite binary. `npm run web:build` shells out to `vite`, which is missing when the .bin shim was not linked. */
export function webBuildInvocation(packageRoot: string, execPath = process.execPath): { command: string; args: string[] } {
  const viteBin = path.join(packageRoot, "node_modules", "vite", "bin", "vite.js");
  if (existsSync(viteBin)) return { command: execPath, args: [viteBin, "build"] };
  return npmInvocation(["run", "web:build"]);
}

/**
 * Lifecycle manager for the local Web workbench (doc 1.md §5).
 *
 * - Spawns the shared Web launcher (`dist/web-launcher.js` in a package build,
 *   or `src/web-launcher.ts` from source) with `PORT=<port>`; the launcher
 *   starts the server and the server serves the packaged UI from `dist/web`.
 * - Readiness is decided by a real `/api/health` poll, never by a PID alone
 *   (doc §5.2). If our process dies early (e.g. EADDRINUSE on a foreign port
 *   owner) the health loop detects it and reports the captured stderr tail.
 * - stop() terminates the whole launcher/server process group with a SIGTERM
 *   grace period, then SIGKILL.
 */
export class WebUiManager {
  private state: WebUiStatus = "stopped";
  private proc: ChildProcess | null = null;
  private port: number;
  private url: string;
  private startedAt: number | null = null;
  private lastError: string | null = null;

  constructor(port = 3001) {
    this.port = port;
    this.url = `http://127.0.0.1:${port}`;
  }

  getState(): WebUiStateInfo {
    const proc = this.proc;
    return {
      status: this.state,
      url: this.state === "running" ? this.url : undefined,
      port: this.port,
      ...(proc?.pid ? { pid: proc.pid } : {}),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  async start(noOpen = false, customPort?: number): Promise<{ url: string; error?: string; notice?: string }> {
    if (this.state === "starting" || this.state === "running") {
      return { url: this.url, error: "Web UI is already running; reuse existing instance." };
    }
    if (customPort !== undefined) {
      this.port = customPort;
      this.url = `http://127.0.0.1:${this.port}`;
    }
    this.state = "starting";
    this.lastError = null;
    const packageRoot = process.cwd();
    try {
      const launcher = resolveWebLauncherCommand(import.meta.url);
      // doc §4.3: the production workbench is Express + packaged static assets,
      // so the UI build must exist first. Build on demand once.
      const launcherEntry = launcher.args.at(-1);
      const webDist = launcherEntry?.endsWith(".js")
        ? path.resolve(path.dirname(launcherEntry), "web")
        : path.resolve(packageRoot, "dist", "web");
      let notice: string | undefined;
      if (!existsSync(webDist)) {
        const buildCommand = webBuildInvocation(packageRoot);
        const build = await this.runCommand(buildCommand.command, buildCommand.args, packageRoot, BUILD_TIMEOUT_MS);
        if (!build.ok) {
          this.state = "failed";
          this.lastError = build.output.slice(-500);
          return {
            url: this.url,
            error: `Web UI build failed; run "npm run web:build" to diagnose.\n${build.output.slice(-500)}`,
          };
        }
        notice = "Built the Web UI on demand (dist/web was missing).";
      }

      this.proc = spawn(launcher.command, [
        ...launcher.args,
        "--port",
        String(this.port),
        "--no-open",
      ], {
        cwd: packageRoot,
        env: { ...process.env, PORT: String(this.port) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // A detached console on Windows delivers CTRL_C_EVENT (exit 0xC000013A)
        // and the server dies before it listens. Unix still needs a process group.
        detached: process.platform !== "win32",
      });
      this.startedAt = Date.now();
      let stderrTail = "";
      this.proc.stdout?.on("data", (data) => {
        const text = String(data).trim();
        if (text) console.error(`[web-ui] server: ${text}`);
      });
      this.proc.stderr?.on("data", (data) => {
        stderrTail = (stderrTail + String(data)).slice(-2000);
        console.error("[web-ui] server stderr:", String(data).trim());
      });
      this.proc.on("error", (err) => {
        this.state = "failed";
        this.lastError = `spawn error: ${err.message}`;
      });
      this.proc.on("exit", (code) => {
        if (this.state === "stopping") {
          // stop() owns the final state transition.
        } else if (this.state === "starting") {
          this.state = "failed";
          this.lastError = `Web launcher exited early (code ${code}). ${stderrTail.slice(-300)}`.trim();
        } else if (this.state === "running") {
          this.state = "failed";
          this.lastError = `Web launcher exited unexpectedly (code ${code}).`;
        } else {
          this.state = "stopped";
        }
        this.proc = null;
        this.startedAt = null;
      });

      const ready = await this.waitForHealth();
      if (!ready) {
        this.state = "failed";
        this.lastError ??= `health check timed out after ${HEALTH_TIMEOUT_MS / 1000}s on ${this.url}.`;
        void this.stop(); // clean up a possibly still-starting process
        return { url: this.url, error: this.lastError };
      }
      this.state = "running";
      if (!noOpen) this.openBrowser();
      return { url: this.url, notice };
    } catch (err: unknown) {
      this.state = "failed";
      this.lastError = err instanceof Error ? err.message : String(err);
      return { url: this.url, error: this.lastError };
    }
  }

  async stop(): Promise<{ ok: boolean; message?: string }> {
    if (this.state === "stopped") return { ok: true, message: "Already stopped." };
    if (this.state === "stopping") return { ok: false, message: "Already stopping." };
    this.state = "stopping";
    const proc = this.proc;
    if (!proc) {
      this.state = "stopped";
      return { ok: true };
    }
    const killTree = (signal: NodeJS.Signals): void => {
      const pid = proc.pid;
      if (pid === undefined) {
        proc.kill(signal);
        return;
      }
      if (process.platform === "win32") {
        // Negative pids are not process groups on Windows. taskkill /t stops
        // the launcher and the server it spawned.
        const args = ["/pid", String(pid), "/t"];
        if (signal === "SIGKILL") args.push("/f");
        spawn("taskkill", args, {
          windowsHide: true,
          stdio: "ignore",
        }).on("error", () => {
          try { proc.kill(signal); } catch { /* already gone */ }
        });
        return;
      }
      try {
        process.kill(-pid, signal); // whole group (npm -> tsx -> node)
      } catch {
        try {
          proc.kill(signal);
        } catch {
          // already gone
        }
      }
    };
    try {
      killTree("SIGTERM");
      const deadline = Date.now() + STOP_GRACE_MS;
      while (Date.now() < deadline && proc.exitCode === null) {
        await this.sleep(200);
      }
      if (proc.exitCode === null) killTree("SIGKILL");
    } catch (err: unknown) {
      this.state = "failed";
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: msg };
    }
    this.proc = null;
    this.startedAt = null;
    this.state = "stopped";
    return { ok: true };
  }

  status(): WebUiStateInfo {
    return this.getState();
  }

  /**
   * doc §5.2: never trust the PID alone - poll the health endpoint while
   * confirming OUR process is still alive, so a foreign port owner cannot
   * produce a false "ready".
   */
  private async waitForHealth(): Promise<boolean> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const proc = this.proc;
      if (!proc || proc.exitCode !== null || proc.killed) return false;
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/api/health`);
        if (response.ok) return true;
      } catch {
        // Server not accepting connections yet; keep polling.
      }
      await this.sleep(HEALTH_INTERVAL_MS);
    }
    return false;
  }

  private openBrowser(): void {
    try {
      if (process.platform === "win32") {
        // `start` is a cmd builtin. The empty title keeps the URL from being
        // parsed as the window title.
        spawn("cmd.exe", ["/d", "/s", "/c", "start", "", this.url], {
          detached: true,
          windowsHide: true,
          stdio: "ignore",
        }).unref();
        return;
      }
      const command = process.platform === "darwin" ? "open" : "xdg-open";
      exec(`${command} ${this.url}`);
    } catch {
      // Auto-open failure is non-fatal (doc §3.1 constraint 4); the URL is
      // returned to the caller so it can be copied.
    }
  }

  private runCommand(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ ok: false, output: `${output}\n(timeout after ${Math.round(timeoutMs / 1000)}s)` });
      }, timeoutMs);
      child.stdout?.on("data", (data) => (output += String(data)));
      child.stderr?.on("data", (data) => (output += String(data)));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, output: `${output}\n${err.message}` });
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, output: output.trim() });
      });
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export type WebLauncherCommand = {
  command: string;
  args: string[];
};

/** Resolve the bundled launcher first, while keeping source execution usable. */
export function resolveWebLauncherCommand(moduleUrl: string): WebLauncherCommand {
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  const bundledLauncher = path.join(moduleDirectory, "web-launcher.js");
  if (existsSync(bundledLauncher)) {
    return { command: process.execPath, args: [bundledLauncher] };
  }

  const sourceLauncher = path.resolve(moduleDirectory, "..", "web-launcher.ts");
  if (existsSync(sourceLauncher)) {
    return { command: process.execPath, args: ["--import", "tsx", sourceLauncher] };
  }

  throw new Error(
    `Web launcher not found next to ${moduleDirectory}; run the package build before using /web-ui.`,
  );
}
