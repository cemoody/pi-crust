# Incident log

A chronological list of dev-box incidents that have shipped tests in
`tests/regressions/`. Each entry summarizes what happened, what made it
hard to diagnose, and which test now pins the invariant.

The discipline is: **every incident gets a regression test**. If a
future outage matches a shape we've seen before, the failing test
points at this doc, which points at the post-mortem.

---

## 2026-05-23 — ELOOP inside `node_modules` (33-minute API outage)

**Summary.** `scripts/dev-api.mjs` crash-looped on `spawn ELOOP` for 33
minutes while its `tryHealCyclicNodeModules()` heuristic silently
no-op'd. The auto-heal only matched the case where `node_modules`
itself is a self-referential symlink; the actual ELOOP was on a
*nested* symlink (`node_modules/.bin/tsx`), so the heal returned false
every time.

**Diagnosis cost.** ~25 minutes. Logs were just "spawn ELOOP — Will
retry" 41 times a minute with no hint of which symlink was broken.

**Fix.** `tryHealCyclicNodeModules()` now (a) detects nested cyclic
symlinks under `node_modules/` via bounded `realpath` probing, (b)
unlinks them, and (c) runs `npm install`. The "heal not applicable"
fallback path emits an actionable diagnostic instead of an opaque
"Will retry".

**Regression test.** `tests/regressions/2026-05-23-eloop-inside-node-modules.test.ts`

---

## 2026-05-23 — two dev-api supervisors fighting for port 8787

**Summary.** An orphan `dev-api.mjs` supervisor (PPID=1, started ~12h
earlier from a since-closed tty) held port 8787 via its child API. The
operator started a *second* `dev:api:loop` in the same tmux pane; the
new supervisor crash-looped silently every 2 s with `EADDRINUSE` and
no information about who held the port.

**Diagnosis cost.** ~10 minutes (helped enormously by `ss -tlnp`).
Cost would have been minutes more in any context where the holder
wasn't a `node` process or wasn't running under the same user.

**Fix.** On a non-zero exit, the supervisor now probes the configured
port and logs the holder's `pid`, `cwd`, and `cmdline`. Probe is
throttled to once per 30 s so a fast crash-loop doesn't fill the log.

**Regression test.** `tests/regressions/2026-05-23-two-supervisors-port-fight.test.ts`

---

## 2026-05-23 — git puller silently failed for 8 days

**Summary.** `~/bin/prc-loop.sh` runs an inline bash puller that pulls
`origin/main` every 15 s. The worktree had drifted onto a release
branch with local-only commits, so every pull failed with "Not
possible to fast-forward, aborting." The bash puller logged this on
every iteration for 8 days: ~46k entries, 10 MB log file, no human
ever noticed.

**Diagnosis cost.** ~5 minutes once we knew to look at the log; 0
minutes of human awareness over the 8 days it was broken.

**Fix.** `scripts/dev-git-puller.mjs` now (a) collapses repeated
identical failures into a single log line + a summary every
`DEV_GIT_PULL_SUMMARY_INTERVAL_S` seconds, (b) emits a "recovered
after N failures" line when a streak ends, and (c) supports
`DEV_GIT_PULL_BRANCH=HEAD` to follow the currently checked-out branch
instead of hard-coding `main`.

**Regression test.** `tests/regressions/2026-05-23-git-puller-silent-divergence.test.ts`

---

## 2026-05-23 — 147 orphaned pirpc-supervisor processes (~16 GB RSS)

**Summary.** Every dev-api restart that didn't cleanly re-adopt its
per-session supervisors left them behind with `PPID=1`. Over 9 days
this accumulated to 147 processes, combined RSS ~16 GB, on a 62 GB
machine.

**Diagnosis cost.** ~5 minutes once we ran `ps -ef | grep
pirpc-supervisor | wc -l`. Lurked invisibly for 9 days otherwise.

**Fix.** `scripts/reap-supervisors.mjs` sweeps orphan supervisors that
(a) are alive, (b) own a status file naming themselves, and (c) are
NOT descendants of any pid in `PIRPC_REAPER_LIVE_API_PIDS`. Safe to
run alongside a live API.

**Regression test.** `tests/regressions/2026-05-23-orphan-supervisor-leak.test.ts`

---

## 2026-05-15 — npm doesn't forward SIGTERM (process-group orphan)

**Summary.** Older `npm run dev:api:loop` chain used `child.kill(sig)`
instead of `process.kill(-pid, sig)`. npm's bash wrapper exits on
SIGTERM but doesn't forward to its tsx → node grandchildren, so the
real api process orphaned and kept holding port 8787. Subsequent
respawns failed `EADDRINUSE` forever.

**Fix.** Already merged before today's incident: `scripts/dev-api.mjs`
spawns children with `detached: true` and signals the whole group via
`process.kill(-pgid, ...)`.

**Regression tests.** `tests/integration/dev-api-supervisor.test.ts`
("SIGTERM on file change kills the child's whole process group").
