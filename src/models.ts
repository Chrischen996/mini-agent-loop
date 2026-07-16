export type ModelCapabilities = {
  input: Array<"text" | "image">;
  tools: boolean;
};

export type ModelRef = {
  id: string;
  provider: "openai-compatible";
  baseUrl: string;
  apiKeyEnv: string[];
  capabilities: ModelCapabilities;
  /** Approximate max context tokens for UI display. */
  contextWindow: number;
};

export type ImagePolicy = "placeholder" | "fail" | "strip";

/**
 * Teaching registry: capabilities are data, not scattered if (deepseek) branches.
 * DeepSeek cannot see images → input is text-only.
 */
export const MODEL_REGISTRY: Record<string, ModelRef> = {
  "deepseek-chat": {
    id: "deepseek-chat",
    provider: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: ["DEEPSEEK_API_KEY", "OPENAI_API_KEY"],
    capabilities: { input: ["text"], tools: true },
    contextWindow: 65536,
  },
  "deepseek-reasoner": {
    id: "deepseek-reasoner",
    provider: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: ["DEEPSEEK_API_KEY", "OPENAI_API_KEY"],
    // reasoner is also text; tools support is weaker — keep tools true for teaching simplicity
    capabilities: { input: ["text"], tools: true },
    contextWindow: 65536,
  },
  "gpt-4o-mini": {
    id: "gpt-4o-mini",
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: ["OPENAI_API_KEY"],
    capabilities: { input: ["text", "image"], tools: true },
    contextWindow: 128000,
  },
  "gpt-4o": {
    id: "gpt-4o",
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: ["OPENAI_API_KEY"],
    capabilities: { input: ["text", "image"], tools: true },
    contextWindow: 128000,
  },
};

export function supportsImageInput(capabilities: ModelCapabilities): boolean {
  return capabilities.input.includes("image");
}

/**
 * Resolve a model id to registry entry.
 * Unknown models default conservatively: text only, tools on
 * (unless baseUrl strongly suggests a known host).
 */
export function resolveModel(modelId: string, baseUrl?: string): ModelRef {
  const known = MODEL_REGISTRY[modelId];
  if (known) {
    return {
      ...known,
      baseUrl: baseUrl?.replace(/\/$/, "") || known.baseUrl,
    };
  }

  const url = (baseUrl ?? "").toLowerCase();
  const looksDeepSeek = url.includes("deepseek");
  const looksOpenAI = url.includes("openai.com") || url === "";

  if (looksDeepSeek) {
    return {
      id: modelId,
      provider: "openai-compatible",
      baseUrl: baseUrl?.replace(/\/$/, "") || "https://api.deepseek.com/v1",
      apiKeyEnv: ["DEEPSEEK_API_KEY", "OPENAI_API_KEY"],
      capabilities: { input: ["text"], tools: true },
      contextWindow: 65536,
    };
  }

  // Unknown: conservative — no vision unless explicitly registered
  return {
    id: modelId,
    provider: "openai-compatible",
    baseUrl:
      baseUrl?.replace(/\/$/, "") ||
      (looksOpenAI ? "https://api.openai.com/v1" : "https://api.openai.com/v1"),
    apiKeyEnv: ["OPENAI_API_KEY", "DEEPSEEK_API_KEY"],
    capabilities: { input: ["text"], tools: true },
    contextWindow: 128000,
  };
}

export function parseImagePolicy(raw: string | undefined): ImagePolicy {
  if (raw === "fail" || raw === "strip" || raw === "placeholder") return raw;
  return "placeholder";
}
