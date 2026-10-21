/**
 * Subagent tool with custom model configuration support.
 * 
 * Extends the base subagent functionality to allow each subagent
 * to use a different model from the catalog or custom providers.
 */

import type { ModelRef } from "../models.ts";
import type { SubagentProfile } from "./types.ts";

export type CustomModelSubagentConfig = {
  profile: SubagentProfile;
  modelOverride?: string | ModelRef;
  contextTier?: "default" | "long_context";
  reasoningEffort?: string;
};

export type SubagentWithModelResult = {
  agentId: string;
  profile: string;
  model: string;
  turns: number;
  output: string;
  cost?: {
    inputTokens: number;
    outputTokens: number;
    totalCost: number;
  };
};

/**
 * Spawn a subagent with a specific model.
 * 
 * This allows the orchestrator to assign different models to different
 * subagents based on their task requirements.
 */
export function createSubagentWithModel(
  config: CustomModelSubagentConfig,
): {
  profile: SubagentProfile;
  modelId: string | undefined;
  contextTier: string | undefined;
  reasoningEffort: string | undefined;
} {
  const modelId = typeof config.modelOverride === "string"
    ? config.modelOverride
    : config.modelOverride?.id;
  
  return {
    profile: config.profile,
    modelId,
    contextTier: config.contextTier,
    reasoningEffort: config.reasoningEffort,
  };
}

/**
 * Model recommendation based on task type.
 */
export function recommendModelForTask(taskType: string): string | undefined {
  const recommendations: Record<string, string> = {
    "code-generation": "claude-sonnet-4",
    "code-review": "gpt-4o",
    "research": "grok-3",
    "analysis": "deepseek-v4",
    "fast-summary": "claude-haiku-4",
    "reasoning": "o4-mini",
  };
  
  return recommendations[taskType];
}

/**
 * Parse model assignment from orchestrator plan.
 */
export function parseModelAssignment(
  taskDescription: string,
  availableModels: ModelRef[],
): ModelRef | undefined {
  const modelHints = [
    /use (?:the )?(\S+) model/i,
    /assign (?:to )?(\S+)/i,
    /model[:\s]+(\S+)/i,
  ];
  
  for (const pattern of modelHints) {
    const match = taskDescription.match(pattern);
    if (match?.[1]) {
      const modelId = match[1];
      return availableModels.find((m) => 
        m.id === modelId || 
        m.name.toLowerCase().includes(modelId.toLowerCase())
      );
    }
  }
  
  return undefined;
}
