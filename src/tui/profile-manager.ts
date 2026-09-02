import type { Dispatch } from "react";
import type { TuiAction } from "./state.ts";
import type { LlmConfig, ModelSwitchOverrides } from "../llm/index.ts";
import type { ModelRef } from "../models.ts";
import type { ModelSetupState } from "./types.ts";
import { saveProfile, listProfiles, loadProfileStore } from "../profile-store.ts";
import { switchLlmModel, loadLlmConfigFromEnv } from "../llm/index.ts";
import { adaptHistoryForModel } from "../message-adapter.ts";
import type { AgentMessage } from "../types.ts";

export type ProfileManagerDeps = {
  llm: LlmConfig;
  setLlm: (llm: LlmConfig) => void;
  setModelSetup: (setup: ModelSetupState | undefined) => void;
  setAcMode: React.Dispatch<React.SetStateAction<any>>;
  setInput: (input: string) => void;
  setAcIndex: (index: number) => void;
  setProfileListState: React.Dispatch<React.SetStateAction<any>>;
  dispatch: Dispatch<TuiAction>;
  historyRef: React.MutableRefObject<AgentMessage[]>;
  /** Persist the adapted transcript immediately after a model switch. */
  persistSession?: (history: AgentMessage[]) => Promise<void>;
};

/**
 * Start the model setup flow, prompting for baseUrl and apiKey.
 */
export function startModelSetup(
  model: ModelRef,
  overrides: ModelSwitchOverrides,
  deps: ProfileManagerDeps,
): void {
  const { llm, setModelSetup, setInput, setAcMode, setAcIndex } = deps;

  const providerKey = model.apiKeyEnv
    .map((name) => process.env[name])
    .find((value): value is string => Boolean(value));

  const canReuseCurrentKey = model.provider === llm.provider && model.baseUrl === llm.baseUrl;

  setModelSetup({
    model,
    baseUrl: overrides.baseUrl || model.baseUrl,
    apiKey: overrides.apiKey ?? (canReuseCurrentKey ? llm.apiKey : providerKey ?? ""),
    field: "baseUrl",
  });
  setInput(overrides.baseUrl || model.baseUrl);
  setAcMode("model-setup");
  setAcIndex(0);
}

/**
 * Complete the model setup by applying the configuration and adapting history.
 */
export async function commitModelSetup(
  setup: ModelSetupState,
  apiKey: string,
  deps: ProfileManagerDeps,
): Promise<void> {
  const { llm, setLlm, setModelSetup, setAcMode, setInput, dispatch, historyRef } = deps;

  try {
    const newLlmConfig = switchLlmModel(llm, setup.model, {
      baseUrl: setup.baseUrl,
      apiKey,
    });
    setLlm(newLlmConfig);
    dispatch({ type: "MODEL_CHANGED", modelName: setup.model.id });

    // Adapt existing conversation history for the new model's capabilities
    if (historyRef.current.length > 1) {
      historyRef.current = adaptHistoryForModel(historyRef.current, {
        targetCapabilities: newLlmConfig.capabilities,
        sourceCapabilities: llm.capabilities,
      });
    }
    await deps.persistSession?.(historyRef.current);

    setModelSetup(undefined);
    setAcMode(null);
    setInput("");
    // Auto-save as a named profile (fire-and-forget, non-fatal)
    const defaultName = `${setup.model.provider}-${setup.model.id}`
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 40);
    try {
      await saveProfile(defaultName, {
        model: `${setup.model.provider}/${setup.model.id}`,
        baseUrl: setup.baseUrl,
        apiKey,
        thinkingLevel: newLlmConfig.thinkingLevel,
        ...(newLlmConfig.timeoutMs !== undefined ? { timeoutMs: newLlmConfig.timeoutMs } : {}),
        ...(newLlmConfig.firstResponseTimeoutMs !== undefined
          ? { firstResponseTimeoutMs: newLlmConfig.firstResponseTimeoutMs }
          : {}),
        ...(newLlmConfig.streamIdleTimeoutMs !== undefined
          ? { streamIdleTimeoutMs: newLlmConfig.streamIdleTimeoutMs }
          : {}),
      });
    } catch {
      // non-fatal: model is already switched in memory
    }
  } catch (error) {
    setModelSetup({ ...setup, apiKey, error: error instanceof Error ? error.message : String(error) });
    setInput(apiKey);
  }
}

/**
 * Open the profile list picker UI.
 */
export async function openProfileList(deps: ProfileManagerDeps): Promise<void> {
  const { setProfileListState, setAcMode, setInput } = deps;

  try {
    const store = await loadProfileStore();
    const profiles = listProfiles(store);
    setProfileListState({ profiles, selectedIndex: 0 });
    setAcMode("profile-list");
    setInput("");
  } catch {
    // ignore
  }
}
