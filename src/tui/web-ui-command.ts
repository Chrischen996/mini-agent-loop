import { WebUiManager } from "./web-ui-manager.ts";

export type WebUiCommandArgs = {
  raw: string;
};

export function parseWebUiCommand(raw: string): { action: "start" | "stop" | "status" | "help"; noOpen?: boolean; port?: number; error?: string } {
  const s = raw.trim();
  const parts = s.split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  if (cmd === "/web-ui" || cmd === "web-ui") {
    const rest = parts.slice(1);
    if (rest.length === 0) return { action: "start" };
    if (rest[0] === "status") return { action: "status" };
    if (rest[0] === "stop") return { action: "stop" };
    if (rest[0] === "help") return { action: "help" };
    // Parse flags
    let noOpen = false;
    let port: number | undefined;
    for (const token of rest) {
      if (token === "--no-open") noOpen = true;
      else if (token === "--help" || token === "-h") return { action: "help" };
      else if (token.startsWith("--port=")) {
        const val = parseInt(token.slice("--port=".length), 10);
        if (!isNaN(val)) port = val;
      } else if (token === "--port" && rest.indexOf(token) + 1 < rest.length) {
        const val = parseInt(rest[rest.indexOf(token) + 1]!, 10);
        if (!isNaN(val)) port = val;
      }
    }
    return { action: "start", noOpen, port };
  }
  return { action: "help", error: `Unknown web-ui command: ${s}` };
}

export async function executeWebUiCommand(
  args: WebUiCommandArgs,
  manager: WebUiManager,
): Promise<{ text: string; error?: boolean }> {
  const parsed = parseWebUiCommand(args.raw);
  if (parsed.error || parsed.action === "help") {
    const helpText = [
      "/web-ui         Start Web UI workbench (open browser)",
      "/web-ui --no-open      Start but do not open browser",
      "/web-ui --port 3080    Start on specified port",
      "/web-ui status        Check workbench status",
      "/web-ui stop          Stop current workbench instance",
      "/web-ui help          Show this help",
    ].join("\n");
    return { text: parsed.error ? `${parsed.error}\n${helpText}` : helpText };
  }
  if (parsed.action === "status") {
    const st = manager.status();
    const lines = [
      `Web UI status: ${st.status}`,
      `Port: ${st.port}`,
      `URL: ${st.url ?? "N/A"}`,
    ];
    if (st.pid !== undefined) lines.push(`PID: ${st.pid}`);
    if (st.startedAt !== undefined) lines.push(`Started: ${new Date(st.startedAt).toLocaleTimeString()}`);
    if (st.error) lines.push(`Last error: ${st.error}`);
    return { text: lines.join("\n"), error: st.status === "failed" };
  }
  if (parsed.action === "stop") {
    const res = await manager.stop();
    return res.ok
      ? { text: "Web UI stopped." }
      : { text: `Failed to stop: ${res.message ?? "unknown"}`, error: true };
  }
  if (parsed.action === "start") {
    const res = await manager.start(parsed.noOpen, parsed.port);
    if (res.error) {
      const notice = res.notice ? `\n${res.notice}` : "";
      return {
        text: `Web UI start failed: ${res.error}\nURL (if available): ${res.url} (copy it if the browser did not open)${notice}`,
        error: true,
      };
    }
    const notice = res.notice ? `\n${res.notice}` : "";
    return { text: `Web UI started\nURL: ${res.url}${notice}` };
  }
  return { text: "Unknown action." };
}
