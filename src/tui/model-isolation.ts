import { switchLlmModel, type LlmConfig } from "../llm/index.ts";
import { findExactModelReferenceMatch, resolveModel } from "../models.ts";
import type { PersistedSession, TuiModelConfigSnapshot } from "../session-store.ts";

export function serializeTuiModelConfig(config: LlmConfig): TuiModelConfigSnapshot {
  const { getApiKey: _getApiKey, sessionId: _sessionId, ...snapshot } = config;
  return { ...snapshot, modelId: `${config.provider}/${config.model}` };
}

export function restoreTuiModelConfig(
  current: LlmConfig,
  snapshot: TuiModelConfigSnapshot | undefined,
): LlmConfig | undefined {
  if (!snapshot) return undefined;
  try {
    if (!snapshot.model || !snapshot.provider || !snapshot.baseUrl || !snapshot.apiKey) return undefined;
    return {
      ...snapshot,
      sessionId: current.sessionId,
      getApiKey: undefined,
    };
  } catch {
    return undefined;
  }
}

export function restoreTuiLlmConfig(
  current: LlmConfig,
  session: Pick<PersistedSession, "modelId" | "thinkingLevel" | "modelConfig">,
): { config: LlmConfig; warning?: string } {
  const snapshot = restoreTuiModelConfig(current, session.modelConfig);
  const identity = session.modelConfig?.modelId ?? session.modelId;
  let legacyConfig: LlmConfig | undefined;
  if (!snapshot && session.modelId) {
    const match = findExactModelReferenceMatch(session.modelId);
    if (match?.model && !match.ambiguous) {
      try { legacyConfig = switchLlmModel(current, match.model); } catch { /* Report unavailable model below. */ }
    }
  }
  const config = snapshot ?? legacyConfig ?? current;
  return {
    config: session.thinkingLevel ? { ...config, thinkingLevel: session.thinkingLevel } : config,
    ...(!snapshot && !legacyConfig && identity && identity !== `${current.provider}/${current.model}` ? { warning: identity } : {}),
  };
}

export function resolveTuiSubagentRoleConfigs<T>(
  local: Record<string, T> | undefined,
  global: Record<string, T> | undefined,
): Record<string, T> {
  return { ...global, ...local };
}
