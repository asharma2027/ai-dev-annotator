// content.js — Dev Annotator
// Alt + Right-Click any element to annotate it inline.
// Notes are saved in real-time as you type and persist across page loads.

const ANN = 'aiann'; // CSS class/id prefix to avoid collisions

// ── Inject stylesheet once ─────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById(`${ANN}-styles`)) return;
  const s = document.createElement('style');
  s.id = `${ANN}-styles`;
  s.textContent = `
    /* Highlighted annotated element */
    .${ANN}-hl {
      outline: 2px solid #f59e0b !important;
      background-color: rgba(253, 230, 138, 0.3) !important;
      border-radius: 2px;
    }
    /* Inline chip badge inserted after each annotated element */
    .${ANN}-chip {
      display: inline-flex;
      align-items: center;
      cursor: pointer;
      background: #fbbf24;
      color: #78350f;
      font: 700 11px/1 system-ui, sans-serif;
      padding: 2px 7px;
      border-radius: 12px;
      vertical-align: middle;
      margin: 0 4px;
      user-select: none;
      white-space: nowrap;
      box-shadow: 0 1px 4px rgba(0,0,0,0.18);
      transition: background 0.12s;
      position: relative;
      z-index: 2147483600;
    }
    .${ANN}-chip:hover { background: #d97706; color: #fff; }
    .${ANN}-chip.has-note { background: #f59e0b; }
    /* Shared editing panel — fixed, appended to body */
    #${ANN}-panel {
      position: fixed;
      width: 272px;
      background: #fff;
      border: 1.5px solid #fbbf24;
      border-radius: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.18);
      padding: 12px;
      z-index: 2147483647;
      display: none;
      font-family: system-ui, sans-serif;
    }
    #${ANN}-panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
      font: 700 11px system-ui, sans-serif;
      color: #78350f;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    #${ANN}-close-btn {
      background: none;
      border: none;
      color: #9ca3af;
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
      padding: 0 2px;
    }
    #${ANN}-close-btn:hover { color: #374151; }
    #${ANN}-textarea {
      width: 100%;
      /* 2× the original 80px default height */
      min-height: 160px;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      padding: 7px 9px;
      font: 12.5px/1.5 system-ui, sans-serif;
      resize: vertical;
      box-sizing: border-box;
      outline: none;
      color: #111827;
    }
    #${ANN}-textarea:focus {
      border-color: #f59e0b;
      box-shadow: 0 0 0 2px rgba(251,191,36,0.25);
    }
    #${ANN}-panel-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 7px;
    }
    #${ANN}-save-status {
      font-size: 10px;
      color: #9ca3af;
      font-family: system-ui, sans-serif;
    }
    #${ANN}-delete-btn {
      background: none;
      border: none;
      color: #ef4444;
      font: 600 11px system-ui, sans-serif;
      cursor: pointer;
      padding: 2px 7px;
      border-radius: 4px;
    }
    #${ANN}-delete-btn:hover { background: #fee2e2; }
  `;
  document.head.appendChild(s);
}

// ── XPath utilities ────────────────────────────────────────────────────────
function getXPath(el) {
  if (!el || el.nodeType !== 1) return '';
  if (el.id) return `id("${el.id}")`;
  if (el === document.body) return 'body';
  let ix = 0;
  const sibs = el.parentNode ? el.parentNode.childNodes : [];
  for (let i = 0; i < sibs.length; i++) {
    const s = sibs[i];
    if (s === el) return getXPath(el.parentNode) + '/' + el.tagName.toLowerCase() + '[' + (ix + 1) + ']';
    if (s.nodeType === 1 && s.tagName === el.tagName) ix++;
  }
  return el.tagName.toLowerCase();
}

function resolveXPath(xpath) {
  try {
    return document.evaluate(
      xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
    ).singleNodeValue;
  } catch { return null; }
}

// ── Storage helpers ────────────────────────────────────────────────────────
const STORE_KEY = 'annotations';
const HISTORY_KEY = 'annotationHistory';
function getAll(cb) { chrome.storage.local.get({ [STORE_KEY]: [] }, r => cb(r[STORE_KEY])); }
function setAll(anns, cb) { chrome.storage.local.set({ [STORE_KEY]: anns }, cb); }
function genId() { return `ann_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; }

// ── Shared panel (single instance, position:fixed, appended to body) ───────
// Using a single shared panel rather than one-per-chip avoids z-index fights
// and overflow:hidden clipping from parent elements.
let activeChip = null;
let activeAnnId = null;
let saveTimer = null;

function buildPanel() {
  const p = document.createElement('div');
  p.id = `${ANN}-panel`;
  p.innerHTML = `
    <div id="${ANN}-panel-header">
      ✏ Annotation
      <button id="${ANN}-close-btn" title="Close">✕</button>
    </div>
    <textarea id="${ANN}-textarea" placeholder="Notes and observations about this element…"></textarea>
    <div id="${ANN}-panel-footer">
      <span id="${ANN}-save-status"></span>
      <button id="${ANN}-delete-btn">🗑 Delete</button>
    </div>`;
  document.body.appendChild(p);

  p.querySelector(`#${ANN}-textarea`).addEventListener('input', e => {
    setSaveStatus('Saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persistNote(activeAnnId, e.target.value), 400);
  });

  p.querySelector(`#${ANN}-delete-btn`).addEventListener('click', () => deleteAnnotation(activeAnnId));
  p.querySelector(`#${ANN}-close-btn`).addEventListener('click', closePanel);

  // Close when clicking outside panel and outside any chip
  document.addEventListener('mousedown', e => {
    const panel = document.getElementById(`${ANN}-panel`);
    if (
      panel && panel.style.display === 'block' &&
      !panel.contains(e.target) &&
      !e.target.closest(`.${ANN}-chip`)
    ) {
      closePanel();
    }
  }, true);

  return p;
}

function getPanel() {
  return document.getElementById(`${ANN}-panel`) || buildPanel();
}

function openPanel(chip, annId) {
  getAll(anns => {
    const ann = anns.find(a => a.id === annId);
    const comment = ann ? (ann.comment || '') : '';

    const panel = getPanel();
    positionPanel(panel, chip);
    panel.style.display = 'block';

    const ta = panel.querySelector(`#${ANN}-textarea`);
    ta.value = comment;
    setSaveStatus(comment ? '' : 'Start typing — auto-saves as you go');

    activeChip = chip;
    activeAnnId = annId;
    ta.focus();
  });
}

function positionPanel(panel, chip) {
  const r = chip.getBoundingClientRect();
  let top = r.bottom + 6;
  let left = r.left;
  // Clamp so panel stays inside viewport (panel height ~270px with 2× textarea)
  if (left + 276 > window.innerWidth - 4) left = window.innerWidth - 280;
  if (top + 270 > window.innerHeight - 4) top = Math.max(4, r.top - 276);
  panel.style.top = top + 'px';
  panel.style.left = Math.max(4, left) + 'px';
}

function closePanel() {
  const p = document.getElementById(`${ANN}-panel`);
  if (p) p.style.display = 'none';
  activeChip = null;
  activeAnnId = null;
}

function setSaveStatus(msg) {
  const el = document.getElementById(`${ANN}-save-status`);
  if (el) el.textContent = msg;
}

function persistNote(annId, text) {
  if (!annId) return;
  getAll(anns => {
    const ann = anns.find(a => a.id === annId);
    if (!ann) return;
    ann.comment = text;
    setAll(anns, () => {
      setSaveStatus('Saved ✓');
      // Update chip tooltip to reflect latest note
      const chip = document.querySelector(`.${ANN}-chip[data-ann-id="${annId}"]`);
      if (chip) {
        chip.title = text.trim() ? text.trim().slice(0, 80) : '(no note)';
        chip.classList.toggle('has-note', !!text.trim());
      }
    });
  });
}

function deleteAnnotation(annId) {
  if (!annId) return;
  const id = annId; // capture before closePanel clears activeAnnId
  closePanel();
  getAll(anns => {
    const ann = anns.find(a => a.id === id);
    if (ann) {
      const el = resolveXPath(ann.xpath);
      if (el) el.classList.remove(`${ANN}-hl`);
      // Move to annotation history
      chrome.storage.local.get({ [HISTORY_KEY]: [] }, r => {
        const hist = r[HISTORY_KEY];
        hist.push({ ...ann, deletedAt: new Date().toISOString() });
        chrome.storage.local.set({ [HISTORY_KEY]: hist });
      });
    }
    const chip = document.querySelector(`.${ANN}-chip[data-ann-id="${id}"]`);
    if (chip) chip.remove();
    setAll(anns.filter(a => a.id !== id));
  });
}

// ── Inject chip sibling after annotated element ────────────────────────────
function injectChip(el, annId, comment) {
  if (document.querySelector(`.${ANN}-chip[data-ann-id="${annId}"]`)) return; // already present

  el.classList.add(`${ANN}-hl`);

  const chip = document.createElement('span');
  chip.className = `${ANN}-chip${comment && comment.trim() ? ' has-note' : ''}`;
  chip.dataset.annId = annId;
  chip.textContent = '✏';
  chip.title = comment && comment.trim() ? comment.trim().slice(0, 80) : '(no note)';

  chip.addEventListener('click', e => {
    e.stopPropagation();
    e.preventDefault();
    const panel = document.getElementById(`${ANN}-panel`);
    // Toggle: clicking the active chip's chip closes it
    if (activeAnnId === annId && panel && panel.style.display === 'block') {
      closePanel();
    } else {
      openPanel(chip, annId);
    }
  });

  try {
    el.insertAdjacentElement('afterend', chip);
  } catch {
    // Fallback for elements that don't support afterend (e.g. <html>)
    document.body.appendChild(chip);
  }
}

// ── Restore annotations for the current page on load ──────────────────────
function restoreAnnotations() {
  const url = window.location.href;
  getAll(anns => {
    anns
      .filter(a => a.url === url)
      .forEach(ann => {
        const el = resolveXPath(ann.xpath);
        if (el) injectChip(el, ann.id, ann.comment);
      });
  });
}

// ── Alt + Right-Click handler ──────────────────────────────────────────────
document.addEventListener('contextmenu', e => {
  if (!e.altKey) return;
  e.preventDefault();

  const target = e.target;

  // Ignore clicks on our own UI
  if (
    target.closest(`#${ANN}-panel`) ||
    target.classList.contains(`${ANN}-chip`) ||
    target === document.body ||
    target === document.documentElement
  ) return;

  // If the element is already annotated, edit the existing annotation instead
  // of creating a duplicate. Search next siblings for the chip injected after it.
  if (target.classList.contains(`${ANN}-hl`)) {
    let chip = null;
    let node = target.nextSibling;
    while (node) {
      if (node.classList && node.classList.contains(`${ANN}-chip`)) {
        chip = node;
        break;
      }
      node = node.nextSibling;
    }
    if (chip) {
      openPanel(chip, chip.dataset.annId);
      return;
    }
    // Chip missing from DOM (edge case) — fall through to create a fresh one
  }

  // Build CSS class string, filtering out our own injected classes
  const classes = typeof target.className === 'string' && target.className.trim()
    ? target.className.trim().split(/\s+/)
        .filter(c => !c.startsWith(ANN))
        .map(c => `.${c}`)
        .join('')
    : '';

  const ann = {
    id: genId(),
    url: window.location.href,
    tag: target.tagName.toLowerCase(),
    elId: target.id || '',
    classes,
    xpath: getXPath(target),
    comment: '',
    timestamp: new Date().toISOString(),
  };

  getAll(anns => {
    anns.push(ann);
    setAll(anns, () => {
      injectChip(target, ann.id, '');
      // Auto-open the panel so user can immediately start typing
      const chip = document.querySelector(`.${ANN}-chip[data-ann-id="${ann.id}"]`);
      if (chip) openPanel(chip, ann.id);
    });
  });
});

// ── Message listener (commands from the popup) ──────────────────────────────
// The popup cannot touch the DOM directly, so it asks the content script to
// perform any visual changes (removing highlights / re-injecting chips).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'removeAnnotation') {
    const { annId, xpath } = msg;
    // Close the floating panel if it is open for this annotation
    if (activeAnnId === annId) closePanel();
    // Remove the chip badge from the DOM
    const chip = document.querySelector(`.${ANN}-chip[data-ann-id="${annId}"]`);
    if (chip) chip.remove();
    // Remove the yellow highlight from the annotated element
    if (xpath) {
      const el = resolveXPath(xpath);
      if (el) el.classList.remove(`${ANN}-hl`);
    }
  }

  if (msg.type === 'restoreAnnotation') {
    const ann = msg.ann;
    if (!ann || !ann.xpath) return;
    const el = resolveXPath(ann.xpath);
    if (el) injectChip(el, ann.id, ann.comment || '');
  }
});

// ── Init ──────────────────────────────────────────────────────────────────
injectStyles();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', restoreAnnotations);
} else {
  restoreAnnotations();
}
