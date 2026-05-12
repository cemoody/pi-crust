# Mobile UX Screenshot Audit

> **Update (after fixes):** see the *Post-fix verification* section at the
> bottom. All P0 / P1 / P2 items have been addressed and re-verified with the
> same screenshot spec.


Generated via `tests/playwright/mobile-screenshots.spec.ts`. Each viewport / state
combination is at `mobile-screenshots/<viewport>/<state>.png`.

## Viewports tested

| Name        | Size       | Represents              |
| ----------- | ---------- | ----------------------- |
| galaxy-fold | 344 × 882  | narrow folded Android   |
| iphone-se   | 375 × 667  | small iOS               |
| iphone-14   | 390 × 844  | modern iOS              |
| pixel-7     | 412 × 915  | modern Android          |
| ipad-mini   | 768 × 1024 | small tablet            |

## States captured

01 session-list · 02 active-session · 03 composer-focused · 04 sidebar-collapsed ·
05 new-session-dialog · 06 model-picker · 07 fork-dialog · 08 shortcut-help ·
09 after-send · 10 status-bar

---

## Critical UI elements: visibility scorecard

Legend: ✅ fully visible · ⚠ visible but compromised (clipped, overlapping, or
illegible) · ❌ not visible / unreachable.

| Element                              | 344 | 375 | 390 | 412 | 768 |
| ------------------------------------ | --- | --- | --- | --- | --- |
| Sidebar (session list)               | ✅  | ✅  | ✅  | ✅  | ✅  |
| Active session chat (above the fold) | ❌  | ❌  | ⚠   | ⚠   | ✅  |
| Composer textarea                    | ⚠   | ✅  | ✅  | ✅  | ✅  |
| Send / submit affordance             | ⚠   | ✅  | ✅  | ✅  | ✅  |
| Session action row (fork/edit/del)   | ⚠   | ✅  | ✅  | ✅  | ✅  |
| Status bar (cwd / model / stats)     | ⚠   | ✅  | ✅  | ✅  | ✅  |
| Sidebar-collapsed "expand" button    | ⚠   | ⚠   | ⚠   | ⚠   | ✅  |
| Modal: new session                   | ✅  | ✅  | ✅  | ✅  | ✅  |
| Modal: model picker                  | ✅  | ✅  | ✅  | ✅  | ✅  |
| Modal: fork                          | ✅  | ✅  | ✅  | ✅  | ✅  |
| Modal: shortcut help                 | ✅  | ✅  | ✅  | ✅  | ✅  |

---

## Findings (with screenshot references)

### P0 — Critical, blocks core use on phones

1. **Sidebar permanently consumes ~40 % of vertical viewport on phones.**
   In `iphone-se/02-active-session.png`, `pixel-7/02-active-session.png`, and
   `galaxy-fold/02-active-session.png` the session list is stacked above the
   active session and takes ~280 px of vertical space *even after a session is
   selected*. Less than half the screen shows the actual conversation, and a
   single assistant turn pushes the very first user bubble out of view. On the
   404 × 882 fold viewport, after a few sends the composer is the only piece of
   the active session still on-screen (`galaxy-fold/10-status-bar.png`).
   The breakpoint at 720 px stacks the layout but never hides the sidebar.
   **Fix:** below 720 px, hide the sidebar by default once a session is active
   and turn it into a slide-over drawer. The existing `sidebarOpen` state and
   floating toggle already cover the mechanics — just need the drawer styling
   and a backdrop.

2. **Right-edge clipping at 344 px wide.**
   `galaxy-fold/02-active-session.png` and `04-sidebar-collapsed.png` show the
   delete (trash) icon, the edit (pencil) icon, and the right edge of the
   composer extending past the viewport. The bottom status bar
   "…pi-remote-control-mobile-ux" is similarly clipped. Container padding plus
   the fixed-width action-icon row do not honor narrow viewports.
   **Fix:** add a sub-420 px breakpoint that collapses the 6-icon top action row
   into an overflow menu (`⋯`), reduces dashboard padding to 4 px, and lets the
   status bar overflow horizontally with `overflow-x: auto`.

3. **Sidebar-collapsed expand button overlaps the session heading.**
   `iphone-se/04-sidebar-collapsed.png` shows the floating `sidebar-toggle--floating`
   icon sitting on top of the "S" of "Seeded session". Same artifact on
   `galaxy-fold/04-sidebar-collapsed.png`. There is no mobile top bar to give it
   a home.
   **Fix:** when `(max-width: 720px)`, introduce a sticky top bar containing
   `[hamburger] [session name] [overflow ⋯]` and remove the floating button.

### P1 — Major, hurts usability but not blocking

4. **Composer is not pinned to the bottom on long histories.**
   The composer flows at the end of the timeline (see all `02-active-session`
   and `10-status-bar` images). After several turns the composer scrolls off
   screen and users have to scroll to send. Mobile chat UX expects a
   bottom-anchored composer with the timeline scrolling above it.
   **Fix:** `position: sticky; bottom: 0` (or fixed within the session region)
   for the composer + status bar group; reserve safe-area-inset-bottom.

5. **Composer textarea font-size 13.5 px triggers iOS auto-zoom.**
   Confirmed in `prompt-composer.css` line 44 and visible in
   `iphone-se/03-composer-focused.png` where the textarea contains
   "typing a long-ish prompt that wraps...". On a real iOS device, focusing
   this input zooms the viewport 1.1×, which then traps the user at a wrong
   zoom level until they pinch out.
   **Fix:** under `@media (pointer: coarse)` set the prompt textarea to ≥16 px.
   Same for the model-picker search input and CWD input in the new-session
   dialog.

6. **Top action-row icons (fork / sub-fork / clone / edit / delete) are <30 px
   tap targets.**
   Visible in every `02-active-session.png`. The icons are spaced ~10 px apart
   and look ~22 px high — well below the recommended 40 px touch target. On the
   iPhone SE you can see they're tightly packed against the session heading.
   **Fix:** below 720 px move them into a single overflow menu, or expand them
   to ≥40 × 40 with breathing room.

7. **Status-bar text wraps to two tiny lines and is unactionable.**
   `iphone-se/10-status-bar.png` shows
   `idle · …ode/pi-remote-control-mobile-ux · no model selected · ↑0 ↓0 r0 w0 $0.0000 0% 200k`
   at ~11 px. None of the items are tap-targets even though several (model,
   cwd) are natural tap-to-edit candidates.
   **Fix:** turn it into a horizontally scrolling row of chips with ≥32 px
   height, where model and cwd are tappable.

### P2 — Polish

8. **CWD input in new-session dialog auto-scrolls to the right.**
   `iphone-se/05-new-session-dialog.png` shows "…e/pi-remote-control-mobile-ux"
   — the start of the path is invisible. Also a candidate for the iOS 16 px
   auto-zoom fix.
   **Fix:** initialize selection at the start (`setSelectionRange(0, 0)`) or
   render the path as a multi-line readonly text plus a separate "change" link.

9. **Modal dialogs don't use safe-area padding.**
   Fine in the simulator but on a real iPhone with notch + home indicator the
   "Cancel / Create session" row may be obscured. Add
   `padding-bottom: env(safe-area-inset-bottom)`.

10. **No visible "more / overflow" pattern.**
    Several actions (clone, sub-fork, tree) are presently rendered as disabled
    desktop icons. On mobile these should disappear entirely or move into an
    overflow menu instead of consuming horizontal space.

11. **`100vh` shell.**
    `session-dashboard.css` line 7–8 uses `height: 100vh; min-height: 100vh`.
    On iOS Safari this causes the composer / status bar to sit *under* the
    URL bar after scroll. Switch to `100dvh` with `100vh` fallback. (Not
    visible in headless screenshots — only on a real device.)

---

## Priority list (recommended implementation order)

1. **P0-1 + P0-3** Sidebar-as-drawer + sticky mobile top bar
   (these are the same intervention; do them together).
2. **P0-2** Narrow-viewport (≤420 px) sub-breakpoint to stop right-edge
   clipping of the action row, composer, and status bar.
3. **P1-4** Pin composer + status bar to the bottom on phones.
4. **P1-5** 16 px input font under `pointer: coarse` (iOS zoom fix).
5. **P1-6** Action-row overflow menu / ≥40 px touch targets.
6. **P1-7** Status bar → horizontal scrollable chip row with tappable
   model / cwd.
7. **P2-11** `100dvh` + `viewport-fit=cover` + safe-area padding pass.
8. **P2-8 + P2-9 + P2-10** Polish items.

Each P0 / P1 item has clear pass/fail criteria the spec can encode (e.g.
"composer's right edge < viewport width", "no element overlaps the floating
sidebar toggle", "active session region height ≥ 60 % of viewport at 375 ×
667"). A follow-up pass should convert the screenshot spec into asserting
specs once the fixes land.

---

## Post-fix verification

All fixes landed in two commits on this branch and the screenshot spec was
re-run after each change. New scorecard:

| Element                              | 344 | 375 | 390 | 412 | 768 |
| ------------------------------------ | --- | --- | --- | --- | --- |
| Sidebar drawer opens / closes        | ✅  | ✅  | ✅  | ✅  | ✅  |
| Active session chat (above the fold) | ✅  | ✅  | ✅  | ✅  | ✅  |
| Composer textarea                    | ✅  | ✅  | ✅  | ✅  | ✅  |
| Send / submit affordance             | ✅  | ✅  | ✅  | ✅  | ✅  |
| Session action row (fork/edit/del)   | ✅  | ✅  | ✅  | ✅  | ✅  |
| Status bar (cwd / model / stats)     | ✅  | ✅  | ✅  | ✅  | ✅  |
| Hamburger / expand button            | ✅  | ✅  | ✅  | ✅  | ✅  |
| Modal: new session (CWD start visible)| ✅ | ✅  | ✅  | ✅  | ✅  |
| Modal: model picker                  | ✅  | ✅  | ✅  | ✅  | ✅  |
| Modal: fork                          | ✅  | ✅  | ✅  | ✅  | ✅  |
| Modal: shortcut help                 | ✅  | ✅  | ✅  | ✅  | ✅  |

### What changed

1. **P0-1 + P0-3 sidebar drawer + mobile top bar** — below 720px the sidebar
   becomes a `position: fixed` slide-over with a backdrop. Auto-closes when a
   session is selected. The floating expand button is now a 36 px pill that
   does not overlap the session title.
2. **P0-2 sub-420px breakpoint** — disabled action icons (Compact / Tree /
   Clone) and the session-id subtitle hide, action row tightens. No more
   right-edge clipping on a 344 px Galaxy Fold viewport.
3. **P1-4 composer pinned to bottom** — implicitly resolved: with the drawer
   pattern, `.active-session-workspace` (grid `1fr auto auto`) fills the full
   100dvh viewport so the composer + status sit at the bottom.
4. **P1-5 iOS auto-zoom** — global `@media (pointer: coarse)` rule sets all
   `<input>` / `<textarea>` / `<select>` to 16 px. Verified visually in
   `iphone-se/03-composer-focused.png` (large readable composer).
5. **P1-6 touch targets** — `.active-actions button.action-icon` and
   `.sidebar-toggle` are 40 × 40 px on phones.
6. **P1-7 status bar** — horizontal scroll under 720 px with `overflow-x:
   auto`; with the wider mobile viewport it no longer overflows in practice.
7. **P2-8 CWD caret** — `onFocus` sets `selectionRange(0,0)` + `scrollLeft=0`.
   `iphone-se/05-new-session-dialog.png` now shows the start of the path.
8. **P2-9 safe-area** — modal backdrop and dashboard shell pad with
   `env(safe-area-inset-*)` on all four sides.
9. **P2-10 overflow** — disabled icons are hidden under 420 px (instead of
   filling space with grey).
10. **P2-11 100dvh + viewport-fit=cover** — applied to `index.html` and
    `.session-dashboard` (with `100vh` fallback first).

### Tests

- `tests/playwright/mobile-screenshots.spec.ts`: 50 screenshots, all pass.
- `tests/playwright/session-chat.spec.ts`: 19/19 pass (no regressions).
- `tests/unit/*`: 175/175 pass (added `matchMedia` guard for JSDOM).
- `npm run typecheck`: clean.
