
import { builtinModels } from "./pi-ai/providers/all.ts";
import type { Api, Model as PiModel } from "./pi-ai/types.ts";
import type { ToolCallFormat } from "./hermes/types.ts";
import { KIMI_K3_MODELS } from "./kimi-k3-models.ts";
import { GPT6_ASTRA_MODELS } from "./openai-gpt6-astra.ts";
import { TOKENROUTER_MODELS, tokenrouterProvider } from "./tokenrouter-models.ts";

export type ModelCapabilities = {
  input: Array<"text" | "image">;
  tools: boolean;
};

export type ModelRef = {
  id: string;
  name: string;
  provider: string;
  api: Api;
  protocol: "pi" | "openai-compatible";
  baseUrl: string;
  apiKeyEnv: string[];
  capabilities: ModelCapabilities;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  /**
   * The wire format used for tool calling.
   *
   * - `"openai"` (default) — standard OpenAI Chat Completions `tool_calls`
   * - `"hermes"` — Hermes XML `<tool_call>` blocks in assistant text
   */
  toolCallFormat?: ToolCallFormat;
  thinkingLevelMap?: Record<string, string | null>;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat?: Record<string, unknown>;
  piModel?: PiModel<Api>;
  /**
   * Per-model timeout overrides (milliseconds). When present on a catalog
   * entry these take precedence over the global env-based defaults.
   * - `timeoutMs` — total request deadline (default 120s)
   * - `firstResponseTimeoutMs` — time-to-first-chunk deadline (defaults to `timeoutMs`)
   * - `streamIdleTimeoutMs` — gap allowed between stream chunks (default 60s)
   */
  timeoutMs?: number;
  firstResponseTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
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

const PROVIDER_ENV_KEYS: Record<string, string[]> = {
  "amazon-bedrock": ["AWS_ACCESS_KEY_ID", "AWS_PROFILE", "AWS_REGION"],
  "agnes-ai": ["AGNES_API_KEY"],
  "ant-ling": ["ANT_LING_API_KEY"],
  anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  "azure-openai-responses": ["AZURE_OPENAI_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_AI_GATEWAY_API_KEY"],
  "cloudflare-workers-ai": ["CLOUDFLARE_API_TOKEN"],
  deepseek: ["DEEPSEEK_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  "google-vertex": ["GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS"],
  groq: ["GROQ_API_KEY"],
  huggingface: ["HF_TOKEN", "HUGGINGFACE_API_KEY"],
  "kimi-coding": ["KIMI_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  "openai-codex": ["OPENAI_CODEX_AUTH_JSON", "OPENAI_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  tokenrouter: ["TOKENROUTER_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  xai: ["XAI_API_KEY"],
  xiaomi: ["XIAOMI_API_KEY"],
  "xiaomi-token-plan-cn": ["XIAOMI_API_KEY"],
  "xiaomi-token-plan-ams": ["XIAOMI_API_KEY"],
  "xiaomi-token-plan-sgp": ["XIAOMI_API_KEY"],
  zai: ["ZAI_API_KEY"],
  "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
  qwen: ["DASHSCOPE_API_KEY"],
};

const piRuntime = builtinModels();

export type LlmGatewayProtocol = "openai-compatible" | "anthropic-messages";

export function isOfficialAnthropicHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl.includes("://") ? baseUrl : `https://${baseUrl}`).hostname.toLowerCase();
    return host === "api.anthropic.com" || host.endsWith(".api.anthropic.com");
  } catch {
    return /api\.anthropic\.com/i.test(baseUrl);
  }
}

/**
 * OpenAI-compatible gateways serve `/v1/chat/completions`.
 * A bare origin (`https://gw.example`) would otherwise hit the marketing site
 * and look like a truncated SSE stream. Anthropic Messages must not get this
 * rewrite — the SDK already appends `/v1/messages`.
 */
export function normalizeOpenAiCompatibleBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  if (!trimmed || isOfficialAnthropicHost(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    const path = url.pathname.replace(/\/$/, "") || "";
    if (!path || path === "/") {
      url.pathname = "/v1";
      return url.toString().replace(/\/$/, "");
    }
  } catch {
    if (!/\/[^/]/.test(trimmed.replace(/^https?:\/\//i, ""))) {
      return `${trimmed}/v1`;
    }
  }
  return trimmed;
}

export function looksLikeAnthropicMessagesEndpoint(baseUrl: string): boolean {
  if (isOfficialAnthropicHost(baseUrl)) return true;
  try {
    const url = new URL(baseUrl.includes("://") ? baseUrl : `https://${baseUrl}`);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    if (host.includes("anthropic.com")) return true;
    if (path.includes("/anthropic")) return true;
    if (path.includes("/messages")) return true;
  } catch {
    return /anthropic/i.test(baseUrl);
  }
  return false;
}

/**
 * Built-in Claude stays on Anthropic Messages for api.anthropic.com.
 * A custom 中转站 / relay defaults to OpenAI-compatible `/chat/completions`,
 * which is what most gateways expose. Opt back into Messages with an
 * Anthropic-shaped URL, `protocol: "anthropic-messages"`, or a catalog entry
 * whose own baseUrl already points at that gateway.
 */
export function shouldUseAnthropicMessages(
  model: Pick<ModelRef, "api" | "baseUrl">,
  targetBaseUrl?: string,
  protocol?: LlmGatewayProtocol,
): boolean {
  if (protocol === "openai-compatible") return false;
  if (model.api !== "anthropic-messages") {
    return protocol === "anthropic-messages";
  }
  if (protocol === "anthropic-messages") return true;
  const catalogUrl = model.baseUrl.replace(/\/$/, "");
  const url = (targetBaseUrl ?? model.baseUrl).replace(/\/$/, "");
  if (!targetBaseUrl || url === catalogUrl) return true;
  return looksLikeAnthropicMessagesEndpoint(url);
}

function toModelRef(model: PiModel<Api>): ModelRef {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    api: model.api,
    protocol: "pi",
    baseUrl: model.baseUrl,
    apiKeyEnv: PROVIDER_ENV_KEYS[model.provider] ?? [],
    capabilities: {
      input: model.input,
      tools: true,
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    cost: model.cost,
    compat: model.compat as Record<string, unknown> | undefined,
    piModel: model,
    timeoutMs: model.timeoutMs,
    firstResponseTimeoutMs: model.firstResponseTimeoutMs,
    streamIdleTimeoutMs: model.streamIdleTimeoutMs,
  };
}

function mergeBuiltInModels(
  upstreamModels: readonly PiModel<Api>[],
  fallbackModels: readonly PiModel<Api>[],
): PiModel<Api>[] {
  const models = new Map<string, PiModel<Api>>();
  for (const model of [...upstreamModels, ...fallbackModels]) {
    const key = `${model.provider}/${model.id}`.toLowerCase();
    if (!models.has(key)) models.set(key, model);
  }
  return [...models.values()];
}

const BUILT_IN_MODELS = mergeBuiltInModels(
  piRuntime.getModels(),
  [...KIMI_K3_MODELS, ...TOKENROUTER_MODELS, ...GPT6_ASTRA_MODELS],
).map(toModelRef);

// The project-owned fallback is outside pi-ai's generated provider catalog,
// so register its OpenAI-compatible transport in the runtime as well.
piRuntime.setProvider(tokenrouterProvider());

export const MODEL_REGISTRY: Record<string, ModelRef> = {};
for (const model of BUILT_IN_MODELS) {
  MODEL_REGISTRY[model.id] ??= model;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function positiveTimeout(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1_000
    ? Math.floor(value)
    : undefined;
}

function parseThinkingLevelMap(value: unknown): Record<string, string | null> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const mapped: Record<string, string | null> = {};
  for (const [level, mappedValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof mappedValue === "string" || mappedValue === null) mapped[level] = mappedValue;
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function parseCompat(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return { ...(value as Record<string, unknown>) };
}

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
    const contextWindow = positiveInteger(item.contextWindow, 128000);
    const maxTokens = Math.min(positiveInteger(item.maxTokens, 16384), Math.max(1, contextWindow - 1));
    const baseUrl = item.baseUrl.replace(/\/$/, "");
    const input = Array.isArray(item.input) && item.input.includes("image")
      ? ["text", "image"] as const
      : ["text"] as const;
    const reasoning = item.reasoning === true;
    const thinkingLevelMap = parseThinkingLevelMap(item.thinkingLevelMap);
    const compat = parseCompat(item.compat);
    const timeouts = {
      ...(item.timeoutMs !== undefined ? { timeoutMs: positiveTimeout(item.timeoutMs) } : {}),
      ...(item.firstResponseTimeoutMs !== undefined
        ? { firstResponseTimeoutMs: positiveTimeout(item.firstResponseTimeoutMs) }
        : {}),
      ...(item.streamIdleTimeoutMs !== undefined
        ? { streamIdleTimeoutMs: positiveTimeout(item.streamIdleTimeoutMs) }
        : {}),
    };
    const anthropic = item.api === "anthropic-messages";
    const piModel = anthropic
      ? {
          id: item.id,
          name: typeof item.name === "string" ? item.name : item.id,
          api: "anthropic-messages" as const,
          provider: "anthropic" as const,
          baseUrl,
          reasoning,
          ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
          input: [...input],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow,
          maxTokens,
          ...(compat ? { compat } : {}),
          ...timeouts,
        } satisfies PiModel<"anthropic-messages">
      : undefined;
    models.push({
      id: item.id,
      name: typeof item.name === "string" ? item.name : item.id,
      provider: item.provider,
      api: anthropic ? "anthropic-messages" : "openai-completions",
      protocol: anthropic ? "pi" : "openai-compatible",
      baseUrl,
      apiKeyEnv,
      capabilities: {
        input: [...input],
        tools: item.tools !== false,
      },
      contextWindow,
      maxTokens,
      reasoning,
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      ...(compat ? { compat } : {}),
      ...(piModel ? { piModel } : {}),
      ...timeouts,
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
  return getAllModels(env).filter((model) => {
    if (model.protocol === "openai-compatible") return model.apiKeyEnv.some((name) => Boolean(env[name]));
    return model.apiKeyEnv.length === 0 || model.apiKeyEnv.some((name) => Boolean(env[name]));
  });
}

export function modelReference(provider: string, modelId: string): string {
  const id = modelId.trim();
  const prefix = `${provider.trim()}/`;
  return id.toLowerCase().startsWith(prefix.toLowerCase()) ? id : `${provider.trim()}/${id}`;
}

export function findExactModelReferenceMatch(
  reference: string,
  models: ModelRef[] = getAvailableModels(),
): ModelReferenceMatch | undefined {
  const normalized = reference.trim().toLowerCase();
  if (!normalized) return undefined;
  const usableModels = models.filter((model): model is ModelRef => Boolean(model));
  const qualifiedMatches = usableModels.filter((model) => `${model.provider}/${model.id}`.toLowerCase() === normalized);
  const matches = qualifiedMatches.length > 0 ? qualifiedMatches : usableModels.filter((model) => model.id.toLowerCase() === normalized);
  if (matches.length === 0) return undefined;
  if (matches.length > 1) return { ambiguous: true, matches };
  return { model: matches[0] };
}

function applyGatewayTransport(
  model: ModelRef,
  baseUrl?: string,
  protocol?: LlmGatewayProtocol,
): ModelRef {
  const rawUrl = (baseUrl ?? model.baseUrl).replace(/\/$/, "");
  const catalogUrl = model.baseUrl.replace(/\/$/, "");
  const sameHost = !baseUrl || rawUrl === catalogUrl;
  // Claude (or an explicit protocol override) is the only catalog transport
  // rewritten for a custom 中转站. Other pi-backed models keep native
  // transport on their catalog host and fall back to OpenAI-compatible
  // Chat Completions on a different gateway.
  if (model.api === "anthropic-messages" || protocol) {
    const useAnthropic = shouldUseAnthropicMessages(model, baseUrl, protocol);
    const url = useAnthropic ? rawUrl : normalizeOpenAiCompatibleBaseUrl(rawUrl);
    return {
      ...model,
      baseUrl: url,
      piModel: useAnthropic && model.piModel
        ? { ...model.piModel, baseUrl: url }
        : undefined,
    };
  }
  const url = sameHost ? rawUrl : normalizeOpenAiCompatibleBaseUrl(rawUrl);
  return {
    ...model,
    baseUrl: url,
    piModel: sameHost && model.piModel
      ? { ...model.piModel, baseUrl: url }
      : undefined,
  };
}

/**
 * Static alias map: old model IDs → canonical IDs.
 * Defined at module level to avoid per-call object allocation.
 */
const LEGACY_MODEL_ALIASES: Record<string, string> = {
  "deepseek-chat": "deepseek-v4-flash",
  "deepseek/deepseek-chat": "deepseek/deepseek-v4-flash",
  "deepseek-reasoner": "deepseek-v4-pro",
  "deepseek/deepseek-reasoner": "deepseek/deepseek-v4-pro",
  // Catalog ids use hyphens (`claude-sonnet-4-6`); users type dotted versions.
  "claude-sonnet-4.6": "anthropic/claude-sonnet-4-6",
  "anthropic/claude-sonnet-4.6": "anthropic/claude-sonnet-4-6",
  "sonnet-4.6": "anthropic/claude-sonnet-4-6",
  "claude-sonnet-4.5": "anthropic/claude-sonnet-4-5",
  "anthropic/claude-sonnet-4.5": "anthropic/claude-sonnet-4-5",
  "sonnet-4.5": "anthropic/claude-sonnet-4-5",
  "claude-haiku-4.5": "anthropic/claude-haiku-4-5",
  "anthropic/claude-haiku-4.5": "anthropic/claude-haiku-4-5",
  "haiku-4.5": "anthropic/claude-haiku-4-5",
  "claude-opus-4.1": "anthropic/claude-opus-4-1",
  "anthropic/claude-opus-4.1": "anthropic/claude-opus-4-1",
  "opus-4.1": "anthropic/claude-opus-4-1",
  "claude-opus-4.5": "anthropic/claude-opus-4-5",
  "anthropic/claude-opus-4.5": "anthropic/claude-opus-4-5",
  "opus-4.5": "anthropic/claude-opus-4-5",
  "claude-opus-4.6": "anthropic/claude-opus-4-6",
  "anthropic/claude-opus-4.6": "anthropic/claude-opus-4-6",
  "opus-4.6": "anthropic/claude-opus-4-6",
  "claude-opus-4.7": "anthropic/claude-opus-4-7",
  "anthropic/claude-opus-4.7": "anthropic/claude-opus-4-7",
  "opus-4.7": "anthropic/claude-opus-4-7",
  "claude-opus-4.8": "anthropic/claude-opus-4-8",
  "anthropic/claude-opus-4.8": "anthropic/claude-opus-4-8",
  "opus-4.8": "anthropic/claude-opus-4-8",
};

export function resolveModel(modelId: string, baseUrl?: string, protocol?: LlmGatewayProtocol): ModelRef {
  modelId = LEGACY_MODEL_ALIASES[modelId.trim().toLowerCase()] ?? modelId;
  const normalizedBaseUrl = baseUrl?.replace(/\/$/, "");
  const all = getAllModels();
  const exact = findExactModelReferenceMatch(modelId, all);
  if (exact?.model && !exact.ambiguous) {
    return applyGatewayTransport(exact.model, normalizedBaseUrl, protocol);
  }
  const idMatches = all.filter((model) => model.id.toLowerCase() === modelId.toLowerCase());
  const known = normalizedBaseUrl
    ? idMatches.find((model) => normalizedBaseUrl.startsWith(model.baseUrl) || model.baseUrl.startsWith(normalizedBaseUrl))
    : idMatches.find((model) => model.apiKeyEnv.some((name) => Boolean(process.env[name]))) ?? idMatches[0];
  if (known) {
    return applyGatewayTransport(known, normalizedBaseUrl, protocol);
  }
  return {
    id: modelId,
    name: modelId,
    provider: "custom",
    api: "openai-completions",
    protocol: "openai-compatible",
    baseUrl: normalizedBaseUrl || "https://api.openai.com/v1",
    apiKeyEnv: ["OPENAI_API_KEY"],
    capabilities: { input: ["text"], tools: true },
    contextWindow: 128000,
    maxTokens: 16384,
    reasoning: false,
  };
}

/** Levenshtein edit distance between two lowercase strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

/**
 * Score how well a single search term matches a field value.
 * Returns 0 if no match, or a positive score:
 *   4 = exact match
 *   3 = prefix match
 *   2 = substring match
 *   1 = fuzzy (edit distance ≤ floor(term.length / 2.5), minimum 1)
 */
function scoreTerm(term: string, field: string): number {
  if (!term) return 2; // empty term matches everything at substring level
  if (field === term) return 4;
  if (field.startsWith(term)) return 3;
  if (field.includes(term)) return 2;
  // Structured terms are model-id fragments; keep them strict instead of
  // matching an unrelated provider through fuzzy distance.
  if (/[\-\/_\.]/.test(term)) return 0;
  // Allow ~1 edit per 2-3 chars: catches transpositions like 'agens'→'agnes'
  const threshold = Math.max(1, Math.floor(term.length / 2.5));
  if (levenshtein(term, field) <= threshold) return 1;
  // Also try fuzzy against each '-' or '/' separated word in the field
  const words = field.split(/[-/_.]/);
  for (const word of words) {
    if (word.length >= 3 && levenshtein(term, word) <= threshold) return 1;
  }
  return 0;
}

/**
 * Search models by a free-text query, matching across `id`, `name`, and `provider`.
 * All whitespace-separated terms must match (AND logic).
 * Results are sorted by descending match score (best first).
 */
export function searchModels(query: string, models: ModelRef[] = getAllModels()): ModelRef[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return models;

  const scored: Array<{ model: ModelRef; score: number }> = [];
  for (const model of models) {
    const qualifiedId = `${model.provider}/${model.id}`.toLowerCase();
    const modelId = model.id.toLowerCase();
    const modelName = model.name.toLowerCase();
    const provider = model.provider.toLowerCase();

    let totalScore = 0;
    for (const term of terms) {
      const hyphenTerm = term.replaceAll(".", "-");
      const s = Math.max(
        scoreTerm(term, qualifiedId),
        scoreTerm(term, modelId),
        scoreTerm(term, modelName),
        scoreTerm(term, provider),
        // Users type dotted versions (`sonnet-4.6`) while catalog ids use hyphens.
        scoreTerm(term, modelId.replaceAll("-", ".")),
        scoreTerm(term, modelName.replaceAll("-", ".")),
        scoreTerm(hyphenTerm, modelId),
        scoreTerm(hyphenTerm, qualifiedId),
      );
      if (s === 0) { totalScore = 0; break; } // all terms must match
      totalScore += s;
    }

    if (totalScore > 0) scored.push({ model, score: totalScore });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.model);
}

export function supportsImageInput(capabilities: ModelCapabilities): boolean {
  return capabilities.input.includes("image");
}

export function parseImagePolicy(raw: string | undefined): ImagePolicy {
  if (raw === "fail" || raw === "strip" || raw === "placeholder") return raw;
  return "placeholder";
}

export function getPiModels(): typeof piRuntime {
  return piRuntime;
}
