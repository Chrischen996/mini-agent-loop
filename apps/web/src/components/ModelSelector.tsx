import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import type { ModelOption } from "../types/api.ts";

export function ModelSelector({
  sessionId,
  currentModel,
  disabled,
  onModelChange,
}: {
  sessionId: string | null;
  currentModel: string | null;
  disabled: boolean;
  onModelChange?: () => void;
}) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(currentModel);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSelected(currentModel);
  }, [currentModel]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .listModels()
      .then((data) => {
        if (!cancelled) {
          setModels(data.models);
          if (!selected && data.defaultModel) {
            setSelected(data.defaultModel);
          }
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelect = async (qualifiedId: string): Promise<void> => {
    if (!sessionId || saving) return;
    setSaving(true);
    try {
      await api.setModel(sessionId, qualifiedId);
      setSelected(qualifiedId);
      onModelChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <span className="muted" style={{ fontSize: 12 }}>Loading models…</span>;
  if (error) return <span className="muted error" style={{ fontSize: 12 }}>{error}</span>;

  return (
    <select
      className="model-select"
      value={selected ?? ""}
      disabled={disabled || !sessionId}
      onChange={(e) => void handleSelect(e.target.value)}
    >
      {models.map((m) => (
        <option key={m.qualifiedId} value={m.qualifiedId}>
          {m.name} ({m.provider})
        </option>
      ))}
    </select>
  );
}
