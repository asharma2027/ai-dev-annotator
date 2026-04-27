# Privacy Policy — AI Website Dev Annotator

_Last updated: 2026-04-26_

AI Website Dev Annotator ("the Extension") is a Chrome extension that
helps developers attach notes to elements on any website and export
them as Markdown. This document explains exactly what the Extension
does and does not do with your data.

## 1. What we collect

**Nothing on a server. We do not run a server.**

All data created by the Extension stays on your device unless you
explicitly enable Auto-Backup, in which case a compressed snapshot is
mirrored to your own Google Account via Chrome Sync.

Locally (`chrome.storage.local`), the Extension stores:
- Your annotations: CSS selector, your note text, the captured element
  text snippet (up to 240 characters), the page URL (origin + path
  only — query strings and hashes are stripped), and a timestamp.
- Annotation history and copy history.
- Your settings (theme, shortcuts, auto-backup toggle).
- Saved-for-later items.
- License / receipt metadata if you have purchased the premium
  version (production build only).

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
- Host permissions — required to inject the annotation overlay on
  the sites you choose to annotate. Granted at install time per the
  manifest.

## 4. Third parties

None. There are no third-party SDKs, analytics, ad networks,
tracking pixels, or remote code in the Extension.

## 5. Payments (premium build only)

If you purchase the premium version, payment is handled by Gumroad.
The Extension stores the resulting license key locally
(`chrome.storage.local`) and verifies it offline. The Extension
itself never transmits your payment information. See Gumroad's
privacy policy at https://gumroad.com/privacy for their handling of
payment data.

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
