/**
 * Three-layer search provider registry.
 *
 * Layers (in priority order):
 *   1. DuckDuckGo — via public SearXNG instances (no API key)
 *   2. MCP search tools — from connected MCP servers
 *   3. Built-in providers — Exa, Brave, Tavily, etc. (via pi-web-access)
 *
 * The `provider` field in `web_search` / `fetch_content` / `source_check`
 * accepts: "duckduckgo", "mcp", "exa", "brave", "tavily", "searxng", etc.
 * When omitted, the search falls through the layers in order.
 */

import type { Tool } from "../tools/types.ts";
import { createMcpRuntimeFromEnv, type McpRuntime } from "../mcp/runtime.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  rank?: number;
};

export type ExtractedContent = {
  url: string;
  title?: string;
  content?: string;
  status?: number;
  error?: string;
};

export type SearchResponse = {
  answer?: string;
  results: SearchResult[];
  provider?: string;
  inlineContent?: ExtractedContent[];
};

// ─── Types ──────────────────────────────────────────────────────────────────

export type SearchProviderName =
  | "duckduckgo"
  | "mcp"
  | "searxng"
  | "exa"
  | "brave"
  | "tavily"
  | "serpdive"
  | "kagi"
  | "ollama"
  | "perplexity"
  | "gemini"
  | "openai"
  | "parallel"
  | "tinyfish"
  | "search1api"
  | "searchinfinity"
  | "querit"
  | "brightdata"
  | "serpbase"
  | "anysearch"
  | "xai"
  | "auto";

export type SearchProviderConfig = {
  /** Layer priority (lower = tried first). */
  priority: number;
  /** Whether this provider is available without extra config. */
  available: boolean;
  /** Search function. */
  search: (query: string, options: SearchOptions) => Promise<SearchResponse>;
  /** Optional fetch function for full content. */
  fetch?: (urls: string[], signal?: AbortSignal) => Promise<ExtractedContent[]>;
};

export type SearchOptions = {
  numResults?: number;
  recencyFilter?: "day" | "week" | "month" | "year";
  domainFilter?: string[];
  signal?: AbortSignal;
};

// ─── DuckDuckGo via SearXNG ─────────────────────────────────────────────────

/**
 * Public SearXNG instances that can serve as DuckDuckGo proxies.
 * These are community-run; availability may vary.
 */
const PUBLIC_SEARXNG_INSTANCES = [
  "https://searx.be",
  "https://search.bus-hit.me",
  "https://searx.tiekoetter.com",
  "https://searx.thegpm.org",
  "https://search.projectsegfau.lt",
] as const;

let searxngInstance: string | undefined;

/**
 * Probe public SearXNG instances and return the first working one.
 * Caches the result for the process lifetime.
 */
async function getWorkingSearxngInstance(): Promise<string | undefined> {
  if (searxngInstance) return searxngInstance;

  for (const instance of PUBLIC_SEARXNG_INSTANCES) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`${instance}/search?q=test&format=json`, {
        signal: controller.signal,
        headers: { "User-Agent": "mini-agent/1.0" },
      });
      clearTimeout(timeout);
      if (response.ok) {
        searxngInstance = instance;
        return instance;
      }
    } catch {
      // Try next instance
    }
  }
  return undefined;
}

/**
 * Search via a SearXNG instance (DuckDuckGo backend).
 */
async function searchViaSearxng(
  instance: string,
  query: string,
  options: SearchOptions,
): Promise<SearchResponse> {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    ...(options.numResults ? { count: String(options.numResults) } : {}),
    ...(options.recencyFilter ? { time_range: options.recencyFilter } : {}),
    ...(options.domainFilter?.length ? { site: options.domainFilter.join(",") } : {}),
  });

  const response = await fetch(`${instance}/search?${params}`, {
    signal: options.signal,
    headers: { "User-Agent": "mini-agent/1.0" },
  });

  if (!response.ok) {
    throw new Error(`SearXNG ${instance} returned ${response.status}`);
  }

  const data = (await response.json()) as { results?: Array<Record<string, unknown>> };
  const results: SearchResult[] = (data.results ?? []).map((r: Record<string, unknown>, index: number) => ({
    title: String(r.title ?? ""),
    url: String(r.url ?? ""),
    snippet: String(r.content ?? r.snippet ?? ""),
    rank: index + 1,
  }));

  return {
    answer: results.slice(0, 3).map((r) => r.snippet).join("\n"),
    results,
    provider: "duckduckgo",
  };
}

export async function createDuckDuckGoProvider(): Promise<SearchProviderConfig | undefined> {
  const instance = await getWorkingSearxngInstance();
  if (!instance) return undefined;

  return {
    priority: 10,
    available: true,
    search: (query, options) => searchViaSearxng(instance, query, options),
  };
}

// ─── MCP Search Provider ────────────────────────────────────────────────────

let mcpRuntime: McpRuntime | undefined;

async function getMcpRuntime(): Promise<McpRuntime | undefined> {
  if (mcpRuntime) return mcpRuntime;
  try {
    mcpRuntime = await createMcpRuntimeFromEnv(process.cwd(), {});
    return mcpRuntime;
  } catch {
    return undefined;
  }
}

function findMcpSearchTools(runtime: McpRuntime): Tool[] {
  const allTools = runtime.toolProvider()();
  return allTools.filter((tool) => {
    const name = tool.name.toLowerCase();
    return (
      name.includes("search") ||
      name.includes("web") ||
      name.includes("google") ||
      name.includes("brave") ||
      name.includes("duckduckgo")
    );
  });
}

export async function createMcpSearchProvider(): Promise<SearchProviderConfig | undefined> {
  const runtime = await getMcpRuntime();
  if (!runtime) return undefined;

  const searchTools = findMcpSearchTools(runtime);
  if (searchTools.length === 0) return undefined;

  return {
    priority: 20,
    available: true,
    search: async (query, options) => {
      // Use the first available MCP search tool
      const tool = searchTools[0];
      const result = await tool.execute({ query, ...options }, options.signal);
      const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content);

      // Try to parse structured results
      let results: SearchResult[] = [];
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          results = parsed.map((r: any, i: number) => ({
            title: r.title ?? r.url ?? `Result ${i + 1}`,
            url: r.url ?? "",
            snippet: r.snippet ?? r.content ?? r.description ?? "",
            rank: i + 1,
          }));
        } else if (parsed.results) {
          results = parsed.results.map((r: any, i: number) => ({
            title: r.title ?? r.url ?? `Result ${i + 1}`,
            url: r.url ?? "",
            snippet: r.snippet ?? r.content ?? r.description ?? "",
            rank: i + 1,
          }));
        }
      } catch {
        // Fallback: treat as single result
        results = [{ title: "MCP Search Result", url: "", snippet: text, rank: 1 }];
      }

      return {
        answer: results.slice(0, 3).map((r) => r.snippet).join("\n"),
        results,
        provider: "mcp",
      };
    },
  };
}

// ─── Built-in Provider (pi-web-access) ──────────────────────────────────────

let builtinSearchFn: ((query: string, options: SearchOptions) => Promise<SearchResponse>) | undefined;

export function setBuiltinSearchProvider(
  fn: (query: string, options: SearchOptions) => Promise<SearchResponse>,
): void {
  builtinSearchFn = fn;
}

export function createBuiltinProvider(): SearchProviderConfig | undefined {
  if (!builtinSearchFn) return undefined;
  return {
    priority: 100,
    available: true,
    search: builtinSearchFn,
  };
}

// ─── Registry ────────────────────────────────────────────────────────────────

let providerCache: SearchProviderConfig[] | undefined;

export async function getSearchProviders(): Promise<SearchProviderConfig[]> {
  if (providerCache) return providerCache;

  const providers: SearchProviderConfig[] = [];

  // Layer 1: DuckDuckGo (SearXNG)
  const ddg = await createDuckDuckGoProvider();
  if (ddg) providers.push(ddg);

  // Layer 2: MCP
  const mcp = await createMcpSearchProvider();
  if (mcp) providers.push(mcp);

  // Layer 3: Built-in
  const builtin = createBuiltinProvider();
  if (builtin) providers.push(builtin);

  // Sort by priority
  providers.sort((a, b) => a.priority - b.priority);
  providerCache = providers;
  return providers;
}

export function clearSearchProviderCache(): void {
  providerCache = undefined;
  searxngInstance = undefined;
  mcpRuntime = undefined;
}

/**
 * Search with automatic layer fallback.
 *
 * If `provider` is specified, only that layer is used.
 * If omitted, layers are tried in priority order until one succeeds.
 */
export async function searchWithFallback(
  query: string,
  options: SearchOptions & { provider?: SearchProviderName },
): Promise<SearchResponse> {
  const providers = await getSearchProviders();

  // If specific provider requested, use only that one
  if (options.provider && options.provider !== "auto") {
    const provider = providers.find((p) => {
      if (options.provider === "duckduckgo") return p.priority === 10;
      if (options.provider === "mcp") return p.priority === 20;
      return p.priority >= 100; // built-in
    });
    if (provider) {
      return provider.search(query, options);
    }
    throw new Error(`Provider "${options.provider}" not available`);
  }

  // Auto: try each layer in order
  let lastError: Error | undefined;
  for (const provider of providers) {
    try {
      return await provider.search(query, options);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // Continue to next layer
    }
  }

  throw lastError ?? new Error("No search providers available");
}