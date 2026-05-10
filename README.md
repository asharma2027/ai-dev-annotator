# AI Website Dev Annotator: AI Notes & Markdown Export

> **One-sentence pitch:** Hold **Alt** (or your chosen modifier) + Right-Click any web element to annotate it, then export all your notes as clean Markdown for AI tools.

---

## What it does

AI Website Dev Annotator is a Chrome extension built for developers who
use AI coding assistants (Cursor, Claude Code, Copilot, ChatGPT, v0). You
annotate any element on any website — bug, copy fix, layout note, design
nit — then export the whole list as clean Markdown that you paste
straight into your AI agent. Every annotation captures a stable CSS
selector, the element’s text snippet, your note, and the URL, so the
model has enough context to find and fix the issue without a screenshot.

Typical flow:
1. Open the site you’re reviewing.
2. Hold **Alt** (or your chosen modifier in Settings) and **Right-Click** an element, type an annotation, repeat.
3. Hit **Copy All** (or **Cut All** via right-click on that button) and paste into your AI assistant.
4. The agent ships a PR.

---

## Features

### Free
- **Modifier + Right-Click** (default **Alt**) annotates any element : captures tag, ID, classes, XPath, URL, and your note. Change the modifier in Settings → Shortcuts.
- While the inline edit panel is open, **modifier + click** other elements to attach them as extra selector context on the same annotation (shown as comma-separated selectors in the popup).
- **Open popup** : Chrome command **Alt+Shift+A** (customizable in `chrome://extensions/shortcuts`)
- Unlimited annotations, grouped by page URL in the popup
- Per-row inline note editing with **auto-expanding textboxes** (auto-saves as you type)
- Per-row delete button : moves annotation to history rather than erasing it
- **Footer export buttons** (labels are customizable in Settings) : by default, **📋 Copy All** copies Markdown without clearing; **right-click** the same button runs **✂ Cut All** (copy + clear). **🗑 Clear All** clears with a 5-second **Undo** banner; **right-click** it runs **💾 Save for Later** instead.
- **↶ / ↷** in the popup header : multi-step undo and redo for recent storage changes
- **🕐 History view** : deleted annotations with timestamps, including restore
- **Copy Log** : copy events with full output preview
- **Saved for Later** : stash the current list and restore it from the History panel
- **Search** (⌘/Ctrl+F or the 🔍 button) : searches the view you have open — current annotations list, History (any of its tabs), or Settings
- Click any annotation selector (pink text) or URL group (blue text) to navigate directly to the annotated element on the page
- **Clear All** (footer) shows an undo banner instead of a confirmation dialog — click Undo within 5 seconds to restore. Clearing a **single URL group** still asks for confirmation first.
- Annotations persist in `chrome.storage.local` across page reloads and browser restarts
- Inline panel on the page : edit or delete annotations without opening the popup
- **Auto-Backup** is **on by default** : mirrors a compressed bundle to `chrome.storage.sync` (your Google Account) and writes a local in-browser snapshot about every **15 minutes** — no download prompts. Turn it off in Settings to stop the Chrome Sync mirror (data stays on this device); the local snapshot still refreshes on the same schedule for recovery on this install.

### Premium : $9.99 one-time
- 🌙 **Dark mode** : a polished dark theme for the popup
- 📝 **Custom prepend & append text** : automatically wrap every Markdown export with your own headers, footers, or AI system prompts
- 🗒️ **Multiple notes per element** : attach more than one note to the same element (each renders as its own bullet under the element selector in Markdown output)
- 🚀 **All future premium features**

[**→ Get Premium ($9.99 one-time)**](https://buy.stripe.com/6oU9AS4Kjc9h6x1bxocfK01)

---

## How it works

1. **Annotate** : Hold your chosen modifier (default **Alt**) and **Right-Click** any element on the page, type a note, and press Esc or click
   outside to save. Empty notes are auto-discarded.
2. **Review** : Open the popup (toolbar icon or **Alt+Shift+A**) to see all saved annotations grouped by page URL. Notes are editable inline.
3. **Navigate** : Click any pink annotation selector or blue URL group label to jump directly to that element on the page — the annotation panel opens automatically.
4. **Copy / cut** : By default, **📋 Copy All** copies Markdown and leaves your list intact; **right-click** that button for **✂ Cut All** (copy + clear). An undo banner appears after a cut-style clear so you can reverse it within 5 seconds.
5. **History** : Click 🕐 to browse past annotations, including deleted ones, with timestamps. Click `+` to restore any entry.
6. **Settings** : Click ⚙️ for shortcuts, footer button actions, Auto-Backup toggle, dark mode (Premium), prepend/append text (Premium), or license key activation.

---

## Example output

```markdown
## https://example.com/dashboard

1. `button#submit-btn`
   - Make this button larger and change color to green
   - Add a loading state while the request is pending
   - _"Submit"_
   - https://example.com/dashboard
   - 2026-05-09T19:30:00.000Z

2. `div.sidebar`
   - Reduce width to 200px and add a top border
   - _"Navigation Settings Billing"_
   - https://example.com/dashboard
   - 2026-05-09T19:31:00.000Z
```

Paste directly into Cursor's chat, Claude, or any AI tool : it already knows which element, where it lives, and what you want changed.

---

## Activating Premium

1. [Purchase Premium on Stripe ($9.99 one-time)](https://buy.stripe.com/6oU9AS4Kjc9h6x1bxocfK01)
2. After paying, Stripe redirects you to a success page that shows your license key with a copy button. Your key is also included in the Stripe receipt email under "License key:"
3. Open the extension popup → click ⚙️ (Settings) → paste your key in the **Premium** section → click **Activate**
4. Your license is verified locally with an Ed25519 signature — no network call, works fully offline

> **Keep your license key safe** : it's stored in `chrome.storage.local`. If you clear extension data, you'll need to re-enter it (the key itself remains valid indefinitely).

---

## Privacy

AI Website Dev Annotator does not send annotation data to an app server.
There is no analytics and no telemetry. Premium checkout and license
delivery use Stripe plus the project's Cloudflare Worker, but the
Extension verifies license keys locally.

| Data                              | Where it lives                              | Leaves your device?                                  |
|-----------------------------------|---------------------------------------------|------------------------------------------------------|
| Annotations, notes, element text  | `chrome.storage.local`                      | No.                                                  |
| Copy / annotation history         | `chrome.storage.local`                      | No.                                                  |
| Settings (theme, shortcuts, backup, footer buttons, history limits, …) | `chrome.storage.local`                      | No.                                                  |
| Auto-Backup mirror (on by default; off in Settings) | `chrome.storage.sync`                       | Only when enabled; synced via your Google Account. |
| License / receipt info            | `chrome.storage.local`                      | No.                                                  |

Auto-Backup is **on by default**. A compressed bundle of your annotations
is mirrored into `chrome.storage.sync` so a fresh Chrome install signed
into the same Google account can restore your work. Google encrypts Sync
data in transit and at rest, and end-to-end if you set a Sync passphrase.
Turn Auto-Backup off in Settings to stop syncing to your Google account;
notes remain on this device, and the extension still refreshes a local
snapshot periodically for recovery on this install.

The extension reads the page’s DOM only when you actively annotate, and
only to compute a stable CSS selector and capture up to 240 characters
of the clicked element’s text (plus up to 120 characters per companion
element if you attach extras with modifier + click). It does not read
passwords, form values, cookies, or storage.

---

## File structure

```
ai-dev-annotator/
├── manifest.json        : Extension config (Manifest V3)
├── content.js           : Injected into pages; handles Alt + Right-Click
├── background.js        : Auto-backup alarm and background message handling
├── popup.html           : Extension popup UI
├── popup.js             : Popup logic (annotations, copy, history, settings, premium)
├── styles.css           : Popup styles (light + dark theme)
├── docs/                : GitHub Pages landing, success, terms, and refund pages
├── infra/worker/        : Cloudflare Worker for Stripe webhooks and license lookup
└── icons/               : Extension icon assets
```
---

## Storage keys

| Key | Contents |
|-----|----------|
| `annotations` | Active (non-deleted) annotations |
| `annotationHistory` | Past annotations with `deletedAt` timestamp |
| `copyHistory` | Log of every copy event |
| `copyAllSnapshots` | Grouped “Copy All” snapshots for the Copy Log UI |
| `savedForLater` | Saved-for-later sets (references into `_annStore`) |
| `_annStore` | Deduplicated annotation bodies referenced by history, copy log, and saved sets |
| `annotatorSettings` | User preferences (theme, shortcuts, backup toggle, footer buttons, history limits, …) |
| `license` | Validated license key info (premium) |
| `_localBackupSnapshot` | Latest local in-browser backup snapshot |
| `annv2_*` / `annv2_count` / `annv2_ts` / `annv2_ver` (sync) | Chunked gzip backup in `chrome.storage.sync` when Auto-Backup is enabled |
| Legacy `ann_sync_*` (sync) | Older chunked JSON backups may still exist from prior versions; they are cleared when a new v2 backup runs |

---

## Support & contact

- 🤝 **Tip Me:** [https://buy.stripe.com/6oU5kCa4D4GPaNhatkcfK00](https://buy.stripe.com/6oU5kCa4D4GPaNhatkcfK00) : Leave an optional tip. Choose any amount you like (min $0.50). Tips are completely voluntary and do not unlock any extra features. The free tier already includes everything most developers need.


- 💼 **Hire me:** [linkedin.com/in/asharma2027](https://www.linkedin.com/in/asharma2027/) : available for freelance and full-time opportunities

---

## Known limitations

- **iframes:** Annotations live in the top frame only. If the element
  you click is inside an embedded iframe (Stripe Checkout, Calendly,
  YouTube embeds, Typeform, embedded Notion / Figma), the chip will
  attach to the iframe container rather than the element inside it.
  Open the embedded page in its own tab to annotate inner elements.
- **Selectors on heavily dynamic SPAs:** Some apps regenerate class
  names on every render (Tailwind JIT in dev mode, CSS-in-JS hash
  classes). The extension prefers `id`, `data-*`, ARIA, and structural
  selectors before falling back to class names, but a chip may still
  become orphaned after a redeploy. Re-click the element to re-anchor.
- **Shadow DOM:** Annotations cannot pierce closed shadow roots. Open
  shadow roots are supported.
- **`file://` URLs and `chrome://` pages:** Out of scope. The extension
  runs on `http(s)://` only.

---

## License

MIT — see [LICENSE](./LICENSE).
