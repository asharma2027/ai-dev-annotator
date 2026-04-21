# AI Dev Annotator

A lightweight Chrome extension (Manifest V3) for annotating web UI elements and exporting your notes as clean Markdown — ready to paste into Cursor, Claude, ChatGPT, or any AI coding tool.

## How it works

1. **Annotate** — Hold `Alt` (or `Option` on Mac) and **Right-Click** any element on a page. A prompt asks what the AI should change.
2. **Review** — Click the extension icon to see all saved annotations.
3. **Copy** — Hit **Copy All as Markdown** to get a perfectly formatted payload, then paste it straight into your AI tool.

## Features

- `Alt + Right-Click` gesture captures element tag, ID, classes, XPath, page URL, and your note
- Popup shows all annotations with full context
- One-click **Copy All as Markdown** formats everything for LLM consumption
- **Clear All** button to reset annotations
- Annotations persist in `chrome.storage.local` — they survive page reloads and browser restarts

## Example output (copied Markdown)

```
### Requested UI Changes

#### Change 1
**Page:** `https://example.com/dashboard`
- **Target Element:** `<button>` (ID: `#submit-btn`)
- **Classes:** `.btn.btn-primary`
- **XPath:** `id("submit-btn")`
- **Improvement:** Make this button larger and change color to green
```

## Installation

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select this folder
5. Refresh any tab you want to annotate (Chrome needs to inject the content script)

## File structure

```
ai-dev-annotator/
├── manifest.json   — Extension config (Manifest V3)
├── content.js      — Injected into pages; handles Alt + Right-Click
├── popup.html      — Extension popup UI
├── popup.js        — Popup logic (load, copy, clear)
├── styles.css      — Popup styles
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Bug fixes vs. Gemini's original

| # | File | Bug | Fix |
|---|------|-----|-----|
| 1 | `content.js` | `getXPath()` return was incomplete — missing `(ix + 1) + ']'` — XPath broken for all non-id elements | Completed the return expression |
| 2 | `popup.js` | Template literals used `{item.tag}` / `{item.id}` (missing `$`) — rendered as literal text | Fixed to `${item.tag}` / `${item.id}` |
| 3 | `popup.js` | Display only showed URL, tag, comment — never showed ID, classes, XPath, or timestamp | All fields now displayed |
| 4 | `popup.js` | No error handling on `navigator.clipboard.writeText()` | Added `.catch()` with user-facing alert |
| 5 | `content.js` | `classes` used `split(' ')` which fails on multi-space class names | Changed to `split(/\s+/)` |
| 6 | `manifest.json` | No icons defined | Added 16/48/128px icons |
| 7 | `manifest.json` | Missing `clipboardWrite` permission | Added to permissions array |
| 8 | `popup.js` | No XSS protection when rendering page data into innerHTML | Added `escapeHtml()` sanitiser |
