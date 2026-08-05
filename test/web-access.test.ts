import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contentAsString } from "../src/content.ts";
import { createTools } from "../src/tools/index.ts";
import { createWebAccessTools, type WebAccessModules } from "../src/web-access/index.ts";

function createFakeWebModules(): { modules: WebAccessModules; stored: Map<string, unknown>; calls: string[] } {
  const stored = new Map<string, unknown>();
  const calls: string[] = [];
  let id = 0;
  const modules: WebAccessModules = {
    search: async (query) => {
      calls.push(`search:${query}`);
      return {
        answer: `Answer for ${query}`,
        provider: "fake",
        results: [{ title: "Example", url: "https://example.com/docs", snippet: "Example result" }],
      };
    },
    fetchAllContent: async (urls) => {
      calls.push(`fetch:${urls.join(",")}`);
      return urls.map((url) => ({
        url,
        title: "Example document",
        content: "The example document contains the requested passage.",
        error: null,
      }));
    },
    findContent: (text, queries) => ({
      text: `matches=${queries.join(",")}:${text.includes(queries[0] ?? "") ? "yes" : "no"}`,
      matchCount: 1,
      returnedMatches: 1,
      queryResults: queries.map((query) => ({ query, matchCount: 1 })),
    }),
    generateId: () => `fake-${++id}`,
    storeResult: (key, value) => stored.set(key, value),
    getResult: (key) => stored.get(key) as never ?? null,
    buildResearchArtifact: (input) => ({
      id: "research-1",
      type: "research",
      timestamp: Date.now(),
      query: input.query,
      provider: input.provider,
      sources: input.results,
      passages: (input.fetched ?? []).map((page, index) => ({
        passage_id: `passage-${index}`,
        source_url: page.url,
        text: page.content,
      })),
    }),
    withClaimAssessment: (artifact, claims) => ({
      ...artifact,
      claims: claims.map((claim) => ({
        claim,
        status: "supported",
        supporting_passages: ["passage-0"],
        contradicting_passages: [],
        rationale: "fake evidence",
        confidence: 0.9,
      })),
    }),
    storeResearchArtifact: (artifact) => stored.set(artifact.id, {
      id: artifact.id,
      type: "research",
      timestamp: artifact.timestamp,
      artifact,
    }),
  };
  return { modules, stored, calls };
}

describe("pi-web-access adapter", () => {
  it("registers all four native web tools without loading the Pi UI", () => {
    const tools = createWebAccessTools(process.cwd(), { moduleLoader: async () => createFakeWebModules().modules });
    assert.deepEqual(tools.map((tool) => tool.name), [
      "web_search",
      "fetch_content",
      "get_search_content",
      "source_check",
    ]);
    for (const tool of tools) {
      assert.deepEqual(tool.source, { kind: "web", package: "pi-web-access" });
    }
  });

  it("searches, stores the response, and retrieves bounded content", async () => {
    const fake = createFakeWebModules();
    const tools = createWebAccessTools(process.cwd(), { moduleLoader: async () => fake.modules });
    const search = tools.find((tool) => tool.name === "web_search")!;
    const getContent = tools.find((tool) => tool.name === "get_search_content")!;

    const result = await search.execute({ query: "adapter test", includeContent: true });
    const text = contentAsString(result.content);
    assert.equal(result.isError, undefined);
    assert.match(text, /Answer for adapter test/);
    assert.match(text, /Search responseId: fake-1/);
    assert.match(text, /Full source content responseId: fake-2/);
    assert.deepEqual(fake.calls, [
      "search:adapter test",
      "fetch:https://example.com/docs",
    ]);

    const stored = await getContent.execute({ responseId: "fake-2", findText: "requested passage" });
    assert.equal(stored.isError, undefined);
    assert.match(contentAsString(stored.content), /matches=requested passage:yes/);
  });

  it("keeps local fetches inside the workspace", async () => {
    let loaded = false;
    const tools = createWebAccessTools(process.cwd(), {
      moduleLoader: async () => {
        loaded = true;
        return createFakeWebModules().modules;
      },
    });
    const fetch = tools.find((tool) => tool.name === "fetch_content")!;
    const result = await fetch.execute({ url: "/tmp/mini-agent-outside-video.mp4" });
    assert.equal(result.isError, true);
    assert.match(contentAsString(result.content), /escapes workspace cwd|Path escapes workspace cwd/);
    assert.equal(loaded, false);
  });

  it("adds web tools to the normal Tool registry and honors explicit selection", () => {
    const defaultTools = createTools(process.cwd(), { codebase: false });
    assert.ok(defaultTools.some((tool) => tool.name === "web_search"));
    assert.ok(defaultTools.some((tool) => tool.name === "fetch_content"));

    const selectedTools = createTools(process.cwd(), { codebase: false, tools: ["read", "web_search"] });
    assert.deepEqual(selectedTools.map((tool) => tool.name), ["read", "web_search"]);
  });
});
