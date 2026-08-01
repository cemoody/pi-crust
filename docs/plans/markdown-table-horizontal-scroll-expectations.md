# Markdown tables: horizontal-scroll expectations

## User problem

On narrow devices, Markdown tables currently compress their first columns until labels wrap one character per line. The result is difficult to scan and hides the table's intended column structure.

## Acceptance criteria

1. Every GitHub-Flavored Markdown table rendered in an assistant timeline message is wrapped in a dedicated, focusable horizontal-scroll viewport.
2. The viewport exposes an accessible name (`Scrollable markdown table`) so keyboard and assistive-technology users can identify it.
3. The viewport is constrained to its message bubble (`max-width: 100%`) and scrolls horizontally (`overflow-x: auto`) without creating page-level horizontal overflow.
4. A table retains its natural column widths; header and data cells do not character-wrap merely to fit a narrow mobile viewport. Users can pan horizontally to inspect off-screen columns.
5. Existing Markdown rendering behavior (headings, links, code blocks, and non-table content) remains unchanged.

## Test approach (TDD)

The component test will first assert the rendered wrapper, its accessibility affordances, and the unchanged table semantics. Because jsdom has no layout engine, the same test verifies the CSS contract at source level: overflow belongs to the wrapper and cells use no-wrap sizing. This test is expected to fail until both the React Markdown table override and its CSS are implemented.
