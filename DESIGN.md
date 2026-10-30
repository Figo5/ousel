# Ousel design

Ousel is a local workspace for understanding what a coding-agent team is doing
and what needs review. This file describes the intended layout. It was checked in
headless Chrome at 1440 × 900 and 390 × 844; that is not a browser matrix.

## Layout: one page, two views

A header runs across the top: the OUSEL wordmark, a project / task select,
total event count, a **Task | Field** toggle, and the connection state
(`live`, `connecting`, `reconnecting`). Reconnecting also shows a banner.

**Task view (default).** One task at a time.

1. Summary strip: last reported, participants, captured vs reported checks,
   latest review decision, files and handoffs.
2. Needs attention (or an explicit "Nothing needs attention").
3. Timeline, chronological, last 300 events.
4. Side column: participants (actor and session ids) and a small
   constellation. On narrow screens the side column stacks after the timeline
   and the constellation is collapsed behind a button.

**Field view.** The original constellation with a session strip and a column of
verdict / blocker / error cards.

## Rules

- Greyscale chrome; the field keeps its own colour palette in `Field.tsx`.
- No state depends on hue alone. Tones carry a label and a border treatment
  (heavy solid, dashed, dotted). Source badges carry a glyph and a border
  pattern: captured = heavy solid, reported = thin, synthetic = dashed,
  inferred = dotted.
- Never show data the stream did not report. Silence is "stale or unknown",
  never "blocked". The single derived state is "quiet — status unknown
  (inferred from inactivity)".
- No router, no `alert` / `confirm` / `prompt`, no icon library, no webfonts.
