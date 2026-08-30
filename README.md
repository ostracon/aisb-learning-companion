# AISB Learning Companion

A local web app for working through the AI Security Bootcamp. It puts the
schedule, course material, Markdown notes, tutor, review tools, and learning
progress in one place.

The companion is kept in its own Git repository. It reads course material from
a separate AISB checkout and stores your notes and chat history outside both
repositories. The tracked schedule is a generalized example; your editable
schedule remains local to your machine.

## Requirements

You need:

- macOS;
- Git;
- Node.js 22.12 or newer, with npm;
- a local checkout of the AISB repository;
- a Codex sign-in that works on this Mac; and
- access to the `gpt-5.6-sol` model.

The tutor needs an internet connection when it sends a message. Preparing
online references and generating images also use the internet.

Optional:

- VS Code, for the **Open in VS Code** buttons;
- `nvm`, to select the Node version from `.nvmrc`; and
- an OpenAI Platform API key in `CODEX_OPENAI_API_KEY`, only if you want to
  generate images. The tutor, review, and manager use your Codex sign-in and do
  not use this key.

The easiest directory layout is:

```text
dev/
├── aisb/
└── aisb-learning-companion/
```

With that layout, the companion finds the AISB repository automatically at
`../aisb`.

## First-time setup

### 1. Clone the repositories

Clone the companion:

```bash
git clone https://github.com/ostracon/aisb-learning-companion.git
cd aisb-learning-companion
```

If you prefer SSH, use:

```bash
git clone git@github.com:ostracon/aisb-learning-companion.git
cd aisb-learning-companion
```

Clone the public AISB curriculum into the sibling `../aisb` directory:

```bash
cd ..
git clone https://github.com/AI-Security-Bootcamp/aisb.git
cd aisb-learning-companion
```

If your AISB checkout is somewhere else, set `AISB_REPO_PATH` before starting
the app:

```bash
export AISB_REPO_PATH="/absolute/path/to/aisb"
```

The AISB path must point to a separate repository root containing `.git`,
`AGENTS.md`, and `build-instructions.sh`.

### 2. Select Node.js

If you use `nvm`:

```bash
nvm install
nvm use
```

Otherwise, install Node.js 22.12 or newer using your normal package manager.
The app checks the version before it starts.

### 3. Install dependencies

```bash
npm ci
```

The lockfile pins the app's dependencies, including the Codex CLI used by the
backend. You do not need a separate global Codex installation.

### 4. Check the Codex sign-in

```bash
./node_modules/.bin/codex login status
```

If it reports that you are not signed in, run:

```bash
./node_modules/.bin/codex login
```

Complete the browser sign-in, then run the status command again. See the
[official Codex authentication guide](https://developers.openai.com/codex/auth/)
for the supported sign-in methods.

### 5. Start the app

```bash
npm run dev
```

Open <http://127.0.0.1:7575/>. Keep that terminal running while you use the
app. The server listens only on your Mac, not on the local network.

Stop it with `Control-C` in the terminal where it is running.

### 6. Run the local self-test

Open <http://127.0.0.1:7575/diagnostics> and select **Run self-test**. It checks
the AISB path, Codex sign-in, model access, and restricted tutor/review
profiles.

## Optional image generation

Image generation is the only feature that needs an OpenAI Platform API key.
Set it in the shell before starting the app:

```bash
export CODEX_OPENAI_API_KEY="your-platform-key"
npm run dev
```

If the key is already exported from `~/.zshrc`, open a new terminal or run
`source ~/.zshrc` before starting the app. Do not commit the key or paste it
into this repository.

The app does not load `.env` files automatically.

## Configuration

All settings are optional when the two repositories are siblings.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AISB_REPO_PATH` | `../aisb` | Location of the AISB repository. |
| `AISB_COMPANION_STATE_PATH` | `~/Library/Application Support/AISB Learning Companion` | Location of notes, chats, progress, cached references, and generated images. |
| `AISB_COMPANION_ALLOW_TEMPORARY_STATE` | `false` | Set to `true` only for an intentionally disposable production smoke test. Never use it for learner data. |
| `PORT` | `7575` | Local port used by the web app. |
| `CODEX_OPENAI_API_KEY` | unset | Enables explicitly approved image generation. |

For example:

```bash
export AISB_REPO_PATH="$HOME/dev/aisb"
export PORT=7576
npm run dev
```

`.env.example` is a reference file. If you copy it to `.env`, export its
values before starting the app:

```bash
set -a
source .env
set +a
npm run dev
```

## Where your data is stored

Application source, AISB curriculum, and learner data are three separate
locations. By default, learner data is below:

```text
~/Library/Application Support/AISB Learning Companion/
```

Important paths include:

- `notes/days/<day>/overview.md` — daily overview notes;
- `notes/lessons/<section>/notes.md` — repository-section notes;
- `notes/events/<event>/notes.md` — schedule-event notes;
- `notes/ad-hoc/<date>/<name>.md` — named quick notes;
- `notes/recovery/`, `notes/conflicts/`, and `notes/revisions/` — protected
  note snapshots, preserved conflicts, and revision journals;
- `schedule/schedule.json` — the editable imported schedule;
- `progress/` — checked learning outcomes and progress state;
- `continuity/` — learner-approved continuity summaries;
- `tutor/sessions/sessions.jsonl` — the inspectable tutor transcript;
- `review/` — review-session state;
- `preparation/` — cached reference material and preparation records; and
- `media/visuals/` — generated learning images and their provenance.

Notes are autosaved to Markdown and also use the current browser profile's
recovery storage while you type. Wait for **Saved to disk** before clearing
browser site data. Use the **Back up learning record** page for a verified
export; automatic restore is not implemented.

The app treats the AISB repository as curriculum input. It does not pull,
branch, commit, or push AISB. An explicit **Open in VS Code** action may create
a missing participant answer file, but it does not overwrite an existing file.

Learner notes, chats, generated images, prepared references, and edited
schedules are runtime data. They belong under the state directory above and
must not be copied into this Git repository.

## Production-style local run

The development command rebuilds when source files change. To run the built
version instead:

```bash
npm run build
npm start
```

Run `npm run build` again after pulling application changes. `npm start`
serves the existing build and does not rebuild it.

Check that it is healthy with:

```bash
curl http://127.0.0.1:7575/api/health
```

## Checks

Run the complete deterministic check before pushing a change:

```bash
npm run check
```

This runs the Codex protocol check, TypeScript, unit and integration tests, the
production build, and a packaged-server smoke test. It does not send a prompt
to Codex or OpenAI.

The live Codex test is separate because it uses the signed-in account and model
usage:

```bash
AISB_CODEX_LIVE=1 npm run test:live:codex
```

## Troubleshooting

### The Node version is rejected

Run `nvm use`, or install Node.js 22.12 or newer. Check the selected version
with `node --version`.

### The AISB repository is not found

Set `AISB_REPO_PATH` to the absolute path of the AISB repository, then
restart the app.

### Production refuses a temporary state path

The production server will not start when learner state resolves inside a
temporary directory such as `/tmp` or `/private/tmp`. Temporary directories can
be cleared by the operating system, which would make notes and chat history
appear to disappear.

Unset `AISB_COMPANION_STATE_PATH` to use the durable default, or point it at a
durable absolute directory and restart the app. The error reports both the
configured path and the temporary directory it resolves into, including through
symlinks.

`AISB_COMPANION_ALLOW_TEMPORARY_STATE=true` is reserved for disposable automated
smoke tests. Do not use that override for course notes or other learner data.

### Tutor or review cannot start

Run:

```bash
./node_modules/.bin/codex login status
```

Sign in if needed, restart the app, and use the app's **Local diagnostics**
page to check the account, model, and restricted permission profiles.

### Port 7575 is already in use

Choose another local port:

```bash
PORT=7576 npm run dev
```

### VS Code does not open

Install standard VS Code or VS Code Insiders in `/Applications`. The note or
answer file remains on disk even if VS Code fails to open.

## Repository documentation

- [AGENTS.md](./AGENTS.md) — product boundaries and development rules.
- [Living ExecPlan](./execplans/aisb-learning-companion.md) — implementation
  decisions, current limits, and verification history.
- [Design system](./docs/design-system.md) — visual direction and interface
  conventions.
