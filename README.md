# Website Dev Annotator: AI Notes & Markdown Export

> **One-sentence pitch:** Alt + Right-Click any web element to annotate it, then export all your notes as clean Markdown for AI tools like Cursor, Claude, and ChatGPT.

---

## What it does

Website Dev Annotator lets you attach sticky-note annotations directly to HTML elements on any web page. When you're done, one click copies everything as structured Markdown : ready to paste into any AI coding assistant, bug tracker, or documentation tool.

**Use cases:**
- Briefing AI tools (Cursor, Claude, ChatGPT) about which elements need changes and why
- Writing QA bug reports with exact element selectors
- Taking design-review notes directly on a live site
- Annotating UI for handoff or code review

---

## Features

### Free
- **Alt + Right-Click** gesture annotates any element : captures tag, ID, classes, XPath, URL, and your note
- Unlimited annotations, grouped by page URL in the popup
- Per-row inline note editing (auto-saves as you type)
- Per-row delete button : moves annotation to history rather than erasing it
- **Copy All as Markdown** : one-click export of all notes in a clean, AI-ready format
- **🕐 History view** : last 30 deleted annotations with timestamps, including restore
- **Copy Log** : last 10 "Copy All as Markdown" events with full output preview
- Annotations persist in `chrome.storage.local` across page reloads and browser restarts
- Inline panel on the page : edit or delete annotations without opening the popup

### Premium : $9.99 one-time
- 🌙 **Dark mode** : a polished dark theme for the popup
- 📝 **Custom prepend & append text** : automatically wrap every Markdown export with your own headers, footers, or AI system prompts
- 📋 **Unlimited history** : full copy log and annotation history, no cap
- 🚀 **All future premium features**

[**→ Get Premium on Gumroad**](https://arjunsharma10.gumroad.com/l/websiteDevAnnotator)

---

## How it works

1. **Annotate** : On any page, hold `Alt` (or `Option` on Mac) and **Right-Click** any element. A panel opens where you type a note. It auto-saves as you type.
2. **Review** : Click the extension icon in the toolbar to see all saved annotations grouped by page URL. Notes are editable inline.
3. **Copy** : Click **Copy All as Markdown** to copy a clean, structured payload to the clipboard.
4. **History** : Click 🕐 to browse past annotations, including deleted ones, with timestamps. Click `+` to restore any entry.
5. **Settings** : Click ⚙ to toggle dark mode (Premium), configure prepend/append text (Premium), or enter a license key.

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
3. Open the extension popup → click ⚙ (Settings) → paste your key in the **Premium** section → click **Activate**
4. Your license is stored locally and validated against Gumroad's API

> **Keep your license key safe** : it's stored in `chrome.storage.local`. If you clear extension data, you'll need to re-enter it (the key itself remains valid indefinitely).

---

## Privacy

Website Dev Annotator stores all annotation data **locally** in your browser via `chrome.storage.local`. No data is sent to any server unless you activate a license key, at which point only the key is sent to Gumroad's API to verify validity. No browsing history, page content, or personal data is ever collected or transmitted.

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
| `copyHistory` | Log of every "Copy All as Markdown" event |
| `annotatorSettings` | User preferences (dark mode, prepend/append text) |
| `license` | Validated license key info (premium) |

---

## Source code

This extension is fully open source. You can review all code at:
**https://github.com/asharma2027/ai-dev-annotator/production**

---

## Support & contact

- ☕ **Ko-fi:** [ko-fi.com/asharma2027](https://ko-fi.com/asharma2027) : buy me a coffee if this saves you time
- 💼 **Hire me:** [linkedin.com/in/asharma2027](https://www.linkedin.com/in/asharma2027/) : available for freelance and full-time opportunities
