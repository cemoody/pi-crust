import { useState } from "react";
import type { ExtensionUiRequest } from "../../shared/protocol.js";

type DialogRequest = Extract<ExtensionUiRequest, { method: "confirm" | "select" | "input" | "editor" }>;

export interface ExtensionUiDialogsProps {
  readonly dialogs: readonly DialogRequest[];
  readonly onValueResponse: (id: string, value: string) => void | Promise<void>;
  readonly onConfirmResponse: (id: string, confirmed: boolean) => void | Promise<void>;
  readonly onCancelResponse: (id: string) => void | Promise<void>;
}

/** Renders extension input and approval dialogs with their local form state. */
export function ExtensionUiDialogs({ dialogs, onValueResponse, onConfirmResponse, onCancelResponse }: ExtensionUiDialogsProps) {
  const [inputValues, setInputValues] = useState<Record<string, string>>({});

  return (
    <>
      <aside aria-label="Approval inbox">
        {dialogs.map((dialog) => <p key={dialog.id}>{dialog.title}</p>)}
      </aside>
      {dialogs.map((dialog) => {
        if (dialog.method === "confirm") {
          return (
            <div key={dialog.id} role="dialog" aria-label={dialog.title}>
              {dialog.message ? <p>{dialog.message}</p> : null}
              <button type="button" onClick={() => void onConfirmResponse(dialog.id, true)}>Confirm</button>
              <button type="button" onClick={() => void onConfirmResponse(dialog.id, false)}>Deny</button>
              <button type="button" onClick={() => void onCancelResponse(dialog.id)}>Cancel</button>
            </div>
          );
        }
        if (dialog.method === "select") {
          return (
            <div key={dialog.id} role="dialog" aria-label={dialog.title}>
              {dialog.options.map((option) => <button key={option} type="button" onClick={() => void onValueResponse(dialog.id, option)}>{option}</button>)}
              <button type="button" onClick={() => void onCancelResponse(dialog.id)}>Cancel</button>
            </div>
          );
        }
        const value = inputValues[dialog.id] ?? (dialog.method === "editor" ? dialog.prefill ?? "" : "");
        const label = `${dialog.title} value`;
        const updateValue = (text: string) => setInputValues((current) => ({ ...current, [dialog.id]: text }));
        return (
          <div key={dialog.id} role="dialog" aria-label={dialog.title}>
            {dialog.method === "editor" ? (
              <textarea aria-label={label} value={value} onChange={(event) => updateValue(event.target.value)} />
            ) : (
              <input aria-label={label} placeholder={dialog.placeholder} value={value} onChange={(event) => updateValue(event.target.value)} />
            )}
            <button type="button" onClick={() => void onValueResponse(dialog.id, value)}>Submit</button>
            <button type="button" onClick={() => void onCancelResponse(dialog.id)}>Cancel</button>
          </div>
        );
      })}
    </>
  );
}
