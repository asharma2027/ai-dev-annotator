// content.js : AI Website Dev Annotator
// Injected into every page. Hold your configured modifier + Right-Click any
// element to annotate it. Notes auto-save in real-time and persist across
// page reloads.

const ANN = 'aiann'; // CSS class/id prefix to avoid collisions

// ── Change 8: Extension context invalidation handling ────────────────────────
let __aiann_contextDead = false;
function showContextInvalidatedNotice() {
  if (__aiann_contextDead) return;
  __aiann_contextDead = true;
  try {
    const n = document.createElement('div');
    n.id = 'aiann-context-dead';
    n.textContent = 'AI Dev Annotator was updated — refresh this page to keep annotating.';
    n.style.cssText = [
      'position:fixed','bottom:16px','right:16px',
      'z-index:2147483647',
      'background:#1f1f23','color:#fff',
      'font:13px/1.4 system-ui,sans-serif',
      'padding:10px 14px','border-radius:8px',
      'box-shadow:0 6px 24px rgba(0,0,0,0.25)',
      'max-width:320px','cursor:pointer'
    ].join(';');
    n.addEventListener('click', () => n.remove());
    document.body.appendChild(n);
    setTimeout(() => { try { n.remove(); } catch (_){} }, 12000);
  } catch (_) {}
}

// ── Annotation shortcut : configurable modifier key ────────────────────────
// Loaded from chrome.storage.local at init and updated in real-time whenever
// the user changes it in Settings. Default: Alt + Right-Click.
let cachedShortcut = { modifier: 'alt' };

function loadShortcut() {
  try {
    chrome.storage.local.get({ annotatorSettings: {} }, r => {
      if (chrome.runtime.lastError) {
        if (String(chrome.runtime.lastError.message).includes('Extension context invalidated')) {
          showContextInvalidatedNotice();
          return;
        }
      }
      const s = r.annotatorSettings || {};
      cachedShortcut = s.shortcut || { modifier: 'alt' };
    });
  } catch (e) {
    if (String(e && e.message).includes('Extension context invalidated')) {
      showContextInvalidatedNotice();
      return;
    }
  }
}

// Keep in sync with any Settings changes without requiring a page reload
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.annotatorSettings) {
      const newSettings = changes.annotatorSettings.newValue || {};
      cachedShortcut = newSettings.shortcut || { modifier: 'alt' };
    }
  });
} catch (_) {}

loadShortcut();

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
    /* Chip badge — now rendered in the overlay */
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

    /* Page-level annotation chip: fixed position, blue tint */
    #${ANN}-page-chips {
      position: fixed;
      bottom: 16px;
      right: 16px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column-reverse;
      gap: 6px;
      align-items: flex-end;
      pointer-events: none;
    }
    .${ANN}-page-chip {
      pointer-events: all;
      background: #3b82f6 !important;
      color: #fff !important;
      font-size: 13px !important;
    }
    .${ANN}-page-chip:hover { background: #1d4ed8 !important; color: #fff !important; }
    .${ANN}-page-chip.has-note { background: #2563eb !important; }

    /* Shared editing panel : fixed, appended to body */
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
      gap: 6px;
    }
    #${ANN}-save-status {
      flex: 1;
      font-size: 10px;
      color: #9ca3af;
      font-family: system-ui, sans-serif;
      text-align: center;
    }
    #${ANN}-delete-btn {
      flex: 0 0 auto;
      background: none;
      border: none;
      color: #ef4444;
      font: 600 11px system-ui, sans-serif;
      cursor: pointer;
      padding: 2px 7px;
      border-radius: 4px;
    }
    #${ANN}-delete-btn:hover { background: #fee2e2; }

    /* Page-level toggle button */
    #${ANN}-page-btn {
      flex: 0 0 auto;
      background: none;
      border: 1px solid #d1d5db;
      color: #6b7280;
      font: 600 11px system-ui, sans-serif;
      cursor: pointer;
      padding: 3px 8px;
      border-radius: 4px;
      white-space: nowrap;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
    }
    #${ANN}-page-btn:hover {
      border-color: #f59e0b;
      color: #92400e;
      background: #fef3c7;
    }
    #${ANN}-page-btn.${ANN}-page-btn--active {
      background: #dbeafe !important;
      border-color: #3b82f6 !important;
      color: #1d4ed8 !important;
    }

    /* Change 15: panel hint */
    .aiann-panel-hint {
      font-size: 11px;
      opacity: 0.65;
      margin-top: 4px;
      line-height: 1.35;
      font-family: system-ui, sans-serif;
      color: #6b7280;
    }
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
const STORE_KEY   = 'annotations';
const HISTORY_KEY = 'annotationHistory';
function getAll(cb) {
  try {
    chrome.storage.local.get({ [STORE_KEY]: [] }, r => {
      if (chrome.runtime.lastError) {
        if (String(chrome.runtime.lastError.message).includes('Extension context invalidated')) {
          showContextInvalidatedNotice();
          cb([]);
          return;
        }
      }
      cb(r[STORE_KEY]);
    });
  } catch (e) {
    if (String(e && e.message).includes('Extension context invalidated')) {
      showContextInvalidatedNotice();
    }
    cb([]);
  }
}
function setAll(anns, cb) {
  try {
    chrome.storage.local.set({ [STORE_KEY]: anns }, cb);
    backupAnnotationsToSync(anns); // keep sync mirror up-to-date
  } catch (e) {
    if (String(e && e.message).includes('Extension context invalidated')) {
      showContextInvalidatedNotice();
    }
  }
}
function genId() { return `ann_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; }

// ── Sync backup (delegated to background service worker) ──────────────────
// The background script owns the v2 compressed sync format. We just nudge
// it on every annotation change so it can debounce + write.
function backupAnnotationsToSync(_annotations) {
  try {
    chrome.runtime.sendMessage({ type: 'scheduleBackup' }).catch(() => {});
  } catch (e) {
    if (String(e && e.message).includes('Extension context invalidated')) {
      showContextInvalidatedNotice();
    }
  }
}

// ── History limit enforcement ──────────────────────────────────────────────
function enforceHistoryLimit() {
  try {
    chrome.storage.local.get({ annotatorSettings: {}, [HISTORY_KEY]: [] }, r => {
      if (chrome.runtime.lastError) {
        if (String(chrome.runtime.lastError.message).includes('Extension context invalidated')) {
          showContextInvalidatedNotice();
          return;
        }
      }
      const settings = r.annotatorSettings || {};
      const maxLen   = (settings.maxHistoryLength !== undefined && settings.maxHistoryLength !== null)
        ? settings.maxHistoryLength : 100;
      if (maxLen <= 0) return; // 0 = indefinite
      const hist = r[HISTORY_KEY];
      if (hist.length <= maxLen) return;
      try { chrome.storage.local.set({ [HISTORY_KEY]: hist.slice(-maxLen) }); } catch {}
    });
  } catch {}
}

// ── Change 18: Normalize URL to origin + pathname only ────────────────────
// Strips query string and hash so annotations survive filtering/pagination.
const __aiann_pageKey = window.location.origin + window.location.pathname;

// ── Shared panel ────────────────────────────────────────────────────────────
let activeChip    = null;
let activeAnnId   = null;
let saveTimer     = null;
// Stores original element data so we can revert a page-level toggle
let originalAnnData = null;

function buildPanel() {
  const p = document.createElement('div');
  p.id = `${ANN}-panel`;
  p.innerHTML = `
    <div id="${ANN}-panel-header">
      ✏ Annotation
      <button id="${ANN}-close-btn" title="Close">✕</button>
    </div>
    <textarea id="${ANN}-textarea"></textarea>
    <div class="aiann-panel-hint">Empty notes are auto-discarded.&nbsp;&nbsp;Esc to close · saves automatically.</div>
    <div id="${ANN}-panel-footer">
      <button id="${ANN}-page-btn" title="Mark as whole-page annotation (not element-specific)">🌐 Page Note</button>
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

  // Change 10: Esc key closes the panel (autosave behavior unchanged)
  p.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closePanel();
    }
  });

  // ── Page-level toggle ─────────────────────────────────────────────────
  p.querySelector(`#${ANN}-page-btn`).addEventListener('click', () => {
    if (!activeAnnId) return;
    getAll(anns => {
      const ann = anns.find(a => a.id === activeAnnId);
      if (!ann) return;

      const isCurrentlyPage = !!(ann.pageLevel);

      if (!isCurrentlyPage) {
        // Store original element data before converting
        originalAnnData = { tag: ann.tag, elId: ann.elId, classes: ann.classes, xpath: ann.xpath };

        // Remove highlight from original element
        const origEl = resolveXPath(ann.xpath);
        if (origEl) origEl.classList.remove(`${ANN}-hl`);

        // Remove the overlay chip and move to page chip container
        const existingChip = document.querySelector(`.${ANN}-chip[data-ann-id="${ann.id}"]`);
        if (existingChip && !existingChip.closest(`#${ANN}-page-chips`)) {
          removeChip(ann.id);
          injectPageChip(ann.id, ann.comment || '');
          activeChip = document.querySelector(`#${ANN}-page-chips .${ANN}-chip[data-ann-id="${ann.id}"]`);
        }

        ann.tag      = 'page';
        ann.elId     = '';
        ann.classes  = '';
        ann.xpath    = 'body';
        ann.pageLevel = true;
      } else {
        // Revert to element-level using stored original data
        if (originalAnnData) {
          ann.tag     = originalAnnData.tag;
          ann.elId    = originalAnnData.elId;
          ann.classes = originalAnnData.classes;
          ann.xpath   = originalAnnData.xpath;

          // Re-add highlight
          const el = resolveXPath(ann.xpath);
          if (el) {
            el.classList.add(`${ANN}-hl`);
            // Remove page chip and inject overlay chip
            const pageChip = document.querySelector(`#${ANN}-page-chips .${ANN}-chip[data-ann-id="${ann.id}"]`);
            if (pageChip) pageChip.remove();
            injectChip(el, ann.id, ann.comment || '');
            activeChip = __aiann_chipMap.get(ann.id) || null;
          }
        }
        delete ann.pageLevel;
      }

      setAll(anns, () => {
        const pageBtn = document.getElementById(`${ANN}-page-btn`);
        if (pageBtn) {
          const nowPage = !!(ann.pageLevel);
          pageBtn.classList.toggle(`${ANN}-page-btn--active`, nowPage);
          pageBtn.title = nowPage
            ? 'Currently: whole-page — click to revert to element-specific'
            : 'Mark as whole-page annotation (not element-specific)';
        }
        setSaveStatus('Saved ✓');
      });
    });
  });

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
    const ann     = anns.find(a => a.id === annId);
    const comment = ann ? (ann.comment || '') : '';

    // Store original element data (only if not already page-level)
    if (ann && !ann.pageLevel) {
      originalAnnData = { tag: ann.tag, elId: ann.elId, classes: ann.classes, xpath: ann.xpath };
    }

    const panel = getPanel();
    positionPanel(panel, chip);
    panel.style.display = 'block';

    const ta = panel.querySelector(`#${ANN}-textarea`);
    ta.value = comment;
    ta.removeAttribute('placeholder'); // no pre-typing hint
    setSaveStatus('');

    // Reflect current page-level state on the button
    const pageBtn = panel.querySelector(`#${ANN}-page-btn`);
    if (pageBtn && ann) {
      const isPage = !!(ann.pageLevel);
      pageBtn.classList.toggle(`${ANN}-page-btn--active`, isPage);
      pageBtn.title = isPage
        ? 'Currently: whole-page — click to revert to element-specific'
        : 'Mark as whole-page annotation (not element-specific)';
    }

    activeChip  = chip;
    activeAnnId = annId;
    ta.focus();
  });
}

function positionPanel(panel, chip) {
  const r    = chip.getBoundingClientRect();
  let top  = r.bottom + 6;
  let left = r.left;
  if (left + 276 > window.innerWidth - 4)  left = window.innerWidth - 280;
  if (top  + 290 > window.innerHeight - 4) top  = Math.max(4, r.top - 296);
  panel.style.top  = top  + 'px';
  panel.style.left = Math.max(4, left) + 'px';
}

function closePanel() {
  // If the active annotation has no comment, discard it instead of saving
  // an empty record. Keeps "open chip → close without typing" non-destructive
  // for existing notes and free of clutter for newly-created ones.
  const idToCheck = activeAnnId;
  const p = document.getElementById(`${ANN}-panel`);
  if (p) p.style.display = 'none';
  activeChip    = null;
  activeAnnId   = null;

  if (!idToCheck) return;
  // Cancel any pending debounced save before checking — otherwise a queued
  // empty-string write can land after we discard.
  clearTimeout(saveTimer);
  getAll(anns => {
    const ann = anns.find(a => a.id === idToCheck);
    if (!ann) return;
    if (ann.comment && ann.comment.trim()) return; // has content — keep
    // Empty: discard silently (no history record, no chip)
    removeChip(idToCheck);
    if (!ann.pageLevel) {
      const el = resolveXPath(ann.xpath);
      if (el) el.classList.remove(`${ANN}-hl`);
    }
    setAll(anns.filter(a => a.id !== idToCheck));
  });
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
  const id = annId;
  closePanel();
  getAll(anns => {
    const ann = anns.find(a => a.id === id);
    if (ann) {
      if (!ann.pageLevel) {
        const el = resolveXPath(ann.xpath);
        if (el) el.classList.remove(`${ANN}-hl`);
      }
      try {
        chrome.storage.local.get({ [HISTORY_KEY]: [] }, r => {
          if (chrome.runtime.lastError) {
            if (String(chrome.runtime.lastError.message).includes('Extension context invalidated')) {
              showContextInvalidatedNotice();
              return;
            }
          }
          const hist = r[HISTORY_KEY];
          hist.push({ ...ann, deletedAt: new Date().toISOString() });
          try { chrome.storage.local.set({ [HISTORY_KEY]: hist }, enforceHistoryLimit); } catch {}
        });
      } catch {}
    }
    removeChip(id);
    setAll(anns.filter(a => a.id !== id));
  });
}

// ── Page-level chip container ──────────────────────────────────────────────
function getPageChipContainer() {
  let container = document.getElementById(`${ANN}-page-chips`);
  if (!container) {
    container = document.createElement('div');
    container.id = `${ANN}-page-chips`;
    document.body.appendChild(container);
  }
  return container;
}

// ── Change 6: Chip overlay infrastructure ─────────────────────────────────
// All element-level chips are rendered into a single fixed overlay div,
// avoiding layout disruption inside tables, grids, flex containers, etc.
let __aiann_chipOverlay = null;
const __aiann_chipMap   = new Map(); // annotationId → chipEl
const __aiann_targetMap = new Map(); // annotationId → targetEl

function getChipOverlay() {
  if (__aiann_chipOverlay && document.body.contains(__aiann_chipOverlay)) {
    return __aiann_chipOverlay;
  }
  const o = document.createElement('div');
  o.id = 'aiann-chip-overlay';
  o.style.cssText = [
    'position:fixed',
    'top:0','left:0',
    'width:0','height:0',
    'pointer-events:none',
    'z-index:2147483646',
    'contain:layout style'
  ].join(';');
  document.body.appendChild(o);
  __aiann_chipOverlay = o;
  return o;
}

function positionChipAtElement(chipEl, targetEl) {
  if (!targetEl || !targetEl.getBoundingClientRect) {
    chipEl.style.display = 'none';
    return;
  }
  const r = targetEl.getBoundingClientRect();
  // Hide chips for elements that are 0x0 or fully off-screen.
  if (r.width === 0 && r.height === 0) {
    chipEl.style.display = 'none';
    return;
  }
  chipEl.style.display = '';
  chipEl.style.position = 'fixed';
  chipEl.style.pointerEvents = 'auto';
  // Anchor: top-right of target, nudged 4px outward.
  chipEl.style.top  = Math.max(0, r.top - 2) + 'px';
  chipEl.style.left = Math.min(
    window.innerWidth - 24,
    r.right - 8
  ) + 'px';
}

// ── Change 9: Auto-detect collisions with site widgets ────────────────────
function repositionPageChipContainer() {
  const c = document.getElementById(`${ANN}-page-chips`);
  if (!c) return;

  // Default anchor: bottom-right, 16px inset.
  const inset = 16;
  const w = c.offsetWidth  || 220;
  const h = c.offsetHeight || 56;
  const candidates = [
    { bottom: inset, right: inset },
    { bottom: inset + h + 12, right: inset },         // shift up
    { bottom: inset, right: inset + w + 12 },         // shift left
    { top: inset, right: inset },                     // top-right fallback
    { top: inset, left: inset }                       // top-left last resort
  ];

  const collidesAt = (pos) => {
    const r = { left: 0, top: 0, right: 0, bottom: 0 };
    if (pos.right  != null) { r.right  = window.innerWidth - pos.right; r.left = r.right - w; }
    if (pos.left   != null) { r.left   = pos.left;                       r.right = r.left + w; }
    if (pos.bottom != null) { r.bottom = window.innerHeight - pos.bottom; r.top = r.bottom - h; }
    if (pos.top    != null) { r.top    = pos.top;                        r.bottom = r.top + h; }
    const pts = [
      [r.left + 4, r.top + 4],
      [r.right - 4, r.top + 4],
      [r.left + 4, r.bottom - 4],
      [r.right - 4, r.bottom - 4],
      [(r.left + r.right) / 2, (r.top + r.bottom) / 2]
    ];
    for (const [x, y] of pts) {
      const els = document.elementsFromPoint(x, y) || [];
      for (const el of els) {
        if (!el || el === c || c.contains(el)) continue;
        if (el.id && el.id.startsWith('aiann-')) continue;
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed' && cs.visibility !== 'hidden' && cs.display !== 'none') {
          const rect = el.getBoundingClientRect();
          if (rect.width >= 32 && rect.height >= 32) return true;
        }
      }
    }
    return false;
  };

  const apply = (pos) => {
    c.style.top = c.style.right = c.style.bottom = c.style.left = '';
    Object.entries(pos).forEach(([k, v]) => { c.style[k] = v + 'px'; });
  };

  for (const pos of candidates) {
    if (!collidesAt(pos)) { apply(pos); return; }
  }
  // All collided — use first candidate anyway.
  apply(candidates[0]);
}

function repositionAllChips() {
  __aiann_chipMap.forEach((chip, id) => {
    const target = __aiann_targetMap.get(id) || null;
    positionChipAtElement(chip, target);
  });
  repositionPageChipContainer();
}

// Wire reposition triggers (idempotent — guard against double-binding):
if (!window.__aiann_chipReposBound) {
  window.__aiann_chipReposBound = true;
  window.addEventListener('scroll',  repositionAllChips, { passive: true, capture: true });
  window.addEventListener('resize',  repositionAllChips, { passive: true });
  const ro = new ResizeObserver(repositionAllChips);
  ro.observe(document.documentElement);
  const mo = new MutationObserver(repositionAllChips);
  mo.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['style', 'class']
  });
}

// ── Inject chip for an annotated element (overlay-based) ──────────────────
function injectChip(el, annId, comment) {
  el.classList.add(`${ANN}-hl`);

  const overlay = getChipOverlay();
  let chip = __aiann_chipMap.get(annId);
  if (!chip) {
    chip = document.createElement('span');
    chip.className = `${ANN}-chip`;
    chip.dataset.annId = annId;
    chip.textContent   = '✏';
    chip.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      const panel = document.getElementById(`${ANN}-panel`);
      if (activeAnnId === annId && panel && panel.style.display === 'block') {
        closePanel();
      } else {
        openPanel(chip, annId);
      }
    });
    overlay.appendChild(chip);
    __aiann_chipMap.set(annId, chip);
  }
  // Update content
  chip.className = `${ANN}-chip${comment && comment.trim() ? ' has-note' : ''}`;
  chip.title = comment && comment.trim() ? comment.trim().slice(0, 80) : '(no note)';
  chip.textContent = '✏';

  // Store target for repositioning
  __aiann_targetMap.set(annId, el);
  positionChipAtElement(chip, el);
}

// Remove a chip from the overlay and clean up maps
function removeChip(annotationId) {
  const chip = __aiann_chipMap.get(annotationId);
  if (chip && chip.parentNode) chip.parentNode.removeChild(chip);
  __aiann_chipMap.delete(annotationId);
  __aiann_targetMap.delete(annotationId);
}

// ── Inject a fixed-position page-level chip ────────────────────────────────
function injectPageChip(annId, comment) {
  if (document.querySelector(`.${ANN}-chip[data-ann-id="${annId}"]`)) return;

  const chip = document.createElement('span');
  chip.className     = `${ANN}-chip ${ANN}-page-chip${comment && comment.trim() ? ' has-note' : ''}`;
  chip.dataset.annId = annId;
  chip.textContent   = '📄';
  chip.title = comment && comment.trim() ? comment.trim().slice(0, 80) : '(page annotation)';

  chip.addEventListener('click', e => {
    e.stopPropagation();
    e.preventDefault();
    const panel = document.getElementById(`${ANN}-panel`);
    if (activeAnnId === annId && panel && panel.style.display === 'block') {
      closePanel();
    } else {
      openPanel(chip, annId);
    }
  });

  getPageChipContainer().appendChild(chip);
}

// ── Restore annotations on page load ──────────────────────────────────────
function restoreAnnotations() {
  // Change 18: match by origin+pathname, also accept old full-href entries
  const pageKey = __aiann_pageKey;
  getAll(anns => {
    anns
      .filter(a => {
        if (!a.url) return false;
        // Normalize stored url for comparison
        try {
          const u = new URL(a.url);
          return (u.origin + u.pathname) === pageKey;
        } catch (_) {
          return a.url === pageKey;
        }
      })
      .forEach(ann => {
        if (ann.pageLevel || ann.tag === 'page') {
          injectPageChip(ann.id, ann.comment || '');
        } else {
          const el = resolveXPath(ann.xpath);
          if (el) injectChip(el, ann.id, ann.comment);
        }
      });
    // After chips are placed, run any post-navigation intent left by the popup
    consumeNavIntent();
  });
}

// ── Post-navigation intent (set by popup before navigating this tab) ──────
// The popup writes _navIntent into chrome.storage.local before redirecting
// the active tab to a different URL. When the content script loads on the
// new page, it picks up the intent and runs the requested action: focus a
// specific annotation's panel, or open every chip on the page.
function consumeNavIntent() {
  try {
    chrome.storage.local.get({ _navIntent: null }, r => {
      if (chrome.runtime.lastError) {
        if (String(chrome.runtime.lastError.message).includes('Extension context invalidated')) {
          showContextInvalidatedNotice();
          return;
        }
      }
      const intent = r._navIntent;
      if (!intent) return;
      if (intent.expiresAt && Date.now() > intent.expiresAt) {
        try { chrome.storage.local.remove('_navIntent'); } catch {}
        return;
      }
      // Change 18: compare with normalized URL
      if (intent.url) {
        try {
          const u = new URL(intent.url);
          const normIntent = u.origin + u.pathname;
          if (normIntent !== __aiann_pageKey) return;
        } catch (_) {
          if (intent.url !== window.location.href) return;
        }
      }

      // Clear immediately so we don't re-fire on subsequent navigations
      try { chrome.storage.local.remove('_navIntent'); } catch {}

      if (intent.type === 'focusAnnotation' && intent.annId) {
        // Slight delay so all chips are wired up
        setTimeout(() => focusAnnotationOnPage(intent.annId), 200);
      } else if (intent.type === 'openAllForUrl') {
        setTimeout(() => openAllChipsOnPage(), 200);
      }
    });
  } catch (e) {
    if (String(e && e.message).includes('Extension context invalidated')) {
      showContextInvalidatedNotice();
    }
  }
}

function focusAnnotationOnPage(annId) {
  const chip = document.querySelector(`.${ANN}-chip[data-ann-id="${annId}"]`);
  if (!chip) return;
  chip.scrollIntoView({ behavior: 'smooth', block: 'center' });
  openPanel(chip, annId);
  // openPanel already focuses the textarea
}

// Sequentially "click" every chip on this page (so each gets a panel pop).
// Since the panel is a single shared element, opening multiple at once
// would just leave the last one visible. Instead we briefly flash each chip
// and then leave the LAST chip's panel open — matching the user expectation
// of "open all" in a small popup.
function openAllChipsOnPage() {
  const chips = Array.from(document.querySelectorAll(`.${ANN}-chip`));
  if (chips.length === 0) return;

  chips.forEach(chip => {
    chip.style.transition = 'transform 0.15s';
    chip.style.transform  = 'scale(1.25)';
    setTimeout(() => { chip.style.transform = ''; }, 400);

    // Highlight the associated element for non-page chips
    const annId = chip.dataset.annId;
    if (annId) {
      getAll(anns => {
        const ann = anns.find(a => a.id === annId);
        if (ann && !ann.pageLevel && ann.xpath) {
          const el = resolveXPath(ann.xpath);
          if (el) el.classList.add(`${ANN}-hl`);
        }
      });
    }
  });

  // Open the panel for the first chip so the user has somewhere to type
  const firstChip = chips[0];
  if (firstChip && firstChip.dataset.annId) {
    firstChip.scrollIntoView({ behavior: 'smooth', block: 'center' });
    openPanel(firstChip, firstChip.dataset.annId);
  }
}

// ── Change 5: Capture-phase contextmenu listener ─────────────────────────
// Using capture:true so sites like Notion/Figma that call stopPropagation
// in their bubble-phase handlers don't swallow our right-click.
document.addEventListener('contextmenu', e => {
  // Read the cached modifier key (updated from Settings in real-time)
  const mod = (cachedShortcut.modifier || 'alt').toLowerCase();
  const modifierHeld = {
    alt:   e.altKey,
    ctrl:  e.ctrlKey,
    shift: e.shiftKey,
    meta:  e.metaKey,
  }[mod];

  if (!modifierHeld) return; // wrong modifier : let normal context menu proceed
  e.preventDefault();

  const target = e.target;

  // Ignore clicks on our own UI
  if (
    target.closest(`#${ANN}-panel`) ||
    target.classList.contains(`${ANN}-chip`) ||
    target === document.body ||
    target === document.documentElement
  ) return;

  // If already annotated, open existing annotation instead of creating a duplicate
  if (target.classList.contains(`${ANN}-hl`)) {
    const chip = __aiann_chipMap.get(
      [...__aiann_targetMap.entries()].find(([, el]) => el === target)?.[0]
    ) || null;
    if (!chip) {
      // fallback: querySelector (covers page-level chips too)
      let node = target.nextSibling;
      while (node) {
        if (node.classList && node.classList.contains(`${ANN}-chip`)) {
          openPanel(node, node.dataset.annId);
          return;
        }
        node = node.nextSibling;
      }
    } else {
      openPanel(chip, chip.dataset.annId);
      return;
    }
  }

  const classes = typeof target.className === 'string' && target.className.trim()
    ? target.className.trim().split(/\s+/)
        .filter(c => !c.startsWith(ANN))
        .map(c => `.${c}`)
        .join('')
    : '';

  // Change 4: capture up to 240 chars of innerText at annotation creation time
  const ann = {
    id:        genId(),
    url:       __aiann_pageKey,  // Change 18: store only origin + pathname
    tag:       target.tagName.toLowerCase(),
    elId:      target.id || '',
    classes,
    xpath:     getXPath(target),
    comment:   '',
    timestamp: new Date().toISOString(),
    text: (() => {
      try {
        const raw = (target && target.innerText) ? target.innerText : '';
        // Collapse whitespace, trim, hard cap at 240 chars.
        return raw.replace(/\s+/g, ' ').trim().slice(0, 240);
      } catch (_) { return ''; }
    })(),
  };

  getAll(anns => {
    anns.push(ann);
    setAll(anns, () => {
      injectChip(target, ann.id, '');
      const chip = __aiann_chipMap.get(ann.id);
      if (chip) openPanel(chip, ann.id);
    });
  });
}, { capture: true, passive: false });

// ── Message listener (commands from the popup) ─────────────────────────────
try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'removeAnnotation') {
      const { annId, xpath } = msg;
      if (activeAnnId === annId) closePanel();
      removeChip(annId);
      // Only remove element highlight for non-page-level annotations
      if (xpath && xpath !== 'body') {
        const el = resolveXPath(xpath);
        if (el) el.classList.remove(`${ANN}-hl`);
      }
    }

    if (msg.type === 'restoreAnnotation') {
      const ann = msg.ann;
      if (!ann) return;
      if (ann.pageLevel || ann.tag === 'page') {
        injectPageChip(ann.id, ann.comment || '');
      } else if (ann.xpath) {
        const el = resolveXPath(ann.xpath);
        if (el) injectChip(el, ann.id, ann.comment || '');
      }
    }

    if (msg.type === 'focusAnnotation') {
      const { annId } = msg;
      getAll(anns => {
        const ann = anns.find(a => a.id === annId);
        if (!ann) return;

        // Find and open the chip panel
        const chip = document.querySelector(`.${ANN}-chip[data-ann-id="${annId}"]`);
        if (chip) {
          chip.scrollIntoView({ behavior: 'smooth', block: 'center' });
          openPanel(chip, annId);
        }

        // Also flash + scroll to the annotated element itself
        if (!ann.pageLevel && ann.xpath && ann.xpath !== 'body') {
          const el = resolveXPath(ann.xpath);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const prevOutline     = el.style.outline;
            const prevTransition  = el.style.transition;
            el.style.transition   = 'outline 0.15s';
            el.style.outline      = '3px solid #f59e0b';
            setTimeout(() => {
              el.style.outline    = prevOutline;
              el.style.transition = prevTransition;
            }, 2000);
          }
        }
      });
    }

    if (msg.type === 'openAllAnnotations') {
      openAllChipsOnPage();
    }
  });
} catch (e) {
  if (String(e && e.message).includes('Extension context invalidated')) {
    showContextInvalidatedNotice();
  }
}

// ── Change 7: SPA navigation tracking ────────────────────────────────────
// Many target sites (Notion, GitHub, Linear) are SPAs that change
// location.href via history.pushState/replaceState without a real navigation.
(function installNavListener() {
  if (window.__aiann_navInstalled) return;
  window.__aiann_navInstalled = true;

  let lastUrl = location.href;
  const onUrlChange = () => {
    const nowUrl = location.href;
    if (nowUrl === lastUrl) return;
    lastUrl = nowUrl;
    // Tear down chips for previous URL, reload for new URL.
    try {
      __aiann_chipMap.forEach((_chip, id) => removeChip(id));
    } catch (_) {}
    // Reload annotations for the new URL
    restoreAnnotations();
  };

  window.addEventListener('popstate',   onUrlChange);
  window.addEventListener('hashchange', onUrlChange);
  const _ps = history.pushState;
  const _rs = history.replaceState;
  history.pushState    = function () { const r = _ps.apply(this, arguments); onUrlChange(); return r; };
  history.replaceState = function () { const r = _rs.apply(this, arguments); onUrlChange(); return r; };
})();

// ── Init ──────────────────────────────────────────────────────────────────
injectStyles();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', restoreAnnotations);
} else {
  restoreAnnotations();
}
