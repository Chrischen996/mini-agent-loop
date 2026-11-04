
import type { TuiAction } from "./state.ts";
import type { LlmConfig, ModelSwitchOverrides } from "../llm/index.ts";
import type { ModelRef } from "../models.ts";
import type { ModelSetupState } from "./types.ts";
import { activateProfile, saveProfile, listProfiles, loadProfileStore } from "../profile-store.ts";
import { switchLlmModel, loadLlmConfigFromEnv } from "../llm/index.ts";
import { adaptHistoryForModel } from "../message-adapter.ts";
import type { AgentMessage } from "../types.ts";

export type ProfileManagerDeps = {
  llm: LlmConfig;
  setLlm: (llm: LlmConfig) => void;
  setModelSetup: (setup: ModelSetupState | undefined) => void;
  setAcMode: (value: any) => void;
  setInput: (input: string) => void;
  setAcIndex: (index: number) => void;
  setProfileListState: (value: any) => void;
  dispatch: (action: TuiAction) => void;
  historyRef: { current: AgentMessage[] };
  /** Persist the adapted transcript immediately after a model switch. */
  persistSession?: (history: AgentMessage[]) => Promise<void>;
};

/** Switch directly when a model has configured credentials; otherwise open setup. */
export function startModelSetup(
  model: ModelRef,
  overrides: ModelSwitchOverrides,
  deps: ProfileManagerDeps,
): Promise<void> | void {
  const { llm, setModelSetup, setInput, setAcMode, setAcIndex } = deps;

  const providerKey = model.apiKeyEnv
    .map((name) => process.env[name])
    .find((value): value is string => Boolean(value));

  const canReuseCurrentKey = model.provider === llm.provider && model.baseUrl === llm.baseUrl;
  const hasOverrides = Boolean(overrides.baseUrl || overrides.apiKey || overrides.protocol);
  const configuredKey = model.apiKey ?? providerKey ?? (canReuseCurrentKey ? llm.apiKey : undefined);

  // Catalog models already have a provider endpoint and key source. Use that
  // integration directly; the setup form is for custom gateways or missing keys.
  if (!hasOverrides && configuredKey) {
    return commitModelSetup({
      model,
      baseUrl: model.baseUrl,
      apiKey: configuredKey,
      field: "apiKey",
    }, configuredKey, deps, { persistProfile: false });
  }

  setModelSetup({
    model,
    baseUrl: overrides.baseUrl || model.baseUrl,
    apiKey: overrides.apiKey ?? (canReuseCurrentKey ? llm.apiKey : providerKey ?? ""),
    field: "baseUrl",
    ...(overrides.protocol ? { protocol: overrides.protocol } : {}),
  });
  // Keep the default in modelSetup as the fallback, but leave the field empty
  // so a pasted gateway URL replaces it instead of being appended to it.
  setInput("");
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
  options: { persistProfile?: boolean } = {},
): Promise<void> {
  const { llm, setLlm, setModelSetup, setAcMode, setInput, dispatch, historyRef } = deps;

  try {
    const effectiveApiKey = apiKey.trim() || setup.apiKey.trim();
    const newLlmConfig = switchLlmModel(llm, setup.model, {
      baseUrl: setup.baseUrl,
      apiKey: effectiveApiKey,
      ...(setup.protocol ? { protocol: setup.protocol } : {}),
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
    if (options.persistProfile !== false) {
      // Auto-save as a named profile (fire-and-forget, non-fatal)
      const defaultName = `${setup.model.provider}-${setup.model.id}`
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 40);
      try {
        await saveProfile(defaultName, {
          model: `${setup.model.provider}/${setup.model.id}`,
          baseUrl: setup.baseUrl,
          apiKey: newLlmConfig.apiKey,
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
    }
  } catch (error) {
    setModelSetup({ ...setup, apiKey: apiKey.trim(), error: error instanceof Error ? error.message : String(error) });
    setInput(apiKey);
  }
}

/** Activate a saved model profile and adapt the current session to it. */
export async function activateSavedModelProfile(
  profileName: string,
  deps: ProfileManagerDeps,
): Promise<void> {
  const { llm, setLlm, setModelSetup, setAcMode, setInput, dispatch, historyRef } = deps;

  await activateProfile(profileName);
  const newLlm = loadLlmConfigFromEnv();
  setLlm(newLlm);
  dispatch({ type: "MODEL_CHANGED", modelName: newLlm.model });
  if (historyRef.current.length > 1) {
    historyRef.current = adaptHistoryForModel(historyRef.current, {
      targetCapabilities: newLlm.capabilities,
      sourceCapabilities: llm.capabilities,
    });
  }
  await deps.persistSession?.(historyRef.current);
  setModelSetup(undefined);
  setAcMode(null);
  setInput("");
}

/** Open all profiles or a filtered set in the profile picker. */
export async function openProfileList(
  deps: ProfileManagerDeps,
  profileNames?: string[],
): Promise<void> {
  const { setProfileListState, setAcMode, setInput } = deps;

  try {
    const store = await loadProfileStore();
    const allowedNames = profileNames ? new Set(profileNames) : undefined;
    const profiles = listProfiles(store).filter((profile) => !allowedNames || allowedNames.has(profile.name));
    if (profiles.length === 0) return;
    setProfileListState({ profiles, selectedIndex: 0 });
    setAcMode("profile-list");
    setInput("");
  } catch {
    // ignore
  }
}
