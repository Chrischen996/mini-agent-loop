import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../lib/api.ts";
import type { ModelOption } from "../types/api.ts";
import { Icon } from "./Icon.tsx";

type PickerPanel = "root" | "models" | "thinking";

const PROVIDER_LABELS: Record<string, string> = {
  "agnes-ai": "Agnes AI",
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  google: "Google",
  "openai-codex": "OpenAI Codex",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  xai: "xAI",
};

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

function providerRank(provider: string): number {
  return provider === "deepseek" ? 0 : 1;
}

function matchesModel(model: ModelOption, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = `${model.name} ${model.id} ${model.provider}`.toLowerCase();
  if (haystack.includes(needle)) return true;

  let position = 0;
  for (const character of needle.replaceAll(/\s/g, "")) {
    position = haystack.indexOf(character, position);
    if (position < 0) return false;
    position += 1;
  }
  return true;
}

function effortLabel(level: string): string {
  return level === "xhigh" ? "X-High" : level === "off" ? "Off" : level[0]?.toUpperCase() + level.slice(1);
}

export function ModelSelector({
  sessionId,
  currentModel,
  currentThinkingLevel,
  disabled,
  open,
  forceSearch = false,
  onOpenChange,
  onModelChange,
}: {
  sessionId: string | null;
  currentModel: string | null;
  currentThinkingLevel: string | null;
  disabled: boolean;
  open?: boolean;
  forceSearch?: boolean;
  onOpenChange?: (open: boolean) => void;
  onModelChange?: () => void;
}) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(currentModel);
  const [thinkingLevel, setThinkingLevel] = useState(currentThinkingLevel);
  const [internalOpen, setInternalOpen] = useState(false);
  const [panel, setPanel] = useState<PickerPanel>("root");
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const [saving, setSaving] = useState<"model" | "thinking" | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);

  const isOpen = open ?? internalOpen;
  const setOpen = (next: boolean): void => {
    if (open === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };
  const close = (restoreFocus = false): void => {
    setOpen(false);
    setPanel("root");
    if (restoreFocus) requestAnimationFrame(() => trigger.current?.focus());
  };

  const loadModels = async (): Promise<void> => {
    setLoading(true);
    try {
      const data = await api.listModels();
      setModels(data.models);
      setDefaultModel(data.defaultModel || null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadModels();
  }, []);

  useEffect(() => {
    setSelected(currentModel);
  }, [currentModel]);

  useEffect(() => {
    setThinkingLevel(currentThinkingLevel);
  }, [currentThinkingLevel]);

  useEffect(() => {
    if (!isOpen) return;
    setPanel("root");
    setQuery("");
    setHighlighted(0);
    setError(null);
    void loadModels();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsideClick = (event: PointerEvent): void => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [isOpen]);

  const currentQualifiedId = selected ?? defaultModel;
  const selectedModel = models.find((model) => model.qualifiedId === currentQualifiedId) ?? null;
  const modelLabel = selectedModel?.name ?? currentQualifiedId ?? "Choose model";
  const thinkingLevels = selectedModel?.thinkingLevels ?? [];
  const currentEffort = thinkingLevel && thinkingLevels.includes(thinkingLevel) ? thinkingLevel : selectedModel?.defaultThinkingLevel ?? (thinkingLevels.includes("medium") ? "medium" : thinkingLevels.find((level) => level !== "off") ?? thinkingLevels[0] ?? null);
  const showSearch = forceSearch || models.length > 4;

  const groups = useMemo(() => {
    const providerOrder = new Map<string, number>();
    models.forEach((model, index) => {
      if (!providerOrder.has(model.provider)) providerOrder.set(model.provider, index);
    });
    const byProvider = new Map<string, ModelOption[]>();
    for (const model of models) {
      if (!matchesModel(model, query)) continue;
      const group = byProvider.get(model.provider) ?? [];
      group.push(model);
      byProvider.set(model.provider, group);
    }
    return [...byProvider.entries()]
      .sort(([left], [right]) => providerRank(left) - providerRank(right) || (providerOrder.get(left) ?? 0) - (providerOrder.get(right) ?? 0))
      .map(([provider, entries]) => ({ provider, models: entries }));
  }, [models, query]);
  const visibleModels = groups.flatMap((group) => group.models);

  useEffect(() => {
    setHighlighted((current) => Math.min(current, Math.max(0, visibleModels.length - 1)));
  }, [query, visibleModels.length]);

  useEffect(() => {
    if (!isOpen || panel !== "models" || !showSearch) return;
    requestAnimationFrame(() => search.current?.focus());
  }, [isOpen, panel, showSearch]);

  const selectModel = async (model: ModelOption): Promise<void> => {
    if (!sessionId || saving) return;
    setSaving("model");
    try {
      const result = await api.setModel(sessionId, model.qualifiedId);
      setSelected(result.qualifiedId);
      setThinkingLevel(result.thinkingLevel);
      onModelChange?.();
      close(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  };

  const selectThinkingLevel = async (level: string): Promise<void> => {
    if (!sessionId || saving) return;
    setSaving("thinking");
    try {
      const result = await api.setThinkingLevel(sessionId, level);
      setThinkingLevel(result.thinkingLevel);
      onModelChange?.();
      close(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  };

  const onModelsKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      setPanel("root");
      return;
    }
    if (visibleModels.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((current) => (current + delta + visibleModels.length) % visibleModels.length);
      return;
    }
    if (event.key === "Enter" && visibleModels[highlighted]) {
      event.preventDefault();
      void selectModel(visibleModels[highlighted]);
    }
  };

  const pickerDisabled = disabled || !sessionId;
  return (
    <div className="model-picker">
      <button
        ref={trigger}
        type="button"
        className="model-picker__trigger"
        aria-label={`Model: ${modelLabel}${currentEffort ? `, effort ${effortLabel(currentEffort)}` : ""}`}
        title={currentQualifiedId ?? "Choose model"}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        disabled={pickerDisabled}
        onClick={() => isOpen ? close(true) : setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !isOpen) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon name="model" width={15} height={15} />
        <span className="model-picker__label">{loading && models.length === 0 ? "Loading models" : modelLabel}</span>
        {currentEffort && <span className="model-picker__effort">{effortLabel(currentEffort)}</span>}
        <Icon name="chevronDown" width={14} height={14} />
      </button>
      {isOpen && <div ref={menu} className="model-picker__menu" role="menu" aria-label="Model selection" onKeyDown={(event) => {
        if (event.key === "Tab" && event.shiftKey) {
          event.preventDefault();
          if (panel === "root") close(true);
          else setPanel("root");
          return;
        }
        if (event.key === "Escape" && panel === "root") {
          event.preventDefault();
          close(true);
          return;
        }
        if (panel === "models") onModelsKeyDown(event);
      }}>
        {panel === "root" && <>
          <button type="button" role="menuitem" className="model-picker__row" onClick={() => setPanel("models")}>
            <span>Model</span><span className="model-picker__row-value">{modelLabel}</span><Icon name="chevronDown" width={14} height={14} />
          </button>
          {thinkingLevels.length > 0 && <button type="button" role="menuitem" className="model-picker__row" onClick={() => setPanel("thinking")}>
            <span>Effort</span><span className="model-picker__row-value">{currentEffort ? effortLabel(currentEffort) : "Default"}</span><Icon name="chevronDown" width={14} height={14} />
          </button>}
        </>}
        {panel === "models" && <>
          <div className="model-picker__panel-header">
            <button type="button" className="model-picker__back" aria-label="Back to model settings" title="Back" onClick={() => setPanel("root")}><Icon name="chevronLeft" width={16} height={16} /></button>
            <span>Model</span>
          </div>
          {showSearch && <div className="model-picker__search"><input ref={search} value={query} onChange={(event) => { setQuery(event.target.value); setHighlighted(0); }} placeholder="Search models" aria-label="Search models" />{query && <button type="button" className="model-picker__clear" aria-label="Clear model search" title="Clear search" onClick={() => { setQuery(""); search.current?.focus(); }}><Icon name="close" width={14} height={14} /></button>}</div>}
          <div className="model-picker__list">
            {loading && models.length === 0 && <p className="model-picker__empty">Loading models...</p>}
            {!loading && models.length === 0 && <p className="model-picker__empty">No available models</p>}
            {!loading && models.length > 0 && visibleModels.length === 0 && <p className="model-picker__empty">No matching models</p>}
            {groups.map((group) => <section key={group.provider} className="model-picker__group" aria-label={providerLabel(group.provider)}>
              <h2>{providerLabel(group.provider)}</h2>
              {group.models.map((model) => {
                const index = visibleModels.indexOf(model);
                const active = currentQualifiedId === model.qualifiedId;
                const pending = saving === "model" && active;
                return <button key={model.qualifiedId} type="button" role="menuitemradio" aria-checked={active} className={`model-picker__option${index === highlighted ? " model-picker__option--highlighted" : ""}`} onMouseMove={() => setHighlighted(index)} onClick={() => void selectModel(model)} disabled={Boolean(saving)}>
                  <span>{model.name}</span>{pending ? <span className="model-picker__pending">Saving...</span> : active ? <Icon name="check" width={16} height={16} /> : null}
                </button>;
              })}
            </section>)}
          </div>
        </>}
        {panel === "thinking" && <>
          <div className="model-picker__panel-header">
            <button type="button" className="model-picker__back" aria-label="Back to model settings" title="Back" onClick={() => setPanel("root")}><Icon name="chevronLeft" width={16} height={16} /></button>
            <span>Effort</span>
          </div>
          <div className="model-picker__list model-picker__list--effort">
            {thinkingLevels.map((level) => {
              const active = level === currentEffort;
              return <button key={level} type="button" role="menuitemradio" aria-checked={active} className="model-picker__option" onClick={() => void selectThinkingLevel(level)} disabled={Boolean(saving)}>
                <span>{effortLabel(level)}</span>{saving === "thinking" && active ? <span className="model-picker__pending">Saving...</span> : active ? <Icon name="check" width={16} height={16} /> : null}
              </button>;
            })}
          </div>
        </>}
        {error && <p className="model-picker__error" role="alert">{error}</p>}
      </div>}
    </div>
  );
}
