/**
 * `/api/models` — model catalog discovery and search.
 */

import type { Express } from "express";
import { getAvailableModels, searchModels, type ModelRef } from "../../models.ts";
import { getSelectableThinkingLevels } from "../../think-intensity.ts";

export type ModelRoutesContext = {
  /** Model id advertised as the server default. */
  defaultModel: string;
  /** Additional models persisted by the Web custom-provider editor. */
  customModels?: () => ModelRef[];
};

function thinkingLevelsForModel(model: ReturnType<typeof getAvailableModels>[number]): string[] {
  if (!model.reasoning) return [];
  return getSelectableThinkingLevels(model);
}

export function registerModelRoutes(app: Express, context: ModelRoutesContext): void {
  app.get("/api/models", (request, response) => {
    const query = String(request.query.q ?? "").trim();
    // A persisted Web provider may intentionally override a built-in route
    // with the same provider/model id, matching Harness profile semantics.
    const available = [...getAvailableModels(), ...(context.customModels?.() ?? [])];
    const unique = [...new Map(available.map((model) => [`${model.provider}/${model.id}`.toLowerCase(), model])).values()];
    const models = query ? searchModels(query, unique) : unique;
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
        defaultThinkingLevel: model.defaultThinkingLevel,
      })),
      defaultModel: context.defaultModel,
    });
  });
}
