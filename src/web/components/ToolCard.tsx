import { useState } from "react";
import { copyTextToClipboard } from "../utils/clipboard.js";
import { useOptionalNotifications } from "./notifications.js";
import { ToolOutputRenderer } from "./tool-output-renderer.js";
import "./tool-card.css";

export interface ToolCardData {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly status: "running" | "success" | "error";
  readonly output: string;
  readonly truncated?: boolean;
  readonly fullOutputUrl?: string;
}

export interface ToolListProps {
  readonly tools: readonly ToolCardData[];
  readonly collapseSuccessfulByDefault?: boolean;
}

export function ToolList({ tools, collapseSuccessfulByDefault = false }: ToolListProps) {
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({});
  const [allCollapsed, setAllCollapsed] = useState(false);

  return (
    <section className="tool-list" aria-label="Tool calls">
      <div className="tool-list-actions">
        <button type="button" onClick={() => setAllCollapsed(false)}>Expand all</button>
        <button type="button" onClick={() => setAllCollapsed(true)}>Collapse all</button>
      </div>
      {tools.map((tool) => {
        const defaultExpanded = tool.status === "error" || !(collapseSuccessfulByDefault && tool.status === "success");
        const expanded = allCollapsed ? false : expandedOverrides[tool.id] ?? defaultExpanded;
        return (
          <ToolCard
            key={tool.id}
            tool={tool}
            expanded={expanded}
            onToggle={() => setExpandedOverrides((current) => ({ ...current, [tool.id]: !expanded }))}
          />
        );
      })}
    </section>
  );
}

export interface ToolCardProps {
  readonly tool: ToolCardData;
  readonly expanded?: boolean;
  readonly onToggle?: () => void;
}

export function ToolCard({ tool, expanded = tool.status !== "success", onToggle }: ToolCardProps) {
  return (
    <article className={`tool-card ${tool.status}`} aria-label={`${tool.name} tool`}>
      <header>
        <button type="button" onClick={onToggle} aria-expanded={expanded}>{expanded ? "▾" : "▸"}</button>
        <strong>{tool.name}</strong>
        <span>{tool.status}</span>
        {tool.truncated ? <span className="tool-badge">truncated</span> : null}
      </header>
      {expanded ? <ToolBody tool={tool} /> : null}
    </article>
  );
}

function ToolBody({ tool }: { readonly tool: ToolCardData }) {
  const notifications = useOptionalNotifications();
  // When toasts are available, the copy result becomes a transient toast
  // (success: 4s, error: persistent until dismissed). Otherwise fall back
  // to the inline pill so the component works standalone (and in tests).
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");

  async function copyOutput(): Promise<void> {
    try {
      await copyTextToClipboard(tool.output);
      if (notifications) notifications.notify({ kind: "success", message: "Copied tool output", durationMs: 1_800 });
      else setCopyStatus("copied");
    } catch (error) {
      console.warn("Unable to copy tool output to clipboard", error);
      if (notifications) notifications.notify({ kind: "error", message: "Failed to copy tool output" });
      else setCopyStatus("failed");
    }
  }

  return (
    <div className="tool-body">
      <ToolOutputRenderer tool={tool} />
      <footer>
        <button type="button" onClick={() => void copyOutput()}>Copy output</button>
        {!notifications && copyStatus !== "idle" ? (
          <span className={copyStatus === "failed" ? "copy-status failed" : "copy-status"} role="status">
            {copyStatus === "failed" ? "copy failed" : "copied"}
          </span>
        ) : null}
        {tool.fullOutputUrl ? <a href={tool.fullOutputUrl} download>Download full output</a> : null}
      </footer>
    </div>
  );
}
