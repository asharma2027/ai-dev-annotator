# License Worker — AI Website Dev Annotator

A Cloudflare Worker that:

1. Receives `checkout.session.completed` webhooks from Stripe.
2. Verifies the Stripe signature.
3. Generates an Ed25519-signed license key (no DB needed — keys are
   self-verifying offline).
4. Emails the key to the customer via Resend.

Cost at typical extension scale: **$0/month**.

## One-time setup

You will need:

- A Cloudflare account (free).
- A Resend account (free, 3,000 emails/month).
- A Stripe account.
- The Ed25519 **private key** from the keypair generation step (see
  `LICENSE_KEYPAIR_DO_NOT_COMMIT.txt` in the repo root — that file is
  gitignored).

### 1. Install Wrangler and log in

```bash
npm install
npx wrangler login
```

### 2. Set secrets

```bash
npx wrangler secret put STRIPE_WEBHOOK_SECRET     # whsec_... from Stripe dashboard → Developers → Webhooks
npx wrangler secret put LICENSE_PRIVATE_KEY       # from LICENSE_KEYPAIR_DO_NOT_COMMIT.txt
npx wrangler secret put RESEND_API_KEY            # re_... from resend.com → API Keys
npx wrangler secret put SENDER_EMAIL              # e.g. "AI Dev Annotator <licenses@yourdomain.com>"
# Optional — if your Premium price ID changes, set it here:
npx wrangler secret put PREMIUM_PRICE_ID          # price_...
```

### 3. Deploy

```bash
npx wrangler deploy
```

The deploy output will print your Worker URL, e.g.
`https://ai-dev-annotator-licenses.your-account.workers.dev`. Use that
URL plus `/stripe/webhook` as the **Endpoint URL** in your Stripe
webhook settings.

### 4. Configure the Stripe webhook

In the Stripe dashboard:

1. Developers → Webhooks → **Add endpoint**.
2. Endpoint URL: `https://<your-worker-url>/stripe/webhook`.
3. Events to send: only `checkout.session.completed`.
4. Reveal the **Signing secret** (`whsec_…`) and run
   `npx wrangler secret put STRIPE_WEBHOOK_SECRET` with that value.

## Health check

```bash
curl https://<your-worker-url>/health
# → ok
```

## How license verification works

The extension ships with the matching Ed25519 **public key** in
`popup.js` (`LICENSE_PUBLIC_KEY`). When a user pastes a key, the
extension verifies the signature locally — no network call, no
allow-list lookup. This is the same security model used by paid Chrome
extensions like 1Password and Tana for offline activation.

If the private key is ever leaked, rotate it: regenerate the keypair,
update the Worker secret, ship a new extension version with the new
public key. Existing legitimate keys keep working only if you ship both
keys for a transition window.
