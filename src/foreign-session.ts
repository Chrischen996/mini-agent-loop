import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "./types.ts";
import type { ForeignSessionOrigin, PersistedSession } from "./session-store.ts";
import type { SessionManager } from "./session-manager.ts";

export type ForeignSessionSource = "claude" | "codex";

export type ForeignSessionCandidate = {
  tool: ForeignSessionSource;
  source: string;
  session_id: string;
  path: string;
  title: string | null;
  cwd?: string | null;
  updated_at?: string | null;
  updated_at_ms?: number;
};

export type ForeignSessionSummary = {
  last_user_request: string | null;
  last_assistant_action: string | null;
  paths: string[];
  turn_count: number;
  warnings: Array<{ code: string; message: string }>;
};

export type ForeignSessionTranscript = {
  tool: ForeignSessionSource;
  source: string;
  session_id: string;
  path: string;
  title: string | null;
  cwd: string | null;
  branch: string | null;
  summary: ForeignSessionSummary;
  warnings: Array<{ code: string; message: string }>;
  config_dir?: string;
  inert: true;
};

export class ForeignSessionError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly matches: ForeignSessionCandidate[] = [],
  ) {
    super(message);
    this.name = "ForeignSessionError";
  }
}

type ReaderPayload = ForeignSessionTranscript & {
  error?: string;
  matches?: ForeignSessionCandidate[];
  sessions?: ForeignSessionCandidate[];
  config_dir_exists?: boolean;
};

function readerScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../skills/adapt-foreign-session/scripts/session-reader.mjs"),
    path.resolve(here, "../../skills/adapt-foreign-session/scripts/session-reader.mjs"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function runReader(args: string[], cwd: string): Promise<{ code: number; payload: ReaderPayload }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", readerScriptPath(), ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve({ code: code ?? 1, payload: JSON.parse(stdout) as ReaderPayload });
      } catch {
        reject(new ForeignSessionError(stderr.trim() || `Session reader returned no JSON (exit ${code ?? 1}).`, 1));
      }
    });
  });
}

export async function listForeignSessions(
  source: ForeignSessionSource,
  cwd: string,
): Promise<{ sessions: ForeignSessionCandidate[]; configDir: string; configDirExists: boolean }> {
  const { code, payload } = await runReader([source, "list", "--cwd", cwd, "--json"], cwd);
  if (code !== 0) {
    throw new ForeignSessionError(payload.error || `Unable to list ${source} sessions.`, code, payload.matches ?? []);
  }
  return {
    sessions: payload.sessions ?? [],
    configDir: payload.config_dir ?? "",
    configDirExists: payload.config_dir_exists !== false,
  };
}

export async function readForeignSession(
  source: ForeignSessionSource,
  cwd: string,
  reference = "",
): Promise<ForeignSessionTranscript> {
  const { code, payload } = await runReader([source, "show", reference || "latest", "--cwd", cwd, "--json"], cwd);
  if (code !== 0 || !payload.session_id) {
    throw new ForeignSessionError(
      payload.error || `No ${source} session matched ${reference || "latest"}.`,
      code === 2 ? 2 : 1,
      payload.matches ?? [],
    );
  }
  return payload;
}

export function formatForeignSessionList(source: ForeignSessionSource, sessions: readonly ForeignSessionCandidate[]): string {
  if (sessions.length === 0) return `No ${source} sessions found for this workspace.`;
  const lines = sessions.slice(0, 20).map((session) => {
    const when = session.updated_at ?? "";
    const title = session.title || "(untitled)";
    return `  ${session.session_id}  ${when}  ${title}`;
  });
  return `${source} sessions (most recent first):\n${lines.join("\n")}`;
}

export function formatForeignHandoff(transcript: ForeignSessionTranscript): string {
  const summary = transcript.summary;
  const warnings = (summary.warnings ?? transcript.warnings ?? [])
    .map((warning) => `- ${warning.code}: ${warning.message}`);
  const paths = summary.paths.length > 0 ? summary.paths.map((item) => `- ${item}`).join("\n") : "- (none recorded)";
  const sourceLabel = transcript.tool === "claude" ? "Claude Code" : "Codex";
  return [
    `Imported ${sourceLabel} session ${transcript.session_id}.`,
    "This is a handoff summary. The original tool calls were not executed again.",
    "",
    `Title: ${transcript.title || "(untitled)"}`,
    `Source cwd: ${transcript.cwd || "(unknown)"}`,
    transcript.branch ? `Branch: ${transcript.branch}` : "",
    "",
    "Last user request:",
    summary.last_user_request || "(none recovered)",
    "",
    "Last recorded action:",
    summary.last_assistant_action || "(none recovered)",
    "",
    "Recorded paths:",
    paths,
    "",
    warnings.length > 0 ? `Warnings:\n${warnings.join("\n")}` : "Warnings: none",
    "",
    "Re-read the named files and check the current git status before editing. Transcript tool output is stale.",
  ].filter((line) => line !== "").join("\n");
}

export function handoffSession(
  transcript: ForeignSessionTranscript,
  workspace: { id?: string; cwd: string },
): PersistedSession {
  const origin: ForeignSessionOrigin = {
    source: transcript.tool,
    sourceSessionId: transcript.session_id,
    sourcePath: transcript.path,
    importedAt: Date.now(),
  };
  const message: AgentMessage = {
    id: randomUUID(),
    role: "user",
    content: formatForeignHandoff(transcript),
  };
  return {
    id: randomUUID(),
    createdAt: origin.importedAt,
    workspaceId: workspace.id,
    cwd: workspace.cwd,
    permissionMode: "plan",
    messages: [message],
    origin,
  };
}

export async function importForeignSession(
  manager: SessionManager,
  source: ForeignSessionSource,
  cwd: string,
  reference = "",
  workspaceId?: string,
): Promise<{ session: PersistedSession; created: boolean; transcript: ForeignSessionTranscript }> {
  const transcript = await readForeignSession(source, cwd, reference);
  const existing = [...(await manager.loadAll()).values()].find((session) =>
    session.origin?.source === transcript.tool
    && session.origin.sourceSessionId === transcript.session_id
    && path.resolve(session.origin.sourcePath) === path.resolve(transcript.path),
  );
  if (existing) return { session: existing, created: false, transcript };
  const session = await manager.importSession(handoffSession(transcript, { id: workspaceId, cwd }));
  return { session, created: true, transcript };
}
