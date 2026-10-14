/**
 * `/api/models` — model catalog discovery and search.
 */

import type { Express } from "express";
import { getAvailableModels, searchModels } from "../../models.ts";
import { ALL_THINKING_LEVELS, modelSupportsMappedLevel } from "../../pi-ai/thinking-levels.ts";

export type ModelRoutesContext = {
  /** Model id advertised as the server default. */
  defaultModel: string;
};

function thinkingLevelsForModel(model: ReturnType<typeof getAvailableModels>[number]): string[] {
  if (!model.reasoning) return [];
  return ALL_THINKING_LEVELS.filter((level) =>
    modelSupportsMappedLevel(model.reasoning, model.thinkingLevelMap, level),
  );
}

export function registerModelRoutes(app: Express, context: ModelRoutesContext): void {
  app.get("/api/models", (request, response) => {
    const query = String(request.query.q ?? "").trim();
    const available = getAvailableModels();
    const models = query ? searchModels(query, available) : available;
    response.json({
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        provider: model.provider,
        qualifiedId: `${model.provider}/${model.id}`,
        capabilities: model.capabilities,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reasoning: model.reasoning,
        thinkingLevels: thinkingLevelsForModel(model),
      })),
      defaultModel: context.defaultModel,
    });
  });
}
