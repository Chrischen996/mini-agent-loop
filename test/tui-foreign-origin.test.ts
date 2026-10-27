/// <reference types="../ink-testing-library.d.ts" />
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import React from "react";
import { App } from "../src/tui/App.tsx";
import { slugify } from "../skills/adapt-foreign-session/scripts/session-reader.mjs";

const { render } = await import("ink-testing-library");
const wait = (ms = 80) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const claudeId = "55555555-5555-4555-8555-555555555555";

describe("TUI foreign session origin", () => {
  let cwd: string;
  let dataDir: string;
  let previousData: string | undefined;
  let previousClaude: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "tui-foreign-work-"));
    dataDir = mkdtempSync(path.join(tmpdir(), "tui-foreign-data-"));
    previousData = process.env.AGENT_DATA_DIR;
    previousClaude = process.env.CLAUDE_CONFIG_DIR;
    process.env.AGENT_DATA_DIR = dataDir;
    process.env.MINI_AGENT_UPDATE_CHECK = "0";
    const config = path.join(dataDir, "claude");
    process.env.CLAUDE_CONFIG_DIR = config;
    const dir = path.join(config, "projects", slugify(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${claudeId}.jsonl`), `${JSON.stringify({
      type: "user",
      uuid: claudeId,
      cwd,
      message: { role: "user", content: [{ type: "text", text: "keep this origin" }] },
    })}\n`);
  });

  afterEach(() => {
    if (previousData === undefined) delete process.env.AGENT_DATA_DIR;
    else process.env.AGENT_DATA_DIR = previousData;
    if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaude;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("keeps the imported origin after the next saved turn", async () => {
    const view = render!(React.createElement(App, { cwd, agentTools: [], allTools: [] }));
    try {
      await wait();
      view.stdin.write(`/resume-claude ${claudeId}`);
      await wait();
      view.stdin.write("\r");
      await wait(400);
      view.stdin.write("continue the imported work");
      await wait();
      view.stdin.write("\r");
      await wait(500);
      const events = readFileSync(findEvents(dataDir), "utf8");
      assert.match(events, new RegExp(claudeId));
      assert.match(events, /"source":"claude"/);
    } finally {
      view.unmount();
    }
  });
});

function findEvents(root: string): string {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const name of readdirSync(current)) {
      const target = path.join(current, name);
      if (name === "events.jsonl") return target;
      if (statSync(target).isDirectory()) pending.push(target);
    }
  }
  throw new Error("imported session was not saved");
}
