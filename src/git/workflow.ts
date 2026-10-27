import { lstat, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

const execFileAsync = promisify(execFile);
const GIT_CONFIG_NULL = process.platform === "win32" ? "NUL" : os.devNull;

export type GitStatus = {
  root: string;
  branch: string;
  head: string;
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
};

export type GitChangedFile = {
  path: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
};

export type GitCheckpoint = {
  id: string;
  label: string;
  root: string;
  branch: string;
  head: string;
  snapshot: string;
  /** Index tree at checkpoint time, so undo preserves staged vs unstaged state. */
  indexSnapshot?: string;
  /** Non-ignored files that were untracked at checkpoint time. */
  untrackedPaths?: string[];
  createdAt: number;
};

export type IsolatedBranch = {
  branch: string;
  path: string;
  base: string;
};

type GitCheckpointStore = {
  version: 1;
  checkpoints: Record<string, GitCheckpoint>;
};

function safeLabel(value: string): string {
  const label = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return label.slice(0, 48) || "checkpoint";
}

async function runGit(root: string, args: string[], options: { env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}): Promise<string> {
  const result = await execFileAsync("git", ["-c", "core.autocrlf=false", "-C", root, ...args], {
    cwd: root,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_GLOBAL: GIT_CONFIG_NULL,
      GIT_CONFIG_NOSYSTEM: "1",
      ...options.env,
    },
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
  });
  return result.stdout;
}

async function repositoryRoot(cwd: string): Promise<string> {
  const root = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
  if (!root) throw new Error("Not inside a Git repository");
  return path.resolve(root);
}

async function readStore(root: string, checkpointDir: string): Promise<GitCheckpointStore> {
  const storePath = checkpointStorePath(root, checkpointDir);
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8")) as Partial<GitCheckpointStore>;
    if (parsed.version === 1 && parsed.checkpoints && typeof parsed.checkpoints === "object") {
      return { version: 1, checkpoints: parsed.checkpoints as Record<string, GitCheckpoint> };
    }
  } catch {
    // A missing or malformed local index does not make Git unusable.
  }
  return { version: 1, checkpoints: {} };
}

async function writeStore(root: string, checkpointDir: string, store: GitCheckpointStore): Promise<void> {
  const file = checkpointStorePath(root, checkpointDir);
  const dir = path.dirname(file);
  await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await (await import("node:fs/promises")).rename(temporary, file);
}

function checkpointStorePath(root: string, checkpointDir: string): string {
  const key = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 24);
  return path.join(checkpointDir, key + ".json");
}

async function snapshotTree(root: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-index-"));
  const index = path.join(tempDir, "index");
  try {
    await runGit(root, ["add", "-A"], { env: { GIT_INDEX_FILE: index } });
    const tree = (await runGit(root, ["write-tree"], { env: { GIT_INDEX_FILE: index } })).trim();
    const head = (await runGit(root, ["rev-parse", "HEAD"])).trim();
    return (await runGit(root, ["commit-tree", tree, "-p", head, "-m", "mini-agent checkpoint"], {
      env: {
        GIT_INDEX_FILE: index,
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "mini-agent",
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "mini-agent@localhost",
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "mini-agent",
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "mini-agent@localhost",
      },
    })).trim();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export class GitWorkflow {
  readonly cwd: string;
  readonly checkpointDir: string;
  readonly worktreeDir: string;

  constructor(cwd: string, options: { checkpointDir?: string; worktreeDir?: string } = {}) {
    this.cwd = path.resolve(cwd);
    this.checkpointDir = path.resolve(
      options.checkpointDir
        ?? process.env.MINI_AGENT_CHECKPOINT_DIR
        ?? path.join(os.homedir(), ".mini-agent", "checkpoints"),
    );
    this.worktreeDir = path.resolve(
      options.worktreeDir
        ?? process.env.MINI_AGENT_WORKTREE_DIR
        ?? path.join(os.homedir(), ".mini-agent", "worktrees"),
    );
  }

  async status(): Promise<GitStatus> {
    const root = await repositoryRoot(this.cwd);
    const [branch, head, porcelain] = await Promise.all([
      runGit(root, ["branch", "--show-current"]),
      runGit(root, ["rev-parse", "HEAD"]),
      runGit(root, ["status", "--porcelain=v1"]),
    ]);
    let staged = 0;
    let unstaged = 0;
    let untracked = 0;
    for (const line of porcelain.split("\n")) {
      if (!line) continue;
      if (line.startsWith("??")) { untracked += 1; continue; }
      if (line[0] && line[0] !== " ") staged += 1;
      if (line[1] && line[1] !== " ") unstaged += 1;
    }
    return { root, branch: branch.trim(), head: head.trim(), dirty: Boolean(porcelain.trim()), staged, unstaged, untracked };
  }

  async changedFiles(): Promise<GitChangedFile[]> {
    const root = await repositoryRoot(this.cwd);
    const porcelain = await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const records = porcelain.split("\0");
    const files: GitChangedFile[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      if (record.length < 4) continue;
      const status = record.slice(0, 2);
      const filePath = record.slice(3);
      const untracked = status === "??";
      files.push({
        path: filePath,
        status,
        staged: !untracked && status[0] !== " ",
        unstaged: !untracked && status[1] !== " ",
        untracked,
      });
      // Porcelain v1 -z emits a second NUL-delimited path for renames/copies.
      if (status.includes("R") || status.includes("C")) index += 1;
    }
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  async diffPath(relativePath: string): Promise<string> {
    const root = await repositoryRoot(this.cwd);
    const file = (await this.changedFiles()).find((candidate) => candidate.path === relativePath);
    if (!file) throw new Error(`Not a changed workspace file: ${relativePath}`);
    if (file.untracked) return diffUntrackedFile(root, relativePath);

    const [staged, unstaged] = await Promise.all([
      file.staged ? runGit(root, ["diff", "--cached", "--no-ext-diff", "--binary", "--no-color", "--", relativePath]) : "",
      file.unstaged ? runGit(root, ["diff", "--no-ext-diff", "--binary", "--no-color", "--", relativePath]) : "",
    ]);
    return [staged, unstaged].filter(Boolean).join("\n") || "(no text diff available)";
  }

  async diff(options: { staged?: boolean; path?: string } = {}): Promise<string> {
    const root = await repositoryRoot(this.cwd);
    const args = ["diff", "--no-ext-diff", "--binary", "--no-color"];
    if (options.staged) args.push("--cached");
    if (options.path) args.push("--", options.path);
    return runGit(root, args, { maxBuffer: 8 * 1024 * 1024 });
  }

  async createCheckpoint(label = "checkpoint"): Promise<GitCheckpoint> {
    const status = await this.status();
    const indexSnapshot = (await runGit(status.root, ["write-tree"])).trim();
    const untrackedPaths = (await runGit(status.root, ["ls-files", "--others", "--exclude-standard"]))
      .split("\n")
      .filter(Boolean);
    const snapshot = await snapshotTree(status.root);
    const checkpoint: GitCheckpoint = {
      id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      label: safeLabel(label),
      root: status.root,
      branch: status.branch,
      head: status.head,
      snapshot,
      indexSnapshot,
      untrackedPaths,
      createdAt: Date.now(),
    };
    await runGit(status.root, ["update-ref", `refs/mini-agent/checkpoints/${checkpoint.id}`, snapshot]);
    const store = await readStore(status.root, this.checkpointDir);
    store.checkpoints[checkpoint.id] = checkpoint;
    await writeStore(status.root, this.checkpointDir, store);
    return checkpoint;
  }

  async listCheckpoints(): Promise<GitCheckpoint[]> {
    const root = await repositoryRoot(this.cwd);
    const store = await readStore(root, this.checkpointDir);
    return Object.values(store.checkpoints).sort((a, b) => b.createdAt - a.createdAt);
  }

  async undo(checkpointId: string): Promise<GitCheckpoint> {
    const root = await repositoryRoot(this.cwd);
    const store = await readStore(root, this.checkpointDir);
    const checkpoint = store.checkpoints[checkpointId];
    if (!checkpoint) throw new Error(`Git checkpoint not found: ${checkpointId}`);
    if (path.resolve(checkpoint.root) !== root) throw new Error("Checkpoint belongs to another repository");
    if (checkpoint.indexSnapshot) {
      await runGit(root, ["restore", "--source", checkpoint.snapshot, "--worktree", "--no-overlay", "."]);
      await runGit(root, ["read-tree", checkpoint.indexSnapshot]);
    } else {
      // Backward compatibility for checkpoints created before indexSnapshot.
      await runGit(root, ["restore", "--source", checkpoint.snapshot, "--staged", "--worktree", "--no-overlay", "."]);
    }
    const expected = new Set(checkpoint.untrackedPaths
      ?? (await runGit(root, ["ls-tree", "-r", "--name-only", checkpoint.snapshot])).split("\n").filter(Boolean));
    const untracked = (await runGit(root, ["ls-files", "--others", "--exclude-standard"])).split("\n").filter(Boolean);
    for (const relative of untracked) {
      if (expected.has(relative)) continue;
      const absolute = path.join(root, relative);
      const info = await stat(absolute).catch(() => undefined);
      if (!info) continue;
      await rm(absolute, { recursive: info.isDirectory(), force: true });
    }
    return checkpoint;
  }

  async createIsolatedBranch(label = "task"): Promise<IsolatedBranch> {
    const status = await this.status();
    if (status.dirty) throw new Error("Create an isolated branch only from a clean worktree; create a checkpoint first");
    const branch = `mini-agent/${safeLabel(label)}-${Date.now().toString(36)}`;
    const baseDir = this.worktreeDir;
    await (await import("node:fs/promises")).mkdir(baseDir, { recursive: true });
    const target = path.join(baseDir, branch.slice("mini-agent/".length));
    await runGit(status.root, ["worktree", "add", "-b", branch, target, status.head]);
    return { branch, path: target, base: status.head };
  }
}

const MAX_UNTRACKED_DIFF_BYTES = 512 * 1024;

async function diffUntrackedFile(root: string, relativePath: string): Promise<string> {
  const absolutePath = path.resolve(root, relativePath);
  const fromRoot = path.relative(root, absolutePath);
  if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new Error(`Changed file is outside the repository: ${relativePath}`);
  }

  const info = await lstat(absolutePath);
  let content: Buffer;
  let mode: string;
  if (info.isSymbolicLink()) {
    content = Buffer.from(await readlink(absolutePath), "utf8");
    mode = "120000";
  } else {
    if (!info.isFile()) return `Untracked path is not a regular file: ${relativePath}`;
    if (info.size > MAX_UNTRACKED_DIFF_BYTES) {
      return `Untracked file is too large to render (${info.size} bytes): ${relativePath}`;
    }
    content = await readFile(absolutePath);
    mode = info.mode & 0o111 ? "100755" : "100644";
  }
  if (content.includes(0)) return `Binary untracked file: ${relativePath}`;

  const text = content.toString("utf8").replace(/\r\n?/g, "\n");
  const hasTrailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (hasTrailingNewline) lines.pop();
  const safePath = relativePath.replace(/[\r\n\t]/g, "?");
  const hunk = lines.length > 0
    ? `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}`
    : "@@ -0,0 +0,0 @@";
  const noNewlineMarker = !hasTrailingNewline && lines.length > 0 ? "\n\\ No newline at end of file" : "";
  return [
    `diff --git a/${safePath} b/${safePath}`,
    `new file mode ${mode}`,
    "--- /dev/null",
    `+++ b/${safePath}`,
    hunk + noNewlineMarker,
    "",
  ].join("\n");
}

export async function createGitWorkflow(cwd: string, options?: { checkpointDir?: string; worktreeDir?: string }): Promise<GitWorkflow> {
  const root = await repositoryRoot(cwd);
  return new GitWorkflow(root, options);
}
