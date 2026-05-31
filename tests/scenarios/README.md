# Scenario tier — reproducible "whole deployment" tests

These are heavyweight, **out-of-process** integration tests. Each one stands up
the *entire* live topology in a hermetic sandbox and perturbs it the way the
real world does, then asserts on the emergent, unix-level behavior that pure
unit/e2e tests structurally cannot reach (signal forwarding, orphaned process
trees, port wars, mid-pull crashes, dead-socket reattach).

```
npm run scenarios                         # run the whole tier (sequential, ~1 min)
npm run scenarios -- <file> -t "<name>"   # one test
```

## The orchestrator: `tests/helpers/live-stack.ts`

One `startLiveStack(opts)` call builds, in temp dirs, and returns a handle to:

- a real **bare git remote + working clone** (the "repo")
- a dedicated **config dir** (clean extensions — the `.pi-crust-live` isolation)
- a dedicated **runtime dir** (`XDG_RUNTIME_DIR` sandbox)
- a **fake-pi** binary (deterministic worker, no LLM — see `tests/helpers/fake-pi.ts`)
- the **real `dev-api.mjs` loop** on a random port (production-shape supervisor)
- optionally the **real `dev-git-puller.mjs`** against the fake remote

The handle exposes:

| group | methods |
|---|---|
| `api` | `health()`, `listSessions()`, `openSession(id)`, `createSession()` |
| `remote` | `pushCommit(files)`, `pushBreaking(kind)`, `headSha()` |
| `proc` | `loopPid()`, `apiChildPids()`, `workerPids()`, `killApiChild()`, `killWorker()` |
| | `squatPort()`, `waitForApi()`, `waitForRollout(fromSha)` |
| `assert` | `sessionsHealthy()`, `noOrphans()`, `noStaleSockets()`, `portOwnedByUs()` |
| | `teardown()` |

Options: `realCheckout` (clone a real working copy so `npm run dev:api` runs the
checkout's own code and `/api/health` gitSha tracks its HEAD — needed for
rollout), `withPuller`, `autoRollout`, `port`, `expectRefusal`.

## How these double as the spec for the robust system

Each scenario reproduces a real 2026-05 incident and is the **executable
acceptance criterion** for one robustness feature. We wrote the failing scenario
first (TDD for infra); implementing the feature turns it green and leaves a
permanent regression guard.

| scenario | feature | status today |
|---|---|---|
| `enoent-self-heals.test.ts` A (API up, worker dies) | **B** self-healing registry | 🔴 spec |
| `enoent-self-heals.test.ts` B (API restart) | B baseline (cold-discovery heal) | 🟢 |
| `port-squatter-refused.test.ts` | **C** single-owner + loud failures | 🔴 spec |
| `rollout-gated.test.ts` 1 (green push) | **A** auto rollout | 🟢 |
| `rollout-gated.test.ts` 2 (breaking push) | **A** health/smoke gate | 🔴 spec |

## Build order (A→B→C priority, TDD)

1. **Feature B** — make `getOrOpenSession` reconcile: detect a dead handle
   (pid not alive OR socket not connectable) and transparently re-spawn.
   Turn `enoent-self-heals` A green.
2. **Feature C** — teach `dev-api.mjs` to detect a *foreign* port holder (not
   its own descendant), emit a single-owner diagnostic, and back off instead of
   tight-respawning. Turn `port-squatter-refused` green.
3. **Feature A** — add a stage→build→smoke→promote pipeline (e.g.
   `scripts/promote.mjs` invoked by the puller on new commits) that boots a
   throwaway server on a scratch port, hits `/api/health`, opens a session, and
   only promotes on green. Turn `rollout-gated` 2 green.

## Author contract

- Sandboxes use the `pi-crust-scenario-` tmp prefix (registered with the
  process-hygiene reaper). Always `teardown()` in `afterEach`.
- The hygiene guard (`tests/setup/process-hygiene.ts`) is the backstop: it
  SIGKILLs any leaked `dev-api.mjs` / `pirpc-supervisor.mjs` and reaps stray
  sandboxes. `teardown()` is the primary contract; the guard catches hard kills.
