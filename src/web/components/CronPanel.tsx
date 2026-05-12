import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { CronApi, CronJobInput, CronJobView } from "../api/session-api.js";
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
  const [jobs, setJobs] = useState<readonly CronJobView[]>([]);
  const [filePath, setFilePath] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
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
    setDraft({ ...EMPTY_DRAFT, cwd: defaultCwd });
  }, [defaultCwd]);

  const startEdit = useCallback((job: CronJobView) => {
    setDraft({
      id: job.id,
      name: job.name,
      schedule: job.schedule,
      cwd: job.cwd,
      prompt: job.prompt,
      enabled: job.enabled,
    });
  }, []);

  const closeDraft = useCallback(() => setDraft(null), []);

  const saveDraft = useCallback(async () => {
    if (!draft) return;
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
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    <section className="cron-panel" aria-label="Cron jobs">
      <header className="cron-panel-header">
        <div className="cron-panel-title">
          <h2>Cron jobs</h2>
          <span className="cron-panel-subtitle" title={filePath}>{filePath ? <code>{filePath}</code> : null}</span>
        </div>
        <div className="cron-panel-actions">
          <button type="button" onClick={startCreate} className="cron-primary">New cron job</button>
        </div>
      </header>

      {error ? <div className="cron-banner cron-banner-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div> : null}
      {notice ? <div className="cron-banner cron-banner-notice" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice(null)}>Dismiss</button></div> : null}

      {loading ? (
        <p className="cron-empty">Loading…</p>
      ) : sortedJobs.length === 0 ? (
        <p className="cron-empty">No cron jobs yet. Create one to schedule a prompt.</p>
      ) : (
        <div className="cron-table-wrapper">
          <table className="cron-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Schedule</th>
                <th>Prompt</th>
                <th>Enabled</th>
                <th>Last run</th>
                <th>Next run</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {sortedJobs.map((job) => (
                <tr key={job.id} className={job.scheduleError ? "cron-row-error" : ""}>
                  <td>
                    <div className="cron-cell-name">{job.name}</div>
                    <div className="cron-cell-cwd" title={job.cwd}><code>{job.cwd}</code></div>
                  </td>
                  <td>
                    <code>{job.schedule}</code>
                    {job.scheduleError ? <div className="cron-error-text">{job.scheduleError}</div> : null}
                  </td>
                  <td>
                    <div className="cron-cell-prompt" title={job.prompt || "(empty)"}>{truncate(job.prompt, 80) || <em>(empty)</em>}</div>
                  </td>
                  <td>
                    <button
                      type="button"
                      className={`cron-toggle ${job.enabled ? "on" : "off"}`}
                      aria-pressed={job.enabled}
                      disabled={busyJobId === job.id}
                      onClick={() => void toggleEnabled(job)}
                      title={job.enabled ? "Disable" : "Enable"}
                    >
                      {job.enabled ? "Enabled" : "Disabled"}
                    </button>
                  </td>
                  <td>{formatTime(job.lastRun)}</td>
                  <td>{job.enabled ? formatTime(job.nextRun) : <span className="cron-muted">—</span>}</td>
                  <td className="cron-row-actions">
                    <button type="button" onClick={() => void runNow(job)} disabled={busyJobId === job.id} title="Run now (spawn session)">Run now</button>
                    <button type="button" onClick={() => startEdit(job)} disabled={busyJobId === job.id}>Edit</button>
                    <button type="button" className="cron-danger" onClick={() => void deleteJob(job)} disabled={busyJobId === job.id}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {draft ? (
        <CronDraftDialog
          draft={draft}
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
  readonly onChange: (draft: EditDraft) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}

function CronDraftDialog({ draft, onChange, onSave, onCancel }: CronDraftDialogProps) {
  const valid = draft.name.trim() && draft.schedule.trim() && draft.cwd.trim();
  return (
    <div className="new-session-backdrop" role="presentation" onClick={onCancel}>
      <section
        className="new-session-dialog cron-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={draft.id ? "Edit cron job" : "New cron job"}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <h2>{draft.id ? "Edit cron job" : "New cron job"}</h2>
          <button type="button" onClick={onCancel} aria-label="Close cron dialog">×</button>
        </header>
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
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" className="cron-primary" disabled={!valid} onClick={onSave}>{draft.id ? "Save" : "Create"}</button>
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
