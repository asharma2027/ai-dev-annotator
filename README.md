# Dev Annotator

A lightweight Chrome extension (Manifest V3) for annotating web UI elements and exporting your notes as clean Markdown — paste them into Cursor, Claude, ChatGPT, a bug report, or anywhere else you need them.

## How it works

1. **Annotate** — Hold `Alt` (or `Option` on Mac) and **Right-Click** any element on a page. A panel opens where you can write a note about the element.
2. **Review** — Click the extension icon to see all saved annotations grouped by page.
3. **Copy** — Hit **Copy All as Markdown** to get a clean, formatted payload ready to paste anywhere.
4. **History** — Click the 🕐 button in the top-right of the popup to browse all past annotations, including ones that were deleted, with full timestamps.

## Features

- `Alt + Right-Click` gesture captures element tag, ID, classes, XPath, page URL, and your note
- Popup shows all annotations grouped by URL, with inline editable notes
- Per-row **✕ delete button** on each annotation — moves it to history rather than erasing it permanently
- **🕐 History view** — see every annotation ever created or deleted, with creation and deletion timestamps
- One-click **Copy All as Markdown** formats everything compactly for any tool or workflow
- **Clear All** button to reset the active list (all cleared annotations are saved to history)
- Annotations persist in `chrome.storage.local` — they survive page reloads and browser restarts
- Inline annotation panel on the page lets you edit or delete annotations without opening the popup

## Example output (copied Markdown)

```
## https://example.com/dashboard

1. `button#submit-btn` → Make this button larger and change color to green
2. `div.sidebar` | `body/div[2]/div[1]` → Reduce width to 200px and add a top border
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
├── popup.js        — Popup logic (load, copy, clear, delete, history)
├── styles.css      — Popup styles
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Storage keys

| Key | Contents |
|-----|----------|
| `annotations` | Active (non-deleted) annotations |
| `annotationHistory` | All past annotations with a `deletedAt` timestamp |

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
