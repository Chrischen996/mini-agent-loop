import { statSync } from "node:fs";
import { win32 } from "node:path";

export interface ResolvedShell {
  command: string;
  args: string[];
  kind: "bash" | "powershell" | "cmd";
}

/** Injectable discovery inputs allow Windows selection tests on any host. */
export interface ShellDiscovery {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isFile?: (path: string) => boolean;
}

export function resolveShell(discovery: ShellDiscovery = {}): ResolvedShell {
  if ((discovery.platform ?? process.platform) !== "win32") {
    return { command: "bash", args: ["-lc"], kind: "bash" };
  }
  const env = discovery.env ?? process.env;
  const getEnv = (name: string): string | undefined =>
    Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  const isFile = discovery.isFile ?? ((path: string) => {
    try { return statSync(path).isFile(); } catch { return false; }
  });
  // Do not search the current workspace through empty or relative PATH entries.
  const paths = (getEnv("PATH") ?? "").split(";")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => win32.isAbsolute(entry));
  const candidates = [
    ...paths.map((dir) => win32.join(dir, "pwsh.exe")),
    win32.join(getEnv("ProgramFiles") || "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
    ...paths.map((dir) => win32.join(dir, "powershell.exe")),
    win32.join(getEnv("SystemRoot") || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ];
  const powershell = candidates.find(isFile);
  if (powershell) {
    return { command: powershell, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"], kind: "powershell" };
  }
  return { command: getEnv("ComSpec") || "cmd.exe", args: ["/D", "/S", "/C"], kind: "cmd" };
}

export function describeShell(shell: ResolvedShell): string {
  const common = "Returns stdout/stderr with timeout and cancellation. Each call starts a fresh process.";
  switch (shell.kind) {
    case "powershell":
      return `Execute a Windows PowerShell command using ${shell.command}. Use PowerShell syntax, not bash or cmd syntax. Windows PowerShell 5.1 does not support && or ||; check $LASTEXITCODE for native command failures. Prefer native cmdlets and -LiteralPath for file paths. Do not pass destructive file operations across shells. ${common}`;
    case "cmd":
      return `Execute a Windows cmd.exe command using ${shell.command}. Use cmd syntax, not bash or PowerShell syntax. ${common}`;
    case "bash":
      return `Execute a bash command using ${shell.command}. Use POSIX shell paths and bash syntax. ${common}`;
  }
}
