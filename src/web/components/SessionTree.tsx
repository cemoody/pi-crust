import { useMemo, useState } from "react";

export type TreeFilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

export interface SessionTreeEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly role: "user" | "assistant" | "tool" | "summary" | "custom";
  readonly text: string;
  readonly label?: string;
}

export interface SessionTreeProps {
  readonly entries: readonly SessionTreeEntry[];
  readonly currentLeafId: string | null;
  readonly onNavigate: (entryId: string, options: { summary: "none" | "default" | "custom"; customInstructions?: string }) => void;
  readonly onRestoreUserMessage: (text: string) => void;
  readonly onLabel: (entryId: string, label: string | undefined) => void;
  readonly onFork: (entryId: string) => void;
  readonly onClone: () => void;
}

export function SessionTree(props: SessionTreeProps) {
  const [filter, setFilter] = useState<TreeFilterMode>("default");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [summary, setSummary] = useState<"none" | "default" | "custom">("none");
  const [customInstructions, setCustomInstructions] = useState("");
  const [labelText, setLabelText] = useState("");

  const selected = selectedId ? props.entries.find((entry) => entry.id === selectedId) : undefined;
  const visible = useMemo(() => props.entries.filter((entry) => matchesFilter(entry, filter)), [filter, props.entries]);

  function select(entry: SessionTreeEntry) {
    setSelectedId(entry.id);
    setLabelText(entry.label ?? "");
  }

  function navigate() {
    if (!selected) return;
    if (selected.role === "user") props.onRestoreUserMessage(selected.text);
    props.onNavigate(selected.id, { summary, ...(summary === "custom" ? { customInstructions } : {}) });
  }

  return (
    <section aria-label="Session tree">
      <header>
        <h2>Session tree</h2>
        <select aria-label="Tree filter" value={filter} onChange={(event) => setFilter(event.target.value as TreeFilterMode)}>
          <option value="default">default</option>
          <option value="no-tools">no-tools</option>
          <option value="user-only">user-only</option>
          <option value="labeled-only">labeled-only</option>
          <option value="all">all</option>
        </select>
        <button type="button" onClick={props.onClone}>Clone</button>
      </header>

      <ul aria-label="Tree entries">
        {visible.map((entry) => (
          <li key={entry.id}>
            <button type="button" aria-current={entry.id === props.currentLeafId ? "true" : undefined} onClick={() => select(entry)}>
              {entry.role}: {entry.text}{entry.label ? ` [${entry.label}]` : ""}
            </button>
          </li>
        ))}
      </ul>

      {selected ? (
        <aside aria-label="Tree entry details">
          <h3>{selected.role}</h3>
          <p>{selected.text}</p>
          <label>Label <input aria-label="Entry label" value={labelText} onChange={(event) => setLabelText(event.target.value)} /></label>
          <button type="button" onClick={() => props.onLabel(selected.id, labelText || undefined)}>Save label</button>
          <button type="button" onClick={() => props.onLabel(selected.id, undefined)}>Clear label</button>
          <button type="button" onClick={() => props.onFork(selected.id)}>Fork</button>

          <fieldset>
            <legend>Branch summary</legend>
            <label><input type="radio" name="summary" checked={summary === "none"} onChange={() => setSummary("none")} /> none</label>
            <label><input type="radio" name="summary" checked={summary === "default"} onChange={() => setSummary("default")} /> default</label>
            <label><input type="radio" name="summary" checked={summary === "custom"} onChange={() => setSummary("custom")} /> custom</label>
            {summary === "custom" ? <textarea aria-label="Custom summary instructions" value={customInstructions} onChange={(event) => setCustomInstructions(event.target.value)} /> : null}
          </fieldset>
          <button type="button" onClick={navigate}>Navigate</button>
        </aside>
      ) : null}
    </section>
  );
}

function matchesFilter(entry: SessionTreeEntry, filter: TreeFilterMode): boolean {
  if (filter === "all" || filter === "default") return true;
  if (filter === "no-tools") return entry.role !== "tool";
  if (filter === "user-only") return entry.role === "user";
  if (filter === "labeled-only") return Boolean(entry.label);
  return true;
}
