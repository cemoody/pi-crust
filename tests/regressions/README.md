# Regression vault

Every file in this directory recreates a real incident on the dev box.
Tests are named `<YYYY-MM-DD>-<short-symptom>.test.ts` and contain a
single `describe` block whose comment is the executive summary of the
post-mortem.

The contract is:

1. **One incident per file.** Tests here are documentation that also runs.
2. **No dependency on the project's own source.** Each regression
   recreates the bug in a sandbox built from `tests/helpers/fs-chaos.ts`
   or `tests/helpers/fake-pi.ts`. Anything else and you can't tell
   whether a future refactor broke the *symptom* or the *test*.
3. **Both the bad behavior and the diagnostic shape are asserted.** It's
   not enough that the supervisor recovers; the operator must see an
   actionable log line. Today's outages all had "recovered eventually"
   but were undiagnosable because the failure mode didn't surface a
   trail.
4. **Failure messages reference the date.** If a regression test starts
   failing the assertion error should immediately point a future
   on-caller at the post-mortem in this directory.

If you add a new incident here, also update `docs/incidents.md`.
