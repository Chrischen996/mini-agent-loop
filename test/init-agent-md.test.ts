import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AGENT_FILENAME, buildAgentMdContent, initAgentMd } from "../src/init-agent-md.ts";
import { parseInitCommand } from "../src/tui/init-command.ts";
import { loadAgentsMd } from "../src/agents-md.ts";
import { SLASH_COMMANDS, formatHelpNotice } from "../src/tui/slash-commands.ts";
import type { LlmConfig } from "../src/llm/index.ts";
import type { AgentMessage } from "../src/types.ts";

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

describe("initAgentMd LLM generation", () => {
  const fakeLlmConfig = {} as LlmConfig;

  it("writes LLM-generated content when llm is requested", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "init-agent-md-llm-"));
    try {
      await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node --test" } }));
      const llmContent = "# Agent Instructions\n\n## Project Overview\nLLM wrote this for demo.";
      let captured: AgentMessage[] | undefined;
      const result = await initAgentMd({
        cwd: dir,
        llm: true,
        llmConfig: fakeLlmConfig,
        llmComplete: async (_config, messages) => {
          captured = messages;
          return llmContent;
        },
      });
      assert.equal(result.created, true);
      assert.equal(result.generatedBy, "llm");
      assert.equal(result.llmFallback, false);
      assert.equal(await readFile(path.join(dir, AGENT_FILENAME), "utf8"), llmContent);
      // The user message carries the project snapshot.
      const user = captured?.find((message) => message.role === "user");
      assert.ok(user);
      assert.match(String(user?.content ?? ""), /demo/);
      assert.match(String(user?.content ?? ""), /node --test/);
      // The system prompt constrains the section structure.
      const system = captured?.find((message) => message.role === "system");
      assert.match(String(system?.content ?? ""), /## Testing and Verification/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("strips an outer code fence the model may add", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "init-agent-md-llm-"));
    try {
      const result = await initAgentMd({
        cwd: dir,
        llm: true,
        llmConfig: fakeLlmConfig,
        llmComplete: async () => "```markdown\n# Agent Instructions\n\n## Project Overview\nFenced.\n```\n",
      });
      const content = await readFile(path.join(dir, AGENT_FILENAME), "utf8");
      assert.doesNotMatch(content, /```/);
      assert.match(content, /# Agent Instructions/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the deterministic template when the LLM call fails", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "init-agent-md-llm-"));
    try {
      const result = await initAgentMd({
        cwd: dir,
        llm: true,
        llmConfig: fakeLlmConfig,
        llmComplete: async () => {
          throw new Error("boom");
        },
      });
      assert.equal(result.generatedBy, "template");
      assert.equal(result.llmFallback, true);
      assert.equal(result.created, true);
      const content = await readFile(path.join(dir, AGENT_FILENAME), "utf8");
      assert.match(content, /# Agent Instructions/);
      assert.match(content, /## Project Overview/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back when the LLM returns empty content", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "init-agent-md-llm-"));
    try {
      const result = await initAgentMd({
        cwd: dir,
        llm: true,
        llmConfig: fakeLlmConfig,
        llmComplete: async () => "   ",
      });
      assert.equal(result.llmFallback, true);
      assert.equal(result.generatedBy, "template");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns LLM content without writing when print is set", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "init-agent-md-llm-"));
    try {
      const raw = "# Agent Instructions\n\n## Project Overview\nPrinted by LLM.\n";
      const result = await initAgentMd({
        cwd: dir,
        llm: true,
        print: true,
        llmConfig: fakeLlmConfig,
        llmComplete: async () => raw,
      });
      assert.equal(result.generatedBy, "llm");
      // extractLlmMarkdown trims surrounding whitespace on LLM output.
      assert.equal(result.content, raw.trimEnd());
      await assert.rejects(access(path.join(dir, AGENT_FILENAME)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("respects force overwrite on the LLM path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "init-agent-md-llm-"));
    try {
      await writeFile(path.join(dir, AGENT_FILENAME), "custom instructions");
      const result = await initAgentMd({
        cwd: dir,
        force: true,
        llm: true,
        llmConfig: fakeLlmConfig,
        llmComplete: async () => "# Agent Instructions\n\n## Project Overview\nOverwritten by LLM.\n",
      });
      assert.equal(result.overwritten, true);
      assert.equal(result.generatedBy, "llm");
      assert.match(await readFile(path.join(dir, AGENT_FILENAME), "utf8"), /Overwritten by LLM/);
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
    assert.deepEqual(parseInitCommand("/init"), { kind: "ok", force: false, print: false });
  });

  it("parses /init --force", () => {
    assert.deepEqual(parseInitCommand("/init --force"), { kind: "ok", force: true, print: false });
  });

  it("parses /init --force --print", () => {
    assert.deepEqual(parseInitCommand("/init --force --print"), { kind: "ok", force: true, print: true });
  });

  it("parses /init --print", () => {
    assert.deepEqual(parseInitCommand("/init --print"), { kind: "ok", force: false, print: true });
  });

  it("rejects unknown options with a usage hint", () => {
    const result = parseInitCommand("/init --bogus");
    assert.equal(result?.kind, "error");
    if (result?.kind === "error") {
      assert.match(result.message, /Unknown option/);
      assert.match(result.message, /--print/);
    }
  });

  it("returns null for non-init input", () => {
    assert.equal(parseInitCommand("/help"), null);
    assert.equal(parseInitCommand("hello"), null);
  });
});

describe("/init command registration", () => {
  it("is listed in SLASH_COMMANDS and /help", () => {
    assert.ok(SLASH_COMMANDS.some((command) => command.name === "init"));
    const help = formatHelpNotice();
    assert.match(help, /\/init/);
  });
});
