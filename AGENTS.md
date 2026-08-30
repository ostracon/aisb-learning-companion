# AISB Learning Companion development guide

This repository contains the companion application. The sibling AISB curriculum
repository is an input, not an application workspace.

## Repository boundaries

- Make application changes only in this repository unless the user separately
  authorizes a specific AISB mutation.
- Treat the resolved AISB repository as read-only for tutoring, indexing, and
  diagnostics. The product never fetches, pulls, branches, stages, commits, or
  pushes AISB; source-control work stays in VS Code or the terminal. The sole
  product write exception is the reviewed create-if-absent participant-file
  handoff documented below.
- Never copy solution, reference, test, secret, Git-object, or raw generated
  instruction content into application fixtures, logs, snapshots, or prompts.
- Never persist, render, log, or forward application credentials. Child-process
  environments use explicit allowlists.

## Product contract

- This is a learning and toil assistant, not an answer dispenser. Respect the
  active AISB instruction sources and use progressive help: orient, ask what was
  tried, offer a nudge, diagnose a concrete attempt, and only reveal material
  that the curriculum explicitly exposes at the learner's current progress.
- Every tutor send uses a fresh server-authoritative page-context snapshot. The
  browser may supply IDs, a live note draft, and explicit file selections; it
  may not author canonical outcomes, schedule fields, repository hashes, or
  source paths.
- Current notes are local Markdown with immediate browser recovery and
  conditional, atomic disk saves. Never silently discard or overwrite a draft.
- The navigation clock is frozen. Sample it only at document bootstrap and the
  explicit “Sync to now” action; ordinary timestamps must not move the page.
- Sidebar, schedule, and tutor panels are independently collapsible. Focus mode
  must preserve the editor state, chat state, route, selection, and exact prior
  layout.

## Engineering conventions

- Use strict TypeScript, Zod at trust boundaries, fixed subprocess argument
  arrays, and dependency-injected clocks/filesystems/process launchers in tests.
- Prefer small domain modules with deterministic unit tests. Network and live
  Codex/Image API tests are opt-in; the default suite uses fakes.
- Keep the warm field-notebook interface restrained: warm ivory surfaces,
  near-black ink, cobalt action/orientation, serif display type, sans-serif UI,
  thin dividers, and the notes surface as the visual center.
- Update the living ExecPlan at meaningful stopping points and verify both Git
  repositories before handing work back.
