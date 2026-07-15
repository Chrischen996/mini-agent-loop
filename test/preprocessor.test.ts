import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractVisionAnalysisParts,
  imagePart,
  messagesHaveImages,
} from "../src/content.ts";
import {
  makeLlmConfig,
  prepareMessagesForModel,
  toOpenAIMessages,
} from "../src/llm.ts";
import { runAgentLoop } from "../src/loop.ts";
import { resolveModel } from "../src/models.ts";
import {
  completeVisionAnalysis,
  createVisionPreprocessor,
  loadVisionConfigFromEnv,
  type VisionAnalyzeFn,
  type VisionConfig,
} from "../src/preprocessors/index.ts";
import type { Tool } from "../src/tools/types.ts";
import type { AgentMessage, AssistantMessage } from "../src/types.ts";

const visionConfig: VisionConfig = {
  provider: "openai-compatible",
  apiKey: "vision-test-key",
  baseUrl: "https://vision.example/v1",
  model: "vision-test-model",
  timeoutMs: 60_000,
  retries: 1,
  retryDelayMs: 0,
};

const deepseekLlm = makeLlmConfig({
  apiKey: "deepseek-test-key",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
});

const deepseekContext = {
  userPrompt: "analyze the images",
  targetModel: resolveModel("deepseek-chat"),
};

const ANALYSIS = [
  "## Summary",
  "Two related screenshots.",
  "## Visible Text",
  "Example",
  "## Objects or UI",
  "A dialog",
  "## Relationships",
  "The second follows the first.",
  "## Uncertainty",
  "None",
].join("\n");

describe("VisionPreprocessor", () => {
  it("does not call vision for text-only batches", async () => {
    let calls = 0;
    const preprocessor = createVisionPreprocessor(visionConfig, async () => {
      calls += 1;
      return ANALYSIS;
    });
    const messages: AgentMessage[] = [{ role: "user", content: "hello" }];

    const result = await preprocessor.process(messages, deepseekContext);
    assert.equal(calls, 0);
    assert.equal(result, messages);
  });

  it("does not preprocess images for a vision-capable main model", async () => {
    let calls = 0;
    const preprocessor = createVisionPreprocessor(visionConfig, async () => {
      calls += 1;
      return ANALYSIS;
    });
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [imagePart("image/png", "aW1hZ2U=", "shot.png")],
      },
    ];

    const result = await preprocessor.process(messages, {
      userPrompt: "describe",
      targetModel: resolveModel("gpt-4o-mini"),
    });
    assert.equal(calls, 0);
    assert.equal(result, messages);
  });

  it("analyzes multiple images once and removes pixels at DeepSeek boundary", async () => {
    let calls = 0;
    let receivedSources: string[] = [];
    const analyze: VisionAnalyzeFn = async (_config, input) => {
      calls += 1;
      receivedSources = input.images.map((image) => image.source ?? "");
      return ANALYSIS;
    };
    const preprocessor = createVisionPreprocessor(visionConfig, analyze);
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [
          imagePart("image/png", "Zmlyc3Q=", "first.png"),
          imagePart("image/jpeg", "c2Vjb25k", "second.jpg"),
        ],
      },
    ];

    const enriched = await preprocessor.process(messages, deepseekContext);
    assert.equal(calls, 1);
    assert.deepEqual(receivedSources, ["first.png", "second.jpg"]);
    assert.equal(messagesHaveImages(enriched), true);

    const user = enriched[0];
    assert.equal(user?.role, "user");
    if (!user || user.role !== "user") return;
    const analyses = extractVisionAnalysisParts(user.content);
    assert.equal(analyses.length, 1);
    assert.deepEqual(analyses[0]?.sources, ["first.png", "second.jpg"]);

    const prepared = prepareMessagesForModel(enriched, deepseekLlm);
    assert.equal(messagesHaveImages(prepared.messages), false);
    const wire = JSON.stringify(toOpenAIMessages(prepared.messages, false));
    assert.doesNotMatch(wire, /image_url|Zmlyc3Q=|c2Vjb25k/);
    assert.match(wire, /Two related screenshots/);
  });

  it("fails on an empty analysis", async () => {
    const preprocessor = createVisionPreprocessor(
      visionConfig,
      async () => "   ",
    );
    await assert.rejects(
      () =>
        preprocessor.process(
          [
            {
              role: "user",
              content: [imagePart("image/png", "aW1hZ2U=", "shot.png")],
            },
          ],
          deepseekContext,
        ),
      /empty analysis/,
    );
  });
});

describe("vision preprocessing in runAgentLoop", () => {
  it("runs vision before the first DeepSeek call for user images", async () => {
    const order: string[] = [];
    const preprocessor = createVisionPreprocessor(visionConfig, async () => {
      order.push("vision");
      return ANALYSIS;
    });
    const chat = async (
      _config: typeof deepseekLlm,
      messages: AgentMessage[],
    ): Promise<AssistantMessage> => {
      order.push("deepseek");
      const user = messages.find((message) => message.role === "user");
      assert.ok(user && user.role === "user");
      if (user?.role === "user") {
        assert.equal(extractVisionAnalysisParts(user.content).length, 1);
      }
      return { role: "assistant", content: "done" };
    };

    await runAgentLoop("describe", {
      llm: deepseekLlm,
      tools: [],
      chat,
      preprocessors: [preprocessor],
      userContent: [imagePart("image/png", "aW1hZ2U=", "shot.png")],
    });

    assert.deepEqual(order, ["vision", "deepseek"]);
  });

  it("batches all image tool results before the next DeepSeek call", async () => {
    const order: string[] = [];
    let analyzedImages = 0;
    const preprocessor = createVisionPreprocessor(
      visionConfig,
      async (_config, input) => {
        order.push("vision");
        analyzedImages = input.images.length;
        return ANALYSIS;
      },
    );
    const imageTool: Tool = {
      name: "image",
      description: "Return a test image",
      parameters: {
        type: "object",
        properties: { source: { type: "string" } },
        required: ["source"],
        additionalProperties: false,
      },
      async execute(args) {
        const source = String(args.source);
        return {
          content: [imagePart("image/png", "aW1hZ2U=", source)],
        };
      },
    };
    let chatCalls = 0;
    const chat = async (
      _config: typeof deepseekLlm,
      messages: AgentMessage[],
    ): Promise<AssistantMessage> => {
      chatCalls += 1;
      order.push(`deepseek-${chatCalls}`);
      if (chatCalls === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "one", name: "image", arguments: { source: "one.png" } },
            { id: "two", name: "image", arguments: { source: "two.png" } },
          ],
        };
      }
      const toolMessages = messages.filter((message) => message.role === "tool");
      assert.equal(toolMessages.length, 2);
      assert.equal(
        toolMessages.flatMap((message) =>
          message.role === "tool"
            ? extractVisionAnalysisParts(message.content)
            : [],
        ).length,
        1,
      );
      return { role: "assistant", content: "images analyzed" };
    };

    await runAgentLoop("read both images", {
      llm: deepseekLlm,
      tools: [imageTool],
      chat,
      preprocessors: [preprocessor],
    });

    assert.equal(analyzedImages, 2);
    assert.deepEqual(order, ["deepseek-1", "vision", "deepseek-2"]);
  });

  it("does not call DeepSeek when vision preprocessing fails", async () => {
    let chatCalls = 0;
    const preprocessor = createVisionPreprocessor(visionConfig, async () => {
      throw new Error("service unavailable");
    });

    await assert.rejects(
      () =>
        runAgentLoop("describe", {
          llm: deepseekLlm,
          tools: [],
          preprocessors: [preprocessor],
          userContent: [imagePart("image/png", "aW1hZ2U=", "shot.png")],
          chat: async () => {
            chatCalls += 1;
            return { role: "assistant", content: "must not run" };
          },
        }),
      /Vision preprocessing failed.*service unavailable/,
    );
    assert.equal(chatCalls, 0);
  });
});

describe("vision configuration and transport", () => {
  it("rejects partially configured vision environment", () => {
    const names = [
      "VISION_PROVIDER",
      "VISION_API_KEY",
      "VISION_BASE_URL",
      "VISION_MODEL",
      "ZHIPU_API_KEY",
    ] as const;
    const previous = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );
    try {
      process.env.VISION_API_KEY = "key";
      delete process.env.VISION_BASE_URL;
      delete process.env.VISION_MODEL;
      assert.throws(loadVisionConfigFromEnv, /Incomplete vision configuration/);

      delete process.env.VISION_API_KEY;
      assert.equal(loadVisionConfigFromEnv(), undefined);

      process.env.VISION_PROVIDER = "zhipu";
      process.env.ZHIPU_API_KEY = "zhipu-key";
      const zhipu = loadVisionConfigFromEnv();
      assert.equal(zhipu?.provider, "zhipu");
      assert.equal(zhipu?.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
      assert.equal(zhipu?.model, "glm-4v-plus");
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("retries a transient Zhipu busy response once", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify({ error: { code: "1305", message: "busy" } }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: ANALYSIS } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const result = await completeVisionAnalysis(
        { ...visionConfig, retries: 1, retryDelayMs: 0 },
        {
          prompt: "describe",
          images: [imagePart("image/png", "aW1hZ2U=", "shot.png")],
        },
      );
      assert.equal(calls, 2);
      assert.equal(result, ANALYSIS);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("aborts a vision request at the configured timeout", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (_input, init) => {
      calls += 1;
      return await new Promise<Response>((_resolve, reject) => {
        const keepAlive = setTimeout(
          () => reject(new Error("abort signal did not fire")),
          1_000,
        );
        const signal = init?.signal;
        if (!signal) {
          clearTimeout(keepAlive);
          reject(new Error("missing abort signal"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(keepAlive);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    }) as typeof fetch;

    try {
      await assert.rejects(
        () =>
          completeVisionAnalysis(
            { ...visionConfig, timeoutMs: 5, retries: 1 },
            {
              prompt: "describe",
              images: [imagePart("image/png", "aW1hZ2U=", "shot.png")],
            },
          ),
        /Vision network error/,
      );
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
