import type { LlmConfig, ModelSwitchOverrides } from "../llm/index.ts";
import type { ModelRef } from "../models.ts";
import { findExactModelReferenceMatch, getAllModels, resolveModel } from "../models.ts";
import { hasGatewayOverrides } from "./model-command.ts";

export type ModelSwitcherCallbacks = {
  openModelPicker: (reference?: string, matches?: ModelRef[]) => void;
  commitModelSetup: (setup: { model: ModelRef; baseUrl: string; apiKey: string; field: "apiKey" }, apiKey: string) => Promise<void>;
  startModelSetup: (model: ModelRef, overrides: ModelSwitchOverrides) => void;
};

/**
 * Select a model by reference string, handling ambiguity and setup.
 */
export function selectModel(
  reference: string,
  overrides: ModelSwitchOverrides,
  callbacks: ModelSwitcherCallbacks,
): void {
  const { openModelPicker, commitModelSetup, startModelSetup } = callbacks;

  const applyModel = (model: ModelRef) => {
    if (hasGatewayOverrides(overrides)) {
      void commitModelSetup(
        { model, baseUrl: overrides.baseUrl!, apiKey: overrides.apiKey!, field: "apiKey" },
        overrides.apiKey!,
      );
      return;
    }
    startModelSetup(model, overrides);
  };

  const match = findExactModelReferenceMatch(reference, getAllModels());

  if (!match) {
    // An unknown id is a valid custom OpenAI-compatible model
    applyModel(resolveModel(reference, overrides.baseUrl));
    return;
  }

  if (match.ambiguous || !match.model) {
    openModelPicker(reference, match.matches);
    return;
  }

  applyModel(match.model);
}
