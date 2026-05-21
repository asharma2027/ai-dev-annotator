# Codex Cloud Setup

This repo is ready to use from Codex web and the ChatGPT mobile app once the current branch is pushed to GitHub.

## Codex Environment

Create or edit a Codex cloud environment for this GitHub repo and use this setup command:

```sh
npm run setup:codex
```

That command installs dependencies for the root package, `desktop-app/`, and `infra/worker/` when their package files are available, then runs:

```sh
npm run check
```

Use `npm run check` as the default validation command in cloud tasks. It checks the Chrome extension manifest and JavaScript syntax, the Electron setup app entry points, and the Worker files that are readable in the checkout.

## Phone Workflow

1. Push this branch to GitHub so Codex cloud can see the latest extension and desktop-app changes.
2. In Codex web, connect the GitHub repo and create an environment that runs `npm run setup:codex`.
3. Open ChatGPT on your phone, go to Codex, select this environment, and prompt against the pushed branch.
4. Ask Codex to run `npm run check` before it finishes any code task.

## Notes

- Codex cloud setup scripts run with internet access so dependencies can install. Runtime internet access is off by default unless enabled in the environment settings.
- Do not store `.env`, `.dev.vars`, Stripe secrets, Firebase secrets, or license private keys in the repo.
- The Electron UI and unpacked Chrome extension still need local/manual testing for full end-to-end verification; cloud validation covers syntax and repo integrity.
