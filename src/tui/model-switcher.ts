import type { LlmConfig, ModelSwitchOverrides } from "../llm/index.ts";
import type { ModelRef } from "../models.ts";
import { findExactModelReferenceMatch, getAllModels, resolveModel } from "../models.ts";
import { loadProfileStoreSync } from "../profile-store.ts";
import { hasGatewayOverrides } from "./model-command.ts";

export type ModelSwitcherCallbacks = {
  openModelPicker: (reference?: string, matches?: ModelRef[]) => void;
  openProfileList: (profileNames?: string[]) => void;
  activateSavedProfile: (profileName: string) => void;
  commitModelSetup: (setup: { model: ModelRef; baseUrl: string; apiKey: string; field: "apiKey" }, apiKey: string) => Promise<void>;
  startModelSetup: (model: ModelRef, overrides: ModelSwitchOverrides) => void | Promise<void>;
};

/**
 * Select a model by reference string, handling ambiguity and setup.
 */
export function selectModel(
  reference: string,
  overrides: ModelSwitchOverrides,
  callbacks: ModelSwitcherCallbacks,
): void {
  const { openModelPicker, openProfileList, activateSavedProfile, commitModelSetup, startModelSetup } = callbacks;

  const applyModel = (model: ModelRef) => {
    const hasOverrides = Boolean(overrides.baseUrl || overrides.apiKey || overrides.protocol);
    if (!hasOverrides) {
      const store = loadProfileStoreSync();
      const reference = `${model.provider}/${model.id}`.toLowerCase();
      const savedProfiles = Object.entries(store?.profiles ?? {})
        .filter(([, profile]) => profile.model.toLowerCase() === reference)
        .map(([name]) => name);
      const activeProfile = store?.activeProfile;

      if (activeProfile && savedProfiles.includes(activeProfile)) {
        activateSavedProfile(activeProfile);
        return;
      }
      if (savedProfiles.length === 1) {
        activateSavedProfile(savedProfiles[0]!);
        return;
      }
      if (savedProfiles.length > 1) {
        openProfileList(savedProfiles);
        return;
      }
    }

    if (hasGatewayOverrides(overrides)) {
      void commitModelSetup(
        {
          model,
          baseUrl: overrides.baseUrl!,
          apiKey: overrides.apiKey!,
          field: "apiKey",
          ...(overrides.protocol ? { protocol: overrides.protocol } : {}),
        },
        overrides.apiKey!,
      );
      return;
    }
    startModelSetup(model, overrides);
  };

  const match = findExactModelReferenceMatch(reference, getAllModels());

  if (!match) {
    // An unknown id is a valid custom OpenAI-compatible model
    applyModel(resolveModel(reference, overrides.baseUrl, overrides.protocol));
    return;
  }

  if (match.ambiguous || !match.model) {
    openModelPicker(reference, match.matches);
    return;
  }

  applyModel(match.model);
}
