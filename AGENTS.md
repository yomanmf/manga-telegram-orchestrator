# Project workflow

## Commands

- Runtime: Node.js 22, matching `.github/workflows/ci.yml` (local Homebrew path: `/opt/homebrew/opt/node@22/bin`).
- Setup: `npm ci && npm ci --prefix apps/manga-bot-worker && npm ci --prefix apps/manga-pdf-processor && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --prefix apps/kindle-uploader`
- Test and lint: `npm run verify`
- Deploy: push the verified commit to `origin/main`; `.github/workflows/ci.yml` builds, publishes, deploys, and waits for the VM terminal event.
- Health: inspect the latest run with `gh run list --workflow ci.yml --limit 1`; do not treat an image push as a completed deployment.
- Never install `yc` or other Yandex software; the existing workflow performs deployment through HTTP APIs.

## Rules

- Run `npm run verify` and `git diff --check` before committing.
- Keep secrets and local environment files out of Git.
- Use the existing CI/deploy-agent path; do not perform an ad-hoc manual deployment unless that documented path is broken.
- After an authorized push, monitor deployment through completion and verify the terminal deploy result matches the pushed revision.
