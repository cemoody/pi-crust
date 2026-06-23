import { useEffect, useState } from "react";
import type { ModelOption } from "../api/session-api.js";
import "./model-picker.css";

export interface ModelPickerProps {
  readonly open: boolean;
  readonly loadModels: () => Promise<readonly ModelOption[]>;
  readonly onSelect: (provider: string, modelId: string) => Promise<void> | void;
  readonly onClose: () => void;
}

export function ModelPicker({ open, loadModels, onSelect, onClose }: ModelPickerProps) {
  const [models, setModels] = useState<readonly ModelOption[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setQuery("");
    void loadModels().then(setModels).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [loadModels, open]);

  if (!open) return null;

  const filtered = models.filter((model) => {
    const haystack = `${model.provider}/${model.id} ${model.name}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
  });

  async function pick(model: ModelOption) {
    if (!model.available) return;
    setPending(`${model.provider}/${model.id}`);
    try {
      await onSelect(model.provider, model.id);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="model-picker-backdrop" role="presentation" onClick={onClose}>
      <div className="model-picker" role="dialog" aria-modal="true" aria-label="Choose a model" onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>Choose a model</h2>
          <button type="button" onClick={onClose} aria-label="Close model picker">×</button>
        </header>
        <input
          autoFocus
          placeholder="Search models"
          aria-label="Search models"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {error ? <p role="alert">{error}</p> : null}
        <ul aria-label="Available models">
          {filtered.map((model) => (
            <li key={`${model.provider}/${model.id}`}>
              <button type="button" disabled={!model.available || pending === `${model.provider}/${model.id}`} onClick={() => void pick(model)}>
                <strong>{model.name}</strong>
                <span>{model.provider}/{model.id}</span>
                {!model.available && model.reason ? <small>{model.reason}</small> : null}
              </button>
            </li>
          ))}
          {filtered.length === 0 ? <li className="empty">{query ? `No models match “${query}”.` : "No models available. Open a session or configure/login to a provider."}</li> : null}
        </ul>
      </div>
    </div>
  );
}
