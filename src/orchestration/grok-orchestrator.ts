/**
 * Grok-style search-and-orchestrate workflow.
 * 
 * Performs web search, analyzes results, and orchestrates multiple
 * specialized subagents with custom models to process the information.
 */

import type { WorkflowInvoker } from "./workflow.ts";

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  content?: string;
};

export type OrchestratorTask = {
  assignee: string;
  model?: string;
  prompt: string;
  dependencies?: string[];
};

export type GrokWorkflowConfig = {
  query: string;
  maxSearchResults?: number;
  plannerModel?: string;
  taskModels?: Record<string, string>;
  invoke: WorkflowInvoker;
  searchTool: (query: string, limit: number) => Promise<SearchResult[]>;
  onProgress?: (stage: string, data: unknown) => void | Promise<void>;
};

export type GrokWorkflowResult = {
  query: string;
  searchResults: SearchResult[];
  orchestrationPlan: OrchestratorTask[];
  taskResults: Record<string, string>;
  synthesis: string;
};

export async function runGrokOrchestrator(
  config: GrokWorkflowConfig,
): Promise<GrokWorkflowResult> {
  const maxResults = config.maxSearchResults ?? 10;
  
  // Stage 1: Web Search
  await config.onProgress?.("searching", { query: config.query });
  const searchResults = await config.searchTool(config.query, maxResults);
  
  // Stage 2: Analyze and Plan
  await config.onProgress?.("planning", { resultCount: searchResults.length });
  const planContext = {
    query: config.query,
    searchResults: searchResults.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
    })),
  };
  
  const planPrompt = [
    `You are an orchestrator AI. A user has searched for: "${config.query}"`,
    ``,
    `Search results summary:`,
    ...searchResults.map((r, i) => `${i + 1}. ${r.title} - ${r.snippet}`),
    ``,
    `Your job: Break this into specialized tasks for different subagents.`,
    `Output a JSON array of tasks with this schema:`,
    `[`,
    `  {`,
    `    "assignee": "researcher|analyst|coder|summarizer|fact-checker",`,
    `    "model": "optional-model-id",`,
    `    "prompt": "Clear instruction for this subagent",`,
    `    "dependencies": ["optional", "list", "of", "prior", "task", "assignees"]`,
    `  }`,
    `]`,
    ``,
    `Guidelines:`,
    `- researcher: extract facts from sources`,
    `- analyst: interpret data, find patterns`,
    `- coder: generate code examples`,
    `- summarizer: create concise summaries`,
    `- fact-checker: verify claims`,
    `- Use dependencies to order tasks that need prior results`,
    `- Suggest custom models if specific expertise is needed`,
  ].join("\n");
  
  const planResponse = await config.invoke({
    profile: "researcher",
    task: planPrompt,
    sharedContext: JSON.stringify(planContext),
  });
  
  const orchestrationPlan = parsePlan(planResponse);
  
  // Stage 3: Execute Tasks in Dependency Order
  await config.onProgress?.("executing", { taskCount: orchestrationPlan.length });
  const taskResults: Record<string, string> = {};
  const completed = new Set<string>();
  
  const executeTasks = async (tasks: OrchestratorTask[]): Promise<void> => {
    const ready = tasks.filter((t) => 
      !completed.has(t.assignee) &&
      (t.dependencies ?? []).every((dep) => completed.has(dep))
    );
    
    if (ready.length === 0) return;
    
    await Promise.all(
      ready.map(async (task) => {
        const dependencyContext = task.dependencies
          ? Object.fromEntries(
              task.dependencies.map((dep) => [dep, taskResults[dep]])
            )
          : {};
        
        const fullContext = {
          query: config.query,
          searchResults,
          dependencies: dependencyContext,
        };
        
        const model = task.model || config.taskModels?.[task.assignee];
        const profile = mapAssigneeToProfile(task.assignee);
        
        const result = await config.invoke({
          profile,
          task: task.prompt,
          sharedContext: JSON.stringify(fullContext),
        });
        
        taskResults[task.assignee] = result;
        completed.add(task.assignee);
        
        await config.onProgress?.("task-complete", {
          assignee: task.assignee,
          model,
        });
      })
    );
    
    if (completed.size < tasks.length) {
      await executeTasks(tasks);
    }
  };
  
  await executeTasks(orchestrationPlan);
  
  // Stage 4: Synthesize Final Answer
  await config.onProgress?.("synthesizing", { taskCount: completed.size });
  const synthesisPrompt = [
    `Synthesize all subagent results into a comprehensive answer.`,
    ``,
    `Original query: ${config.query}`,
    ``,
    `Subagent results:`,
    ...Object.entries(taskResults).map(([agent, result]) => 
      `\n## ${agent}\n${result}`
    ),
  ].join("\n");
  
  const synthesis = await config.invoke({
    profile: "researcher",
    task: synthesisPrompt,
    sharedContext: JSON.stringify({ query: config.query }),
  });
  
  return {
    query: config.query,
    searchResults,
    orchestrationPlan,
    taskResults,
    synthesis,
  };
}

function parsePlan(response: string): OrchestratorTask[] {
  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    return [{
      assignee: "researcher",
      prompt: "Summarize the search results",
    }];
  }
  
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [{
      assignee: "researcher",
      prompt: "Summarize the search results",
    }];
  }
}

function mapAssigneeToProfile(assignee: string): string {
  const mapping: Record<string, string> = {
    researcher: "researcher",
    analyst: "researcher",
    coder: "coder",
    summarizer: "researcher",
    "fact-checker": "reviewer",
  };
  return mapping[assignee] || "researcher";
}
