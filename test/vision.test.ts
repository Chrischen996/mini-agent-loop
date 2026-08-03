import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import { imagePart, messagesHaveImages, textPart } from "../src/content.ts";
import {
  loadLlmConfigFromEnv,
  makeLlmConfig,
  prepareMessagesForModel,
} from "../src/llm/index.ts";
import type { AgentMessage } from "../src/types.ts";

const visionLlm = makeLlmConfig({
  apiKey: "test-key",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
});

describe("vision message preparation", () => {
  it("appends tool images after every result in the tool block", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "test" },
      { role: "user", content: "read two files" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "image-call", name: "read", arguments: { path: "a.png" } },
          { id: "text-call", name: "read", arguments: { path: "a.txt" } },
        ],
      },
      {
        role: "tool",
        toolCallId: "image-call",
        name: "read",
        content: [
          textPart("image metadata"),
          imagePart("image/png", "aGVsbG8=", "a.png"),
        ],
      },
      {
        role: "tool",
        toolCallId: "text-call",
        name: "read",
        content: "text result",
      },
    ];

    const prepared = prepareMessagesForModel(messages, visionLlm);
    assert.deepEqual(
      prepared.messages.map((message) => message.role),
      ["system", "user", "assistant", "tool", "tool", "user"],
    );
    assert.equal(prepared.messages[3]?.role, "tool");
    assert.equal(prepared.messages[4]?.role, "tool");
    assert.equal(prepared.messages[5]?.role, "user");
    assert.equal(messagesHaveImages(prepared.messages), true);
  });

  it("replaces images for a non-vision model by default", () => {
    const config = makeLlmConfig({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
    });
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [imagePart("image/png", "aGVsbG8=", "a.png")],
      },
    ];

    const prepared = prepareMessagesForModel(messages, config);
    assert.equal(messagesHaveImages(prepared.messages), false);
    const user = prepared.messages[0];
    assert.equal(user?.role, "user");
    if (!user || user.role !== "user") return;
    assert.match(String(user.content), /Image omitted.*deepseek-chat/);
  });
});

describe("LLM environment config", () => {
  it("selects the API key declared by the resolved provider", () => {
    const names = [
      "OPENAI_API_KEY",
      "DEEPSEEK_API_KEY",
      "OPENAI_MODEL",
      "OPENAI_BASE_URL",
    ] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));

    try {
      // Clear all possible API keys to ensure proper test isolation
      const keysToClear = [
        "AGNES_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY",
        "ZHIPU_API_KEY", "DASHSCOPE_API_KEY", "GEMINI_API_KEY",
        "MOONSHOT_API_KEY", "XAI_API_KEY", "MISTRAL_API_KEY",
        "GROQ_API_KEY", "OPENROUTER_API_KEY", "SILICONFLOW_API_KEY",
        "MINI_AGENT_PROFILE",
        "MINI_AGENT_MODEL_CONFIG",
      ] as const;
      const previousKeys = Object.fromEntries(
        keysToClear.map((k) => [k, process.env[k]])
      );
      for (const k of keysToClear) delete process.env[k];
      
      // Point to an empty profile store to avoid reading user's ~/.mini-agent/models.json
      const tmpConfig = JSON.stringify({ version: 1, profiles: {} });
      const tmpPath = os.tmpdir() + '/mini-agent-test-models.json';
      writeFileSync(tmpPath, tmpConfig);
      process.env.MINI_AGENT_MODEL_CONFIG = tmpPath;

      process.env.OPENAI_API_KEY = "openai-key";
      process.env.DEEPSEEK_API_KEY = "deepseek-key";
      delete process.env.OPENAI_BASE_URL;

      assert.equal(loadLlmConfigFromEnv().apiKey, "deepseek-key");

      process.env.OPENAI_MODEL = "gpt-4o-mini";
      assert.equal(loadLlmConfigFromEnv().apiKey, "openai-key");
      
      // Cleanup
      unlinkSync(tmpPath);
      
      // Restore keys
      for (const k of keysToClear) {
        const val = previousKeys[k];
        if (val === undefined) delete process.env[k];
        else process.env[k] = val;
      }
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
