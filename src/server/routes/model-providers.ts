/** Model provider management for the Web settings page. */

import type { Express, Request, Response } from "express";
import {
  deleteCustomProvider,
  loadProfileStore,
  saveProfileStore,
  upsertCustomProvider,
  validateCustomProvider,
  type CustomProviderModel,
  type CustomProviderProfile,
  type CustomProviderProtocol,
} from "../../profile-store.ts";

export type ModelProviderRoutesContext = {
  getProviders: () => Record<string, CustomProviderProfile>;
  onProvidersChanged: (providers: Record<string, CustomProviderProfile>) => void;
  storePath?: string;
};

type ProviderPayload = {
  provider?: unknown;
  displayName?: unknown;
  baseUrl?: unknown;
  protocol?: unknown;
  apiKey?: unknown;
  models?: unknown;
  compat?: unknown;
};

function providerSummary(provider: string, profile: CustomProviderProfile): Record<string, unknown> {
  return {
    provider,
    displayName: profile.displayName ?? provider,
    baseUrl: profile.baseUrl,
    protocol: profile.protocol,
    keyConfigured: Boolean(profile.apiKey),
    models: profile.models,
    ...(profile.compat ? { compat: profile.compat } : {}),
  };
}

function bodyModelList(value: unknown): CustomProviderModel[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is CustomProviderModel => Boolean(item && typeof item === "object"));
}

function payloadToProfile(
  provider: string,
  body: ProviderPayload,
  existing?: CustomProviderProfile,
): CustomProviderProfile {
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : existing?.baseUrl;
  const protocol = body.protocol === "openai-completions" || body.protocol === "openai-responses" || body.protocol === "anthropic-messages"
    ? body.protocol
    : existing?.protocol;
  const apiKey = typeof body.apiKey === "string" && body.apiKey.trim()
    ? body.apiKey
    : existing?.apiKey;
  const models = body.models === undefined ? existing?.models : bodyModelList(body.models);
  return validateCustomProvider(provider, {
    ...(typeof body.displayName === "string" ? { displayName: body.displayName } : existing?.displayName ? { displayName: existing.displayName } : {}),
    baseUrl,
    protocol,
    apiKey,
    models,
    compat: body.compat === undefined ? existing?.compat : body.compat,
  });
}

function discoveryUrl(baseUrl: string, protocol: CustomProviderProtocol): string {
  const normalized = baseUrl.trim().replace(/\/$/, "");
  if (protocol === "anthropic-messages" && !/\/v1$/i.test(normalized)) {
    return `${normalized}/v1/models`;
  }
  return `${normalized}/models`;
}

function discoveryHeaders(protocol: CustomProviderProtocol, apiKey: string): Record<string, string> {
  return protocol === "anthropic-messages"
    ? {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        accept: "application/json",
      }
    : {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      };
}

async function discoverModels(
  baseUrl: string,
  protocol: CustomProviderProtocol,
  apiKey: string,
): Promise<CustomProviderModel[]> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("baseUrl must be a valid http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("baseUrl must use http or https");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(discoveryUrl(baseUrl, protocol), {
      headers: discoveryHeaders(protocol, apiKey),
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Model discovery failed with HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 1_000_000) throw new Error("Model discovery response is too large");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Model discovery returned invalid JSON");
    }
    const listing = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
    const data = listing?.data;
    const modelMap = listing?.models;
    const values: Array<{ key?: string; item: Record<string, unknown> }> = Array.isArray(data)
      ? data.flatMap((value) => value && typeof value === "object" && !Array.isArray(value)
        ? [{ item: value as Record<string, unknown> }]
        : [])
      : Array.isArray(modelMap)
        ? modelMap.flatMap((value) => value && typeof value === "object" && !Array.isArray(value)
          ? [{ item: value as Record<string, unknown> }]
          : [])
        : modelMap && typeof modelMap === "object"
          ? Object.entries(modelMap).flatMap(([key, value]) => value && typeof value === "object" && !Array.isArray(value)
            ? [{ key, item: value as Record<string, unknown> }]
            : [])
          : [];
    if (values.length === 0 && !Array.isArray(data) && !Array.isArray(modelMap) && !(modelMap && typeof modelMap === "object")) {
      throw new Error("Model discovery response did not contain a data array or models object");
    }
    const seen = new Set<string>();
    const models: CustomProviderModel[] = [];
    const numberField = (...candidates: unknown[]): number | undefined => {
      for (const candidate of candidates) {
        if (typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0) return candidate;
      }
      return undefined;
    };
    for (const { key, item } of values) {
      const id = (typeof key === "string" && key.trim() ? key : typeof item.id === "string" ? item.id : "").trim();
      if (!id || seen.has(id.toLowerCase())) continue;
      seen.add(id.toLowerCase());
      const name = typeof item.name === "string"
        ? item.name.trim()
        : typeof item.display_name === "string"
          ? item.display_name.trim()
          : typeof item.displayName === "string" ? item.displayName.trim() : undefined;
      const limit = item.limit && typeof item.limit === "object" && !Array.isArray(item.limit)
        ? item.limit as Record<string, unknown>
        : undefined;
      const topProvider = item.top_provider && typeof item.top_provider === "object" && !Array.isArray(item.top_provider)
        ? item.top_provider as Record<string, unknown>
        : undefined;
      const contextWindow = numberField(item.contextWindow, item.context_window, item.context_length, item.max_input_tokens, limit?.context);
      const maxTokens = numberField(item.maxTokens, item.max_tokens, item.max_output_tokens, item.maxOutputTokens, limit?.output, topProvider?.max_completion_tokens);
      const input = Array.isArray(item.input)
        ? item.input.filter((value): value is "text" | "image" => value === "text" || value === "image")
        : Array.isArray(item.input_modalities)
          ? item.input_modalities.filter((value): value is "text" | "image" => value === "text" || value === "image")
          : undefined;
      models.push({
        id,
        name: name || id,
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxTokens ? { maxTokens } : {}),
        ...(input && input.length > 0 ? { input: [...new Set(input)] } : {}),
      });
    }
    return models;
  } finally {
    clearTimeout(timer);
  }
}

export function registerModelProviderRoutes(
  app: Express,
  context: ModelProviderRoutesContext,
): void {
  app.get("/api/model-providers", (_request, response) => {
    response.json({
      providers: Object.entries(context.getProviders()).map(([provider, profile]) => providerSummary(provider, profile)),
    });
  });

  app.post("/api/model-providers/discover", async (request, response) => {
    const body = (request.body ?? {}) as ProviderPayload;
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
    const protocol = body.protocol === "openai-responses" || body.protocol === "anthropic-messages"
      ? body.protocol
      : "openai-completions";
    const provider = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : "";
    const apiKey = typeof body.apiKey === "string" && body.apiKey.trim()
      ? body.apiKey.trim()
      : provider ? context.getProviders()[provider]?.apiKey ?? "" : "";
    if (!baseUrl) {
      response.status(400).json({ error: "baseUrl is required" });
      return;
    }
    if (!apiKey) {
      response.status(400).json({ error: "apiKey is required for model discovery" });
      return;
    }
    try {
      response.json({ models: await discoverModels(baseUrl, protocol, apiKey) });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  const save = async (request: Request, response: Response, providerFromPath?: string): Promise<void> => {
    const body = (request.body ?? {}) as ProviderPayload;
    const requestedProvider = providerFromPath ?? (typeof body.provider === "string" ? body.provider : "");
    const provider = requestedProvider.trim().toLowerCase();
    const existing = context.getProviders()[provider];
    try {
      const profile = payloadToProfile(provider, body, existing);
      const store = await loadProfileStore(context.storePath);
      const updated = upsertCustomProvider(store, provider, profile);
      await saveProfileStore(updated, context.storePath);
      context.onProvidersChanged(updated.customProviders ?? {});
      response.status(providerFromPath ? 200 : 201).json(providerSummary(provider, profile));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  };

  app.post("/api/model-providers", (request, response) => { void save(request, response); });
  app.put("/api/model-providers/:provider", (request, response) => { void save(request, response, request.params.provider); });

  app.delete("/api/model-providers/:provider", async (request, response) => {
    const provider = request.params.provider.trim().toLowerCase();
    try {
      const store = await loadProfileStore(context.storePath);
      const updated = deleteCustomProvider(store, provider);
      await saveProfileStore(updated, context.storePath);
      context.onProvidersChanged(updated.customProviders ?? {});
      response.status(204).end();
    } catch (error) {
      response.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

