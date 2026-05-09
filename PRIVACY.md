# Privacy Policy — AI Website Dev Annotator

_Last updated: 2026-05-09_

AI Website Dev Annotator ("the Extension") is a Chrome extension that
helps developers attach notes to elements on any website and export
them as Markdown. This document explains exactly what the Extension
does and does not do with your data.

## 1. What we collect

For annotation data, AI Website Dev Annotator is local-first. Notes,
selectors, history, settings, and saved-for-later items stay on your
device unless you explicitly enable Auto-Backup, in which case a
compressed snapshot is mirrored to your own Google Account via Chrome
Sync.

Locally (`chrome.storage.local`), the Extension stores:
- Your annotations: CSS selector, your note text, the captured element
  text snippet (up to 240 characters), the page URL (origin + path
  only — query strings and hashes are stripped), and a timestamp.
- Annotation history and copy history.
- Your settings (theme, shortcuts, auto-backup toggle).
- Saved-for-later items.
- License key metadata if you have purchased the premium version,
  including the license key, licensed email address, and activation
  timestamp.

Optionally synced to your Google Account via Chrome Sync
(`chrome.storage.sync`) when Auto-Backup is enabled:
- A compressed bundle of the data above, so a new Chrome install
  signed in to the same Google Account can restore your work.

The Extension does **not** collect: passwords, form input, cookies,
browsing history, IP addresses, identifiers, analytics, or telemetry.

## 2. Page access

The Extension only reads the DOM of a page when you actively
annotate. It computes a stable CSS selector for the element you
click and reads up to 240 characters of that element's `innerText`.
It does not read other elements, scripts, or storage on the page.

## 3. Permissions

- `storage` — to save annotations and settings on your device and
  optionally to Chrome Sync.
- `scripting` — to inject the annotation overlay when you open the
  Extension on a page.
- `contextMenus` — to add the right-click "Annotate this element"
  entry.
- `notifications` — to show local toast notifications (e.g.
  "Backup restored").
- `tabs` — to open annotated pages, focus the current tab, and launch
  external purchase/support links when you click them.
- `alarms` — to schedule the optional local/Chrome Sync Auto-Backup.
- Host permissions — required to inject the annotation overlay on
  the sites you choose to annotate. Granted at install time per the
  manifest.

## 4. Third parties

There are no third-party SDKs, analytics, ad networks, tracking pixels,
or remote code in the Extension.

The optional Auto-Backup feature uses Chrome Sync, controlled by your
Google Account. Premium purchases are handled by Stripe Checkout, and
license issuance uses a Cloudflare Worker operated for this project.

## 5. Payments (premium build only)

If you purchase the premium version, payment is handled by Stripe
Checkout. After payment, Stripe redirects you to a success page with a
checkout session ID. That page asks the project's Cloudflare Worker for
your license key; the Worker verifies the paid Stripe checkout session,
derives an Ed25519-signed license key, and returns it to the success
page.

The Worker also stores the license key in Stripe metadata and in the
Stripe receipt description so the key can be delivered in your Stripe
receipt email. The Extension stores the license key locally
(`chrome.storage.local`) and verifies it offline. The Extension itself
does not transmit your card details or contact the license Worker.
Stripe handles payment data under https://stripe.com/privacy.

## 6. Data deletion

Click "Clear all data" in Settings, or uninstall the Extension. All
`chrome.storage.local` data is removed when the Extension is
uninstalled. To remove synced data, also disable Chrome Sync for
Extensions in your Google Account settings.

## 7. Children

The Extension is a developer tool not directed to children under 13.

## 8. Changes

Material changes to this policy will be announced in the Extension's
release notes on GitHub.

## 9. Contact

Arjun Sharma — asharma27@uchicago.edu
Source code: https://github.com/asharma2027/ai-dev-annotator
