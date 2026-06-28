import { useEffect, useId, useRef, useState } from "react";
import type { ExtensionUiRequest } from "../../shared/protocol.js";
import "./extension-ui-host.css";

export interface ExtensionUiHostProps {
  readonly requests: readonly ExtensionUiRequest[];
  readonly onValueResponse: (id: string, value: string) => void | Promise<void>;
  readonly onConfirmResponse: (id: string, confirmed: boolean) => void | Promise<void>;
  readonly onCancelResponse: (id: string) => void | Promise<void>;
  readonly onEditorText?: (text: string) => void;
  /**
   * If provided, extension `notify` requests are dispatched here (e.g. to
   * the global toast region) instead of being rendered inline. The host
   * still renders inline as a fallback when this prop is omitted so the
   * component remains usable standalone (and in unit tests).
   */
  readonly onNotify?: (request: Extract<ExtensionUiRequest, { method: "notify" }>) => void;
}

export function ExtensionUiHost(props: ExtensionUiHostProps) {
  const [inputValues, setInputValues] = useState<Record<string, string>>({});

  const statuses = props.requests.filter(isStatusRequest).filter((request) => request.statusText);
  const widgets = props.requests.filter(isWidgetRequest).filter((request) => request.widgetLines);
  const notifications = props.requests.filter(isNotifyRequest);
  const dialogs = props.requests.filter(isDialogRequest);

  // When onNotify is provided, forward each notify request once. Track
  // already-forwarded ids so re-renders don't fire duplicate toasts.
  const forwardedNotifyIds = useRef<Set<string>>(new Set());
  const onNotify = props.onNotify;
  useEffect(() => {
    if (!onNotify) return;
    for (const request of notifications) {
      if (forwardedNotifyIds.current.has(request.id)) continue;
      forwardedNotifyIds.current.add(request.id);
      onNotify(request);
    }
  }, [notifications, onNotify]);

  useEffect(() => {
    for (const request of props.requests) {
      if (request.method === "setTitle") document.title = request.title;
      if (request.method === "set_editor_text") props.onEditorText?.(request.text);
    }
  }, [props]);

  if (statuses.length === 0 && widgets.length === 0 && notifications.length === 0 && dialogs.length === 0) return null;

  return (
    <section className="extension-ui-host" aria-label="Extension UI">
      {statuses.length ? (
        <div className="extension-status-tray" role="region" aria-label="Extension statuses">
          {statuses.map((status) => (
            <span key={status.id} className="extension-status-chip" title={status.statusText}>{status.statusText}</span>
          ))}
        </div>
      ) : null}

      {widgets.filter((widget) => widget.widgetPlacement !== "belowEditor").map((widget) => (
        <Widget key={widget.id} widget={widget} />
      ))}

      {notifications.length && !onNotify ? (
        <div aria-label="Notifications">
          {notifications.map((notification) => <div key={notification.id} role="status">{notification.message}</div>)}
        </div>
      ) : null}

      {dialogs.length ? (
        <aside aria-label="Approval inbox">
          {dialogs.map((dialog) => <p key={dialog.id}>{dialog.title}</p>)}
        </aside>
      ) : null}

      {dialogs.map((dialog) => {
        if (dialog.method === "confirm") {
          return (
            <div key={dialog.id} role="dialog" aria-label={dialog.title}>
              {dialog.message ? <p>{dialog.message}</p> : null}
              <button type="button" onClick={() => void props.onConfirmResponse(dialog.id, true)}>Confirm</button>
              <button type="button" onClick={() => void props.onConfirmResponse(dialog.id, false)}>Deny</button>
              <button type="button" onClick={() => void props.onCancelResponse(dialog.id)}>Cancel</button>
            </div>
          );
        }
        if (dialog.method === "select") {
          return (
            <div key={dialog.id} role="dialog" aria-label={dialog.title}>
              {dialog.options.map((option) => <button key={option} type="button" onClick={() => void props.onValueResponse(dialog.id, option)}>{option}</button>)}
              <button type="button" onClick={() => void props.onCancelResponse(dialog.id)}>Cancel</button>
            </div>
          );
        }
        if (dialog.method === "input" || dialog.method === "editor") {
          const value = inputValues[dialog.id] ?? (dialog.method === "editor" ? dialog.prefill ?? "" : "");
          return (
            <div key={dialog.id} role="dialog" aria-label={dialog.title}>
              {dialog.method === "editor" ? (
                <textarea aria-label={`${dialog.title} value`} value={value} onChange={(event) => setInputValues((current) => ({ ...current, [dialog.id]: event.target.value }))} />
              ) : (
                <input aria-label={`${dialog.title} value`} placeholder={dialog.placeholder} value={value} onChange={(event) => setInputValues((current) => ({ ...current, [dialog.id]: event.target.value }))} />
              )}
              <button type="button" onClick={() => void props.onValueResponse(dialog.id, value)}>Submit</button>
              <button type="button" onClick={() => void props.onCancelResponse(dialog.id)}>Cancel</button>
            </div>
          );
        }
        return null;
      })}

      {widgets.filter((widget) => widget.widgetPlacement === "belowEditor").map((widget) => (
        <Widget key={widget.id} widget={widget} />
      ))}
    </section>
  );
}

function Widget({ widget }: { readonly widget: Extract<ExtensionUiRequest, { method: "setWidget" }> }) {
  const contentId = useId();
  const lines = widget.widgetLines ?? [];
  const [expanded, setExpanded] = useState(false);
  const preview = lines[0] ?? "";
  const summary = `${lines.length} item${lines.length === 1 ? "" : "s"}`;
  return (
    <section aria-label={`Widget ${widget.widgetKey}`} role="group" className="extension-widget" data-expanded={expanded ? "true" : "false"}>
      <button
        type="button"
        className="extension-widget-header"
        aria-label={`${widget.widgetKey} extension widget`}
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="extension-widget-caret" aria-hidden="true">▸</span>
        <span className="extension-widget-title">{widget.widgetKey}</span>
        <span className="extension-widget-preview" title={preview}>{preview}</span>
        <span className="extension-widget-count">{summary}</span>
      </button>
      <div id={contentId} className="extension-widget-body">
        {lines.map((line, index) => <p key={index} title={line}>{line}</p>)}
      </div>
    </section>
  );
}

function isStatusRequest(request: ExtensionUiRequest): request is Extract<ExtensionUiRequest, { method: "setStatus" }> {
  return request.method === "setStatus";
}

function isWidgetRequest(request: ExtensionUiRequest): request is Extract<ExtensionUiRequest, { method: "setWidget" }> {
  return request.method === "setWidget";
}

function isNotifyRequest(request: ExtensionUiRequest): request is Extract<ExtensionUiRequest, { method: "notify" }> {
  return request.method === "notify";
}

function isDialogRequest(request: ExtensionUiRequest): request is Extract<ExtensionUiRequest, { method: "confirm" | "select" | "input" | "editor" }> {
  return request.method === "confirm" || request.method === "select" || request.method === "input" || request.method === "editor";
}
