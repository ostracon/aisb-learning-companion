# Contributing

Thanks for helping improve AISB Learning Companion. Keep changes focused on
the companion application; curriculum changes belong in the separate
[AISB repository](https://github.com/AI-Security-Bootcamp/aisb).

## Set up the repositories

Clone `aisb-learning-companion` and `aisb` as sibling directories, then follow
the setup steps in [README.md](./README.md). The project supports Node.js
22.12 or newer and uses the committed npm lockfile.

## Before opening a pull request

Run the complete deterministic gate:

```bash
npm ci
AISB_REPO_PATH=../aisb npm run check
```

Do not add learner notes, chat transcripts, generated images, prepared caches,
credentials, local state, real calendars, speaker attribution, accommodation
details, or exact private event locations. Use synthetic fixtures and generic
paths such as `/Users/learner` in tests.

Keep `AGENTS.md` current when a product boundary changes, and add a concise
revision note to the living ExecPlan for material architectural decisions.

## Security issues

Do not open a public issue for a vulnerability or include secrets or personal
data in a report. Follow [SECURITY.md](./SECURITY.md) instead.
