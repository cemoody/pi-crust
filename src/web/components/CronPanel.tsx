import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CronApi, CronJobInput, CronJobView } from "../api/session-api.js";
import { useNotifications } from "./notifications.js";
import "./cron-panel.css";

export interface CronPanelProps {
  readonly api: CronApi;
  readonly defaultCwd: string;
  readonly onOpenSession: (sessionId: string) => void;
}

interface EditDraft {
  readonly id: string | null; // null = creating
  name: string;
  schedule: string;
  cwd: string;
  prompt: string;
  enabled: boolean;
}

const EMPTY_DRAFT: Omit<EditDraft, "cwd"> = {
  id: null,
  name: "",
  schedule: "*/5 * * * *",
  prompt: "",
  enabled: true,
};

export function CronPanel({ api, defaultCwd, onOpenSession }: CronPanelProps) {
  const { notify, dismiss } = useNotifications();
  // Errors auto-dismiss like other toasts. We still track the last id so
  // a successful reload can clear an error toast early (matching the
  // prior "dismiss banner on next success" behavior).
  const lastErrorIdRef = useRef<string | null>(null);
  const setError = useCallback((message: string | null) => {
    if (message === null) {
      if (lastErrorIdRef.current) { dismiss(lastErrorIdRef.current); lastErrorIdRef.current = null; }
      return;
    }
    lastErrorIdRef.current = notify({ kind: "error", message });
  }, [notify, dismiss]);
  const setNotice = useCallback((message: string) => { notify({ kind: "success", message }); }, [notify]);
  const [jobs, setJobs] = useState<readonly CronJobView[]>([]);
  const [filePath, setFilePath] = useState<string>("");
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftSaving, setDraftSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const response = await api.list();
      setJobs(response.jobs);
      setFilePath(response.filePath);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void reload(); }, [reload]);

  const startCreate = useCallback(() => {
    setDraftError(null);
    setDraftSaving(false);
    setDraft({ ...EMPTY_DRAFT, cwd: defaultCwd });
  }, [defaultCwd]);

  const startEdit = useCallback((job: CronJobView) => {
    setDraftError(null);
    setDraftSaving(false);
    setDraft({
      id: job.id,
      name: job.name,
      schedule: job.schedule,
      cwd: job.cwd,
      prompt: job.prompt,
      enabled: job.enabled,
    });
  }, []);

  const closeDraft = useCallback(() => {
    setDraft(null);
    setDraftError(null);
    setDraftSaving(false);
  }, []);

  const saveDraft = useCallback(async () => {
    if (!draft) return;
    setDraftSaving(true);
    setDraftError(null);
    try {
      if (draft.id === null) {
        const input: CronJobInput = {
          name: draft.name.trim(),
          schedule: draft.schedule.trim(),
          cwd: draft.cwd.trim(),
          prompt: draft.prompt,
          enabled: draft.enabled,
        };
        await api.create(input);
        setNotice(`Created cron job "${input.name}"`);
      } else {
        await api.update(draft.id, {
          name: draft.name,
          schedule: draft.schedule,
          cwd: draft.cwd,
          prompt: draft.prompt,
          enabled: draft.enabled,
        });
        setNotice(`Updated cron job "${draft.name}"`);
      }
      setDraft(null);
      setDraftError(null);
      await reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const friendly = /not found|404/i.test(message)
        ? `${message} — the server may be running an old build without cron support. Restart it to pick up the new /api/cron routes.`
        : message;
      console.error("[cron] save failed", err);
      setDraftError(friendly);
    } finally {
      setDraftSaving(false);
    }
  }, [api, draft, reload]);

  const toggleEnabled = useCallback(async (job: CronJobView) => {
    setBusyJobId(job.id);
    try {
      await api.update(job.id, { enabled: !job.enabled });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyJobId(null);
    }
  }, [api, reload]);

  const deleteJob = useCallback(async (job: CronJobView) => {
    if (!window.confirm(`Delete cron job "${job.name}"?`)) return;
    setBusyJobId(job.id);
    try {
      await api.delete(job.id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyJobId(null);
    }
  }, [api, reload]);

  const runNow = useCallback(async (job: CronJobView) => {
    setBusyJobId(job.id);
    try {
      const result = await api.runNow(job.id);
      setNotice(`Started session for "${job.name}"`);
      await reload();
      onOpenSession(result.sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyJobId(null);
    }
  }, [api, onOpenSession, reload]);

  const sortedJobs = useMemo(() => jobs.slice().sort((a, b) => a.name.localeCompare(b.name)), [jobs]);

  return (
    <section className="cron-panel" aria-label="Schedule">
      <div className="cron-panel-inner">
        <header className="cron-panel-header">
          <div className="cron-panel-title">
            <h2>Schedule</h2>
            <span className="cron-panel-subtitle" title={filePath}>
              {filePath ? <code>{filePath}</code> : null}
            </span>
          </div>
          <div className="cron-panel-actions">
            <button type="button" onClick={startCreate} className="cron-primary">New scheduled job</button>
          </div>
        </header>


        {loading ? (
          <p className="cron-empty">Loading…</p>
        ) : sortedJobs.length === 0 ? (
          <p className="cron-empty">No scheduled jobs yet. Create one to schedule a prompt.</p>
        ) : (
          <ul className="cron-list" aria-label="Scheduled jobs">
            {sortedJobs.map((job) => (
              <li key={job.id} className={`cron-card ${job.scheduleError ? "cron-card-error" : ""}`}>
                <div className="cron-card-head">
                  <div className="cron-card-identity">
                    <h3 className="cron-card-name">{job.name}</h3>
                    <code className="cron-card-cwd" title={job.cwd}>{job.cwd}</code>
                  </div>
                  <div className="cron-card-head-right">
                    <button
                      type="button"
                      className={`cron-toggle ${job.enabled ? "on" : "off"}`}
                      aria-pressed={job.enabled}
                      disabled={busyJobId === job.id}
                      onClick={() => void toggleEnabled(job)}
                      title={job.enabled ? "Disable" : "Enable"}
                    >
                      <span className="cron-toggle-dot" aria-hidden="true" />
                      {job.enabled ? "Enabled" : "Disabled"}
                    </button>
                  </div>
                </div>

                <dl className="cron-card-meta">
                  <div className="cron-meta-item">
                    <dt>Schedule</dt>
                    <dd>
                      <code>{job.schedule}</code>
                      {job.scheduleError ? <div className="cron-error-text">{job.scheduleError}</div> : null}
                    </dd>
                  </div>
                  <div className="cron-meta-item">
                    <dt>Next run</dt>
                    <dd>{job.enabled ? formatTime(job.nextRun) : <span className="cron-muted">—</span>}</dd>
                  </div>
                  <div className="cron-meta-item">
                    <dt>Last run</dt>
                    <dd>{formatTime(job.lastRun)}</dd>
                  </div>
                </dl>

                <div className="cron-card-prompt">
                  <div className="cron-card-prompt-label">Prompt</div>
                  <div className="cron-card-prompt-body" title={job.prompt || "(empty)"}>
                    {job.prompt ? truncate(job.prompt, 240) : <em className="cron-muted">(empty)</em>}
                  </div>
                </div>

                <div className="cron-card-actions">
                  <button type="button" className="cron-action-primary" onClick={() => void runNow(job)} disabled={busyJobId === job.id} title="Run now (spawn session)">Run now</button>
                  <button type="button" onClick={() => startEdit(job)} disabled={busyJobId === job.id}>Edit</button>
                  <button type="button" className="cron-danger" onClick={() => void deleteJob(job)} disabled={busyJobId === job.id}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {draft ? (
        <CronDraftDialog
          draft={draft}
          error={draftError}
          saving={draftSaving}
          onChange={setDraft}
          onSave={() => void saveDraft()}
          onCancel={closeDraft}
        />
      ) : null}
    </section>
  );
}

interface CronDraftDialogProps {
  readonly draft: EditDraft;
  readonly error: string | null;
  readonly saving: boolean;
  readonly onChange: (draft: EditDraft) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}

function CronDraftDialog({ draft, error, saving, onChange, onSave, onCancel }: CronDraftDialogProps) {
  const valid = !!(draft.name.trim() && draft.schedule.trim() && draft.cwd.trim());
  return (
    <div className="new-session-backdrop" role="presentation" onClick={onCancel}>
      <section
        className="new-session-dialog cron-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={draft.id ? "Edit scheduled job" : "New scheduled job"}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <h2>{draft.id ? "Edit scheduled job" : "New scheduled job"}</h2>
          <button type="button" onClick={onCancel} aria-label="Close scheduled job dialog" disabled={saving}>×</button>
        </header>
        {error ? <div className="cron-dialog-error" role="alert">{error}</div> : null}
        <div className="cron-form">
          <label>
            <span>Name</span>
            <input value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} autoFocus />
          </label>
          <label>
            <span>Schedule (5-field cron, e.g. <code>*/5 * * * *</code>)</span>
            <input value={draft.schedule} onChange={(event) => onChange({ ...draft, schedule: event.target.value })} />
          </label>
          <label>
            <span>Working directory</span>
            <input value={draft.cwd} onChange={(event) => onChange({ ...draft, cwd: event.target.value })} />
          </label>
          <label>
            <span>Prompt</span>
            <textarea
              value={draft.prompt}
              onChange={(event) => onChange({ ...draft, prompt: event.target.value })}
              rows={8}
              placeholder="Prompt text to send when this job fires"
            />
          </label>
          <label className="cron-form-inline">
            <input type="checkbox" checked={draft.enabled} onChange={(event) => onChange({ ...draft, enabled: event.target.checked })} />
            <span>Enabled</span>
          </label>
        </div>
        <footer className="cron-dialog-footer">
          <button type="button" onClick={onCancel} disabled={saving}>Cancel</button>
          <button type="button" className="cron-primary" disabled={!valid || saving} onClick={onSave}>
            {saving ? (draft.id ? "Saving…" : "Creating…") : (draft.id ? "Save" : "Create")}
          </button>
        </footer>
      </section>
    </div>
  );
}

function formatTime(ts: number | null | undefined): ReactNode {
  if (!ts) return <span className="cron-muted">—</span>;
  const d = new Date(ts);
  return d.toLocaleString();
}

function truncate(text: string, max: number): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
