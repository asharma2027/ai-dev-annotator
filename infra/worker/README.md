# License Worker — AI Website Dev Annotator

A Cloudflare Worker that issues Ed25519-signed license keys after a
successful Stripe checkout. **No separate email infrastructure is
required** — the license key reaches the buyer through two
Stripe-native channels:

1. **The success page** (`docs/success.html`, served from GitHub
   Pages). Stripe's Payment Link redirects buyers there with the
   checkout session ID; the page calls this Worker's `/license`
   endpoint and shows the key prominently with a copy button.
2. **The Stripe receipt email** that Stripe already sends
   automatically. The Worker stamps the key into the successful
   Charge's `description` field, which Stripe shows in the receipt PDF
   and receipt email body.

Cost at typical extension scale: **$0/month** (Cloudflare free tier).

## Endpoints

| Path | Method | Auth | Purpose |
|---|---|---|---|
| `/health` | GET | — | Returns `ok` |
| `/stripe/webhook` | POST | Stripe HMAC | Receives `checkout.session.completed`, stamps the license key onto session metadata and the successful Charge description |
| `/license?session_id=cs_xxx` | GET | None (public) | Looks up the Stripe session, re-derives the deterministic Ed25519 license key, returns it as JSON |

The `/license` endpoint is safe to expose publicly — it only returns a
key for sessions that are actually paid and that match a real Stripe
checkout session ID. An attacker who guessed a `cs_xxx` ID could fetch
its license key, but Stripe session IDs are 56+ random characters and
not enumerable.

## One-time setup

You will need:
- A Cloudflare account (free).
- A Stripe account.
- The Ed25519 **private key** from the keypair generation step (saved
  in `LICENSE_KEYPAIR_DO_NOT_COMMIT.txt` in the repo root, gitignored).

### 1. Install Wrangler and log in

```bash
npm install
npx wrangler login
```

### 2. Set secrets

```bash
npx wrangler secret put STRIPE_SECRET_KEY         # sk_test_... or sk_live_...
npx wrangler secret put STRIPE_WEBHOOK_SECRET     # whsec_... — see step 4
npx wrangler secret put LICENSE_PRIVATE_KEY       # from LICENSE_KEYPAIR_DO_NOT_COMMIT.txt
```

### 3. Deploy

```bash
npx wrangler deploy
```

Wrangler prints your Worker URL, e.g.
`https://ai-dev-annotator-licenses.<your-account>.workers.dev`.

### 4. Configure the Stripe webhook

In the Stripe dashboard:

1. Developers → Webhooks → **Add endpoint**.
2. Endpoint URL: `https://<your-worker-url>/stripe/webhook`.
3. Events to send: only `checkout.session.completed`.
4. Reveal the **Signing secret** (`whsec_…`) and run
   `npx wrangler secret put STRIPE_WEBHOOK_SECRET` with that value.

### 5. Configure the Stripe Payment Link success URL

In the Stripe dashboard → Payment Links → your $9.99 Premium link →
**After payment** → choose **"Don't show confirmation page"** →
custom URL = `https://<your-github-username>.github.io/ai-dev-annotator/success.html?session_id={CHECKOUT_SESSION_ID}`

Stripe substitutes `{CHECKOUT_SESSION_ID}` with the real session ID at
redirect time. The success page calls the Worker's `/license` endpoint
with that ID to fetch the buyer's key.

## Health check

```bash
curl https://<your-worker-url>/health    # → ok
```

## How license verification works

The extension ships with the matching Ed25519 **public key** in
`popup.js` (`LICENSE_PUBLIC_KEY`). When a user pastes their key, the
extension verifies the signature locally with `crypto.subtle.verify` —
no network call, no allow-list lookup, fully offline. Same security
model as 1Password, Tana, and Sublime Text license keys.

If the private key ever leaks, rotate the keypair, redeploy the Worker
with the new private key, and ship a new extension version with the
new public key. Existing legitimate keys keep working only if you
include both public keys for a transition window.
