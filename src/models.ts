export type ModelCapabilities = {
  input: Array<"text" | "image">;
  tools: boolean;
};

export type ModelRef = {
  id: string;
  provider: string;
  /** This transport currently supports OpenAI Chat Completions compatible APIs. */
  protocol: "openai-compatible";
  baseUrl: string;
  apiKeyEnv: string[];
  capabilities: ModelCapabilities;
  contextWindow: number;
};

export type ModelReferenceMatch = {
  model: ModelRef;
  ambiguous?: false;
} | {
  model?: undefined;
  ambiguous: true;
  matches: ModelRef[];
};

export type ImagePolicy = "placeholder" | "fail" | "strip";

type ModelPreset = {
  provider: string;
  baseUrl: string;
  apiKeyEnv: string[];
  models: Array<{
    id: string;
    contextWindow: number;
    vision?: boolean;
    tools?: boolean;
  }>;
};

const PRESETS: ModelPreset[] = [
  {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: ["DEEPSEEK_API_KEY"],
    models: [
      // Current production models (verified via /v1/models)
      { id: "deepseek-v4-flash", contextWindow: 131072 },
      { id: "deepseek-v4-pro", contextWindow: 131072 },
      // Legacy / classic models (may be available on some plans)
      { id: "deepseek-chat", contextWindow: 65536 },
      { id: "deepseek-reasoner", contextWindow: 65536 },
    ],
  },
  {
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: ["OPENAI_API_KEY"],
    models: [
      { id: "gpt-4.1", contextWindow: 1047576, vision: true },
      { id: "gpt-4.1-mini", contextWindow: 1047576, vision: true },
      { id: "gpt-4.1-nano", contextWindow: 1047576, vision: true },
      { id: "gpt-4o", contextWindow: 128000, vision: true },
      { id: "gpt-4o-mini", contextWindow: 128000, vision: true },
      { id: "o3", contextWindow: 200000, vision: true },
      { id: "o4-mini", contextWindow: 200000, vision: true },
    ],
  },
  {
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    models: [
      { id: "gemini-2.5-pro", contextWindow: 1048576, vision: true },
      { id: "gemini-2.5-flash", contextWindow: 1048576, vision: true },
      { id: "gemini-2.0-flash", contextWindow: 1048576, vision: true },
    ],
  },
  {
    provider: "dashscope",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: ["DASHSCOPE_API_KEY"],
    models: [
      { id: "qwen-max", contextWindow: 32768 },
      { id: "qwen-plus", contextWindow: 131072 },
      { id: "qwen-turbo", contextWindow: 1000000 },
      { id: "qwen3-235b-a22b", contextWindow: 131072 },
      { id: "qwen-vl-max", contextWindow: 131072, vision: true },
      { id: "qwen-vl-plus", contextWindow: 131072, vision: true },
    ],
  },
  {
    provider: "zhipu",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKeyEnv: ["ZHIPU_API_KEY"],
    models: [
      { id: "glm-4-plus", contextWindow: 128000 },
      { id: "glm-4-air", contextWindow: 128000 },
      { id: "glm-4-flash", contextWindow: 128000 },
      { id: "glm-4v-plus", contextWindow: 8192, vision: true },
    ],
  },
  {
    provider: "moonshot",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: ["MOONSHOT_API_KEY"],
    models: [
      { id: "moonshot-v1-8k", contextWindow: 8192 },
      { id: "moonshot-v1-32k", contextWindow: 32768 },
      { id: "moonshot-v1-128k", contextWindow: 131072 },
      { id: "kimi-k2-0711-preview", contextWindow: 131072 },
    ],
  },
  {
    provider: "xai",
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: ["XAI_API_KEY"],
    models: [
      { id: "grok-3", contextWindow: 131072 },
      { id: "grok-3-mini", contextWindow: 131072 },
      { id: "grok-4", contextWindow: 256000, vision: true },
    ],
  },
  {
    provider: "mistral",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnv: ["MISTRAL_API_KEY"],
    models: [
      { id: "mistral-large-latest", contextWindow: 131072 },
      { id: "mistral-small-latest", contextWindow: 32768 },
      { id: "codestral-latest", contextWindow: 256000 },
      { id: "pixtral-large-latest", contextWindow: 131072, vision: true },
    ],
  },
  {
    provider: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: ["GROQ_API_KEY"],
    models: [
      { id: "llama-3.3-70b-versatile", contextWindow: 131072 },
      { id: "meta-llama/llama-4-maverick-17b-128e-instruct", contextWindow: 131072, vision: true },
      { id: "qwen/qwen3-32b", contextWindow: 131072 },
    ],
  },
  {
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: ["OPENROUTER_API_KEY"],
    models: [
      { id: "anthropic/claude-sonnet-4", contextWindow: 200000, vision: true },
      { id: "anthropic/claude-opus-4", contextWindow: 200000, vision: true },
      { id: "google/gemini-2.5-pro", contextWindow: 1048576, vision: true },
      { id: "meta-llama/llama-4-maverick", contextWindow: 1048576, vision: true },
      { id: "x-ai/grok-3", contextWindow: 131072 },
      { id: "mistralai/mistral-large", contextWindow: 131072 },
    ],
  },
  {
    provider: "siliconflow",
    baseUrl: "https://api.siliconflow.cn/v1",
    apiKeyEnv: ["SILICONFLOW_API_KEY"],
    models: [
      { id: "deepseek-ai/DeepSeek-V3", contextWindow: 65536 },
      { id: "deepseek-ai/DeepSeek-R1", contextWindow: 65536 },
      { id: "Qwen/Qwen3-235B-A22B", contextWindow: 131072 },
      { id: "meta-llama/Llama-4-Maverick-17B-128E-Instruct", contextWindow: 131072, vision: true },
    ],
  },
];

const BUILT_IN_MODELS = PRESETS.flatMap((preset) =>
  preset.models.map<ModelRef>((model) => ({
    id: model.id,
    provider: preset.provider,
    protocol: "openai-compatible",
    baseUrl: preset.baseUrl,
    apiKeyEnv: preset.apiKeyEnv,
    capabilities: {
      input: model.vision ? ["text", "image"] : ["text"],
      tools: model.tools ?? true,
    },
    contextWindow: model.contextWindow,
  })),
);

export const MODEL_REGISTRY: Record<string, ModelRef> = Object.fromEntries(
  BUILT_IN_MODELS.map((model) => [model.id, model]),
);

function parseCustomModels(raw: string | undefined): ModelRef[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const models: ModelRef[] = [];
  for (const value of parsed) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.provider !== "string" || typeof item.baseUrl !== "string") continue;
    const apiKeyEnv = Array.isArray(item.apiKeyEnv)
      ? item.apiKeyEnv.filter((name): name is string => typeof name === "string")
      : typeof item.apiKeyEnv === "string" ? [item.apiKeyEnv] : [];
    if (apiKeyEnv.length === 0) continue;
    const input = Array.isArray(item.input) && item.input.includes("image")
      ? ["text", "image"] as Array<"text" | "image">
      : ["text"] as Array<"text" | "image">;
    models.push({
      id: item.id,
      provider: item.provider,
      protocol: "openai-compatible",
      baseUrl: item.baseUrl.replace(/\/$/, ""),
      apiKeyEnv,
      capabilities: { input, tools: item.tools !== false },
      contextWindow: typeof item.contextWindow === "number" ? item.contextWindow : 128000,
    });
  }
  return models;
}

export function getAllModels(env: NodeJS.ProcessEnv = process.env): ModelRef[] {
  const models = [...BUILT_IN_MODELS, ...parseCustomModels(env.MINI_AGENT_MODELS)];
  const unique = new Map(models.map((model) => [`${model.provider}/${model.id}`.toLowerCase(), model]));
  return [...unique.values()];
}

export function getAvailableModels(env: NodeJS.ProcessEnv = process.env): ModelRef[] {
  return getAllModels(env).filter((model) =>
    model.apiKeyEnv.some((name) => Boolean(env[name])),
  );
}

export function findExactModelReferenceMatch(
  reference: string,
  models: ModelRef[] = getAvailableModels(),
): ModelReferenceMatch | undefined {
  const normalized = reference.trim().toLowerCase();
  if (!normalized) return undefined;
  const qualifiedMatches = models.filter((model) =>
    `${model.provider}/${model.id}`.toLowerCase() === normalized,
  );
  const matches = qualifiedMatches.length > 0
    ? qualifiedMatches
    : models.filter((model) => model.id.toLowerCase() === normalized);
  if (matches.length === 0) return undefined;
  if (matches.length > 1) return { ambiguous: true, matches };
  return { model: matches[0] };
}

function inferProvider(baseUrl: string): { provider: string; apiKeyEnv: string[] } {
  const url = baseUrl.toLowerCase();
  for (const preset of PRESETS) {
    try {
      if (url.includes(new URL(preset.baseUrl).hostname)) {
        return { provider: preset.provider, apiKeyEnv: preset.apiKeyEnv };
      }
    } catch {
      // Ignore malformed custom URLs and use the generic fallback.
    }
  }
  return { provider: "custom", apiKeyEnv: ["OPENAI_API_KEY"] };
}

export function resolveModel(modelId: string, baseUrl?: string): ModelRef {
  const normalizedBaseUrl = baseUrl?.replace(/\/$/, "");
  const all = getAllModels();
  const exactReference = findExactModelReferenceMatch(modelId, all);
  if (exactReference?.model && !exactReference.ambiguous) {
    return { ...exactReference.model, baseUrl: normalizedBaseUrl || exactReference.model.baseUrl };
  }
  const idMatches = all.filter((model) => model.id.toLowerCase() === modelId.toLowerCase());
  const known = normalizedBaseUrl
    ? idMatches.find((model) => normalizedBaseUrl.startsWith(model.baseUrl) || model.baseUrl.startsWith(normalizedBaseUrl))
    : idMatches[0];
  if (known) return { ...known, baseUrl: normalizedBaseUrl || known.baseUrl };

  const fallbackBaseUrl = normalizedBaseUrl || "https://api.openai.com/v1";
  const inferred = inferProvider(fallbackBaseUrl);
  return {
    id: modelId,
    provider: inferred.provider,
    protocol: "openai-compatible",
    baseUrl: fallbackBaseUrl,
    apiKeyEnv: inferred.apiKeyEnv,
    capabilities: { input: ["text"], tools: true },
    contextWindow: 128000,
  };
}

export function supportsImageInput(capabilities: ModelCapabilities): boolean {
  return capabilities.input.includes("image");
}

export function parseImagePolicy(raw: string | undefined): ImagePolicy {
  if (raw === "fail" || raw === "strip" || raw === "placeholder") return raw;
  return "placeholder";
}
