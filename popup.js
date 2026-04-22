// popup.js

// ─────────────────────────────────────────────────────────────────────────────
// DEV MODE & PREMIUM SYSTEM
//
// DEV_MODE: set to `true` during development to unlock all premium features.
// When publishing, set this to `false` and wire `isPremium()` to your actual
// subscription / entitlement check.
//
// Features marked with [PREMIUM FEATURE] throughout this file are gated behind
// `isPremium()`. Non-premium users can see the UI but cannot interact with it.
// ─────────────────────────────────────────────────────────────────────────────
const DEV_MODE = true; // [DEV] Toggle — defaults to true; set false to enforce premium gates

function isPremium() {
  // In dev mode every user gets full premium access.
  // Replace with a real entitlement check before publishing.
  return DEV_MODE;
}

// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const listEl      = document.getElementById('annotations-list');
  const historyEl   = document.getElementById('history-panel');
  const settingsEl  = document.getElementById('settings-panel');
  const badge       = document.getElementById('count-badge');
  const copyBtn     = document.getElementById('copy-btn');
  const clearBtn    = document.getElementById('clear-btn');
  const historyBtn  = document.getElementById('history-btn');
  const settingsBtn = document.getElementById('settings-btn');
  const footer      = document.querySelector('.footer');

  const HISTORY_KEY      = 'annotationHistory';
  const COPY_HISTORY_KEY = 'copyHistory';       // records each "copy all as markdown" click
  const SETTINGS_KEY     = 'annotatorSettings';

  let historyVisible  = false;
  let settingsVisible = false;
  let historyTab      = 'annotations'; // 'annotations' | 'copies'

  // Prevent storage.onChanged from triggering a re-render when the popup itself
  // is the one writing (avoids textarea cursor-position resets).
  let isWritingFromPopup = false;

  // ── Settings defaults ────────────────────────────────────────────────────
  const DEFAULT_SETTINGS = {
    prependText: '', // [PREMIUM FEATURE] prepended to "copy all as markdown" output
    appendText:  '', // [PREMIUM FEATURE] appended  to "copy all as markdown" output
    darkMode:    false, // [PREMIUM FEATURE] dark / light theme toggle
  };

  function loadSettings(cb) {
    chrome.storage.local.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS }, r => {
      cb({ ...DEFAULT_SETTINGS, ...r[SETTINGS_KEY] });
    });
  }

  function saveSettings(patch, cb) {
    loadSettings(current => {
      const updated = { ...current, ...patch };
      chrome.storage.local.set({ [SETTINGS_KEY]: updated }, () => {
        if (cb) cb(updated);
      });
    });
  }

  // ── Dark mode ─────────────────────────────────────────────────────────────
  // [PREMIUM FEATURE] Applies the chosen theme to the popup body.
  function applyDarkMode(enabled) {
    document.body.dataset.theme = enabled ? 'dark' : 'light';
  }

  // Apply dark mode as early as possible to avoid a flash
  loadSettings(s => applyDarkMode(s.darkMode));

  // ── Helpers ───────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s ?? '')
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Builds a compact CSS-selector-style string for an annotation.
   * Handles both the old storage format (id field = '#foo' or 'N/A')
   * and the new format (elId field = raw id string).
   */
  function getSelector(ann) {
    const rawId = ann.elId !== undefined
      ? (ann.elId ? `#${ann.elId}` : '')         // new format
      : (ann.id && ann.id !== 'N/A' && !ann.id.startsWith('ann_')
          ? ann.id                                // old format: already has # prefix
          : '');
    const cls = ann.classes && ann.classes !== 'N/A' ? ann.classes : '';
    return `${ann.tag}${rawId}${cls}`;
  }

  function formatTimestamp(ts) {
    if (!ts) return '';
    try { return new Date(ts).toLocaleString(); } catch { return ts; }
  }

  // ── Save a single annotation's comment from the popup ─────────────────────
  const saveTimers = {};
  function saveComment(annId, value) {
    clearTimeout(saveTimers[annId]);
    saveTimers[annId] = setTimeout(() => {
      isWritingFromPopup = true;
      chrome.storage.local.get({ annotations: [] }, r => {
        const anns = r.annotations;
        const ann = anns.find(a => a.id === annId);
        if (ann) {
          ann.comment = value;
          chrome.storage.local.set({ annotations: anns }, () => {
            isWritingFromPopup = false;
          });
        } else {
          isWritingFromPopup = false;
        }
      });
    }, 350);
  }

  // ── Delete a single annotation (moves it to history) ──────────────────────
  function deleteAnnotation(annId) {
    isWritingFromPopup = true;
    chrome.storage.local.get({ annotations: [], [HISTORY_KEY]: [] }, r => {
      const anns = r.annotations;
      const hist = r[HISTORY_KEY];
      const ann  = anns.find(a => a.id === annId);
      if (ann) hist.push({ ...ann, deletedAt: new Date().toISOString() });
      const remaining = anns.filter(a => a.id !== annId);
      chrome.storage.local.set({ annotations: remaining, [HISTORY_KEY]: hist }, () => {
        isWritingFromPopup = false;
        render(remaining);
        if (ann) {
          chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
            if (tabs[0]) {
              chrome.tabs.sendMessage(tabs[0].id, {
                type: 'removeAnnotation',
                annId,
                xpath: ann.xpath,
              }).catch(() => {});
            }
          });
        }
      });
    });
  }

  // ── Restore a history entry back into current annotations ──────────────────
  function restoreAnnotation(annId, deletedAt) {
    chrome.storage.local.get({ annotations: [], [HISTORY_KEY]: [] }, r => {
      const anns    = r.annotations;
      const hist    = r[HISTORY_KEY];
      const histIdx = hist.findIndex(a => a.id === annId && a.deletedAt === deletedAt);
      if (histIdx === -1) return;

      const ann = { ...hist[histIdx] };
      delete ann.deletedAt;

      if (anns.some(a => a.id === ann.id)) { showHistory(); return; }

      const newAnns = [...anns, ann];
      const newHist = hist.filter((_, i) => i !== histIdx);

      chrome.storage.local.set({ annotations: newAnns, [HISTORY_KEY]: newHist }, () => {
        showHistory();
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
          if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, { type: 'restoreAnnotation', ann }).catch(() => {});
          }
        });
      });
    });
  }

  // ── Render annotation list ─────────────────────────────────────────────────
  function render(anns) {
    badge.textContent = anns.length > 0 ? String(anns.length) : '';

    if (anns.length === 0) {
      listEl.innerHTML = `
        <p class="empty-msg">
          No annotations yet.<br>
          Hold <strong>Alt + Right-Click</strong> any element on a page.
        </p>`;
      return;
    }

    // Group by URL
    const byUrl = {};
    anns.forEach(ann => (byUrl[ann.url] = byUrl[ann.url] || []).push(ann));

    let html = '';
    Object.entries(byUrl).forEach(([url, items]) => {
      html += `<div class="url-group">
        <div class="url-label" title="${escHtml(url)}">${escHtml(url)}</div>`;
      items.forEach(ann => {
        const sel = getSelector(ann);
        html += `
        <div class="item">
          <div class="item-sel">
            <code>${escHtml(sel)}</code>
            <button class="item-delete-btn" data-ann-id="${escHtml(ann.id)}" title="Delete annotation">✕</button>
          </div>
          <textarea
            class="item-note-edit"
            data-ann-id="${escHtml(ann.id)}"
            placeholder="Add a note…"
            rows="2"
          >${escHtml(ann.comment || '')}</textarea>
        </div>`;
      });
      html += '</div>';
    });

    listEl.innerHTML = html;

    listEl.querySelectorAll('.item-note-edit').forEach(ta => {
      ta.addEventListener('input', () => saveComment(ta.dataset.annId, ta.value));
    });
    listEl.querySelectorAll('.item-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => deleteAnnotation(btn.dataset.annId));
    });
  }

  function load() {
    chrome.storage.local.get({ annotations: [] }, r => render(r.annotations));
  }

  // Refresh popup in real-time when storage changes (e.g. user annotating on the page),
  // but skip re-renders triggered by the popup's own writes to avoid cursor resets.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.annotations && !isWritingFromPopup && !historyVisible && !settingsVisible) {
      render(changes.annotations.newValue || []);
    }
  });

  // ── History panel ──────────────────────────────────────────────────────────
  function showHistory() {
    historyVisible  = true;
    settingsVisible = false;
    listEl.style.display      = 'none';
    footer.style.display      = 'none';
    settingsEl.style.display  = 'none';
    historyEl.style.display   = 'block';
    settingsBtn.textContent   = '⚙';
    settingsBtn.title         = 'Settings';
    settingsBtn.classList.remove('active');
    historyBtn.textContent    = '✕';
    historyBtn.title          = 'Close history';
    renderHistoryTab();
  }

  function renderHistoryTab() {
    if (historyTab === 'annotations') renderAnnotationHistory();
    else renderCopyHistory();
  }

  // Tab markup — shared by both history sub-views
  function historyTabsHTML(active) {
    return `
      <div class="hist-tabs">
        <button class="hist-tab${active === 'annotations' ? ' active' : ''}" data-tab="annotations">Annotations</button>
        <button class="hist-tab${active === 'copies'      ? ' active' : ''}" data-tab="copies">Copy Log</button>
      </div>`;
  }

  function attachTabListeners() {
    historyEl.querySelectorAll('.hist-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        historyTab = btn.dataset.tab;
        renderHistoryTab();
      });
    });
  }

  // Sub-view 1: deleted annotation records
  function renderAnnotationHistory() {
    chrome.storage.local.get({ [HISTORY_KEY]: [] }, r => {
      const hist = r[HISTORY_KEY];
      if (hist.length === 0) {
        historyEl.innerHTML = historyTabsHTML('annotations') +
          `<p class="empty-msg">No annotation history yet.<br>Deleted annotations will appear here.</p>`;
        attachTabListeners();
        return;
      }

      const sorted = [...hist].reverse();
      const byUrl  = {};
      sorted.forEach(ann => (byUrl[ann.url] = byUrl[ann.url] || []).push(ann));

      let html = historyTabsHTML('annotations');
      Object.entries(byUrl).forEach(([url, items]) => {
        html += `<div class="url-group">
          <div class="url-label" title="${escHtml(url)}">${escHtml(url)}</div>`;
        items.forEach(ann => {
          const sel = getSelector(ann);
          html += `
          <div class="item hist-item">
            <div class="item-sel">
              <code>${escHtml(sel)}</code>
              <button class="hist-restore-btn"
                data-ann-id="${escHtml(ann.id)}"
                data-deleted-at="${escHtml(ann.deletedAt || '')}"
                title="Restore annotation">+</button>
            </div>
            <div class="hist-meta">
              <span class="hist-ts">📅 ${escHtml(formatTimestamp(ann.timestamp))}</span>
              <span class="hist-ts hist-deleted">🗑 ${escHtml(formatTimestamp(ann.deletedAt))}</span>
            </div>
            ${ann.comment
              ? `<div class="hist-note">${escHtml(ann.comment)}</div>`
              : `<div class="hist-note empty-note">(no note)</div>`}
          </div>`;
        });
        html += '</div>';
      });

      historyEl.innerHTML = html;
      attachTabListeners();
      historyEl.querySelectorAll('.hist-restore-btn').forEach(btn => {
        btn.addEventListener('click', () => restoreAnnotation(btn.dataset.annId, btn.dataset.deletedAt));
      });
    });
  }

  // Sub-view 2: log of every "copy all as markdown" click
  function renderCopyHistory() {
    chrome.storage.local.get({ [COPY_HISTORY_KEY]: [] }, r => {
      const copyHist = r[COPY_HISTORY_KEY];
      if (copyHist.length === 0) {
        historyEl.innerHTML = historyTabsHTML('copies') +
          `<p class="empty-msg">No copy history yet.<br>Click "Copy All as Markdown" to record an output here.</p>`;
        attachTabListeners();
        return;
      }

      let html = historyTabsHTML('copies');
      [...copyHist].reverse().forEach(entry => {
        html += `
        <div class="item copy-hist-item">
          <div class="copy-hist-header">
            <span class="hist-ts">📋 ${escHtml(formatTimestamp(entry.timestamp))}</span>
            <span class="copy-hist-count">${entry.count} annotation${entry.count !== 1 ? 's' : ''}</span>
          </div>
          <div class="copy-hist-preview">${escHtml(entry.output)}</div>
        </div>`;
      });

      historyEl.innerHTML = html;
      attachTabListeners();
    });
  }

  function hideHistory() {
    historyVisible = false;
    historyEl.style.display = 'none';
    footer.style.display    = '';
    listEl.style.display    = '';
    historyBtn.textContent  = '🕐';
    historyBtn.title        = 'View annotation history';
    load();
  }

  historyBtn.addEventListener('click', () => {
    if (historyVisible) hideHistory();
    else showHistory();
  });

  // ── Settings panel ─────────────────────────────────────────────────────────
  function showSettings() {
    settingsVisible = true;
    historyVisible  = false;
    listEl.style.display      = 'none';
    footer.style.display      = 'none';
    historyEl.style.display   = 'none';
    historyBtn.textContent    = '🕐';
    historyBtn.title          = 'View annotation history';
    settingsEl.style.display  = 'block';
    settingsBtn.textContent   = '✕';
    settingsBtn.title         = 'Close settings';
    settingsBtn.classList.add('active');
    renderSettings();
  }

  function hideSettings() {
    settingsVisible = false;
    settingsEl.style.display = 'none';
    footer.style.display     = '';
    listEl.style.display     = '';
    settingsBtn.textContent  = '⚙';
    settingsBtn.title        = 'Settings';
    settingsBtn.classList.remove('active');
    load();
  }

  function renderSettings() {
    const premium = isPremium();

    loadSettings(s => {
      settingsEl.innerHTML = `
        <!-- ── General ── -->
        <div class="settings-section">
          <div class="settings-section-title">General</div>
          <div class="settings-row">
            <span class="settings-label">Dev Mode</span>
            <span class="settings-value dev-mode-badge${DEV_MODE ? ' dev-mode-on' : ''}">${DEV_MODE ? 'ON' : 'OFF'}</span>
          </div>
          <div class="settings-row">
            <span class="settings-label">Premium Access</span>
            <span class="settings-value">${premium ? '✅ Active' : '🔒 Not active'}</span>
          </div>
        </div>

        <!-- ── Appearance (PREMIUM FEATURE) ── -->
        <div class="settings-section">
          <div class="settings-section-title">
            Appearance
            ${!premium ? '<span class="premium-badge">⭐ Premium</span>' : ''}
          </div>
          <div class="settings-row settings-row--toggle">
            <span class="settings-label">
              Dark Mode
              ${!premium ? '<span class="lock-icon" title="Upgrade to Premium to unlock">🔒</span>' : ''}
            </span>
            <div class="toggle-wrap${!premium ? ' premium-locked' : ''}">
              <label class="toggle-switch">
                <input type="checkbox" id="dark-mode-toggle" ${s.darkMode ? 'checked' : ''} ${!premium ? 'disabled' : ''}>
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>
        </div>

        <!-- ── Markdown Copy (PREMIUM FEATURE) ── -->
        <div class="settings-section">
          <div class="settings-section-title">
            Markdown Copy
            ${!premium ? '<span class="premium-badge">⭐ Premium</span>' : ''}
          </div>
          <div class="settings-field">
            <label class="settings-label" for="prepend-text">
              Prepend Text
              ${!premium ? '<span class="lock-icon" title="Upgrade to Premium to unlock">🔒</span>' : ''}
            </label>
            <textarea
              id="prepend-text"
              class="settings-textarea${!premium ? ' premium-locked' : ''}"
              placeholder="Text added before the markdown output…"
              ${!premium ? 'disabled' : ''}
            >${escHtml(s.prependText || '')}</textarea>
          </div>
          <div class="settings-field">
            <label class="settings-label" for="append-text">
              Append Text
              ${!premium ? '<span class="lock-icon" title="Upgrade to Premium to unlock">🔒</span>' : ''}
            </label>
            <textarea
              id="append-text"
              class="settings-textarea${!premium ? ' premium-locked' : ''}"
              placeholder="Text added after the markdown output…"
              ${!premium ? 'disabled' : ''}
            >${escHtml(s.appendText || '')}</textarea>
          </div>
        </div>
      `;

      if (premium) {
        // [PREMIUM FEATURE] Dark mode toggle — saves in real-time
        const darkToggle = settingsEl.querySelector('#dark-mode-toggle');
        darkToggle.addEventListener('change', () => {
          saveSettings({ darkMode: darkToggle.checked }, updated => applyDarkMode(updated.darkMode));
        });

        // [PREMIUM FEATURE] Prepend / append text — saves in real-time (350ms debounce)
        let prependTimer, appendTimer;
        const prependTa = settingsEl.querySelector('#prepend-text');
        const appendTa  = settingsEl.querySelector('#append-text');

        prependTa.addEventListener('input', () => {
          clearTimeout(prependTimer);
          prependTimer = setTimeout(() => saveSettings({ prependText: prependTa.value }), 350);
        });
        appendTa.addEventListener('input', () => {
          clearTimeout(appendTimer);
          appendTimer = setTimeout(() => saveSettings({ appendText: appendTa.value }), 350);
        });
      }
    });
  }

  settingsBtn.addEventListener('click', () => {
    if (settingsVisible) hideSettings();
    else showSettings();
  });

  // ── Dense Markdown copy ────────────────────────────────────────────────────
  // Format: one line per annotation, grouped by URL.
  // Excludes: timestamps, verbose labels, redundant fields.
  // Keeps: URL (as section header), CSS selector, XPath (for element targeting), note.
  copyBtn.addEventListener('click', () => {
    chrome.storage.local.get({ annotations: [], [COPY_HISTORY_KEY]: [] }, r => {
      // Only include annotations that have a non-empty note
      const anns = r.annotations.filter(a => a.comment && a.comment.trim());

      if (anns.length === 0) {
        alert('No annotations with notes to copy yet.');
        return;
      }

      // Group by URL
      const byUrl = {};
      anns.forEach(ann => (byUrl[ann.url] = byUrl[ann.url] || []).push(ann));
      const urls = Object.keys(byUrl);

      let md = '';
      if (urls.length === 1) {
        md += `## ${urls[0]}\n`;
        byUrl[urls[0]].forEach((ann, i) => { md += formatLine(i + 1, ann); });
      } else {
        urls.forEach((url, ui) => {
          if (ui > 0) md += '\n';
          md += `### ${url}\n`;
          byUrl[url].forEach((ann, i) => { md += formatLine(i + 1, ann); });
        });
      }

      // [PREMIUM FEATURE] Apply prepend / append text from settings
      loadSettings(s => {
        let finalMd = md.trim();
        if (isPremium()) {
          if (s.prependText && s.prependText.trim()) {
            finalMd = s.prependText.trim() + '\n\n' + finalMd;
          }
          if (s.appendText && s.appendText.trim()) {
            finalMd = finalMd + '\n\n' + s.appendText.trim();
          }
        }

        navigator.clipboard.writeText(finalMd).then(() => {
          // Record this copy event in history
          const copyHist = r[COPY_HISTORY_KEY];
          copyHist.push({
            timestamp: new Date().toISOString(),
            output:    finalMd,
            count:     anns.length,
          });
          chrome.storage.local.set({ [COPY_HISTORY_KEY]: copyHist });

          const orig = copyBtn.textContent;
          copyBtn.textContent = '✅ Copied!';
          setTimeout(() => (copyBtn.textContent = orig), 1500);
        }).catch(() => alert('Clipboard write failed. Try again.'));
      });
    });
  });

  /**
   * Formats one annotation as a single dense line.
   *
   * If the element has an ID, the XPath is redundant (XPath would be
   * `id("foo")` anyway), so just emit the CSS selector.
   * Otherwise emit: `selector | xpath → note`
   */
  function formatLine(n, ann) {
    const sel   = getSelector(ann);
    const hasId = ann.elId
      ? !!ann.elId
      : (ann.id && ann.id !== 'N/A' && !ann.id.startsWith('ann_'));
    if (hasId) return `${n}. \`${sel}\` → ${ann.comment.trim()}\n`;
    return `${n}. \`${sel}\` | \`${ann.xpath}\` → ${ann.comment.trim()}\n`;
  }

  // ── Clear All (moves all annotations to history) ───────────────────────────
  clearBtn.addEventListener('click', () => {
    if (confirm('Clear all annotations? They will be saved to history.')) {
      chrome.storage.local.get({ annotations: [], [HISTORY_KEY]: [] }, r => {
        const anns = r.annotations;
        const hist = r[HISTORY_KEY];
        const now  = new Date().toISOString();
        anns.forEach(ann => hist.push({ ...ann, deletedAt: now }));
        isWritingFromPopup = true;
        chrome.storage.local.set({ annotations: [], [HISTORY_KEY]: hist }, () => {
          isWritingFromPopup = false;
          load();
        });
      });
    }
  });

  load();
});
