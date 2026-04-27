# AI Website Dev Annotator: AI Notes & Markdown Export

> **One-sentence pitch:** Alt + Right-Click any web element to annotate it, then export all your notes as clean Markdown for AI tools like Cursor, Claude, and ChatGPT.

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
2. Click an element, type a note, repeat.
3. Hit “Copy as Markdown” and paste into your AI assistant.
4. The agent ships a PR.

---

## Features

### Free
- **Alt + Right-Click** gesture annotates any element : captures tag, ID, classes, XPath, URL, and your note
- Unlimited annotations, grouped by page URL in the popup
- Per-row inline note editing with **auto-expanding textboxes** (auto-saves as you type)
- Per-row delete button : moves annotation to history rather than erasing it
- **✂ Cut All** : one-click export + clear of all notes in a clean, AI-ready format
  - *Right-click Cut All* to copy only (without clearing)
- **🕐 History view** : last 30 deleted annotations with timestamps, including restore
- **Copy Log** : last 10 copy events with full output preview
- **Search** (⌘/Ctrl+F) : works over both the main annotation list and the history panel
- Click any annotation selector (pink text) or URL group (blue text) to navigate directly to the annotated element on the page
- **Clear All** shows an undo banner instead of a confirmation dialog — click Undo within 5 seconds to restore
- Annotations persist in `chrome.storage.local` across page reloads and browser restarts
- Inline panel on the page : edit or delete annotations without opening the popup
- Auto-backup to `chrome.storage.sync` (cloud) and a local in-browser snapshot every 15 min — no download prompts

### Premium : $9.99 one-time
- 🌙 **Dark mode** : a polished dark theme for the popup
- 📝 **Custom prepend & append text** : automatically wrap every Markdown export with your own headers, footers, or AI system prompts
- 📋 **Unlimited history** : full copy log and annotation history, no cap
- 🚀 **All future premium features**

[**→ Get Premium on Gumroad**](https://arjunsharma10.gumroad.com/l/websiteDevAnnotator)

---

## How it works

1. Click the toolbar icon (or press `Alt+Shift+A`) and pick “Annotate”.
   Click any element on the page, type a note, and press Esc or click
   outside to save. Empty notes are auto-discarded.
2. **Review** : Click the extension icon in the toolbar to see all saved annotations grouped by page URL. Notes are editable inline.
3. **Navigate** : Click any pink annotation selector or blue URL group label to jump directly to that element on the page — the annotation panel opens automatically.
4. **Cut** : Click **✂ Cut All** to copy a clean, structured Markdown payload to the clipboard and clear the current list. Right-click **✂ Cut All** to copy only, without clearing. An undo banner appears briefly so you can reverse the clear.
5. **History** : Click 🕐 to browse past annotations, including deleted ones, with timestamps. Click `+` to restore any entry. Search works inside the history view too (⌘/Ctrl+F).
6. **Settings** : Click ⚙️ to toggle dark mode (Premium), configure prepend/append text (Premium), or enter a license key.

---

## Example output

```markdown
## https://example.com/dashboard

1. `button#submit-btn` → Make this button larger and change color to green
2. `div.sidebar` | `body/div[2]/div[1]` → Reduce width to 200px and add a top border
```

Paste directly into Cursor's chat, Claude, or any AI tool : it already knows which element, where it lives, and what you want changed.

---

## Activating Premium

1. [Purchase a license key on Gumroad](https://arjunsharma10.gumroad.com/l/websiteDevAnnotator)
2. Gumroad will email you a license key
3. Open the extension popup → click ⚙️ (Settings) → paste your key in the **Premium** section → click **Activate**
4. Your license is stored locally and validated against Gumroad's API

> **Keep your license key safe** : it's stored in `chrome.storage.local`. If you clear extension data, you'll need to re-enter it (the key itself remains valid indefinitely).

---

## Privacy

AI Website Dev Annotator does not send your data anywhere. There is no
server, no analytics, and no telemetry.

| Data                              | Where it lives                              | Leaves your device?                                  |
|-----------------------------------|---------------------------------------------|------------------------------------------------------|
| Annotations, notes, element text  | `chrome.storage.local`                      | No.                                                  |
| Copy / annotation history         | `chrome.storage.local`                      | No.                                                  |
| Settings (theme, shortcuts, etc.) | `chrome.storage.local`                      | No.                                                  |
| Auto-Backup snapshot (optional)   | `chrome.storage.sync`                       | Synced through your Google Account to other Chromes. |
| License / receipt info            | `chrome.storage.local`                      | No.                                                  |

Auto-Backup is opt-in. When enabled, a compressed bundle of your
annotations is mirrored into `chrome.storage.sync` so a fresh Chrome
install signed into the same Google account restores your work. Google
encrypts Sync data in transit and at rest, and end-to-end if you set a
Sync passphrase. Turn Auto-Backup off in Settings to keep everything
strictly on this device.

The extension reads the page’s DOM only when you actively annotate, and
only to compute a stable CSS selector and capture up to 240 characters
of the clicked element’s text. It does not read passwords, form values,
cookies, or storage.

---

## File structure

```
ai-dev-annotator/
├── manifest.json   : Extension config (Manifest V3)
├── content.js      : Injected into pages; handles Alt + Right-Click
├── popup.html      : Extension popup UI
├── popup.js        : Popup logic (annotations, copy, history, settings, premium)
├── styles.css      : Popup styles (light + dark theme)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```
---

## Storage keys

| Key | Contents |
|-----|----------|
| `annotations` | Active (non-deleted) annotations |
| `annotationHistory` | Past annotations with `deletedAt` timestamp |
| `copyHistory` | Log of every copy event |
| `annotatorSettings` | User preferences (dark mode, prepend/append text) |
| `license` | Validated license key info (premium) |
| `_localBackupSnapshot` | Latest local in-browser backup snapshot |

---

## Support & contact

- ☕ **Ko-fi:** [ko-fi.com/asharma2027](https://ko-fi.com/asharma2027) : buy me a coffee if this saves you time
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
