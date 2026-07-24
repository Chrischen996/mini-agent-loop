import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseHermesResponse,
  createHermesStreamState,
  feedHermesChunk,
  finalizeHermesStream,
} from "../src/hermes/parser.ts";
import {
  postProcessAssistantResponse,
  convertHermesResponse,
  shouldEmbedToolsInPrompt,
  prepareSystemPrompt,
} from "../src/hermes/format-adapter.ts";
import {
  buildHermesSystemPrompt,
  formatToolResultForHermes,
} from "../src/hermes/system-prompt.ts";
import type { Tool } from "../src/tools/types.ts";
import type { AssistantMessage } from "../src/types.ts";

// ─── Parser: complete (non-streaming) ─────────────────────────────────────────

describe("parseHermesResponse", () => {
  it("extracts a single tool_call", () => {
    const raw = `<tool_call>
{"name": "read", "arguments": {"path": "package.json"}}
</tool_call>`;
    const result = parseHermesResponse(raw);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0]!.name, "read");
    assert.deepEqual(result.toolCalls[0]!.arguments, { path: "package.json" });
    assert.equal(result.text, "");
    assert.equal(result.thinking, "");
    assert.equal(result.errors.length, 0);
  });

  it("extracts multiple tool_calls", () => {
    const raw = `Let me read both files.
<tool_call>
{"name": "read", "arguments": {"path": "a.txt"}}
</tool_call>
<tool_call>
{"name": "read", "arguments": {"path": "b.txt"}}
</tool_call>`;
    const result = parseHermesResponse(raw);
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0]!.name, "read");
    assert.equal(result.toolCalls[1]!.name, "read");
    assert.deepEqual(result.toolCalls[0]!.arguments, { path: "a.txt" });
    assert.deepEqual(result.toolCalls[1]!.arguments, { path: "b.txt" });
    assert.equal(result.text, "Let me read both files.");
  });

  it("extracts thinking blocks", () => {
    const raw = `<think>
I need to read the file first.
</think>
Here is my answer.`;
    const result = parseHermesResponse(raw);
    assert.equal(result.thinking, "I need to read the file first.");
    assert.equal(result.text, "Here is my answer.");
    assert.equal(result.toolCalls.length, 0);
  });

  it("handles <thinking> tag variant", () => {
    const raw = `<thinking>Analyzing the request</thinking>
The answer is 42.`;
    const result = parseHermesResponse(raw);
    assert.equal(result.thinking, "Analyzing the request");
    assert.equal(result.text, "The answer is 42.");
  });

  it("handles mixed content: text + thinking + tool_call", () => {
    const raw = `<think>Let me check the file first.</think>
I'll read the configuration.
<tool_call>
{"name": "read", "arguments": {"path": "config.json"}}
</tool_call>`;
    const result = parseHermesResponse(raw);
    assert.equal(result.thinking, "Let me check the file first.");
    assert.equal(result.text, "I'll read the configuration.");
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0]!.name, "read");
  });

  it("handles plain text without any special blocks", () => {
    const raw = "Just a regular response with no tools or thinking.";
    const result = parseHermesResponse(raw);
    assert.equal(result.text, "Just a regular response with no tools or thinking.");
    assert.equal(result.thinking, "");
    assert.equal(result.toolCalls.length, 0);
    assert.equal(result.errors.length, 0);
  });

  it("reports error for malformed JSON in tool_call", () => {
    const raw = `<tool_call>
not valid json
</tool_call>`;
    const result = parseHermesResponse(raw);
    assert.equal(result.toolCalls.length, 0);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0]!.includes("Invalid JSON"));
  });

  it("reports error for tool_call missing name field", () => {
    const raw = `<tool_call>
{"arguments": {"path": "file.txt"}}
</tool_call>`;
    const result = parseHermesResponse(raw);
    assert.equal(result.toolCalls.length, 0);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0]!.includes("missing \"name\""));
  });

  it("handles flat format (no arguments wrapper)", () => {
    const raw = `<tool_call>
{"name": "read", "path": "file.txt", "offset": 0}
</tool_call>`;
    const result = parseHermesResponse(raw);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0]!.name, "read");
    assert.deepEqual(result.toolCalls[0]!.arguments, { path: "file.txt", offset: 0 });
  });

  it("handles stringified arguments", () => {
    const raw = `<tool_call>
{"name": "bash", "arguments": "{\\"command\\": \\"ls -la\\"}"}
</tool_call>`;
    const result = parseHermesResponse(raw);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0]!.name, "bash");
    assert.deepEqual(result.toolCalls[0]!.arguments, { command: "ls -la" });
  });

  it("handles unclosed tool_call tag", () => {
    const raw = `<tool_call>
{"name": "read", "arguments": {"path": "file.txt"}}`;
    const result = parseHermesResponse(raw);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0]!.includes("Unclosed"));
  });

  it("handles unclosed thinking tag gracefully", () => {
    const raw = `<think>I'm still thinking...`;
    const result = parseHermesResponse(raw);
    assert.equal(result.thinking, "I'm still thinking...");
    assert.equal(result.text, "");
  });

  it("handles empty response", () => {
    const result = parseHermesResponse("");
    assert.equal(result.text, "");
    assert.equal(result.thinking, "");
    assert.equal(result.toolCalls.length, 0);
    assert.equal(result.errors.length, 0);
  });

  it("extracts JSON from surrounding text in tool_call", () => {
    const raw = `<tool_call>
Sure, here's the call: {"name": "read", "arguments": {"path": "test.txt"}}
</tool_call>`;
    const result = parseHermesResponse(raw);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0]!.name, "read");
  });

  it("handles multiple thinking blocks", () => {
    const raw = `<think>First thought.</think>
Some text.
<think>Second thought.</think>
More text.`;
    const result = parseHermesResponse(raw);
    assert.ok(result.thinking.includes("First thought."));
    assert.ok(result.thinking.includes("Second thought."));
    assert.ok(result.text.includes("Some text."));
    assert.ok(result.text.includes("More text."));
  });
});

// ─── Parser: streaming (incremental) ──────────────────────────────────────────

describe("streaming Hermes parser", () => {
  it("handles complete response in one chunk", () => {
    const state = createHermesStreamState();
    const result = feedHermesChunk(
      state,
      `<tool_call>\n{"name": "read", "arguments": {"path": "a.txt"}}\n</tool_call>`,
    );
    assert.equal(result.completedToolCalls.length, 1);
    assert.equal(result.completedToolCalls[0]!.name, "read");
    assert.equal(result.textDelta, "");
  });

  it("handles tool_call split across chunks", () => {
    const state = createHermesStreamState();

    const r1 = feedHermesChunk(state, "<tool_ca");
    assert.equal(r1.completedToolCalls.length, 0);
    assert.equal(r1.textDelta, "");

    const r2 = feedHermesChunk(state, 'll>\n{"name": "read", "arguments": {"path": "x.txt"}}\n</tool_');
    assert.equal(r2.completedToolCalls.length, 0);

    const r3 = feedHermesChunk(state, "call>");
    assert.equal(r3.completedToolCalls.length, 1);
    assert.equal(r3.completedToolCalls[0]!.name, "read");
  });

  it("emits text deltas for plain content", () => {
    const state = createHermesStreamState();
    const r1 = feedHermesChunk(state, "Hello ");
    assert.equal(r1.textDelta, "Hello ");

    const r2 = feedHermesChunk(state, "world!");
    assert.equal(r2.textDelta, "world!");

    const final = finalizeHermesStream(state);
    assert.equal(final.text, "Hello world!");
  });

  it("emits thinking deltas", () => {
    const state = createHermesStreamState();

    const r1 = feedHermesChunk(state, "<think>First ");
    assert.equal(r1.thinkingDelta, "First ");
    assert.equal(r1.textDelta, "");

    const r2 = feedHermesChunk(state, "thought.</think>Answer.");
    assert.equal(r2.thinkingDelta, "thought.");
    assert.equal(r2.textDelta, "Answer.");

    const final = finalizeHermesStream(state);
    assert.equal(final.thinking, "First thought.");
    assert.equal(final.text, "Answer.");
  });

  it("handles interleaved text and tool_calls across chunks", () => {
    const state = createHermesStreamState();

    feedHermesChunk(state, "I'll read the file. ");
    feedHermesChunk(state, '<tool_call>\n{"name": "read", "arguments": {"path": "test.txt"}}\n</tool_call>');
    feedHermesChunk(state, " Done.");

    const final = finalizeHermesStream(state);
    assert.equal(final.toolCalls.length, 1);
    assert.ok(final.text.includes("I'll read the file."));
    assert.ok(final.text.includes("Done."));
  });

  it("finalizes with remaining buffer as text", () => {
    const state = createHermesStreamState();
    feedHermesChunk(state, "Incomplete ");
    const final = finalizeHermesStream(state);
    assert.equal(final.text, "Incomplete");
  });

  it("handles unclosed tool_call at end of stream", () => {
    const state = createHermesStreamState();
    feedHermesChunk(state, '<tool_call>\n{"name": "read", "arguments": {"path": "x"}}');
    const final = finalizeHermesStream(state);
    assert.ok(final.errors.some((e) => e.includes("Unclosed")));
    // Should still attempt to parse the incomplete tool call
    assert.equal(final.toolCalls.length, 1);
  });
});

// ─── Format adapter ──────────────────────────────────────────────────────────

describe("format-adapter", () => {
  it("shouldEmbedToolsInPrompt returns true for hermes", () => {
    assert.equal(shouldEmbedToolsInPrompt("hermes"), true);
    assert.equal(shouldEmbedToolsInPrompt("openai"), false);
  });

  it("prepareSystemPrompt embeds tools for hermes format", () => {
    const tool: Tool = {
      name: "read",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      execute: async () => ({ content: "" }),
    };
    const prompt = prepareSystemPrompt("You are an assistant.", [tool], "hermes");
    assert.ok(prompt.includes("<tools>"));
    assert.ok(prompt.includes("</tools>"));
    assert.ok(prompt.includes('"name": "read"'));
    assert.ok(prompt.includes("<tool_call>"));
  });

  it("prepareSystemPrompt returns base prompt unchanged for openai format", () => {
    const tool: Tool = {
      name: "read",
      description: "Read a file",
      parameters: {},
      execute: async () => ({ content: "" }),
    };
    const prompt = prepareSystemPrompt("You are an assistant.", [tool], "openai");
    assert.equal(prompt, "You are an assistant.");
  });

  it("postProcessAssistantResponse passes through openai format unchanged", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: "Hello",
      toolCalls: [{ id: "tc1", name: "read", arguments: { path: "a.txt" } }],
    };
    const result = postProcessAssistantResponse(msg, "openai");
    assert.deepEqual(result.message, msg);
    assert.equal(result.reasoning, "");
    assert.equal(result.errors.length, 0);
  });

  it("postProcessAssistantResponse extracts hermes tool_calls from text", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: `<think>Need to check the file.</think>
I'll read it now.
<tool_call>
{"name": "read", "arguments": {"path": "package.json"}}
</tool_call>`,
    };
    const result = postProcessAssistantResponse(msg, "hermes");
    assert.equal(result.message.content, "I'll read it now.");
    assert.equal(result.message.toolCalls?.length, 1);
    assert.equal(result.message.toolCalls![0]!.name, "read");
    assert.equal(result.reasoning, "Need to check the file.");
    assert.equal(result.errors.length, 0);
  });

  it("postProcessAssistantResponse preserves existing toolCalls for hermes", () => {
    // If a hermes model somehow returns structured tool_calls, prefer them
    const msg: AssistantMessage = {
      role: "assistant",
      content: "Some text",
      toolCalls: [{ id: "tc1", name: "bash", arguments: { command: "ls" } }],
    };
    const result = postProcessAssistantResponse(msg, "hermes");
    assert.deepEqual(result.message, msg);
  });

  it("convertHermesResponse generates unique IDs", () => {
    const raw = `<tool_call>
{"name": "read", "arguments": {"path": "a.txt"}}
</tool_call>
<tool_call>
{"name": "read", "arguments": {"path": "b.txt"}}
</tool_call>`;
    const result = convertHermesResponse(raw);
    assert.equal(result.message.toolCalls?.length, 2);
    const ids = result.message.toolCalls!.map((tc) => tc.id);
    assert.notEqual(ids[0], ids[1]); // IDs should be unique
    assert.ok(ids[0]!.startsWith("hermes_"));
    assert.ok(ids[1]!.startsWith("hermes_"));
  });
});

// ─── System prompt builder ───────────────────────────────────────────────────

describe("buildHermesSystemPrompt", () => {
  it("builds prompt with tool descriptions", () => {
    const tools: Tool[] = [
      {
        name: "read",
        description: "Read a workspace file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        execute: async () => ({ content: "" }),
      },
      {
        name: "write",
        description: "Write a file",
        parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
        execute: async () => ({ content: "" }),
      },
    ];

    const prompt = buildHermesSystemPrompt({
      basePrompt: "You are a helpful assistant.",
      tools,
    });

    assert.ok(prompt.startsWith("You are a helpful assistant."));
    assert.ok(prompt.includes("<tools>"));
    assert.ok(prompt.includes("</tools>"));
    assert.ok(prompt.includes("<tool>"));
    assert.ok(prompt.includes("</tool>"));
    assert.ok(prompt.includes('"name": "read"'));
    assert.ok(prompt.includes('"name": "write"'));
    assert.ok(prompt.includes("<tool_call>"));
    assert.ok(prompt.includes("</tool_call>"));
    assert.ok(prompt.includes("<think>"));
  });

  it("skips tool section when no tools provided", () => {
    const prompt = buildHermesSystemPrompt({
      basePrompt: "You are a helpful assistant.",
      tools: [],
    });
    assert.equal(prompt, "You are a helpful assistant.");
  });

  it("includes additional instructions when provided", () => {
    const prompt = buildHermesSystemPrompt({
      basePrompt: "Base.",
      tools: [],
      additionalInstructions: "Be concise.",
    });
    assert.ok(prompt.includes("Base."));
    assert.ok(prompt.includes("Be concise."));
  });
});

describe("formatToolResultForHermes", () => {
  it("wraps success result in tool_response tags", () => {
    const result = formatToolResultForHermes("read", "file content here", false);
    assert.ok(result.includes("<tool_response>"));
    assert.ok(result.includes("</tool_response>"));
    assert.ok(result.includes("Tool: read"));
    assert.ok(result.includes("file content here"));
  });

  it("wraps error result in tool_error tags", () => {
    const result = formatToolResultForHermes("bash", "command not found", true);
    assert.ok(result.includes("<tool_error>"));
    assert.ok(result.includes("</tool_error>"));
    assert.ok(result.includes("Tool: bash"));
    assert.ok(result.includes("command not found"));
  });
});
