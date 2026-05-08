// Cloudflare Worker — license issuer for AI Website Dev Annotator.
//
// Option B (no email infrastructure): after a successful Stripe checkout,
// this Worker generates an Ed25519-signed license key and exposes it in
// two places that Stripe already shows the customer:
//
//   1. The Stripe-hosted receipt email — we set the PaymentIntent's
//      `description` field to "AI Website Dev Annotator Premium —
//      License key: <key>". Stripe automatically emails the receipt;
//      the description appears prominently in it.
//   2. A success page hosted on GitHub Pages
//      (docs/success.html). Stripe's Payment Link redirects buyers to
//      `success.html?session_id={CHECKOUT_SESSION_ID}` after payment.
//      The page calls this Worker's GET /license?session_id=... endpoint
//      and shows the key prominently with a copy button.
//
// Endpoints:
//   POST /stripe/webhook   — Stripe webhook (checkout.session.completed)
//   GET  /license?session_id=cs_xxx  — public lookup for the success page
//                                       (CORS open, no PII leaked beyond
//                                       what the buyer themselves owns)
//   GET  /health           — returns "ok"
//
// No DB. No email service. No third-party dependency at runtime besides
// Stripe. The license key is deterministically re-derived on every
// request: Ed25519 signatures over the same payload are identical, so
// (email, session_id) → license is stable across calls.

// ─────────────────────────────────────────────────────────────────────────────
// base64url + utf8 helpers
// ─────────────────────────────────────────────────────────────────────────────
function b64uEncode(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function utf8(s) { return new TextEncoder().encode(s); }
function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stripe webhook signature verification
//   Stripe-Signature: t=<unix>,v1=<hexHmac>,v1=<hexHmac>...
// ─────────────────────────────────────────────────────────────────────────────
async function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300) {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map(kv => {
      const idx = kv.indexOf('=');
      return [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()];
    }).filter(([k]) => k),
  );
  const v1s = header.split(',')
    .map(kv => kv.split('='))
    .filter(([k]) => k.trim() === 'v1')
    .map(([, v]) => v.trim());
  const t = parts.t;
  if (!t || v1s.length === 0) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(t, 10)) > toleranceSec) return false;

  const key = await crypto.subtle.importKey(
    'raw', utf8(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, utf8(`${t}.${rawBody}`));
  const expectedHex = bytesToHex(new Uint8Array(sig));

  for (const v1 of v1s) {
    if (timingSafeEqual(hexToBytes(v1), hexToBytes(expectedHex))) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ed25519 license signing
// ─────────────────────────────────────────────────────────────────────────────
async function importEd25519PrivateKey(privBase64Url) {
  const raw = b64uDecode(privBase64Url);
  if (raw.length !== 32) throw new Error(`Ed25519 private key must be 32 bytes, got ${raw.length}`);
  // PKCS#8 wrapper for Ed25519 (RFC 8410)
  const prefix = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
    0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const pkcs8 = new Uint8Array(prefix.length + raw.length);
  pkcs8.set(prefix, 0);
  pkcs8.set(raw, prefix.length);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
}

// License key format:
//   v1.<b64u(email)>.<b64u(sessionId)>.<b64u(issuedAtUnix)>.<b64u(signature)>
async function signLicense({ email, sessionId, issuedAt }, privKey) {
  const payload = [
    'v1',
    b64uEncode(utf8(email)),
    b64uEncode(utf8(sessionId)),
    b64uEncode(utf8(String(issuedAt))),
  ].join('.');
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privKey, utf8(payload));
  return `${payload}.${b64uEncode(new Uint8Array(sig))}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stripe API helpers (we never use stripe-node — too heavy for Workers; the
// REST API is straightforward).
// ─────────────────────────────────────────────────────────────────────────────
async function stripeApi(path, { method = 'GET', body, secret } = {}) {
  const init = {
    method,
    headers: { 'Authorization': `Bearer ${secret}` },
  };
  if (body) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(body).toString();
  }
  const resp = await fetch(`https://api.stripe.com/v1${path}`, init);
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Stripe ${method} ${path} failed ${resp.status}: ${JSON.stringify(json)}`);
  return json;
}

async function getCheckoutSession(sessionId, secret) {
  return stripeApi(`/checkout/sessions/${encodeURIComponent(sessionId)}`, { secret });
}

async function setSessionMetadata(sessionId, metadata, secret) {
  // Stripe's checkout/session update accepts metadata.
  const body = {};
  for (const [k, v] of Object.entries(metadata)) body[`metadata[${k}]`] = v;
  return stripeApi(`/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'POST', body, secret,
  });
}

async function setPaymentIntentDescription(paymentIntentId, description, secret) {
  return stripeApi(`/payment_intents/${encodeURIComponent(paymentIntentId)}`, {
    method: 'POST', body: { description }, secret,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Premium classification
//   - If session.metadata.tier === 'premium' → premium
//   - Else if session.amount_total === 999 (cents) → premium
//   - Else → tip (no license issued)
// ─────────────────────────────────────────────────────────────────────────────
function isPremiumPurchase(session) {
  const tier = session.metadata?.tier || session.payment_link?.metadata?.tier;
  if (tier === 'premium') return true;
  if (session.amount_total === 999) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// CORS for the public /license endpoint (called by docs/success.html)
// ─────────────────────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age':       '86400',
};

function jsonResponse(obj, init = {}) {
  return new Response(JSON.stringify(obj), {
    status: init.status || 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...(init.headers || {}) },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main router
// ─────────────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    // ── Public license lookup, called from docs/success.html ────────────
    if (request.method === 'GET' && url.pathname === '/license') {
      const sessionId = url.searchParams.get('session_id') || '';
      if (!sessionId.startsWith('cs_')) {
        return jsonResponse({ error: 'invalid session_id' }, { status: 400 });
      }
      try {
        const session = await getCheckoutSession(sessionId, env.STRIPE_SECRET_KEY);
        if (session.payment_status !== 'paid' && session.status !== 'complete') {
          return jsonResponse({ error: 'not_paid', status: session.payment_status }, { status: 402 });
        }
        if (!isPremiumPurchase(session)) {
          return jsonResponse({ error: 'not_premium', message: 'This checkout was not a Premium purchase.' }, { status: 400 });
        }
        const email = session.customer_details?.email || session.customer_email || '';
        if (!email) return jsonResponse({ error: 'no_email' }, { status: 400 });

        const privKey = await importEd25519PrivateKey(env.LICENSE_PRIVATE_KEY);
        // Use the session's `created` timestamp so the same key is
        // re-derived on every lookup (deterministic re-issuance).
        const issuedAt = session.created || Math.floor(Date.now() / 1000);
        const licenseKey = await signLicense({ email, sessionId, issuedAt }, privKey);

        return jsonResponse({ license: licenseKey, email });
      } catch (err) {
        console.error('license lookup failed', err);
        return jsonResponse({ error: 'lookup_failed' }, { status: 500 });
      }
    }

    // ── Stripe webhook ──────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/stripe/webhook') {
      const rawBody = await request.text();
      const sigHeader = request.headers.get('Stripe-Signature');
      const ok = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
      if (!ok) return new Response('Bad signature', { status: 400 });

      let event;
      try { event = JSON.parse(rawBody); }
      catch { return new Response('Bad JSON', { status: 400 }); }

      if (event.type !== 'checkout.session.completed') {
        return new Response('ignored', { status: 200 });
      }

      const session = event.data?.object || {};
      const email   = session.customer_details?.email || session.customer_email || '';
      const sessionId = session.id || '';
      if (!email || !sessionId) return new Response('missing email or session id', { status: 200 });

      if (!isPremiumPurchase(session)) {
        // Tip — log and acknowledge
        console.log('Tip received:', { email, sessionId, amount: session.amount_total });
        return new Response('tip ok', { status: 200 });
      }

      try {
        const privKey = await importEd25519PrivateKey(env.LICENSE_PRIVATE_KEY);
        const issuedAt = session.created || Math.floor(Date.now() / 1000);
        const licenseKey = await signLicense({ email, sessionId, issuedAt }, privKey);

        // Best-effort: stamp the key onto the session metadata + the
        // PaymentIntent description so it shows up in Stripe's auto
        // receipt email and dashboard. Both are best-effort: if either
        // call fails (e.g. transient Stripe error), the success page
        // still works because /license re-derives the key on demand.
        ctx.waitUntil((async () => {
          try {
            await setSessionMetadata(sessionId, {
              license_key: licenseKey,
              tier: 'premium',
            }, env.STRIPE_SECRET_KEY);
          } catch (e) { console.error('setSessionMetadata failed', e); }
          if (session.payment_intent) {
            try {
              // Fetch the PaymentIntent to get the latest_charge ID,
              // then update the Charge (not the PaymentIntent) so the
              // description actually appears in the Stripe receipt email.
              const pi = await stripeApi(
                `/payment_intents/${session.payment_intent}`,
                { secret: env.STRIPE_SECRET_KEY },
              );
              const chargeId = pi.latest_charge;
              if (chargeId) {
                await stripeApi(`/charges/${chargeId}`, {
                  method: 'POST',
                  body: { description: `AI Website Dev Annotator Premium\nLicense key: ${licenseKey}\nActivate in extension Settings → Premium → paste key → Activate.` },
                  secret: env.STRIPE_SECRET_KEY,
                });
              }
            } catch (e) { console.error('setChargeDescription failed', e); }
          }
        })());

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        console.error('license issuance failed', err);
        return new Response('issuance failed', { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  },
};
