# Live tool-output tail — acceptance criteria and TDD plan

## Goal

A tool invocation must never look completed merely because it has emitted
partial output. While a tool is executing, the conversation should visibly
show that it is still running and provide a small, live terminal-style tail of
its latest output without forcing a user to expand a large log.

This applies to the existing conversation timeline tool cards. It deliberately
uses the existing `tool_execution_start`, `tool_execution_update`, and
`tool_execution_end` events; no new realtime transport is introduced.

## Acceptance criteria

### Lifecycle correctness

1. On `tool_execution_start`, the matching card is a **running** tool card. It
   has a running indicator and never a success/check indicator.
2. Every `tool_execution_update` replaces the displayed live output for that
   `toolCallId` while preserving its `running` status, original arguments, and
   start time.
3. Only `tool_execution_end` transitions the card to `success` or `error`.
   A non-empty partial result alone must not imply completion.
4. Multiple active calls each render their own running state and own output;
   an update for one `toolCallId` cannot alter another card.

### Live-tail presentation

5. A running tool card is expanded by default so its progress is visible.
   Successful historical cards remain collapsed by default; error cards remain
   expanded by default.
6. A running card with output renders exactly the most recent four logical
   lines, in a monospaced `<pre>` region. Earlier output is not mounted in the
   collapsed/live preview.
7. A tail with fewer than four lines renders every available line. Blank lines
   are meaningful terminal output and are retained when selecting the tail.
8. A running card with no output says `Waiting for output…`; it does not render
   an empty terminal box or a completion message.
9. The tail region is a polite live region (`aria-live="polite"`,
   `aria-atomic="true"`) so assistive technology can announce progress without
   treating the entire conversation as a live region.
10. The live tail identifies itself as `Live output` and communicates that it
    is a four-line tail (for example, `Live output (last 4 lines)`).

### Completion, disclosure, and regressions

11. Once the terminal event arrives, the normal tool-card result behavior
    remains available: expanding the card exposes the complete final result,
    including existing rich `read` renderers and artifacts.
12. User disclosure choices are respected while a tool continues to update:
    manually collapsing a running card keeps it collapsed; a later update does
    not force it open again.
13. Existing replay/idempotency behavior remains intact: repeated update/end
    events for a call leave one card, retain its original args, and end with the
    terminal result/status.
14. Mobile layout remains horizontally safe: the live tail scrolls inside its
    own output area rather than widening the message timeline.
15. Existing completed-tool, error-tool, artifact, image, markdown, and HTML
    tool rendering tests continue to pass.

## Test-first implementation sequence

1. Add focused failing unit tests for tail selection, empty-running state,
   running/success/error indicators, and accessible live-tail markup.
2. Add a reducer test for two simultaneous live tool calls and lifecycle
   status/argument isolation.
3. Implement the smallest pure tail helper and timeline-card rendering needed
   to satisfy those tests.
4. Add/adjust CSS for the bounded, monospace, mobile-safe live tail.
5. Run the focused tests, typecheck, the relevant Playwright timeline suites,
   and then the repository checks required by CI.

## Explicit non-goals

- Replacing the timeline with the Assistant UI experiment.
- Streaming a full terminal emulator into the chat.
- Adding a second websocket/SSE endpoint or changing the Pi protocol.
- Auto-scrolling a reader who has intentionally scrolled away from the active
  conversation.
