# Slides (presentation) extension — mobile UX fixes

Reproduced on a 390×844 mobile viewport (iPhone-class). The deck used is the
seeded mock "Presentation artifact session".

## Bugs (before)

1. **Trapped in full screen** (`before-1-toolbar-trap.png`)
   The modal toolbar was a single non-wrapping flex row. On a phone the
   right-hand actions ("Presentation mode" + the × close button) overflowed
   off-screen — the close affordance sat at x≈398–423 on a 390px viewport, so
   the user could not exit.

2. **Competing arrows** (`before-2-competing-arrows.png`)
   The iframe always rendered its own bottom-right `nav.deck-controls` AND the
   React modal rendered its own nav, so two arrow widgets fought for the same
   corner in presentation mode.

3. **Title-slide cropping** — the 16:9-designed slides used raw `vw`/`vh`
   units, so on a portrait viewport headlines were clipped horizontally.

## Fixes (after)

- `after-1-toolbar-fixed.png` — toolbar wraps, title truncates, Close is anchored
  top-right and always reachable; safe-area padding clears the notch; `100dvh`
  modal height; 40–44px touch targets.
- `after-2-single-nav.png` — iframe `deck-controls` suppressed via a new
  `embedded` compile option; the React modal is the single source of nav, plus a
  single full-opacity × exit.
- `after-3-mode-switch.png` — the two buttons collapse into one segmented
  **Edit | Present** control (frees ~90px of bar).
- `after-4-immersive-swap-edit.png` — immersive Present mode adds a floating
  **Edit** button so the single control is bidirectional (Edit ⇄ Present).
- `after-5-letterbox-portrait.png` / `after-6-letterbox-landscape.png` — slides
  now render as a fit-to-viewport 16:9 container using container-query units:
  portrait letterboxes (no crop), landscape fills exactly as before.

## Regression coverage

- `tests/unit/presentation-reveal-embedded.test.ts` — `embedded` option +
  letterbox CSS contract.
- `tests/unit/presentation-mode-switch.test.tsx` — single Edit|Present switch +
  immersive swap-back.
- `tests/playwright/presentation-mobile-repro.spec.ts` — Close on-screen + zero
  iframe arrows on a mobile viewport.
