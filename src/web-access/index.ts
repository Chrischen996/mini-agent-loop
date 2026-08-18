import path from "node:path";
import { fileURLToPath } from "node:url";
import { imagePart, textPart } from "../content.ts";
import { resolveWorkspacePath } from "../workspace.ts";
import type { ContentPart } from "../types.ts";
import type { Tool, ToolResult } from "../tools/types.ts";

const MAX_RESULT_CHARS = 30_000;
const MAX_SEARCH_QUERIES = 8;
const MAX_FETCH_URLS = 10;
const WEB_SOURCE = { kind: "web", package: "pi-web-access" } as const;

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

type ExtractedContent = {
  url: string;
  title: string;
  content: string;
  error: string | null;
  thumbnail?: { data: string; mimeType: string };
  frames?: Array<{ data: string; mimeType: string; timestamp: string }>;
  duration?: number;
  mimeType?: string;
  status?: number;
};

type SearchResponse = {
  answer: string;
  results: SearchResult[];
  provider?: string;
  inlineContent?: ExtractedContent[];
};

type StoredQuery = {
  query: string;
  answer: string;
  results: SearchResult[];
  error: string | null;
  provider?: string;
};

type StoredResult = {
  id: string;
  type: "search" | "fetch" | "research";
  timestamp: number;
  queries?: StoredQuery[];
  urls?: ExtractedContent[];
  artifact?: unknown;
};

type ResearchArtifact = {
  id: string;
  type: "research";
  timestamp: number;
  query: string;
  sources: Array<Record<string, unknown>>;
  passages: Array<Record<string, unknown>>;
  claims?: Array<Record<string, unknown>>;
  provider?: string;
  summary?: string;
  errors?: Array<{ query: string; error: string }>;
};

export type WebAccessModules = {
  search: (query: string, options?: Record<string, unknown>) => Promise<SearchResponse>;
  fetchAllContent: (
    urls: string[],
    signal?: AbortSignal,
    options?: Record<string, unknown>,
  ) => Promise<ExtractedContent[]>;
  findContent: (
    text: string,
    queries: string[],
    mode: "exact" | "case-insensitive" | "fuzzy",
  ) => { text: string; matchCount: number; returnedMatches: number; queryResults: Array<{ query: string; matchCount: number }> };
  generateId: () => string;
  storeResult: (id: string, data: StoredResult) => void;
  getResult: (id: string) => StoredResult | null;
  buildResearchArtifact: (input: {
    query: string;
    provider?: string;
    summary?: string;
    results: Array<SearchResult & { rank?: number }>;
    fetched?: ExtractedContent[];
    recency?: "day" | "week" | "month" | "year";
    domainFilter?: string[];
  }) => ResearchArtifact;
  withClaimAssessment: (artifact: ResearchArtifact, claims: string[]) => ResearchArtifact;
  storeResearchArtifact: (artifact: ResearchArtifact) => void;
};

export type WebAccessModuleLoader = () => Promise<WebAccessModules>;

export type WebAccessToolOptions = {
  moduleLoader?: WebAccessModuleLoader;
};

type WebAccessStorageModules = Pick<WebAccessModules, "generateId" | "storeResult" | "getResult">;
type WebAccessSourceCheckModules = Pick<WebAccessModules, "buildResearchArtifact" | "withClaimAssessment" | "storeResearchArtifact">;

type WebAccessModuleAccessors = {
  search: () => Promise<WebAccessModules["search"]>;
  fetchAllContent: () => Promise<WebAccessModules["fetchAllContent"]>;
  findContent: () => Promise<WebAccessModules["findContent"]>;
  storage: () => Promise<WebAccessStorageModules>;
  sourceCheck: () => Promise<WebAccessSourceCheckModules>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (error instanceof Error && error.name === "AbortError") || message.includes("abort");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
  }
}

function truncate(text: string, limit = MAX_RESULT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}\n\n[notice: output truncated to ${limit} characters]`, truncated: true };
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function stringList(value: unknown, label: string, max: number): string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const normalized = values
    .map((entry) => nonEmptyString(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (values.length > 0 && normalized.length !== values.length) {
    throw new Error(`${label} must contain only non-empty strings`);
  }
  if (normalized.length > max) throw new Error(`${label} supports at most ${max} entries`);
  return [...new Set(normalized)];
}

function optionalRecency(value: unknown): "day" | "week" | "month" | "year" | undefined {
  if (value === undefined) return undefined;
  if (value === "day" || value === "week" || value === "month" || value === "year") return value;
  throw new Error("recencyFilter must be day, week, month, or year");
}

function optionalNumber(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return Math.min(max, Math.max(min, value));
}

function providerSelection(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  if (Array.isArray(value)) return stringList(value, "provider", 20).map((entry) => entry.toLowerCase());
  throw new Error("provider must be a provider name or a non-empty provider array");
}

function makeToolResult(content: string, isError = false): ToolResult {
  return isError ? { content, isError: true } : { content };
}

function formatSearchResult(query: string, response: SearchResponse): string {
  const lines = [
    `Query: ${query}`,
    `Provider: ${response.provider ?? "auto"}`,
    "",
    response.answer?.trim() || "No synthesized answer returned.",
  ];
  if (response.results.length > 0) {
    lines.push("", "Sources:");
    response.results.forEach((result, index) => {
      lines.push(`${index + 1}. ${result.title || result.url}\n   ${result.url}\n   ${result.snippet || ""}`);
    });
  }
  return lines.join("\n");
}

function formatFetchedResult(result: ExtractedContent, index: number): string {
  const header = `${index + 1}. ${result.title || result.url}\nURL: ${result.url}`;
  if (result.error) return `${header}\nError: ${result.error}`;
  const status = result.status !== undefined ? `\nHTTP status: ${result.status}` : "";
  const body = result.content || (result.thumbnail || result.frames?.length ? "[binary media returned]" : "[empty content]");
  return `${header}${status}\n\n${body}`;
}

function contentParts(results: ExtractedContent[], text: string): ContentPart[] {
  const parts: ContentPart[] = [textPart(text)];
  for (const result of results) {
    if (result.thumbnail?.data && result.thumbnail.mimeType) {
      parts.push(imagePart(result.thumbnail.mimeType, result.thumbnail.data, result.url));
    }
    for (const frame of result.frames ?? []) {
      if (frame.data && frame.mimeType) {
        parts.push(imagePart(frame.mimeType, frame.data, `${result.url} @ ${frame.timestamp}`));
      }
    }
  }
  return parts;
}

function getLocalTarget(value: string, cwd: string): string | undefined {
  if (value.startsWith("file:")) {
    try {
      return fileURLToPath(value);
    } catch {
      throw new Error(`Invalid local file URL: ${value}`);
    }
  }
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return undefined;
    if (url.protocol) throw new Error(`Unsupported fetch URL protocol: ${url.protocol}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unsupported fetch URL protocol:")) throw error;
  }
  return path.resolve(cwd, value);
}

async function validateFetchTargets(urls: string[], cwd: string): Promise<void> {
  for (const value of urls) {
    let remote = false;
    try {
      const url = new URL(value);
      remote = url.protocol === "http:" || url.protocol === "https:";
    } catch {
      remote = false;
    }
    if (remote) continue;
    const target = getLocalTarget(value, cwd);
    if (!target) continue;
    const relative = path.relative(cwd, target);
    const resolved = await resolveWorkspacePath(cwd, relative);
    if (!resolved.ok) throw new Error(resolved.error);
  }
}

function searchSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      query: { type: "string", description: "Single web search query" },
      queries: { type: "array", items: { type: "string" }, maxItems: MAX_SEARCH_QUERIES, description: "Multiple varied search queries" },
      numResults: { type: "integer", minimum: 1, maximum: 20, description: "Results per query" },
      includeContent: { type: "boolean", description: "Fetch full source content for later retrieval" },
      recencyFilter: { type: "string", enum: ["day", "week", "month", "year"] },
      domainFilter: { type: "array", items: { type: "string" } },
      provider: { description: "Provider name or a provider array" },
    },
    additionalProperties: false,
  };
}

function fetchSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      url: { type: "string", description: "One HTTP(S) URL or workspace-local video/file path" },
      urls: { type: "array", items: { type: "string" }, maxItems: MAX_FETCH_URLS },
      forceClone: { type: "boolean", description: "Force cloning a large GitHub repository" },
      prompt: { type: "string", description: "Question for video understanding" },
      mode: { type: "string", enum: ["readable", "raw"], description: "Readable extraction or exact textual HTTP body" },
      timestamp: { type: "string", description: "Video timestamp or range" },
      frames: { type: "integer", minimum: 1, maximum: 12 },
      model: { type: "string", description: "Optional Gemini video model override" },
    },
    additionalProperties: false,
  };
}

function contentSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      responseId: { type: "string" },
      query: { type: "string" },
      queryIndex: { type: "integer", minimum: 0 },
      url: { type: "string" },
      urlIndex: { type: "integer", minimum: 0 },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_CHARS },
      findText: { description: "Text or texts to find" },
      findMode: { type: "string", enum: ["exact", "case-insensitive", "fuzzy"] },
    },
    required: ["responseId"],
    additionalProperties: false,
  };
}

function sourceCheckSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      claim: { type: "string" },
      queries: { type: "array", items: { type: "string" }, maxItems: MAX_SEARCH_QUERIES },
      numResults: { type: "integer", minimum: 1, maximum: 20 },
      fetchContent: { type: "boolean" },
      recencyFilter: { type: "string", enum: ["day", "week", "month", "year"] },
      domainFilter: { type: "array", items: { type: "string" } },
      provider: { description: "Provider name or a provider array" },
    },
    required: ["claim"],
    additionalProperties: false,
  };
}

function renderStoredResult(
  data: StoredResult,
  args: Record<string, unknown>,
  findContent: WebAccessModules["findContent"],
): string {
  const findValue = args.findText;
  const findQueries = Array.isArray(findValue)
    ? stringList(findValue, "findText", 10)
    : findValue === undefined ? [] : stringList(findValue, "findText", 1);
  const findMode = args.findMode === undefined ? "case-insensitive" : args.findMode;
  if (findMode !== "exact" && findMode !== "case-insensitive" && findMode !== "fuzzy") {
    throw new Error("findMode must be exact, case-insensitive, or fuzzy");
  }
  if (findQueries.length > 0 && (args.offset !== undefined || args.limit !== undefined)) {
    throw new Error("findText cannot be combined with offset or limit");
  }

  if (data.type === "research") {
    const serialized = JSON.stringify(data.artifact ?? {}, null, 2);
    if (findQueries.length > 0) return findContent(serialized, findQueries, findMode).text;
    const offset = optionalNumber(args.offset, "offset", 0, serialized.length) ?? 0;
    const limit = optionalNumber(args.limit, "limit", 1, MAX_RESULT_CHARS) ?? MAX_RESULT_CHARS;
    const slice = serialized.slice(offset, offset + limit);
    const nextOffset = offset + slice.length < serialized.length ? offset + slice.length : undefined;
    return `${slice}${nextOffset !== undefined ? `\n\n[next offset: ${nextOffset}]` : ""}`;
  }

  if (data.type === "search") {
    const queries = data.queries ?? [];
    const requestedQuery = nonEmptyString(args.query);
    const queryIndex = args.queryIndex === undefined
      ? undefined
      : optionalNumber(args.queryIndex, "queryIndex", 0, Math.max(0, queries.length - 1));
    const selected = requestedQuery
      ? queries.find((entry) => entry.query === requestedQuery)
      : queryIndex !== undefined ? queries[queryIndex] : undefined;
    const serialized = JSON.stringify(selected ?? queries, null, 2);
    if (findQueries.length > 0) return findContent(serialized, findQueries, findMode).text;
    return truncate(serialized).text;
  }

  const urls = data.urls ?? [];
  const requestedUrl = nonEmptyString(args.url);
  const urlIndex = args.urlIndex === undefined
    ? undefined
    : optionalNumber(args.urlIndex, "urlIndex", 0, Math.max(0, urls.length - 1));
  const selected = requestedUrl
    ? urls.find((entry) => entry.url === requestedUrl)
    : urlIndex !== undefined ? urls[urlIndex] : urls[0];
  if (!selected) throw new Error("No stored URL matches the requested selector");
  if (findQueries.length > 0) return findContent(selected.content, findQueries, findMode).text;
  const offset = optionalNumber(args.offset, "offset", 0, selected.content.length) ?? 0;
  const limit = optionalNumber(args.limit, "limit", 1, MAX_RESULT_CHARS) ?? MAX_RESULT_CHARS;
  const slice = selected.content.slice(offset, offset + limit);
  const nextOffset = offset + slice.length < selected.content.length ? offset + slice.length : undefined;
  return `${slice}${nextOffset !== undefined ? `\n\n[next offset: ${nextOffset}]` : ""}`;
}

function lazyModule<T>(loader: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => promise ??= loader();
}

function createModuleAccessors(options: WebAccessToolOptions): WebAccessModuleAccessors {
  const loadCustom = options.moduleLoader ? lazyModule(options.moduleLoader) : undefined;
  const load = (specifier: string) => import(specifier) as Promise<Record<string, unknown>>;
  const select = <T>(
    fallback: () => Promise<T>,
    pick: (modules: WebAccessModules) => T,
  ): (() => Promise<T>) => loadCustom
    ? () => loadCustom().then(pick)
    : lazyModule(fallback);

  return {
    search: select(
      () => load("pi-web-access/gemini-search.ts").then((module) => module.search as WebAccessModules["search"]),
      (modules) => modules.search,
    ),
    fetchAllContent: select(
      () => load("pi-web-access/extract.ts").then((module) => module.fetchAllContent as WebAccessModules["fetchAllContent"]),
      (modules) => modules.fetchAllContent,
    ),
    findContent: select(
      () => load("pi-web-access/content-find.ts").then((module) => module.findContent as WebAccessModules["findContent"]),
      (modules) => modules.findContent,
    ),
    storage: select(
      () => load("pi-web-access/storage.ts").then((module) => ({
        generateId: module.generateId as WebAccessModules["generateId"],
        storeResult: module.storeResult as WebAccessModules["storeResult"],
        getResult: module.getResult as WebAccessModules["getResult"],
      })),
      (modules) => ({
        generateId: modules.generateId,
        storeResult: modules.storeResult,
        getResult: modules.getResult,
      }),
    ),
    sourceCheck: select(
      () => load("pi-web-access/source-check.ts").then((module) => ({
        buildResearchArtifact: module.buildResearchArtifact as WebAccessModules["buildResearchArtifact"],
        withClaimAssessment: module.withClaimAssessment as WebAccessModules["withClaimAssessment"],
        storeResearchArtifact: module.storeResearchArtifact as WebAccessModules["storeResearchArtifact"],
      })),
      (modules) => ({
        buildResearchArtifact: modules.buildResearchArtifact,
        withClaimAssessment: modules.withClaimAssessment,
        storeResearchArtifact: modules.storeResearchArtifact,
      }),
    ),
  };
}

export function createWebAccessTools(cwd: string, options: WebAccessToolOptions = {}): Tool[] {
  const resolvedCwd = path.resolve(cwd);
  const modules = createModuleAccessors(options);

  const webSearch: Tool = {
    name: "web_search",
    displayName: "Web Search",
    description: "Search the web and return answers with source URLs.",
    source: WEB_SOURCE,
    annotations: { readOnlyHint: true, openWorldHint: true },
    parameters: searchSchema(),
    async execute(rawArgs, signal) {
      const args = asRecord(rawArgs);
      try {
        throwIfAborted(signal);
        const queryValues = stringList(args.queries ?? args.query, "query", MAX_SEARCH_QUERIES);
        if (queryValues.length === 0) return makeToolResult("query or queries is required", true);
        const numResults = optionalNumber(args.numResults, "numResults", 1, 20);
        const recencyFilter = optionalRecency(args.recencyFilter);
        const domainFilter = args.domainFilter === undefined ? undefined : stringList(args.domainFilter, "domainFilter", 50);
        const provider = providerSelection(args.provider);
        const includeContent = args.includeContent === true;
        const search = await modules.search();
        const queryResults: StoredQuery[] = [];
        const inlineContent: ExtractedContent[] = [];
        for (const query of queryValues) {
          throwIfAborted(signal);
          try {
            const response = await search(query, {
              ...(numResults !== undefined ? { numResults } : {}),
              ...(recencyFilter ? { recencyFilter } : {}),
              ...(domainFilter ? { domainFilter } : {}),
              ...(provider !== undefined ? { provider } : {}),
              includeContent,
              signal,
            });
            queryResults.push({
              query,
              answer: response.answer ?? "",
              results: response.results ?? [],
              error: null,
              provider: response.provider,
            });
            inlineContent.push(...(response.inlineContent ?? []));
          } catch (error) {
            if (isAbortError(error)) throw error;
            queryResults.push({ query, answer: "", results: [], error: errorMessage(error) });
          }
        }
        const successful = queryResults.filter((entry) => !entry.error);
        if (successful.length === 0) {
          return makeToolResult(queryResults.map((entry) => `${entry.query}: ${entry.error}`).join("\n"), true);
        }

        const storage = await modules.storage();
        const searchId = storage.generateId();
        storage.storeResult(searchId, { id: searchId, type: "search", timestamp: Date.now(), queries: queryResults });
        const output = queryResults.map((entry) => entry.error
          ? `Query: ${entry.query}\nError: ${entry.error}`
          : formatSearchResult(entry.query, entry)).join("\n\n---\n\n");
        const lines = [output, `\nSearch responseId: ${searchId}`];

        if (includeContent) {
          const urls = [...new Set(successful.flatMap((entry) => entry.results.map((result) => result.url)))];
          const covered = new Set(inlineContent.map((entry) => entry.url));
          const missing = urls.filter((url) => !covered.has(url));
          if (missing.length > 0) {
            const fetchAllContent = await modules.fetchAllContent();
            inlineContent.push(...await fetchAllContent(missing, signal));
          }
          if (inlineContent.length > 0) {
            const contentId = storage.generateId();
            storage.storeResult(contentId, { id: contentId, type: "fetch", timestamp: Date.now(), urls: inlineContent });
            lines.push(`Full source content responseId: ${contentId}`);
          }
        }
        return makeToolResult(truncate(lines.join("\n")).text);
      } catch (error) {
        if (isAbortError(error)) throw error;
        return makeToolResult(errorMessage(error), true);
      }
    },
  };

  const fetchContent: Tool = {
    name: "fetch_content",
    displayName: "Fetch Content",
    description: "Fetch HTTP(S) URLs or local video/files. Extract readable or raw content.",
    source: WEB_SOURCE,
    annotations: { readOnlyHint: true, openWorldHint: true },
    parameters: fetchSchema(),
    async execute(rawArgs, signal) {
      const args = asRecord(rawArgs);
      try {
        throwIfAborted(signal);
        const urls = stringList(args.urls ?? args.url, "url", MAX_FETCH_URLS);
        if (urls.length === 0) return makeToolResult("url or urls is required", true);
        await validateFetchTargets(urls, resolvedCwd);
        const mode = args.mode === undefined ? undefined : args.mode;
        if (mode !== undefined && mode !== "readable" && mode !== "raw") {
          return makeToolResult('mode must be "readable" or "raw"; answer mode is not available in the native adapter', true);
        }
        const frames = optionalNumber(args.frames, "frames", 1, 12);
        const fetchAllContent = await modules.fetchAllContent();
        const results = await fetchAllContent(urls, signal, {
          ...(typeof args.forceClone === "boolean" ? { forceClone: args.forceClone } : {}),
          ...(nonEmptyString(args.prompt) ? { prompt: nonEmptyString(args.prompt) } : {}),
          ...(nonEmptyString(args.timestamp) ? { timestamp: nonEmptyString(args.timestamp) } : {}),
          ...(frames !== undefined ? { frames } : {}),
          ...(nonEmptyString(args.model) ? { model: nonEmptyString(args.model) } : {}),
          ...(mode !== undefined ? { mode } : {}),
        });
        const storage = await modules.storage();
        const responseId = storage.generateId();
        storage.storeResult(responseId, { id: responseId, type: "fetch", timestamp: Date.now(), urls: results });
        const rendered = results.map(formatFetchedResult).join("\n\n---\n\n");
        const output = `${truncate(rendered).text}\n\nFetch responseId: ${responseId}`;
        const parts = contentParts(results, truncate(output).text);
        return { content: parts };
      } catch (error) {
        if (isAbortError(error)) throw error;
        return makeToolResult(errorMessage(error), true);
      }
    },
  };

  const getSearchContent: Tool = {
    name: "get_search_content",
    displayName: "Get Search Content",
    description: "Retrieve content slices from a previous web_search, fetch_content, or source_check.",
    source: WEB_SOURCE,
    annotations: { readOnlyHint: true },
    parameters: contentSchema(),
    async execute(rawArgs) {
      const args = asRecord(rawArgs);
      try {
        const responseId = nonEmptyString(args.responseId);
        if (!responseId) return makeToolResult("responseId is required", true);
        const storage = await modules.storage();
        const data = storage.getResult(responseId);
        if (!data) return makeToolResult(`No stored result for ${responseId}`, true);
        const findContent = await modules.findContent();
        return makeToolResult(truncate(renderStoredResult(data, args, findContent)).text);
      } catch (error) {
        return makeToolResult(errorMessage(error), true);
      }
    },
  };

  const sourceCheck: Tool = {
    name: "source_check",
    displayName: "Source Check",
    description: "Check a claim against web sources. Returns structured assessment with passages.",
    source: WEB_SOURCE,
    annotations: { readOnlyHint: true, openWorldHint: true },
    parameters: sourceCheckSchema(),
    async execute(rawArgs, signal) {
      const args = asRecord(rawArgs);
      try {
        throwIfAborted(signal);
        const claim = nonEmptyString(args.claim);
        if (!claim) return makeToolResult("claim is required", true);
        const queries = stringList(args.queries ?? claim, "queries", MAX_SEARCH_QUERIES);
        const numResults = optionalNumber(args.numResults, "numResults", 1, 20) ?? 5;
        const recencyFilter = optionalRecency(args.recencyFilter);
        const domainFilter = args.domainFilter === undefined ? undefined : stringList(args.domainFilter, "domainFilter", 50);
        const provider = providerSelection(args.provider);
        const search = await modules.search();
        const searches: StoredQuery[] = [];
        for (const query of queries) {
          throwIfAborted(signal);
          try {
            const response = await search(query, {
              numResults,
              ...(recencyFilter ? { recencyFilter } : {}),
              ...(domainFilter ? { domainFilter } : {}),
              ...(provider !== undefined ? { provider } : {}),
              signal,
            });
            searches.push({ query, answer: response.answer ?? "", results: response.results ?? [], error: null, provider: response.provider });
          } catch (error) {
            if (isAbortError(error)) throw error;
            searches.push({ query, answer: "", results: [], error: errorMessage(error) });
          }
        }
        const allResults = searches.flatMap((entry) => entry.results.map((result, index) => ({ ...result, rank: index + 1 })));
        const fetched = args.fetchContent === true && allResults.length > 0
          ? await (await modules.fetchAllContent())([...new Set(allResults.slice(0, 5).map((result) => result.url))], signal)
          : undefined;
        const sourceCheck = await modules.sourceCheck();
        const artifact = sourceCheck.buildResearchArtifact({
          query: queries.join(" | "),
          provider: searches.find((entry) => entry.provider)?.provider,
          summary: searches.filter((entry) => !entry.error).map((entry) => entry.answer).filter(Boolean).join("\n\n"),
          results: allResults,
          ...(fetched ? { fetched } : {}),
          ...(recencyFilter ? { recency: recencyFilter } : {}),
          ...(domainFilter ? { domainFilter } : {}),
        });
        const assessed = sourceCheck.withClaimAssessment(artifact, [claim]);
        if (searches.some((entry) => entry.error)) {
          assessed.errors = searches.filter((entry) => entry.error).map((entry) => ({ query: entry.query, error: entry.error! }));
        }
        sourceCheck.storeResearchArtifact(assessed);
        const output = {
          responseId: assessed.id,
          claim,
          status: assessed.claims?.[0]?.status ?? "missing-evidence",
          sources: assessed.sources,
          passages: assessed.passages,
          assessment: assessed.claims?.[0],
          errors: assessed.errors,
        };
        return makeToolResult(truncate(JSON.stringify(output, null, 2)).text);
      } catch (error) {
        if (isAbortError(error)) throw error;
        return makeToolResult(errorMessage(error), true);
      }
    },
  };

  return [webSearch, fetchContent, getSearchContent, sourceCheck];
}
