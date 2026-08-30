# Warm field notebook design system

## Thesis

The companion should feel like a well-made field notebook beside a technical
workbench: warm, quiet, precise, and ready to be written in. Ivory paper and
near-black ink carry nearly every surface; cobalt appears only for orientation,
selection, and deliberate actions.

The first viewport is the working surface, not a dashboard or marketing page.
The note editor is dominant. Navigation, schedule, outcomes, and tutor context
are plain columns separated by hairlines, never a mosaic of cards.

## Content hierarchy

1. Current programme day and session orientation.
2. Explicit canonical learning outcomes.
3. The live Markdown note and its recovery/save state.
4. Tutor conversation and the exact context that will accompany the next send.

## Interaction thesis

- Panel folds use a short, spatial transition so the writing surface visibly
  gains room; focus mode is one reversible state change.
- “Sync to now” is the only in-document clock reorientation and gives immediate,
  quiet confirmation without changing schedule data.
- Save, stream, unread, stale, and conflict states change with small opacity or
  colour cues, never celebratory animation. Reduced-motion removes movement.

## Tokens and rules

- Display type: Georgia, `Times New Roman`, serif fallback.
- Interface type: Inter when locally available, then system sans-serif.
- Paper: `#f5f1e8`; lifted paper: `#fbf8f1`; ink: `#171715`.
- Cobalt: `#145edb`; muted text: `#6e6b64`; divider: `#d6d0c4`.
- One-pixel dividers, minimal radius, no decorative gradients, no drop-shadow
  stack, and no card unless the region itself is a movable interaction.
- Minimum target size 44px, visible keyboard focus, AA contrast, and meaningful
  layout at 200% zoom.
