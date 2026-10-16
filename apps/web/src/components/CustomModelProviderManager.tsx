import { applyCompletionsThinking } from "../../../../src/pi-ai/completions-thinking.ts";
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { automaticThinking, resolveThinking, thinkingDraft, thinkingLevels as levels, type ThinkingContext } from "../lib/custom-model-thinking.ts";
import type {
  CustomModelDefinition,
  ThinkingLevel,
  ThinkingCompat,
  ModelProviderInput,
  ModelProviderProtocol,
  ModelProviderSummary,
} from "../types/api.ts";
import { Icon } from "./Icon.tsx";

type EditableModel = {
  id: string;
  name: string;
  contextWindow: string;
  maxTokens: string;
  input: "text" | "text,image";
  tools: boolean;
  reasoning: boolean;
  automaticThinking: boolean;
  efforts: Partial<Record<ThinkingLevel, string | null>>;
  defaultLevel: ThinkingLevel;
  compat: ThinkingCompat;
};

type ProviderEditor = {
  provider: string;
  displayName: string;
  baseUrl: string;
  protocol: ModelProviderProtocol;
  apiKey: string;
  compat: ThinkingCompat;
  models: EditableModel[];
};

const newModel = (): EditableModel => ({
  id: "",
  name: "",
  contextWindow: "",
  maxTokens: "",
  input: "text",
  tools: true,
  reasoning: false,
  automaticThinking: true,
  efforts: { off: null, low: "low", medium: "medium", high: "high" },
  defaultLevel: "medium",
  compat: {},
});

const newEditor = (): ProviderEditor => ({
  provider: "",
  displayName: "",
  baseUrl: "",
  protocol: "openai-completions",
  apiKey: "",
  compat: {},
  models: [newModel()],
});

function toEditableModel(model: CustomModelDefinition, context: ThinkingContext): EditableModel {
  return {
    id: model.id,
    name: model.name ?? "",
    contextWindow: model.contextWindow ? String(model.contextWindow) : "",
    maxTokens: model.maxTokens ? String(model.maxTokens) : "",
    input: model.input?.includes("image") ? "text,image" : "text",
    tools: model.tools !== false,
    reasoning: model.reasoningEfforts === undefined ? model.reasoning === true : model.reasoningEfforts !== false,
    ...thinkingDraft(model, context),
  };
}

function toEditor(provider: ModelProviderSummary): ProviderEditor {
  return {
    provider: provider.provider,
    displayName: provider.displayName ?? "",
    baseUrl: provider.baseUrl,
    protocol: provider.protocol,
    apiKey: "",
    compat: provider.compat ?? {},
    models: provider.models.length > 0 ? provider.models.map((model) => toEditableModel(model, { ...provider, compat: provider.compat ?? {} })) : [newModel()],
  };
}

function toModelDefinition(model: EditableModel, context: ThinkingContext): CustomModelDefinition {
  const contextWindow = Number.parseInt(model.contextWindow, 10);
  const maxTokens = Number.parseInt(model.maxTokens, 10);
  const thinking = resolveThinking(model, context, model.id);
  return {
    id: model.id.trim(),
    ...(model.name.trim() ? { name: model.name.trim() } : {}),
    ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
    ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
    input: model.input === "text,image" ? ["text", "image"] : ["text"],
    tools: model.tools,
    reasoning: model.reasoning,
    reasoningEfforts: model.reasoning ? thinking.efforts : false,
    ...(model.reasoning ? { defaultThinkingLevel: thinking.defaultLevel } : {}),
    compat: thinking.compat,
  };
}

function providerInput(editor: ProviderEditor): ModelProviderInput {
  return {
    provider: editor.provider.trim(),
    ...(editor.displayName.trim() ? { displayName: editor.displayName.trim() } : {}),
    baseUrl: editor.baseUrl.trim(),
    protocol: editor.protocol,
    compat: editor.compat,
    ...(editor.apiKey.trim() ? { apiKey: editor.apiKey.trim() } : {}),
    models: editor.models.map((model) => toModelDefinition(model, editor)),
  };
}

const formats: NonNullable<ThinkingCompat["thinkingFormat"]>[] = ["openai", "deepseek", "openrouter", "qwen", "qwen-chat-template", "zai", "together", "string-thinking", "ant-ling"];

function ThinkingFormatFields({ value, onChange, inherited = false }: { value: ThinkingCompat; onChange: (value: ThinkingCompat) => void; inherited?: boolean }) {
  return <>
    <label><span>Thinking format</span><select value={value.thinkingFormat ?? ""} onChange={(event) => { const next = { ...value }; if (event.target.value) next.thinkingFormat = event.target.value as ThinkingCompat["thinkingFormat"]; else delete next.thinkingFormat; onChange(next); }}><option value="">{inherited ? "Use provider format" : "OpenAI (default)"}</option>{formats.map((format) => <option key={format} value={format}>{format}</option>)}</select></label>
    <label><span>Send reasoning effort</span><select value={value.supportsReasoningEffort === undefined ? "" : String(value.supportsReasoningEffort)} onChange={(event) => { const next = { ...value }; if (event.target.value === "") delete next.supportsReasoningEffort; else next.supportsReasoningEffort = event.target.value === "true"; onChange(next); }}><option value="">{inherited ? "Use provider setting" : "Yes (default)"}</option><option value="true">Yes</option><option value="false">No (thinking switch only)</option></select></label>
  </>;
}

function thinkingPreview(model: EditableModel, protocol: ModelProviderProtocol, providerCompat: ThinkingCompat): string {
  const level = model.defaultLevel;
  if (protocol !== "openai-completions") return JSON.stringify({ thinkingLevel: level, mappedEffort: model.efforts[level], protocol }, null, 2);
  const body: Record<string, unknown> = {};
  const map = Object.fromEntries(levels.flatMap((key) => model.efforts[key] === null && key === "off" ? [] : [[key, model.efforts[key] ?? null]]));
  applyCompletionsThinking(body, { reasoning: true, thinkingLevelMap: map }, { reasoningEffort: level === "off" ? undefined : level }, { thinkingFormat: "openai", supportsReasoningEffort: true, ...providerCompat, ...model.compat });
  return JSON.stringify(body, null, 2);
}

export function CustomModelProviderManager({ onModelChange }: { onModelChange: () => void }) {
  const [providers, setProviders] = useState<ModelProviderSummary[]>([]);
  const [editor, setEditor] = useState<ProviderEditor | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProviders = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listModelProviders();
      setProviders(result.providers);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadProviders();
  }, []);

  const editProvider = (provider: ModelProviderSummary): void => {
    setEditor(toEditor(provider));
    setError(null);
  };

  const startNewProvider = (): void => {
    setEditor(newEditor());
    setError(null);
  };

  const updateEditor = (patch: Partial<ProviderEditor>): void => {
    setEditor((current) => current ? { ...current, ...patch } : current);
  };

  const updateModel = (index: number, patch: Partial<EditableModel>): void => {
    setEditor((current) => {
      if (!current) return current;
      const models = current.models.slice();
      models[index] = { ...models[index], ...patch };
      return { ...current, models };
    });
  };

  const removeModel = (index: number): void => {
    setEditor((current) => {
      if (!current || current.models.length <= 1) return current;
      return { ...current, models: current.models.filter((_, modelIndex) => modelIndex !== index) };
    });
  };

  const discoverModels = async (): Promise<void> => {
    if (!editor || !editor.baseUrl.trim() || discovering) return;
    setDiscovering(true);
    setError(null);
    try {
      const result = await api.discoverModelProvider({
        baseUrl: editor.baseUrl.trim(),
        protocol: editor.protocol,
        ...(editor.provider.trim() ? { provider: editor.provider.trim() } : {}),
        ...(editor.apiKey.trim() ? { apiKey: editor.apiKey.trim() } : {}),
      });
      setEditor((current) => {
        if (!current) return current;
        const existing = new Map(current.models.filter((model) => model.id.trim()).map((model) => [model.id.trim(), model]));
        for (const model of result.models) {
          if (!existing.has(model.id)) existing.set(model.id, toEditableModel(model, current));
        }
        return { ...current, models: [...existing.values(), ...(existing.size === 0 ? [newModel()] : [])] };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscovering(false);
    }
  };

  const saveProvider = async (): Promise<void> => {
    if (!editor || saving) return;
    if (editor.models.some((model) => {
      const thinking = resolveThinking(model, editor, model.id);
      return model.reasoning && (!Object.keys(thinking.efforts).some((level) => level !== "off") || !Object.hasOwn(thinking.efforts, thinking.defaultLevel));
    })) {
      setError("Choose at least one thinking level and a supported default level.");
      return;
    }
    const input = providerInput(editor);
    if (!input.provider || !input.baseUrl || input.models.some((model) => !model.id)) {
      setError("Provider ID, base URL, and every model ID are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (providers.some((provider) => provider.provider === input.provider)) {
        await api.updateModelProvider(input.provider, input);
      } else {
        await api.createModelProvider(input);
      }
      await loadProviders();
      setEditor(null);
      onModelChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const deleteProvider = async (): Promise<void> => {
    if (!editor || deleting || providers.every((provider) => provider.provider !== editor.provider)) return;
    if (!window.confirm(`Delete provider “${editor.provider}”?`)) return;
    setDeleting(true);
    setError(null);
    try {
      await api.deleteModelProvider(editor.provider);
      await loadProviders();
      setEditor(null);
      onModelChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  return <section className="settings-provider-manager" aria-labelledby="custom-models-title">
    <div className="settings-provider-manager__heading">
      <div><h4 id="custom-models-title">Custom model API</h4><p className="muted">Connect an OpenAI or Anthropic compatible endpoint.</p></div>
      {!editor && <button type="button" className="btn btn--primary" onClick={startNewProvider}>Add provider</button>}
    </div>
    {loading ? <p className="muted">Loading providers…</p> : providers.length === 0 && !editor ? <p className="muted">No custom providers configured.</p> : null}
    {!editor && providers.length > 0 && <div className="settings-provider-list">
      {providers.map((provider) => <button type="button" className="settings-provider-row" key={provider.provider} onClick={() => editProvider(provider)}>
        <span className="settings-provider-row__main"><strong>{provider.displayName || provider.provider}</strong><small>{provider.provider} · {provider.models.length} model{provider.models.length === 1 ? "" : "s"}</small></span>
        <span className="settings-provider-row__meta">{provider.keyConfigured ? "API key set" : "No API key"}<Icon name="chevronDown" width={14} height={14} /></span>
      </button>)}
    </div>}
    {editor && <div className="settings-provider-editor">
      <div className="settings-provider-editor__toolbar"><button type="button" className="btn" onClick={() => { setEditor(null); setError(null); }}>Back</button><strong>{providers.some((provider) => provider.provider === editor.provider) ? "Edit provider" : "Add provider"}</strong></div>
      <div className="settings-provider-form">
        <label><span>Provider ID</span><input value={editor.provider} disabled={providers.some((provider) => provider.provider === editor.provider)} onChange={(event) => updateEditor({ provider: event.target.value })} placeholder="my-gateway" autoComplete="off" /></label>
        <label><span>Display name</span><input value={editor.displayName} onChange={(event) => updateEditor({ displayName: event.target.value })} placeholder="My Gateway" /></label>
        <label className="settings-provider-form__wide"><span>Base URL</span><input type="url" value={editor.baseUrl} onChange={(event) => updateEditor({ baseUrl: event.target.value })} placeholder={editor.protocol === "anthropic-messages" ? "https://api.example.com" : "https://api.example.com/v1"} autoComplete="url" /></label>
        <label><span>API protocol</span><select value={editor.protocol} onChange={(event) => updateEditor({ protocol: event.target.value as ModelProviderProtocol, compat: {}, models: editor.models.map((model) => ({ ...model, compat: {} })) })}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
        <label><span>API key</span><input type="password" value={editor.apiKey} onChange={(event) => updateEditor({ apiKey: event.target.value })} placeholder={providers.some((provider) => provider.provider === editor.provider) ? "Leave blank to keep current key" : "sk-…"} autoComplete="new-password" /></label>
      </div>
      {editor.protocol === "openai-completions" && <details className="settings-provider-advanced"><summary>Advanced API settings</summary><div className="settings-provider-form"><ThinkingFormatFields value={editor.compat} onChange={(compat) => updateEditor({ compat })} /></div></details>}
      <div className="settings-provider-models__heading"><div><strong>Models</strong><small>Choose Fetch models or add IDs manually.</small></div><button type="button" className="btn" onClick={() => void discoverModels()} disabled={!editor.baseUrl.trim() || discovering}>{discovering ? "Fetching…" : "Fetch models"}</button></div>
      <div className="settings-provider-models">
        {editor.models.map((model, index) => {
          const thinking = resolveThinking(model, editor, model.id);
          const customizeThinking = (patch: Partial<EditableModel>): void => updateModel(index, { ...thinking, automaticThinking: false, ...patch });
          return <div className="settings-provider-model" key={index}>
          <label className="settings-provider-model__id"><span>Model ID</span><input value={model.id} onChange={(event) => updateModel(index, { id: event.target.value })} placeholder="deepseek-chat" /></label>
          <label><span>Name</span><input value={model.name} onChange={(event) => updateModel(index, { name: event.target.value })} placeholder="DeepSeek Chat" /></label>
          <label><span>Context</span><input inputMode="numeric" value={model.contextWindow} onChange={(event) => updateModel(index, { contextWindow: event.target.value.replace(/[^0-9]/g, "") })} placeholder="128000" /></label>
          <label><span>Max output</span><input inputMode="numeric" value={model.maxTokens} onChange={(event) => updateModel(index, { maxTokens: event.target.value.replace(/[^0-9]/g, "") })} placeholder="8192" /></label>
          <label><span>Input</span><select value={model.input} onChange={(event) => updateModel(index, { input: event.target.value as EditableModel["input"] })}><option value="text">Text</option><option value="text,image">Text + image</option></select></label>
          <label className="settings-provider-model__check"><input type="checkbox" checked={model.tools} onChange={(event) => updateModel(index, { tools: event.target.checked })} /><span>Tools</span></label>
          <label className="settings-provider-model__check"><input type="checkbox" checked={model.reasoning} onChange={(event) => updateModel(index, { reasoning: event.target.checked })} /><span>Enable thinking</span></label>
          {model.reasoning && <div className="settings-thinking">
            <div className="settings-thinking__simple">
              <label><span>Default thinking level</span><select value={thinking.defaultLevel} onChange={(event) => updateModel(index, { defaultLevel: event.target.value as ThinkingLevel })}>{levels.filter((level) => Object.hasOwn(thinking.efforts, level)).map((level) => <option key={level} value={level}>{level.charAt(0).toUpperCase() + level.slice(1)}</option>)}</select></label>
              <small className="muted">{model.automaticThinking ? "Ready to use. You can change the level in chat." : "Using your saved custom settings."}</small>
            </div>
            <details className="settings-thinking__advanced">
              <summary>Advanced thinking settings</summary>
              <div className="settings-thinking__advanced-body">
                <div className="settings-thinking__heading"><small className="muted">Only needed for a custom API. Existing mappings are preserved.</small><button type="button" className="btn" onClick={() => updateModel(index, { ...automaticThinking(editor, model.id), automaticThinking: true })}>Use automatic settings</button></div>
                <div className="settings-thinking__levels">{levels.map((level) => <div className="settings-thinking__level" key={level}>
                  <label className="settings-provider-model__check"><input type="checkbox" checked={Object.hasOwn(thinking.efforts, level)} onChange={(event) => { const efforts = { ...thinking.efforts }; if (event.target.checked) efforts[level] = level === "off" ? null : level; else delete efforts[level]; customizeThinking({ efforts, defaultLevel: Object.hasOwn(efforts, thinking.defaultLevel) ? thinking.defaultLevel : (Object.keys(efforts).find((key) => key !== "off") ?? "off") as ThinkingLevel }); }} /><span>{level}</span></label>
                  {Object.hasOwn(thinking.efforts, level) && <input aria-label={`${model.id || "Model"} ${level} API value`} value={thinking.efforts[level] ?? ""} placeholder={level === "off" ? "Protocol default" : level} onChange={(event) => customizeThinking({ efforts: { ...thinking.efforts, [level]: level === "off" && !event.target.value ? null : event.target.value } })} />}
                </div>)}</div>
                {editor.protocol === "openai-completions" && <div className="settings-provider-form"><ThinkingFormatFields value={thinking.compat} onChange={(compat) => customizeThinking({ compat })} inherited /></div>}
                <details><summary>{editor.protocol === "openai-completions" ? "Default thinking request preview" : "Default thinking configuration"}</summary><pre>{thinkingPreview({ ...model, ...thinking }, editor.protocol, editor.compat)}</pre></details>
              </div>
            </details>
          </div>}
          <button type="button" className="icon-button settings-provider-model__remove" aria-label={`Remove ${model.id || "model"}`} title="Remove model" onClick={() => removeModel(index)} disabled={editor.models.length <= 1}><Icon name="close" width={15} height={15} /></button>
        </div>;
        })}
      </div>
      <button type="button" className="btn" onClick={() => setEditor((current) => current ? { ...current, models: [...current.models, newModel()] } : current)}><Icon name="plus" width={14} height={14} /> Add model</button>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="settings-provider-editor__actions"><button type="button" className="btn btn--danger" onClick={() => void deleteProvider()} disabled={!providers.some((provider) => provider.provider === editor.provider) || deleting || saving}>Delete</button><span /><button type="button" className="btn" onClick={() => setEditor(null)} disabled={saving}>Cancel</button><button type="button" className="btn btn--primary" onClick={() => void saveProvider()} disabled={saving || deleting}>{saving ? "Saving…" : "Save provider"}</button></div>
    </div>}
    {error && !editor && <p className="error" role="alert">{error}</p>}
  </section>;
}
