import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AGENT_FILENAME, buildAgentMdContent, initAgentMd, writeAgentMd } from "../src/init-agent-md.ts";
import { parseInitCommand } from "../src/tui/init-command.ts";
import { loadAgentsMd } from "../src/agents-md.ts";
import { SLASH_COMMANDS, formatHelpNotice } from "../src/tui/slash-commands.ts";

async function assertExists(file: string): Promise<void> {
  await access(file);
}

describe("initAgentMd", () => {
  it("creates AGENT.MD when the file does not exist", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "init-agent-md-"));
    try {
      const result = await initAgentMd({ cwd: dir });
      assert.equal(result.created, true);
      assert.equal(result.overwritten, false);
      assert.equal(path.basename(result.path), AGENT_FILENAME);
      await assertExists(path.join(dir, AGENT_FILENAME));
      const content = await readFile(path.join(dir, AGENT_FILENAME), "utf8");
      assert.match(content, /# Agent Instructions/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects overwriting an existing file without --force", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "init-agent-md-"));
    try {
      const existing = path.join(dir, AGENT_FILENAME);
      await writeFile(existing, "custom instructions");
      await assert.rejects(
        initAgentMd({ cwd: dir }),
        /already exists/,
      );
      const preserved = await readFile(existing, "utf8");
      assert.equal(preserved, "custom instructions");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("overwrites an existing file when force is set", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "init-agent-md-"));
    try {
      await writeFile(path.join(dir, AGENT_FILENAME), "custom instructions");
      const result = await initAgentMd({ cwd: dir, force: true });
      assert.equal(result.overwritten, true);
      const content = await readFile(path.join(dir, AGENT_FILENAME), "utf8");
      assert.match(content, /# Agent Instructions/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns the generated template without writing when print is set", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "init-agent-md-"));
    try {
      const result = await initAgentMd({ cwd: dir, print: true });
      assert.equal(result.created, false);
      assert.equal(result.overwritten, false);
      assert.match(result.content, /# Agent Instructions/);
      await assert.rejects(access(path.join(dir, AGENT_FILENAME)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("generates the template with generic content in an empty project", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "init-agent-md-"));
    try {
      const content = await buildAgentMdContent(dir);
      assert.match(content, /# Agent Instructions/);
      assert.match(content, /## Project Overview/);
      assert.match(content, /## Development Commands/);
      // No hardcoded mini-agent internals.
      assert.doesNotMatch(content, /mini-agent/);
      assert.doesNotMatch(content, /src\/tui/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fills detected script hints for Node projects", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "init-agent-md-"));
    try {
      await writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({
          name: "demo",
          scripts: { test: "node --test", build: "vite build" },
          devDependencies: { typescript: "5.6.0" },
        }),
      );
      const content = await buildAgentMdContent(dir);
      assert.match(content, /Detected: Node\.js/);
      assert.match(content, /- `test`: `node --test`/);
      assert.match(content, /- `build`: `vite build`/);
      assert.match(content, /Detected: TypeScript compiler present\./);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("loadAgentsMd recognises AGENT.MD", () => {
  it("returns the generated AGENT.MD content", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "init-agent-md-load-"));
    try {
      await initAgentMd({ cwd: dir });
      const result = await loadAgentsMd(dir);
      assert.match(result ?? "", /# Agent Instructions/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parseInitCommand", () => {
  it("parses /init without options", () => {
    assert.deepEqual(parseInitCommand("/init"), { kind: "ok", force: false, print: false, template: false });
  });

  it("parses /init --force", () => {
    assert.deepEqual(parseInitCommand("/init --force"), { kind: "ok", force: true, print: false, template: false });
  });

  it("parses /init --force --print", () => {
    assert.deepEqual(parseInitCommand("/init --force --print"), { kind: "ok", force: true, print: true, template: false });
  });

  it("parses /init --template", () => {
    assert.deepEqual(parseInitCommand("/init --template"), { kind: "ok", force: false, print: false, template: true });
    assert.deepEqual(parseInitCommand("/init -t"), { kind: "ok", force: false, print: false, template: true });
  });

  it("rejects unknown options", () => {
    const result = parseInitCommand("/init --bogus");
    assert.equal(result?.kind, "error");
    if (result?.kind === "error") assert.match(result.message, /Unknown option/);
  });

  it("returns null for non-init input", () => {
    assert.equal(parseInitCommand("/help"), null);
    assert.equal(parseInitCommand("hello"), null);
  });
});

describe("writeAgentMd", () => {
  it("creates the file and reports created=true", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "write-agent-md-"));
    try {
      const result = await writeAgentMd({ cwd: dir, content: "# Custom\n" });
      assert.equal(result.created, true);
      assert.equal(result.overwritten, false);
      assert.equal(await readFile(path.join(dir, AGENT_FILENAME), "utf8"), "# Custom\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite without force", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "write-agent-md-"));
    try {
      await writeFile(path.join(dir, AGENT_FILENAME), "keep me");
      await assert.rejects(writeAgentMd({ cwd: dir, content: "new" }), /already exists/);
      assert.equal(await readFile(path.join(dir, AGENT_FILENAME), "utf8"), "keep me");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("overwrites when force is set", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "write-agent-md-"));
    try {
      await writeFile(path.join(dir, AGENT_FILENAME), "keep me");
      const result = await writeAgentMd({ cwd: dir, content: "new", force: true });
      assert.equal(result.overwritten, true);
      assert.equal(result.created, false);
      assert.equal(await readFile(path.join(dir, AGENT_FILENAME), "utf8"), "new");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("/init command registration", () => {
  it("is listed in SLASH_COMMANDS and /help", () => {
    assert.ok(SLASH_COMMANDS.some((command) => command.name === "init"));
    const help = formatHelpNotice();
    assert.match(help, /\/init/);
  });
});
