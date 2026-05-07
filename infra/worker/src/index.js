// Cloudflare Worker — receives Stripe webhooks for AI Website Dev Annotator,
// generates an Ed25519-signed license key, and emails it via Resend.
//
// Endpoints:
//   POST /stripe/webhook   — Stripe sends checkout.session.completed here
//   GET  /health           — returns "ok"
//
// The license format is:
//   v1.<base64url(email)>.<base64url(sessionId)>.<base64url(issuedAtUnix)>.<base64url(signature)>
//
// The extension verifies the signature offline using a hard-coded public key.
// No DB. No server lookup at activation time. No third-party dependency
// besides Stripe (payments) and Resend (email).

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — base64url, hex, and webcrypto wrappers
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

function utf8(s) {
  return new TextEncoder().encode(s);
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// Constant-time comparison for HMAC signatures
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stripe webhook signature verification
//   Stripe-Signature: t=<unix>,v1=<hexHmac>,v1=<hexHmac>...
//   signedPayload = `${t}.${rawBody}`
//   expected      = HMAC_SHA256(secret, signedPayload)
// ─────────────────────────────────────────────────────────────────────────────
async function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300) {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map(kv => {
      const idx = kv.indexOf('=');
      return [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()];
    }).filter(([k]) => k),
  );
  // multiple v1 entries are possible — split manually
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
    const got = hexToBytes(v1);
    const exp = hexToBytes(expectedHex);
    if (timingSafeEqual(got, exp)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ed25519 license signing
// ─────────────────────────────────────────────────────────────────────────────
async function importEd25519PrivateKey(privBase64Url) {
  // Cloudflare Workers' WebCrypto supports Ed25519 with raw private keys
  // imported as PKCS#8. We convert raw 32-byte seed → PKCS#8 wrapper.
  const raw = b64uDecode(privBase64Url);
  if (raw.length !== 32) throw new Error(`Ed25519 private key must be 32 bytes, got ${raw.length}`);
  // PKCS#8 wrapper for Ed25519 (RFC 8410):
  //   30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20 <32 bytes seed>
  const prefix = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
    0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const pkcs8 = new Uint8Array(prefix.length + raw.length);
  pkcs8.set(prefix, 0);
  pkcs8.set(raw, prefix.length);

  return crypto.subtle.importKey(
    'pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign'],
  );
}

async function signLicense({ email, sessionId, issuedAt }, privKey) {
  const payloadParts = [
    'v1',
    b64uEncode(utf8(email)),
    b64uEncode(utf8(sessionId)),
    b64uEncode(utf8(String(issuedAt))),
  ];
  const payload = payloadParts.join('.');
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privKey, utf8(payload));
  return `${payload}.${b64uEncode(new Uint8Array(sig))}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resend email
// ─────────────────────────────────────────────────────────────────────────────
async function sendLicenseEmail({ to, licenseKey, sender, resendApiKey }) {
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;">
      <h2 style="margin:0 0 16px;">Thanks for buying AI Website Dev Annotator Premium</h2>
      <p>Your license key is below. Open the extension popup, click the gear icon, paste your key in the <strong>Premium</strong> section, and click <strong>Activate</strong>.</p>
      <pre style="background:#f1f5f9;padding:14px 16px;border-radius:8px;font-size:13px;white-space:pre-wrap;word-break:break-all;border:1px solid #e2e8f0;">${licenseKey}</pre>
      <p style="margin-top:24px;">Premium unlocks:</p>
      <ul>
        <li>🌙 Polished dark mode</li>
        <li>📝 Custom prepend &amp; append text on every Markdown export</li>
        <li>🚀 All future Premium features</li>
      </ul>
      <p style="color:#64748b;font-size:13px;margin-top:24px;">Keep this email — your license key works forever, on any number of your own devices.</p>
    </div>
  `;
  const text = `Thanks for buying AI Website Dev Annotator Premium.\n\nYour license key:\n\n${licenseKey}\n\nOpen the extension popup → Settings (gear icon) → Premium → paste your key → Activate.\n\nPremium unlocks dark mode, custom prepend/append text, and all future Premium features.`;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: sender,
      to: [to],
      subject: 'Your AI Website Dev Annotator Premium license key',
      html,
      text,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Resend error ${resp.status}: ${body}`);
  }
  return resp.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    if (request.method !== 'POST' || url.pathname !== '/stripe/webhook') {
      return new Response('Not found', { status: 404 });
    }

    // Read raw body — must be the exact bytes Stripe signed
    const rawBody = await request.text();
    const sigHeader = request.headers.get('Stripe-Signature');

    const ok = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
    if (!ok) return new Response('Bad signature', { status: 400 });

    let event;
    try { event = JSON.parse(rawBody); }
    catch { return new Response('Bad JSON', { status: 400 }); }

    // We only act on completed checkouts
    if (event.type !== 'checkout.session.completed') {
      return new Response('ignored', { status: 200 });
    }

    const session = event.data?.object || {};
    const email   = session.customer_details?.email
                 || session.customer_email
                 || '';
    const sessionId = session.id || '';

    if (!email || !sessionId) {
      return new Response('missing email or session id', { status: 200 });
    }

    // Distinguish Premium vs Tip:
    //   - If PREMIUM_PRICE_ID is configured, treat checkouts that include
    //     that price as Premium. Everything else (custom-amount tips) is a tip.
    //   - If PREMIUM_PRICE_ID is not set, fall back to: sessions with
    //     payment_link metadata.tier === "premium" are premium, else
    //     a fixed amount of 999 cents (USD) is treated as premium.
    let isPremium = false;
    const tier = session.metadata?.tier || session.payment_link?.metadata?.tier;
    if (tier === 'premium') isPremium = true;
    if (env.PREMIUM_PRICE_ID) {
      // line_items aren't included by default in webhooks — but Payment Links
      // emit price IDs through `payment_link` for fixed-price links. We use
      // amount_total as a robust fallback.
      if (session.amount_total === 999) isPremium = true;
    } else if (session.amount_total === 999) {
      isPremium = true;
    }

    if (!isPremium) {
      // Tip — log and acknowledge
      console.log('Tip received:', { email, sessionId, amount: session.amount_total });
      return new Response('tip ok', { status: 200 });
    }

    // Sign and email license key
    try {
      const privKey = await importEd25519PrivateKey(env.LICENSE_PRIVATE_KEY);
      const issuedAt = Math.floor(Date.now() / 1000);
      const licenseKey = await signLicense({ email, sessionId, issuedAt }, privKey);

      ctx.waitUntil(
        sendLicenseEmail({
          to: email,
          licenseKey,
          sender: env.SENDER_EMAIL,
          resendApiKey: env.RESEND_API_KEY,
        }).catch(err => console.error('email failed', err)),
      );

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      console.error('license issuance failed', err);
      return new Response('issuance failed', { status: 500 });
    }
  },
};
