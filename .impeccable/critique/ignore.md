# Detector findings to ignore (with reasons)

- `single-font` on web/index.html: false positive. The page deliberately pairs
  a system sans body with ui-monospace for data/labels; the detector's
  generic-font filtering collapses the set to the literal token `var(--mono)`
  and misreports "only font used is var(--mono)". Verified 2026-06-12 (the
  in-page detector run did not reproduce it). The intentional design is
  sans + mono, no decorative display font: a deliberate choice for a dev tool.
