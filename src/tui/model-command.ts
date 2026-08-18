import { findExactModelReferenceMatch, getAllModels, type ModelRef } from "../models.ts";
import type { ModelSwitchOverrides } from "../llm/index.ts";

export type ModelCommand = {
  reference: string;
  overrides: ModelSwitchOverrides;
};

export function looksLikeUrl(token: string): boolean {
  return /^https?:\/\//i.test(token);
}

/**
 * Parse `/model` arguments.
 *
 * Supported forms:
 * - `/model xai/grok-3`
 * - `/model xai/grok-3 https://gateway.example/v1 sk-...`
 * - `/model xai/grok-3 --base-url URL --api-key KEY`
 * - `/model xai/grok-3 --api-key-env ENV`
 *
 * Positional URL / key tokens are stripped from the model reference so they
 * never participate in picker filtering.
 */
export function parseModelCommand(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelCommand {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const positional: string[] = [];
  const overrides: ModelSwitchOverrides = {};

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "--base-url") {
      const value = tokens[++index];
      if (value) overrides.baseUrl = value;
      continue;
    }
    if (token === "--api-key") {
      const value = tokens[++index];
      if (value) overrides.apiKey = value;
      continue;
    }
    if (token === "--api-key-env") {
      const envName = tokens[++index];
      if (envName && env[envName]) overrides.apiKey = env[envName];
      continue;
    }
    positional.push(token);
  }

  let reference = "";
  for (const token of positional) {
    if (!reference && !looksLikeUrl(token)) {
      reference = token;
      continue;
    }
    if (looksLikeUrl(token)) {
      overrides.baseUrl ??= token;
      continue;
    }
    if (!overrides.apiKey) overrides.apiKey = token;
  }

  return { reference, overrides };
}

/** Extract the model needle from a picker or `/model` input. */
export function modelSearchQuery(raw: string): string {
  return parseModelCommand(raw.replace(/^\/model\s*/i, "")).reference;
}

export function hasGatewayOverrides(overrides: ModelSwitchOverrides): boolean {
  return Boolean(overrides.baseUrl && overrides.apiKey);
}

/**
 * Enter should submit the typed `/model` line when it already names a model
 * (or includes a gateway/key). Otherwise keep the picker-selection behavior.
 */
export function shouldSubmitTypedModelCommand(rawInput: string, models = getAllModels()): boolean {
  const parsed = parseModelCommand(rawInput.replace(/^\/model\s*/i, ""));
  if (!parsed.reference) return false;
  if (parsed.overrides.baseUrl || parsed.overrides.apiKey) return true;
  const match = findExactModelReferenceMatch(parsed.reference, models);
  return Boolean(match?.model && !match.ambiguous);
}

/** Previous picker logic: simple substring match on `provider/id`. */
export function filterModelsByQuery(query: string, models: ModelRef[]): ModelRef[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return models;
  return models.filter((model) =>
    `${model.provider}/${model.id}`.toLowerCase().includes(needle),
  );
}

export function modelChoices(query = "", models = getAllModels()): {
  references: string[];
  contextWindows: Record<string, number>;
} {
  const filtered = filterModelsByQuery(query, models);
  return {
    references: filtered.map((model) => `${model.provider}/${model.id}`),
    contextWindows: Object.fromEntries(
      filtered.map((model) => [`${model.provider}/${model.id}`, model.contextWindow]),
    ),
  };
}
