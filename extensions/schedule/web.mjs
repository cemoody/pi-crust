export function renderActivity(props) {
  const React = props.React;
  return React.createElement(SchedulePanel, { hostProps: props });
}

function SchedulePanel({ hostProps: props }) {
  const React = props.React;
  const { useEffect, useMemo, useState } = React;
  const defaultCwd = props.api.getDefaultCwd ? undefined : '';
  const [state, setState] = useState({ loading: true, error: null, jobs: [], filePath: '', defaultCwd: defaultCwd ?? '' });
  const [draft, setDraft] = useState({ name: '', schedule: '0 9 * * *', prompt: '', cwd: '' });
  const [editing, setEditing] = useState(null);
  const [busyJob, setBusyJob] = useState(null);

  const sortedJobs = useMemo(() => [...state.jobs].sort((a, b) => (a.nextRun ?? Number.MAX_SAFE_INTEGER) - (b.nextRun ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name)), [state.jobs]);
  const scheduleApi = createScheduleApi(props.api);

  const refresh = () => {
    if (!scheduleApi) {
      setState((current) => ({ ...current, loading: false, error: 'Schedule API is not available.' }));
      return Promise.resolve();
    }
    setState((current) => ({ ...current, loading: true, error: null }));
    return scheduleApi.list()
      .then((result) => setState((current) => ({ ...current, loading: false, error: null, jobs: result.jobs, filePath: result.filePath })))
      .catch((error) => setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : String(error) })));
  };

  useEffect(() => {
    let cancelled = false;
    Promise.resolve(props.api.getDefaultCwd?.()).then((cwd) => {
      if (!cancelled && cwd) {
        setState((current) => ({ ...current, defaultCwd: cwd }));
        setDraft((current) => current.cwd ? current : { ...current, cwd });
      }
    }).catch(() => undefined);
    refresh();
    return () => { cancelled = true; };
  }, []);

  const resetDraft = () => {
    setEditing(null);
    setDraft({ name: '', schedule: '0 9 * * *', prompt: '', cwd: state.defaultCwd || '' });
  };

  const submit = (event) => {
    event.preventDefault();
    if (!scheduleApi) return;
    const input = {
      name: draft.name.trim(),
      schedule: draft.schedule.trim(),
      prompt: draft.prompt,
      cwd: draft.cwd.trim() || state.defaultCwd,
      enabled: true,
    };
    const op = editing ? scheduleApi.update(editing, input) : scheduleApi.create(input);
    setState((current) => ({ ...current, loading: true, error: null }));
    op.then(() => { resetDraft(); return refresh(); })
      .catch((error) => setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : String(error) })));
  };

  const editJob = (job) => {
    setEditing(job.id);
    setDraft({ name: job.name, schedule: job.schedule, prompt: job.prompt, cwd: job.cwd });
  };

  const updateJob = (job, patch) => {
    if (!scheduleApi) return;
    setBusyJob(job.id);
    scheduleApi.update(job.id, patch).then(refresh)
      .catch((error) => setState((current) => ({ ...current, error: error instanceof Error ? error.message : String(error) })))
      .finally(() => setBusyJob(null));
  };

  const runJob = (job) => {
    if (!scheduleApi) return;
    setBusyJob(job.id);
    scheduleApi.runNow(job.id)
      .then(async (result) => {
        if (result.sessionId && props.navigation?.openSession) await props.navigation.openSession(result.sessionId);
        return refresh();
      })
      .catch((error) => setState((current) => ({ ...current, error: error instanceof Error ? error.message : String(error) })))
      .finally(() => setBusyJob(null));
  };

  const deleteJob = (job) => {
    if (!scheduleApi) return;
    setBusyJob(job.id);
    scheduleApi.delete(job.id).then(refresh)
      .catch((error) => setState((current) => ({ ...current, error: error instanceof Error ? error.message : String(error) })))
      .finally(() => setBusyJob(null));
  };

  return React.createElement('div', { className: 'cron-panel external-schedule-panel' },
    React.createElement('header', null,
      React.createElement('div', null,
        React.createElement('h2', null, 'Schedule'),
        React.createElement('p', null, state.filePath || 'Scheduled Pi prompts')
      ),
      React.createElement('button', { type: 'button', onClick: refresh, disabled: state.loading }, state.loading ? 'Loading…' : 'Refresh')
    ),
    state.error ? React.createElement('p', { role: 'alert', className: 'dialog-error' }, state.error) : null,
    React.createElement('form', { className: 'cron-form', onSubmit: submit },
      React.createElement('label', null, React.createElement('span', null, 'Name'), React.createElement('input', { value: draft.name, onChange: (event) => setDraft({ ...draft, name: event.target.value }), placeholder: 'Nightly summary', required: true })),
      React.createElement('label', null, React.createElement('span', null, 'Schedule'), React.createElement('input', { value: draft.schedule, onChange: (event) => setDraft({ ...draft, schedule: event.target.value }), placeholder: '0 9 * * *', required: true })),
      React.createElement('label', null, React.createElement('span', null, 'Working directory'), React.createElement('input', { value: draft.cwd, onChange: (event) => setDraft({ ...draft, cwd: event.target.value }), placeholder: state.defaultCwd || '/workspace', required: true })),
      React.createElement('label', { className: 'cron-form-prompt' }, React.createElement('span', null, 'Prompt'), React.createElement('textarea', { value: draft.prompt, onChange: (event) => setDraft({ ...draft, prompt: event.target.value }), placeholder: 'What should Pi do?', rows: 5 })),
      React.createElement('div', { className: 'cron-form-actions' },
        React.createElement('button', { type: 'submit', disabled: state.loading }, editing ? 'Save schedule' : 'Add schedule'),
        editing ? React.createElement('button', { type: 'button', onClick: resetDraft }, 'Cancel') : null
      )
    ),
    sortedJobs.length === 0 && !state.loading ? React.createElement('p', { className: 'cron-empty' }, 'No scheduled jobs yet.') : null,
    sortedJobs.length > 0 ? React.createElement('ul', { className: 'cron-job-list' }, sortedJobs.map((job) => React.createElement('li', { key: job.id, className: `cron-job-card ${job.enabled ? '' : 'disabled'}` },
      React.createElement('div', { className: 'cron-job-main' },
        React.createElement('div', { className: 'cron-job-title' },
          React.createElement('strong', null, job.name),
          React.createElement('code', null, job.schedule),
          job.enabled ? null : React.createElement('span', { className: 'cron-job-disabled' }, 'disabled')
        ),
        React.createElement('p', { className: 'cron-job-prompt' }, job.prompt || 'No prompt text'),
        React.createElement('p', { className: 'cron-job-meta' }, `${job.cwd} · next ${formatTime(job.nextRun)} · last ${formatTime(job.lastRun)}`),
        job.scheduleError ? React.createElement('p', { role: 'alert', className: 'dialog-error' }, job.scheduleError) : null
      ),
      React.createElement('div', { className: 'cron-job-actions' },
        React.createElement('button', { type: 'button', onClick: () => runJob(job), disabled: busyJob === job.id }, busyJob === job.id ? 'Running…' : 'Run now'),
        React.createElement('button', { type: 'button', onClick: () => editJob(job) }, 'Edit'),
        React.createElement('button', { type: 'button', onClick: () => updateJob(job, { enabled: !job.enabled }) }, job.enabled ? 'Disable' : 'Enable'),
        React.createElement('button', { type: 'button', className: 'danger', onClick: () => deleteJob(job) }, 'Delete')
      )
    ))) : null
  );
}

function createScheduleApi(hostApi) {
  if (hostApi.cron) return hostApi.cron;
  if (!hostApi.request) return null;
  return {
    list: () => hostApi.request('/api/cron'),
    create: (input) => hostApi.request('/api/cron', { method: 'POST', body: input }),
    update: (id, patch) => hostApi.request(`/api/cron/${encodeURIComponent(id)}`, { method: 'POST', body: patch }),
    delete: async (id) => { await hostApi.request(`/api/cron/${encodeURIComponent(id)}/delete`, { method: 'POST', body: {} }); },
    runNow: (id) => hostApi.request(`/api/cron/${encodeURIComponent(id)}/run`, { method: 'POST', body: {} }),
  };
}

function formatTime(value) {
  if (value === null || value === undefined) return 'never';
  try { return new Date(value).toLocaleString(); } catch { return String(value); }
}
