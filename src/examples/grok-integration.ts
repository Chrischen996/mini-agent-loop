/**
 * Real-world integration example for Grok-style orchestration.
 * 
 * This shows how to integrate with:
 * - Real web search APIs (Brave, Exa, Tavily)
 * - Your existing subagent system
 * - Custom model configuration
 */

import type { ModelRef } from "../models.ts";
import { runGrokOrchestrator, type SearchResult } from "../orchestration/grok-orchestrator.ts";
import { createSubagentWithModel, recommendModelForTask } from "../subagent/custom-model-tool.ts";
import { researcherProfile, coderProfile, reviewerProfile } from "../subagent/profiles.ts";

// ─── Web Search Integration ──────────────────────────────────────────────────

/**
 * Integrate with Brave Search API
 * https://brave.com/search/api/
 */
async function braveSearch(query: string, limit: number): Promise<SearchResult[]> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) throw new Error("BRAVE_API_KEY not set");
  
  const response = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
    { headers: { "X-Subscription-Token": apiKey } }
  );
  
  const data = (await response.json()) as {
    web?: { results?: { title?: string; url?: string; description?: string }[] };
  };
  return data.web?.results?.map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.description ?? "",
  })) ?? [];
}

/**
 * Integrate with Exa.ai (semantic search)
 * https://exa.ai/
 */
async function exaSearch(query: string, limit: number): Promise<SearchResult[]> {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) throw new Error("EXA_API_KEY not set");
  
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      query,
      numResults: limit,
      type: "neural",
      contents: { text: true },
    }),
  });
  
  const data = (await response.json()) as {
    results?: { title?: string; url?: string; text?: string }[];
  };
  return data.results?.map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.text?.substring(0, 200) || "",
    content: r.text,
  })) ?? [];
}

/**
 * Integrate with Tavily (AI-optimized search)
 * https://tavily.com/
 */
async function tavilySearch(query: string, limit: number): Promise<SearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY not set");
  
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: limit,
      search_depth: "advanced",
      include_answer: true,
    }),
  });
  
  const data = (await response.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  return data.results?.map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content?.substring(0, 200) || "",
    content: r.content,
  })) ?? [];
}

// ─── Subagent Integration ────────────────────────────────────────────────────

/**
 * Integration with your existing subagent spawn system.
 * Replace this with your actual implementation.
 */
async function spawnSubagentWithModel(input: {
  profile: string;
  task: string;
  model?: string;
  sharedContext: string;
}): Promise<string> {
  // Your actual subagent spawn logic here
  // This is where you'd call your existing subagent system
  // and pass the custom model configuration
  
  console.log(`Spawning ${input.profile} with model ${input.model || "default"}`);
  
  // Example integration point:
  // return await yourSubagentSystem.spawn({
  //   profile: getProfileByName(input.profile),
  //   model: resolveModel(input.model),
  //   prompt: input.task,
  //   context: input.sharedContext,
  // });
  
  throw new Error("Integrate with your subagent system");
}

// ─── Orchestration Workflow ──────────────────────────────────────────────────

export async function runProductionGrokSearch(input: {
  query: string;
  searchProvider?: "brave" | "exa" | "tavily";
  models?: ModelRef[];
  onProgress?: (stage: string, data: any) => void;
}) {
  const searchFn = {
    brave: braveSearch,
    exa: exaSearch,
    tavily: tavilySearch,
  }[input.searchProvider ?? "brave"];
  
  // Auto-assign models based on task type
  const taskModels: Record<string, string> = {
    researcher: recommendModelForTask("research") ?? "grok-3",
    analyst: recommendModelForTask("analysis") ?? "deepseek-v4",
    coder: recommendModelForTask("code-generation") ?? "claude-sonnet-4",
    summarizer: recommendModelForTask("fast-summary") ?? "claude-haiku-4",
    "fact-checker": recommendModelForTask("reasoning") ?? "o4-mini",
  };
  
  return await runGrokOrchestrator({
    query: input.query,
    maxSearchResults: 15,
    taskModels,
    searchTool: searchFn,
    invoke: async ({ profile, task, sharedContext }) => {
      const profileObj = {
        researcher: researcherProfile,
        coder: coderProfile,
        reviewer: reviewerProfile,
      }[profile] ?? researcherProfile;
      
      const model = taskModels[profile];
      
      return await spawnSubagentWithModel({
        profile,
        task,
        model,
        sharedContext,
      });
    },
    onProgress: input.onProgress,
  });
}

// ─── Usage Example ───────────────────────────────────────────────────────────

if (import.meta.main) {
  const result = await runProductionGrokSearch({
    query: process.argv[2] || "how to optimize React performance",
    searchProvider: "exa",
    onProgress: (stage, data) => {
      console.log(`[${stage}]`, data);
    },
  });
  
  console.log("\n=== FINAL ANSWER ===\n");
  console.log(result.synthesis);
}
