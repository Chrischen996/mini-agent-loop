import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cleanThinkingPrompt,
  buildIntenseLlm,
  clampThinkingLevelForModel,
  cycleThinkingLevel,
  getDefaultIntensity,
  getDefaultThinkingLevel,
  getThinkingLevelChoices,
  intensityToModelThinkingLevel,
  parseThinkingIntensityCommand,
  parseThinkingCommandMode,
  parseThinkingIntensityPrompt,
  stripThinkingIntensityCommands,
  supportsThinkingOff,
  thinkingLevelToDisplay,
} from "../src/think-intensity.ts";

describe("thinking intensity parsing", () => {
  it("accepts only standalone canonical commands", () => {
    assert.equal(parseThinkingIntensityCommand("/think:low do this"), "low");
    assert.equal(parseThinkingIntensityCommand("  /THINK:MED do this"), "med");
    assert.equal(parseThinkingIntensityCommand("do this /think:high"), null);
    assert.equal(parseThinkingIntensityCommand("/think:xhigh"), "xhigh");
    assert.equal(parseThinkingIntensityCommand("/think:off do this"), "off");
    assert.equal(parseThinkingIntensityCommand("/think:highest do this"), null);
    assert.equal(parseThinkingIntensityCommand("prefix/think:high do this"), null);
    assert.equal(parseThinkingIntensityCommand("thinking:high is ordinary text"), null);
  });

  it("recognizes and removes the adaptive command", () => {
    assert.equal(parseThinkingCommandMode("/think:auto investigate the failure"), "adaptive");
    assert.equal(parseThinkingIntensityCommand("/think:auto investigate the failure"), null);
    assert.equal(stripThinkingIntensityCommands("/think:auto investigate the failure"), "investigate the failure");
    assert.equal(parseThinkingCommandMode("investigate /think:auto"), null);
  });

  it("removes commands while retaining the user prompt", () => {
    assert.equal(stripThinkingIntensityCommands("/think:high fix the parser"), "fix the parser");
    assert.equal(cleanThinkingPrompt("fix the parser /think:low"), "fix the parser /think:low");
    assert.equal(stripThinkingIntensityCommands("/think:med   fix\tthis"), "fix\tthis");
    assert.equal(stripThinkingIntensityCommands("/think:xhigh"), "");
    assert.equal(stripThinkingIntensityCommands("ordinary /think:highest text"), "ordinary /think:highest text");
  });

  it("returns the intensity and cleaned prompt together", () => {
    assert.deepEqual(parseThinkingIntensityPrompt("/think:xhigh investigate this"), {
      intensity: "xhigh",
      prompt: "investigate this",
    });
    assert.deepEqual(parseThinkingIntensityPrompt("ordinary request"), {
      intensity: null,
      prompt: "ordinary request",
    });
  });

  it("parses an explicit thinking-off command", () => {
    assert.deepEqual(parseThinkingIntensityPrompt("/think:off answer directly"), {
      intensity: "off",
      prompt: "answer directly",
    });
  });

  it("does not classify ordinary text containing thinking words as a command", () => {
    const prompt = "Explain why thinking:high is not a valid command or /think:highest.";
    assert.equal(parseThinkingIntensityCommand(prompt), null);
    assert.equal(stripThinkingIntensityCommands(prompt), prompt);
  });
});

describe("thinking intensity model levels", () => {
  it("maps user-facing levels to ModelThinkingLevel values", () => {
    assert.equal(intensityToModelThinkingLevel("low"), "low");
    assert.equal(intensityToModelThinkingLevel("med"), "medium");
    assert.equal(intensityToModelThinkingLevel("high"), "high");
    assert.equal(intensityToModelThinkingLevel("xhigh"), "xhigh");
  });

  it("changes only thinkingLevel in the LLM config", () => {
    const base = {
      apiKey: "key",
      provider: "custom",
      baseUrl: "https://example.test/v1",
      model: "existing-model",
      capabilities: { input: ["text"] as Array<"text" | "image">, tools: true },
      contextWindow: 1000,
      maxTokens: 500,
      reasoning: true,
      imagePolicy: "placeholder" as const,
      toolCallFormat: "openai" as const,
    };
    const next = buildIntenseLlm(base, "high");
    assert.equal(next.thinkingLevel, "high");
    assert.equal(next.model, base.model);
    assert.equal(next.maxTokens, base.maxTokens);
    assert.deepEqual(next.capabilities, base.capabilities);
  });

  it("uses balanced/medium as the default and honors a valid override", () => {
    assert.equal(getDefaultIntensity({}), "med");
    assert.equal(getDefaultThinkingLevel({}), "medium");
    assert.equal(getDefaultIntensity({ DEFAULT_THINKING_INTENSITY: "high" }), "high");
    assert.equal(getDefaultThinkingLevel({ DEFAULT_THINKING_INTENSITY: "xhigh" }), "xhigh");
    assert.equal(getDefaultIntensity({ DEFAULT_THINKING_INTENSITY: "unsupported" }), "med");
  });

  it("cycles supported levels directly without wrapping", () => {
    const config = { reasoning: true, piModel: undefined, thinkingLevel: "medium" as const };
    assert.deepEqual(getThinkingLevelChoices(config), ["minimal", "low", "medium", "high"]);
    assert.equal(cycleThinkingLevel(config, "increase"), "high");
    assert.equal(cycleThinkingLevel(config, "decrease"), "low");
    assert.equal(cycleThinkingLevel({ ...config, thinkingLevel: "max" }, "increase"), "minimal");
    assert.equal(cycleThinkingLevel({ ...config, thinkingLevel: "minimal" }, "decrease"), "minimal");
    assert.equal(thinkingLevelToDisplay("xhigh"), "极高");
  });

  it("supports a one-key wrapped cycle for quick switching", () => {
    const config = { reasoning: true, piModel: undefined, thinkingLevel: "high" as const };
    assert.equal(cycleThinkingLevel(config, "increase", { wrap: true }), "minimal");
    assert.equal(cycleThinkingLevel({ ...config, thinkingLevel: "minimal" }, "decrease", { wrap: true }), "high");
  });

  it("keeps non-reasoning models disabled", () => {
    const config = { reasoning: false, piModel: undefined, thinkingLevel: "off" as const };
    assert.deepEqual(getThinkingLevelChoices(config), ["off"]);
    assert.equal(cycleThinkingLevel(config, "increase"), "off");
    assert.equal(cycleThinkingLevel(config, "decrease"), "off");
  });

  it("does not claim that direct xAI reasoning models support thinking off", () => {
    assert.equal(supportsThinkingOff({
      reasoning: true,
      provider: "xai",
      baseUrl: "https://api.x.ai/v1",
      compat: { supportsReasoningEffort: false },
      piModel: undefined,
    }), false);
    assert.equal(supportsThinkingOff({
      reasoning: true,
      provider: "custom",
      baseUrl: "https://gateway.example/v1",
      compat: {},
      piModel: undefined,
    }), true);
  });

  it("uses Pi's extended-level capability semantics when clamping", () => {
    const config = {
      reasoning: true,
      piModel: {
        thinkingLevelMap: {
          xhigh: null,
          max: null,
        },
      },
    } as Parameters<typeof getThinkingLevelChoices>[0];
    assert.deepEqual(getThinkingLevelChoices(config), ["minimal", "low", "medium", "high"]);
    assert.equal(clampThinkingLevelForModel(config, "xhigh"), "high");

    const explicitMax = {
      reasoning: true,
      piModel: { thinkingLevelMap: { xhigh: null, max: "max" } },
    } as Parameters<typeof getThinkingLevelChoices>[0];
    assert.deepEqual(getThinkingLevelChoices(explicitMax), ["minimal", "low", "medium", "high", "max"]);
    assert.equal(clampThinkingLevelForModel(explicitMax, "xhigh"), "max");
  });
});
