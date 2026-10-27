#!/usr/bin/env node
/**
 * Read Claude Code and Codex transcripts as inert history.
 * stdout is always one JSON object. Exit 0 = result, 2 = ambiguous, 1 = error.
 */
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CODEX_ROLLOUT_RE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-fA-F-]{36})\.jsonl(?:\.zst)?$/;
const GENERATED_META_RE = /^\s*<[a-z][A-Za-z0-9_.:-]*(?:\s|\/?>)/;
const INTERRUPTED_RE = /^\s*\[Request interrupted by user/i;
const MAX_BYTES = 20 * 1024 * 1024;
const PATH_KEYS = ["file_path", "filePath", "path", "target_file", "target_notebook"];

export function slugify(cwd) {
  return [...String(cwd)].map((char) => /\p{L}|\p{N}/u.test(char) ? char : "-").join("");
}

export function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false;
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  try {
    return normalize(left) === normalize(right);
  } catch {
    return false;
  }
}

function oneLine(value, limit) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function preview(value, limit) {
  let text;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return oneLine(text, limit);
}

function isGeneratedMeta(text) {
  return GENERATED_META_RE.test(text) || INTERRUPTED_RE.test(text);
}

function addWarning(warnings, code, message) {
  if (!warnings.some((item) => item.code === code && item.message === message)) {
    warnings.push({ code, message });
  }
}

function blocks(content) {
  if (Array.isArray(content)) return content.filter((item) => item && typeof item === "object");
  if (content && typeof content === "object") return [content];
  if (typeof content === "string" && content.trim()) return [{ type: "text", text: content }];
  return [];
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && typeof item.text === "string") return item.text;
      return "";
    }).filter(Boolean).join("\n");
  }
  if (content && typeof content === "object") {
    for (const key of ["text", "output", "content"]) {
      if (typeof content[key] === "string") return content[key];
    }
  }
  return "";
}

function turn(role, text = "", toolCalls = [], toolResults = []) {
  return {
    role,
    text,
    tool_calls: toolCalls,
    tool_results: toolResults,
    inert: true,
  };
}

async function isSymlink(target) {
  try {
    return (await lstat(target)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function readText(target) {
  const info = await stat(target);
  if (info.size <= MAX_BYTES) return { text: await readFile(target, "utf8"), truncated: false };
  const chunks = [];
  const stream = createReadStream(target, { start: 0, end: MAX_BYTES - 1 });
  for await (const chunk of stream) chunks.push(chunk);
  return { text: Buffer.concat(chunks).toString("utf8"), truncated: true };
}

function parseJsonl(text) {
  const records = [];
  let malformed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) records.push(value);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed };
}

async function readJsonl(target) {
  if (target.endsWith(".jsonl.zst")) {
    const executable = process.platform === "win32" ? "zstd.exe" : "zstd";
    const completed = spawnSync(executable, ["-dc", target], { encoding: "utf8", maxBuffer: MAX_BYTES });
    if (completed.error) {
      throw new Error(`zstd is required to read ${target}`);
    }
    if (completed.status !== 0) {
      throw new Error(`zstd failed to decompress ${target}`);
    }
    const parsed = parseJsonl(completed.stdout ?? "");
    return { ...parsed, truncated: Buffer.byteLength(completed.stdout ?? "", "utf8") >= MAX_BYTES };
  }
  const { text, truncated } = await readText(target);
  return { ...parseJsonl(text), truncated };
}

function collectPaths(value, paths, depth = 0) {
  if (depth > 4 || paths.length >= 20) return;
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, paths, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (PATH_KEYS.includes(key) && typeof item === "string" && item.trim()) {
      if (!paths.includes(item)) paths.push(item);
    } else if (item && typeof item === "object") {
      collectPaths(item, paths, depth + 1);
    }
  }
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function summarize(turns, warnings) {
  const paths = [];
  for (const item of turns) {
    for (const call of item.tool_calls ?? []) collectPaths(parseMaybeJson(call.input_raw ?? call.input), paths);
  }
  const lastUser = [...turns].reverse().find((item) => item.role === "user" && item.text);
  const lastAssistant = [...turns].reverse().find((item) => item.role === "assistant" && (item.text || item.tool_calls?.length));
  let lastAction = lastAssistant?.text ? oneLine(lastAssistant.text, 400) : "";
  if (!lastAction && lastAssistant?.tool_calls?.length) {
    lastAction = `called inert foreign tool(s): ${lastAssistant.tool_calls.map((call) => call.name || "unknown").join(", ")}`;
  }
  return {
    last_user_request: lastUser ? oneLine(lastUser.text, 400) : null,
    last_assistant_action: lastAction || null,
    paths,
    turn_count: turns.length,
    warnings: [...warnings].sort((left, right) => left.code.localeCompare(right.code) || left.message.localeCompare(right.message)),
  };
}

function finalize(result, turns, warnings) {
  const capped = turns.slice(-result.max_turns);
  if (capped.length < turns.length) {
    addWarning(warnings, "turns_truncated", `Kept the latest ${capped.length} of ${turns.length} recovered turns.`);
  }
  result.summary = summarize(capped, warnings);
  for (const item of capped) {
    for (const call of item.tool_calls ?? []) delete call.input_raw;
  }
  result.turns = capped;
  result.warnings = result.summary.warnings;
  result.inert = true;
  delete result.max_turns;
  return result;
}

function claudeParent(record) {
  return typeof record.parentUuid === "string" && record.parentUuid
    ? record.parentUuid
    : typeof record.logicalParentUuid === "string" && record.logicalParentUuid
      ? record.logicalParentUuid
      : null;
}

function renderClaude(record, maxToolChars, replacementIds) {
  if (!record || !["user", "assistant"].includes(record.type)) return null;
  if (record.isMeta || record.isCompactSummary || record.isVirtual || record.isVisibleInTranscriptOnly || record.isSidechain) {
    return null;
  }
  const message = record.message;
  if (!message || typeof message !== "object") return null;
  const role = message.role === "user" || message.role === "assistant" ? message.role : record.type;
  const texts = [];
  const toolCalls = [];
  const toolResults = [];
  for (const block of blocks(message.content)) {
    const blockType = block.type;
    if (["thinking", "redacted_thinking", "signature"].includes(blockType)) continue;
    if (["text", "input_text", "output_text"].includes(blockType) && typeof block.text === "string" && block.text.trim() && !isGeneratedMeta(block.text)) {
      texts.push(block.text);
    } else if (blockType === "tool_use") {
      toolCalls.push({
        id: block.id ?? null,
        name: String(block.name || "unknown"),
        input: preview(block.input ?? {}, maxToolChars),
        input_raw: block.input ?? {},
        inert: true,
      });
    } else if (blockType === "tool_result") {
      const raw = contentText(block.content);
      const unavailable = (typeof block.tool_use_id === "string" && replacementIds.has(block.tool_use_id))
        || raw.includes("<persisted-output>")
        || raw.includes("[Old tool result content cleared]");
      toolResults.push({
        tool_use_id: block.tool_use_id ?? null,
        content: unavailable ? "[output summarized/stored elsewhere]" : oneLine(raw, maxToolChars),
        is_error: Boolean(block.is_error),
        unavailable,
        inert: true,
      });
    } else if (blockType === "image") {
      texts.push("[image content unavailable]");
    }
  }
  const text = texts.filter((item) => item.trim()).join("\n");
  if (!text && toolCalls.length === 0 && toolResults.length === 0) return null;
  return turn(role, text, toolCalls, toolResults);
}

function claudeChain(records, warnings) {
  const boundary = records.findLastIndex((record) => record.type === "system" && record.subtype === "compact_boundary");
  const scoped = boundary >= 0 ? records.slice(boundary) : records;
  if (boundary > 0) {
    addWarning(warnings, "compaction_gap", "Claude compaction dropped earlier transcript records; only the post-boundary chain was recovered.");
  }
  const messages = new Map();
  for (const record of scoped) {
    if (record.isSidechain) continue;
    if (typeof record.uuid === "string" && record.uuid) messages.set(record.uuid, record);
  }
  const parents = new Set([...messages.values()].map(claudeParent).filter(Boolean));
  const leaves = [...messages.values()].filter((record) => typeof record.uuid === "string" && !parents.has(record.uuid));
  const leaf = leaves.sort((left, right) => String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? "")))
    .at(-1);
  if (!leaf) {
    return scoped.filter((record) => record.type === "user" || record.type === "assistant");
  }
  const chain = [];
  const seen = new Set();
  let current = leaf;
  while (current) {
    const uuid = current.uuid;
    if (typeof uuid !== "string" || seen.has(uuid)) {
      if (seen.has(uuid)) addWarning(warnings, "parent_cycle", "A cycle was detected in the Claude parent chain; only the recoverable suffix is shown.");
      break;
    }
    seen.add(uuid);
    chain.push(current);
    const parent = claudeParent(current);
    current = parent ? messages.get(parent) : null;
  }
  chain.reverse();
  return chain;
}

function replacementIds(records) {
  const ids = new Set();
  for (const record of records) {
    if (record.type !== "content-replacement" || record.agentId) continue;
    const replacements = Array.isArray(record.replacements) ? record.replacements : [];
    for (const item of replacements) {
      const toolId = item?.toolUseId ?? item?.tool_use_id;
      if (typeof toolId === "string") ids.add(toolId);
    }
  }
  return ids;
}

export async function readClaudeSession(target, options) {
  const loaded = await readJsonl(target);
  const warnings = [];
  if (loaded.malformed) addWarning(warnings, "malformed_records_skipped", `Skipped ${loaded.malformed} malformed Claude transcript record(s).`);
  if (loaded.truncated) addWarning(warnings, "transcript_truncated", `Read the first ${MAX_BYTES} bytes of ${target}.`);
  const chain = claudeChain(loaded.records, warnings);
  const replacements = replacementIds(loaded.records);
  const turns = chain.map((record) => renderClaude(record, options.maxToolChars, replacements)).filter(Boolean);
  if (turns.some((item) => item.tool_results.some((result) => result.unavailable))) {
    addWarning(warnings, "tool_output_unavailable", "Some Claude tool outputs were summarized or stored elsewhere.");
  }
  const metadata = chain.length > 0 ? chain : loaded.records;
  const cwd = metadata.find((record) => typeof record.cwd === "string")?.cwd ?? null;
  const branch = [...metadata].reverse().find((record) => typeof record.gitBranch === "string")?.gitBranch ?? null;
  const timestamps = chain.map((record) => record.timestamp).filter((value) => typeof value === "string");
  const titleRecord = [...loaded.records].reverse().find((record) => ["custom-title", "ai-title", "summary"].includes(record.type));
  const titleField = titleRecord?.customTitle ?? titleRecord?.aiTitle ?? titleRecord?.summary;
  const title = typeof titleField === "string"
    ? oneLine(titleField, 200)
    : oneLine(turns.find((item) => item.role === "user" && item.text)?.text ?? "", 200) || null;
  if (options.cwd && cwd && !samePath(cwd, options.cwd)) {
    addWarning(warnings, "cwd_mismatch", `Transcript cwd ${cwd} does not match ${options.cwd}.`);
  }
  return finalize({
    tool: "claude",
    source: "claude-code",
    session_id: path.basename(target, ".jsonl"),
    path: target,
    title,
    cwd,
    branch,
    created_at: timestamps[0] ?? null,
    updated_at: timestamps.at(-1) ?? new Date((await stat(target)).mtimeMs).toISOString(),
    max_turns: options.maxTurns,
  }, turns, warnings);
}

function renderCodexItem(item, maxToolChars) {
  if (!item || typeof item !== "object") return { turn: null, skipped: true };
  if (item.type === "message") {
    if (!["user", "assistant"].includes(item.role)) return { turn: null, skipped: ["system", "developer"].includes(item.role) };
    const texts = [];
    for (const block of blocks(item.content)) {
      if (["reasoning", "thinking", "encrypted_content"].includes(block.type)) continue;
      if (["input_text", "output_text", "text"].includes(block.type) && typeof block.text === "string" && block.text.trim() && !isGeneratedMeta(block.text)) {
        texts.push(block.text);
      }
    }
    const text = texts.join("\n");
    return { turn: text ? turn(item.role, text) : null, skipped: false };
  }
  if (item.type === "function_call" || item.type === "custom_tool_call" || item.type === "local_shell_call") {
    const name = item.type === "local_shell_call" ? "local_shell" : String(item.name || "function");
    const input = item.type === "local_shell_call" ? item.action ?? {} : item.arguments ?? item.input ?? "";
    return {
      turn: turn("assistant", "", [{
        id: item.call_id ?? item.id ?? null,
        name,
        input: preview(input, maxToolChars),
        input_raw: input,
        inert: true,
      }]),
      skipped: false,
    };
  }
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    const output = item.output && typeof item.output === "object"
      ? item.output.body ?? item.output.text ?? item.output
      : item.output;
    return {
      turn: turn("tool", "", [], [{
        tool_use_id: item.call_id ?? item.id ?? null,
        content: preview(output, maxToolChars),
        is_error: item.success === false,
        unavailable: false,
        inert: true,
      }]),
      skipped: false,
    };
  }
  return { turn: null, skipped: true };
}

function dropLastUserTurns(turns, number) {
  if (!Number.isInteger(number) || number <= 0) return turns;
  const positions = turns.map((item, index) => item.role === "user" ? index : -1).filter((index) => index >= 0);
  const cut = positions[Math.max(0, positions.length - number)] ?? 0;
  return turns.slice(0, cut);
}

export async function readCodexSession(target, options) {
  const loaded = await readJsonl(target);
  const warnings = [];
  if (loaded.malformed) addWarning(warnings, "malformed_records_skipped", `Skipped ${loaded.malformed} malformed Codex rollout record(s).`);
  if (loaded.truncated) addWarning(warnings, "transcript_truncated", `Read a bounded prefix of ${target}.`);
  const meta = loaded.records.find((record) => record.type === "session_meta" && record.payload && typeof record.payload === "object")?.payload ?? {};
  let base = [];
  let start = 0;
  loaded.records.forEach((record, index) => {
    if (record.type !== "compacted") return;
    const replacement = record.payload?.replacement_history;
    if (Array.isArray(replacement)) {
      base = replacement;
      start = index + 1;
    }
  });
  let turns = [];
  let skipped = 0;
  for (const item of base) {
    const rendered = renderCodexItem(item, options.maxToolChars);
    skipped += rendered.skipped ? 1 : 0;
    if (rendered.turn) turns.push(rendered.turn);
  }
  for (const record of loaded.records.slice(start)) {
    if (record.type === "response_item") {
      const rendered = renderCodexItem(record.payload, options.maxToolChars);
      skipped += rendered.skipped ? 1 : 0;
      if (rendered.turn) turns.push(rendered.turn);
    } else if (record.type === "event_msg" && record.payload?.type === "thread_rolled_back") {
      turns = dropLastUserTurns(turns, record.payload.num_turns);
    } else if (record.type === "session_meta" || record.type === "compacted") {
      continue;
    } else {
      skipped += 1;
    }
  }
  if (skipped) addWarning(warnings, "unsafe_records_skipped", `Skipped ${skipped} foreign instruction, reasoning, context, or unknown Codex item(s).`);
  const git = meta.git && typeof meta.git === "object" ? meta.git : {};
  const timestamps = loaded.records.map((record) => record.timestamp).filter((value) => typeof value === "string");
  const cwd = typeof meta.cwd === "string" ? meta.cwd : null;
  if (options.cwd && cwd && !samePath(cwd, options.cwd)) {
    addWarning(warnings, "cwd_mismatch", `Transcript cwd ${cwd} does not match ${options.cwd}.`);
  }
  const sessionId = typeof meta.id === "string" ? meta.id : (CODEX_ROLLOUT_RE.exec(path.basename(target))?.[1] ?? path.basename(target).replace(/\.jsonl(?:\.zst)?$/, ""));
  return finalize({
    tool: "codex",
    source: meta.source === "cli" || meta.source === "vscode" ? `codex-${meta.source}` : "codex",
    session_id: sessionId,
    path: target,
    title: oneLine(turns.find((item) => item.role === "user" && item.text)?.text ?? "", 200) || null,
    cwd,
    branch: typeof git.branch === "string" ? git.branch : typeof meta.git_branch === "string" ? meta.git_branch : null,
    created_at: timestamps[0] ?? null,
    updated_at: timestamps.at(-1) ?? new Date((await stat(target)).mtimeMs).toISOString(),
    max_turns: options.maxTurns,
  }, turns, warnings);
}

async function walkFiles(root, accept) {
  if (!(await stat(root).catch(() => null))?.isDirectory() || await isSymlink(root)) return [];
  const found = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(target);
      else if (accept(entry.name, target)) found.push(target);
    }
  }
  return found;
}

function applyClaudeHead(found, line) {
  if (!line.trim()) return;
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  if (!found.cwd && typeof value.cwd === "string") found.cwd = value.cwd;
  const titleField = value.customTitle ?? value.aiTitle ?? value.summary;
  if (!found.title && typeof titleField === "string") found.title = oneLine(titleField, 200);
  const content = value.message?.content;
  const text = typeof content === "string"
    ? content
    : content?.find?.((block) => block?.type === "text")?.text;
  if (!found.title && value.type === "user" && !value.isMeta && !value.isSidechain && typeof text === "string" && !isGeneratedMeta(text)) {
    found.title = oneLine(text, 200);
  }
}

async function claudeHead(target) {
  const found = { cwd: null, title: null };
  try {
    const handle = createReadStream(target, { encoding: "utf8", highWaterMark: 64 * 1024 });
    let buffered = "";
    for await (const chunk of handle) {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) applyClaudeHead(found, line);
      if (found.cwd && found.title) {
        handle.destroy();
        break;
      }
      if (Buffer.byteLength(buffered, "utf8") > 1024 * 1024) break;
    }
    applyClaudeHead(found, buffered);
  } catch {
    return found;
  }
  return found;
}

export async function listClaude(configDir, cwd) {
  const projects = path.join(configDir, "projects");
  const files = await walkFiles(projects, (name) => name.endsWith(".jsonl") && UUID_RE.test(path.basename(name, ".jsonl")));
  const sessions = [];
  for (const file of files) {
    if (await isSymlink(file)) continue;
    const head = await claudeHead(file);
    const inExpected = path.basename(path.dirname(file)) === slugify(cwd);
    if (head.cwd && !samePath(head.cwd, cwd)) continue;
    if (!head.cwd && !inExpected) continue;
    const info = await stat(file);
    sessions.push({
      tool: "claude",
      source: "claude-code",
      session_id: path.basename(file, ".jsonl"),
      path: file,
      title: head.title,
      cwd: head.cwd ?? cwd,
      updated_at_ms: info.mtimeMs,
      updated_at: new Date(info.mtimeMs).toISOString(),
    });
  }
  return sessions.sort((left, right) => right.updated_at_ms - left.updated_at_ms);
}

function preferredCodexRollout(files) {
  const byId = new Map();
  for (const file of files) {
    const sessionId = CODEX_ROLLOUT_RE.exec(path.basename(file))?.[1];
    if (!sessionId) continue;
    const current = byId.get(sessionId);
    if (!current || (current.endsWith(".jsonl.zst") && !file.endsWith(".jsonl.zst"))) byId.set(sessionId, file);
  }
  return [...byId.values()];
}

async function listCodexFiles(home, cwd) {
  const sessions = [];
  for (const rootName of ["sessions"]) {
    const files = preferredCodexRollout(await walkFiles(path.join(home, rootName), (name) => CODEX_ROLLOUT_RE.test(name)));
    for (const file of files) {
      let meta = null;
      try {
        const { records } = parseJsonl((await readText(file)).text.split(/\r?\n/).slice(0, 30).join("\n"));
        meta = records.find((record) => record.type === "session_meta")?.payload ?? null;
        const firstUser = records.map((record) => record.payload).find((item) => item?.type === "message" && item.role === "user");
        const firstText = blocks(firstUser?.content).find((block) => typeof block.text === "string")?.text;
        if (meta && typeof firstText === "string") meta = { ...meta, title: meta.title || firstText };
      } catch (error) {
        if (!file.endsWith(".jsonl.zst")) continue;
        const sessionId = CODEX_ROLLOUT_RE.exec(path.basename(file))?.[1];
        if (!sessionId) continue;
        const info = await stat(file);
        sessions.push({
          tool: "codex",
          source: "codex",
          session_id: sessionId,
          path: file,
          title: "(compressed; zstd required to read)",
          cwd,
          updated_at_ms: info.mtimeMs,
          updated_at: new Date(info.mtimeMs).toISOString(),
          read_error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (file.endsWith(".jsonl.zst") && !meta) {
        const sessionId = CODEX_ROLLOUT_RE.exec(path.basename(file))?.[1];
        if (!sessionId) continue;
        const info = await stat(file);
        sessions.push({
          tool: "codex",
          source: "codex",
          session_id: sessionId,
          path: file,
          title: "(compressed; zstd required to read)",
          cwd,
          updated_at_ms: info.mtimeMs,
          updated_at: new Date(info.mtimeMs).toISOString(),
          read_error: "zstd is required to read this rollout",
        });
        continue;
      }
      if (!meta || !["cli", "vscode"].includes(meta.source) || !samePath(meta.cwd, cwd)) continue;
      if (typeof meta.id !== "string" || !UUID_RE.test(meta.id)) continue;
      const info = await stat(file);
      sessions.push({
        tool: "codex",
        source: `codex-${meta.source}`,
        session_id: meta.id,
        path: file,
        title: oneLine(meta.title ?? "", 200) || "(untitled)",
        cwd: meta.cwd,
        branch: typeof meta.git?.branch === "string" ? meta.git.branch : null,
        updated_at_ms: info.mtimeMs,
        updated_at: new Date(info.mtimeMs).toISOString(),
      });
    }
  }
  return sessions;
}

async function listCodexDatabase(home, cwd) {
  let entries = [];
  try {
    entries = await readdir(home, { withFileTypes: true });
  } catch {
    return null;
  }
  const databases = entries
    .filter((entry) => entry.isFile() && /^state_(\d+)\.sqlite$/.test(entry.name))
    .map((entry) => ({ version: Number(/^state_(\d+)\.sqlite$/.exec(entry.name)[1]), file: path.join(home, entry.name) }))
    .sort((left, right) => right.version - left.version);
  if (databases.length === 0) return null;
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    return null;
  }
  try {
    const database = new sqlite.DatabaseSync(databases[0].file, { readOnly: true });
    const columns = new Set(database.prepare("PRAGMA table_info(threads)").all().map((row) => row.name));
    const required = ["id", "rollout_path", "source", "cwd"];
    if (!required.every((name) => columns.has(name))) {
      database.close();
      return null;
    }
    const updated = columns.has("updated_at_ms") ? "updated_at_ms" : columns.has("updated_at") ? "updated_at" : null;
    if (!updated) {
      database.close();
      return null;
    }
    const title = columns.has("title") ? "title" : "''";
    const archived = columns.has("archived") ? "archived = 0 AND " : "";
    const rows = database.prepare(
      `SELECT id, rollout_path, ${updated} AS updated_value, source, cwd, ${title} AS title FROM threads WHERE ${archived}source IN ('cli', 'vscode')`,
    ).all();
    database.close();
    const sessions = [];
    for (const row of rows) {
      if (!samePath(row.cwd, cwd) || typeof row.id !== "string" || !UUID_RE.test(row.id)) continue;
      const rollout = typeof row.rollout_path === "string"
        ? (path.isAbsolute(row.rollout_path) ? row.rollout_path : path.join(home, row.rollout_path))
        : null;
      if (!rollout || await isSymlink(rollout) || !(await stat(rollout).catch(() => null))?.isFile()) continue;
      const info = await stat(rollout);
      sessions.push({
        tool: "codex",
        source: `codex-${row.source}`,
        session_id: row.id,
        path: rollout,
        title: oneLine(row.title, 200) || "(untitled)",
        cwd: row.cwd,
        updated_at_ms: Number(row.updated_value) || info.mtimeMs,
        updated_at: new Date(Number(row.updated_value) || info.mtimeMs).toISOString(),
      });
    }
    return sessions;
  } catch {
    return null;
  }
}

export async function listCodex(home, cwd) {
  return await listCodexDatabase(home, cwd) ?? await listCodexFiles(home, cwd);
}

function resolveRef(sessions, ref) {
  const query = ref.trim();
  if (!query || query.toLowerCase() === "latest") {
    const readable = sessions.filter((item) => !item.read_error);
    const pool = readable.length > 0 ? readable : sessions;
    if (pool.length === 0) throw Object.assign(new Error("no session found for this cwd"), { code: 1 });
    return pool[0];
  }
  const exact = sessions.filter((item) => item.session_id.toLowerCase() === query.toLowerCase());
  if (exact.length === 1) return exact[0];
  const folded = query.toLowerCase();
  const matches = sessions.filter((item) => String(item.title ?? "").toLowerCase().includes(folded) || item.session_id.toLowerCase().includes(folded));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw Object.assign(new Error(`reference ${JSON.stringify(query)} matched ${matches.length} sessions`), {
      code: 2,
      matches,
    });
  }
  throw Object.assign(new Error(`no session matched ${JSON.stringify(query)}`), { code: 1 });
}

function parseArgs(argv) {
  const positional = [];
  const flags = { json: false, withinMin: 0, maxToolChars: 300, maxTurns: 40 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      index += 1;
      return value;
    };
    if (arg === "--json") flags.json = true;
    else if (arg === "--cwd") flags.cwd = next();
    else if (arg.startsWith("--cwd=")) flags.cwd = arg.slice("--cwd=".length);
    else if (arg === "--claude-config") flags.claudeConfig = next();
    else if (arg === "--codex-home") flags.codexHome = next();
    else if (arg === "--within-min") flags.withinMin = Number(next());
    else if (arg === "--max-tool-chars") flags.maxToolChars = Number(next());
    else if (arg === "--max-turns") flags.maxTurns = Number(next());
    else if (arg.startsWith("-")) throw new Error(`unknown flag ${arg}`);
    else positional.push(arg);
  }
  return { positional, flags };
}

async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const [tool, command, ref = ""] = positional;
  if (!["claude", "codex"].includes(tool) || !["list", "show"].includes(command)) {
    throw new Error("usage: session-reader.mjs <claude|codex> <list|show> [ref] --cwd DIR [--json]");
  }
  const cwd = path.resolve(flags.cwd ?? process.cwd());
  const options = { cwd, maxToolChars: flags.maxToolChars, maxTurns: flags.maxTurns };
  const claudeConfig = path.resolve(flags.claudeConfig ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"));
  const codexHome = path.resolve(flags.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
  const configDir = tool === "claude" ? claudeConfig : codexHome;
  let sessions = tool === "claude" ? await listClaude(claudeConfig, cwd) : await listCodex(codexHome, cwd);
  if (flags.withinMin > 0) {
    const cutoff = Date.now() - flags.withinMin * 60 * 1000;
    sessions = sessions.filter((item) => item.updated_at_ms >= cutoff);
  }
  if (command === "list") {
    return {
      tool,
      cwd,
      config_dir: configDir,
      config_dir_exists: Boolean(await stat(configDir).catch(() => null)),
      sessions,
    };
  }
  let selected = null;
  if (ref && !["latest"].includes(ref.toLowerCase())) {
    const asPath = path.resolve(ref);
    const info = await stat(asPath).catch(() => null);
    if (info?.isFile() && !(await isSymlink(asPath))) selected = { path: asPath, session_id: path.basename(asPath) };
  }
  if (!selected) selected = resolveRef(sessions, ref);
  const result = tool === "claude"
    ? await readClaudeSession(selected.path, options)
    : await readCodexSession(selected.path, options);
  result.config_dir = configDir;
  return result;
}

function writeResult(payload, code = 0) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = code;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (payload) => writeResult(payload, 0),
    (error) => writeResult({
      error: error instanceof Error ? error.message : String(error),
      matches: error.matches ?? [],
    }, error.code === 2 ? 2 : 1),
  );
}
