import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeLlmConfig, type ChatFn } from "../src/llm/index.ts";
import type { AgentMessage, AssistantMessage } from "../src/types.ts";
import type { Tool } from "../src/tools/types.ts";
import {
  AGENT_MD_BEGIN_MARKER,
  AGENT_MD_END_MARKER,
  InitGenerationError,
  extractMarkedAgentMd,
  generateAgentMdWithLlm,
  resolveAgentMdContent,
} from "../src/init-agent.ts";

const dummyLlm = makeLlmConfig({
  apiKey: "test",
  baseUrl: "http://localhost/v1",
  model: "faux",
});

const MARKED_CONTENT = [
  AGENT_MD_BEGIN_MARKER,
  "# Agent Instructions",
  "",
  "## Project Overview",
  "",
  "A demo TypeScript library with a test suite.",
  "",
  "## Development Commands",
  "",
  "Run `npm test` before committing.",
  AGENT_MD_END_MARKER,
].join("\n");

function extractExpectedBody(): string {
  return MARKED_CONTENT.slice(
    MARKED_CONTENT.indexOf(AGENT_MD_BEGIN_MARKER) + AGENT_MD_BEGIN_MARKER.length,
    MARKED_CONTENT.lastIndexOf(AGENT_MD_END_MARKER),
  ).trim();
}

async function makeDemoProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "init-agent-llm-"));
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "demo", scripts: { test: "node --test" } }),
  );
  return dir;
}

/** Faux model: one read tool call, then a final message with marked content. */
function createInitFauxChat(finalText: string): ChatFn {
  let callCount = 0;
  return async (_config, _messages: AgentMessage[], _tools?: Tool[]): Promise<AssistantMessage> => {
    callCount += 1;
    if (callCount === 1) {
      return {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_read_1", name: "read", arguments: { path: "package.json" } }],
      };
    }
    if (callCount === 2) {
      return { role: "assistant", content: finalText };
    }
    throw new Error(`unexpected extra LLM call (#${callCount})`);
  };
}

describe("extractMarkedAgentMd", () => {
  it("extracts content between the markers from the last marked assistant message", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: "still exploring" },
      { role: "assistant", content: `intro text\n${MARKED_CONTENT}\ntrailing` },
    ];
    assert.equal(extractMarkedAgentMd(messages), extractExpectedBody());
  });

  it("returns undefined when no assistant message carries both markers", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: `only begin ${AGENT_MD_BEGIN_MARKER}` },
      { role: "assistant", content: `only end ${AGENT_MD_END_MARKER}` },
    ];
    assert.equal(extractMarkedAgentMd(messages), undefined);
  });

  it("returns undefined when the marked body is too short", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: `${AGENT_MD_BEGIN_MARKER}\nshort\n${AGENT_MD_END_MARKER}` },
    ];
    assert.equal(extractMarkedAgentMd(messages), undefined);
  });
});

describe("generateAgentMdWithLlm", () => {
  it("runs a read-only analysis loop and returns the marked content", async () => {
    const dir = await makeDemoProject();
    try {
      const toolEvents: string[] = [];
      const result = await generateAgentMdWithLlm({
        cwd: dir,
        llm: dummyLlm,
        chat: createInitFauxChat(MARKED_CONTENT),
        onEvent: (event) => {
          if (event.type === "tool_start") toolEvents.push(event.call.name);
        },
      });
      assert.equal(result.content, extractExpectedBody());
      assert.equal(result.model, "faux");
      assert.equal(result.turns, 2);
      assert.deepEqual(toolEvents, ["read"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws InitGenerationError when the model never emits markers", async () => {
    const dir = await makeDemoProject();
    try {
      await assert.rejects(
        generateAgentMdWithLlm({
          cwd: dir,
          llm: dummyLlm,
          chat: createInitFauxChat("no markers in this answer at all"),
        }),
        InitGenerationError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveAgentMdContent", () => {
  it("returns the offline template without calling the model when template is set", async () => {
    const dir = await makeDemoProject();
    try {
      const resolution = await resolveAgentMdContent({
        cwd: dir,
        template: true,
        chat: async () => {
          throw new Error("chat must not be called for --template");
        },
      });
      assert.equal(resolution.source, "template");
      assert.equal(resolution.warning, undefined);
      assert.match(resolution.content, /# Agent Instructions/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns LLM-generated content when the analysis succeeds", async () => {
    const dir = await makeDemoProject();
    try {
      const resolution = await resolveAgentMdContent({
        cwd: dir,
        llm: dummyLlm,
        chat: createInitFauxChat(MARKED_CONTENT),
      });
      assert.equal(resolution.source, "llm");
      assert.equal(resolution.content, extractExpectedBody());
      assert.equal(resolution.warning, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the template with a warning when generation fails", async () => {
    const dir = await makeDemoProject();
    try {
      const resolution = await resolveAgentMdContent({
        cwd: dir,
        llm: dummyLlm,
        chat: async () => {
          throw new Error("provider exploded");
        },
      });
      assert.equal(resolution.source, "template");
      assert.match(resolution.warning ?? "", /LLM generation failed/);
      assert.match(resolution.warning ?? "", /provider exploded/);
      assert.match(resolution.content, /# Agent Instructions/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the template when no usable LLM provider is configured", async () => {
    const dir = await makeDemoProject();
    const savedEnv: Record<string, string | undefined> = {};
    const keys = [
      "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
      "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY",
      "GROQ_API_KEY", "XAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
      "MINI_AGENT_PROFILE", "MINI_AGENT_RELAY",
    ];
    for (const key of keys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    try {
      // Without credentials the loader either throws (warning: "No LLM
      // provider configured") or returns an unusable config whose first
      // request fails (warning: "LLM generation failed"); both routes must
      // land on the template fallback.
      const resolution = await resolveAgentMdContent({ cwd: dir });
      assert.equal(resolution.source, "template");
      assert.match(resolution.warning ?? "", /No LLM provider configured|LLM generation failed/);
      assert.match(resolution.content, /# Agent Instructions/);
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
