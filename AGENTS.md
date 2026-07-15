# AGENTS.md

## Project

AI Website Dev Annotator is a Chrome extension with an optional Electron desktop dashboard and a Cloudflare Worker for premium license flows.

Key files:

- `manifest.json`, `background.js`, `content.js`, `popup.html`, `popup.js`, and `styles.css` are the extension surface.
- `desktop-app/` is the Electron dashboard and local process supervisor.
- `infra/worker/` is the Cloudflare Worker used for Stripe and license operations.
- `scripts/start-desktop.js` launches the desktop app from the repo root.

## Safety

- Start by checking `git status --short --branch`.
- Preserve existing user changes. Do not reset, checkout, or overwrite modified files unless the user explicitly asks.
- Never commit secrets. Keep `.env`, `.dev.vars`, Stripe secrets, Firebase secrets, and license private keys out of the repo.
- Treat extension storage, local project commands, and license behavior as user-facing data paths. Prefer small, targeted changes with validation.

## Commands

- `npm run setup:codex` installs desktop dependencies and runs validation.
- `npm run check` validates the extension, desktop app, Worker, and focused tests.
- `npm run check:extension` validates the Chrome extension files.
- `npm run check:desktop` validates the Electron dashboard files and focused tests.
- `npm run check:worker` validates the Cloudflare Worker files.
- `npm run start` launches the local Electron dashboard. Do not use it in a headless environment unless GUI support is available.

## Cloud Notes

Use `npm run setup:codex` as the cloud environment setup command. Cloud agents cannot load the unpacked Chrome extension into a real browser unless browser tooling is explicitly available, so use `npm run check` as the baseline validation loop and add focused tests when changing shared logic.
