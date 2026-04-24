// popup.js : Website Dev Annotator

// ─────────────────────────────────────────────────────────────────────────────
// DEV MODE
// Set DEV_MODE = true in your *local* copy to unlock all premium features
// during development. Never commit with DEV_MODE = true : it bypasses all
// license checks and exposes the dev-only UI.
// ─────────────────────────────────────────────────────────────────────────────
const DEV_MODE = false;

// ─────────────────────────────────────────────────────────────────────────────
// PREMIUM / LICENSE SYSTEM (Gumroad)
//
// SETUP : one-time steps before publishing:
//   1. Create a free Gumroad account → https://gumroad.com
//   2. Create a product ("Website Dev Annotator Premium"), enable "Generate a
//      unique license key" in product settings, and set your price.
//   3. Replace GUMROAD_PRODUCT_PERMALINK with the slug at the end of your
//      product URL (e.g. for gumroad.com/l/websiteDevAnnotator → use
//      "websiteDevAnnotator").
//   4. Replace PREMIUM_PURCHASE_URL with your full product URL.
//
// Flow: user purchases → Gumroad emails them a license key → they paste it
// in Settings → Premium → extension validates via Gumroad's public API →
// result cached in chrome.storage.local.
// ─────────────────────────────────────────────────────────────────────────────
const GUMROAD_PRODUCT_PERMALINK = 'websiteDevAnnotator';
const PREMIUM_PURCHASE_URL      = 'https://arjunsharma10.gumroad.com/l/websiteDevAnnotator';

const LICENSE_STORAGE_KEY = 'license';

// Free-tier history caps (premium = unlimited)
const FREE_ANNOTATION_HISTORY_LIMIT = 30;
const FREE_COPY_HISTORY_LIMIT       = 10;

// Human-readable labels for each modifier key
const MODIFIER_LABELS = {
  alt:   'Alt',
  ctrl:  'Ctrl',
  shift: 'Shift',
  meta:  'Meta / ⌘ Cmd',
};

// ─── Cached premium status ────────────────────────────────────────────────────
let _premium = DEV_MODE;

function isPremium() {
  return _premium;
}

async function refreshPremiumStatus() {
  if (DEV_MODE) { _premium = true; return; }
  return new Promise(resolve => {
    chrome.storage.local.get({ [LICENSE_STORAGE_KEY]: null }, r => {
      const lic = r[LICENSE_STORAGE_KEY];
      _premium = !!(lic && lic.valid === true);
      resolve(_premium);
    });
  });
}

// ─── Gumroad license validation ───────────────────────────────────────────────
async function validateLicenseWithGumroad(key) {
  if (!GUMROAD_PRODUCT_PERMALINK) {
    return { valid: false, email: '', error: 'Premium purchases are not yet live. Check back soon!' };
  }
  try {
    const resp = await fetch('https://api.gumroad.com/v2/licenses/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        product_permalink:    GUMROAD_PRODUCT_PERMALINK,
        license_key:          key.trim(),
        increment_uses_count: 'false',
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.success && !data.purchase?.refunded) {
      return { valid: true, email: data.purchase?.email || '' };
    }
    return { valid: false, email: '', error: data.message || 'Invalid license key.' };
  } catch {
    return { valid: false, email: '', error: 'Could not reach the license server. Check your internet and try again.' };
  }
}

async function activateLicense(key) {
  const result = await validateLicenseWithGumroad(key);
  if (result.valid) {
    await new Promise(resolve => {
      chrome.storage.local.set({
        [LICENSE_STORAGE_KEY]: {
          valid:       true,
          key:         key.trim(),
          email:       result.email,
          activatedAt: new Date().toISOString(),
        },
      }, resolve);
    });
    _premium = true;
  }
  return result;
}

async function deactivateLicense() {
  await new Promise(resolve => chrome.storage.local.remove(LICENSE_STORAGE_KEY, resolve));
  _premium = false;
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
  const searchBtn     = document.getElementById('search-btn');
  const searchBar     = document.getElementById('search-bar');
  const searchInput   = document.getElementById('search-input');
  const searchCount   = document.getElementById('search-count');
  const restoreBanner = document.getElementById('restore-banner');
  const footer        = document.querySelector('.footer');

  const HISTORY_KEY      = 'annotationHistory';
  const COPY_HISTORY_KEY = 'copyHistory';
  const SETTINGS_KEY     = 'annotatorSettings';
  const SYNC_PREFIX      = 'ann_sync_';
  const SYNC_CHUNK_SIZE  = 7000;

  let historyVisible  = false;
  let settingsVisible = false;
  let historyTab      = 'annotations'; // 'annotations' | 'copies'
  let isWritingFromPopup = false;

  // ── Search state ──────────────────────────────────────────────────────────
  let searchActive     = false;
  let searchMatches    = [];
  let searchCurrentIdx = 0;

  // ── Sync backup state ─────────────────────────────────────────────────────
  let syncBackupTimer = null;

  // ── Sync backup helpers ──────────────────────────────────────────────────
  // Mirrors the current annotations array into chrome.storage.sync so data
  // survives an extension uninstall as long as Chrome is signed in.
  function backupToSync(annotations) {
    clearTimeout(syncBackupTimer);
    syncBackupTimer = setTimeout(() => {
      try {
        const json   = JSON.stringify(annotations || []);
        const chunks = [];
        for (let i = 0; i < json.length; i += SYNC_CHUNK_SIZE)
          chunks.push(json.slice(i, i + SYNC_CHUNK_SIZE));

        chrome.storage.sync.get(null, existing => {
          const staleKeys = Object.keys(existing).filter(k => k.startsWith(SYNC_PREFIX));
          const clear = staleKeys.length
            ? new Promise(res => chrome.storage.sync.remove(staleKeys, res))
            : Promise.resolve();

          clear.then(() => {
            const data = {
              [`${SYNC_PREFIX}count`]: chunks.length,
              [`${SYNC_PREFIX}ts`]:    new Date().toISOString(),
            };
            chunks.forEach((c, i) => { data[`${SYNC_PREFIX}${i}`] = c; });
            chrome.storage.sync.set(data).then(() => {
              chrome.storage.local.set({ _lastSyncBackup: new Date().toISOString(), _syncBackupError: null });
            }).catch(err => {
              chrome.storage.local.set({ _syncBackupError: 'Quota exceeded — data may be too large for free sync storage.' });
              console.warn('[Annotator] Sync backup quota:', err.message);
            });
          });
        });
      } catch (e) {
        console.warn('[Annotator] Sync backup error:', e);
      }
    }, 2000); // 2-second debounce
  }

  function readFromSync(cb) {
    chrome.storage.sync.get(null, sync => {
      const count = sync[`${SYNC_PREFIX}count`];
      const ts    = sync[`${SYNC_PREFIX}ts`];
      if (!count || count === 0) { cb(null, null); return; }
      let json = '';
      for (let i = 0; i < count; i++) json += sync[`${SYNC_PREFIX}${i}`] || '';
      try {
        const anns = JSON.parse(json);
        cb(Array.isArray(anns) ? anns : null, ts);
      } catch { cb(null, null); }
    });
  }

  // ── Settings defaults ────────────────────────────────────────────────────
  const DEFAULT_SETTINGS = {
    shortcut:         { modifier: 'alt' }, // free: customizable annotation trigger
    prependText:      '',                  // [PREMIUM] prepended to markdown output
    appendText:       '',                  // [PREMIUM] appended  to markdown output
    darkMode:         false,               // [PREMIUM] dark / light theme toggle
    maxHistoryLength: 100,                 // 0 = indefinite
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
  function applyDarkMode(enabled) {
    document.body.dataset.theme = enabled ? 'dark' : 'light';
  }

  loadSettings(s => applyDarkMode(s.darkMode));

  // ── Helpers ───────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s ?? '')
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getSelector(ann) {
    // Page-level annotation
    if (ann.pageLevel || ann.tag === 'page') return '(whole page)';
    const rawId = ann.elId !== undefined
      ? (ann.elId ? `#${ann.elId}` : '')
      : (ann.id && ann.id !== 'N/A' && !ann.id.startsWith('ann_') ? ann.id : '');
    const cls = ann.classes && ann.classes !== 'N/A' ? ann.classes : '';
    return `${ann.tag}${rawId}${cls}`;
  }

  function formatTimestamp(ts) {
    if (!ts) return '';
    try { return new Date(ts).toLocaleString(); } catch { return ts; }
  }

  function modLabel(mod) {
    return MODIFIER_LABELS[mod] || 'Alt';
  }

  // ── Enforce history length limit ──────────────────────────────────────────
  function enforceHistoryLimitInStorage(cb) {
    loadSettings(s => {
      const maxLen = (s.maxHistoryLength !== undefined && s.maxHistoryLength !== null)
        ? s.maxHistoryLength : 100;
      if (maxLen <= 0) { if (cb) cb(); return; } // 0 = indefinite
      chrome.storage.local.get({ [HISTORY_KEY]: [] }, r => {
        const hist = r[HISTORY_KEY];
        if (hist.length <= maxLen) { if (cb) cb(); return; }
        const trimmed = hist.slice(-maxLen); // keep newest
        chrome.storage.local.set({ [HISTORY_KEY]: trimmed }, cb);
      });
    });
  }

  // ── Save a single annotation's comment ────────────────────────────────────
  const saveTimers = {};
  function saveComment(annId, value) {
    clearTimeout(saveTimers[annId]);
    saveTimers[annId] = setTimeout(() => {
      isWritingFromPopup = true;
      chrome.storage.local.get({ annotations: [] }, r => {
        const anns = r.annotations;
        const ann  = anns.find(a => a.id === annId);
        if (ann) {
          ann.comment = value;
          chrome.storage.local.set({ annotations: anns }, () => { isWritingFromPopup = false; });
        } else {
          isWritingFromPopup = false;
        }
      });
    }, 350);
  }

  // ── Delete a single annotation ────────────────────────────────────────────
  function deleteAnnotation(annId) {
    isWritingFromPopup = true;
    chrome.storage.local.get({ annotations: [], [HISTORY_KEY]: [] }, r => {
      const anns = r.annotations;
      const hist = r[HISTORY_KEY];
      const ann  = anns.find(a => a.id === annId);
      if (ann) hist.push({ ...ann, deletedAt: new Date().toISOString() });
      const remaining = anns.filter(a => a.id !== annId);
      chrome.storage.local.set({ annotations: remaining, [HISTORY_KEY]: hist }, () => {
        enforceHistoryLimitInStorage(() => {
          isWritingFromPopup = false;
          render(remaining);
          if (ann) {
            chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
              if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'removeAnnotation', annId, xpath: ann.xpath }).catch(() => {});
            });
          }
        });
      });
    });
  }

  // ── Copy a single group's annotations as Markdown ─────────────────────────
  function copyGroup(url) {
    chrome.storage.local.get({ annotations: [] }, r => {
      const anns = r.annotations.filter(a => a.url === url && a.comment && a.comment.trim());
      if (anns.length === 0) {
        alert('No annotations with notes in this group.');
        return;
      }
      let md = `## ${url}\n`;
      anns.forEach((ann, i) => { md += formatLine(i + 1, ann); });
      navigator.clipboard.writeText(md.trim()).then(() => {
        // Escape URL for use in querySelector attribute selector
        const safeUrl = url.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const btn = listEl.querySelector(`.url-copy-btn[data-url="${safeUrl}"]`);
        if (btn) {
          const orig = btn.textContent;
          btn.textContent = '✅';
          setTimeout(() => (btn.textContent = orig), 1500);
        }
      }).catch(() => alert('Clipboard write failed. Try again.'));
    });
  }

  // ── Copy a single annotation as Markdown ──────────────────────────────────
  function copyAnnotation(annId) {
    chrome.storage.local.get({ annotations: [] }, r => {
      const ann = r.annotations.find(a => a.id === annId);
      if (!ann) return;
      const line = formatLine(1, ann).trim();
      navigator.clipboard.writeText(line).then(() => {
        const btn = listEl.querySelector(`.item-copy-btn[data-ann-id="${annId}"]`);
        if (btn) {
          const orig = btn.textContent;
          btn.textContent = '✅';
          setTimeout(() => (btn.textContent = orig), 1500);
        }
      }).catch(() => alert('Clipboard write failed. Try again.'));
    });
  }

  // ── Restore a history entry ────────────────────────────────────────────────
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
          if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'restoreAnnotation', ann }).catch(() => {});
        });
      });
    });
  }

  // ── Render annotation list ─────────────────────────────────────────────────
  function render(anns) {
    badge.textContent = anns.length > 0 ? String(anns.length) : '';

    if (anns.length === 0) {
      // Read current shortcut to show the right gesture in the empty-state hint
      loadSettings(s => {
        const mod = modLabel(s.shortcut?.modifier || 'alt');
        listEl.innerHTML = `
          <p class="empty-msg">
            No annotations yet.<br>
            Hold <strong>${escHtml(mod)} + Right-Click</strong> any element on a page.
          </p>`;
      });
      return;
    }

    const byUrl = {};
    anns.forEach(ann => (byUrl[ann.url] = byUrl[ann.url] || []).push(ann));

    let html = '';
    Object.entries(byUrl).forEach(([url, items]) => {
      html += `<div class="url-group">
        <div class="url-header">
          <div class="url-label" title="${escHtml(url)}">${escHtml(url)}</div>
          <button class="url-copy-btn" data-url="${escHtml(url)}" title="Copy group as Markdown">📋</button>
        </div>`;
      items.forEach(ann => {
        const sel = getSelector(ann);
        const isPageLevel = !!(ann.pageLevel || ann.tag === 'page');
        html += `
        <div class="item${isPageLevel ? ' item--page-level' : ''}">
          <div class="item-sel">
            <code>${escHtml(sel)}</code>
            <button class="item-copy-btn" data-ann-id="${escHtml(ann.id)}" title="Copy this annotation">📋</button>
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
    listEl.querySelectorAll('.url-copy-btn').forEach(btn => {
      btn.addEventListener('click', () => copyGroup(btn.dataset.url));
    });
    listEl.querySelectorAll('.item-copy-btn').forEach(btn => {
      btn.addEventListener('click', () => copyAnnotation(btn.dataset.annId));
    });

    // Re-apply search highlights if search is active
    if (searchActive && searchInput && searchInput.value.trim()) {
      applySearch(searchInput.value.trim());
    }
  }

  function load() {
    chrome.storage.local.get({ annotations: [] }, r => render(r.annotations));
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.annotations) {
      const newAnns = changes.annotations.newValue || [];
      // Always keep sync in step with local — this is the real-time backup
      backupToSync(newAnns);
      if (!isWritingFromPopup && !historyVisible && !settingsVisible) {
        render(newAnns);
      }
    }
  });

  // ── Sync restore banner ───────────────────────────────────────────────────
  function checkSyncRestore() {
    chrome.storage.local.get({ annotations: [] }, local => {
      if (local.annotations.length > 0) return; // local has data — no restore needed
      readFromSync((anns, ts) => {
        if (!anns || anns.length === 0) return;
        showRestoreBanner(anns, ts);
      });
    });
  }

  function showRestoreBanner(annotations, ts) {
    if (!restoreBanner) return;
    const when = ts ? new Date(ts).toLocaleString() : 'unknown time';
    restoreBanner.innerHTML = `
      <div class="restore-banner-text">
        ☁ Sync backup found — <strong>${annotations.length}</strong> annotation${annotations.length !== 1 ? 's' : ''} from ${escHtml(when)}
      </div>
      <div class="restore-banner-actions">
        <button id="restore-confirm-btn" class="restore-btn restore-btn--confirm">Restore</button>
        <button id="restore-dismiss-btn" class="restore-btn restore-btn--dismiss">Dismiss</button>
      </div>`;
    restoreBanner.style.display = 'flex';

    restoreBanner.querySelector('#restore-confirm-btn').addEventListener('click', () => {
      isWritingFromPopup = true;
      chrome.storage.local.set({ annotations }, () => {
        isWritingFromPopup = false;
        restoreBanner.style.display = 'none';
        render(annotations);
        // Notify active tab so chips get re-injected
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
          if (tabs[0]) {
            annotations.forEach(ann => {
              chrome.tabs.sendMessage(tabs[0].id, { type: 'restoreAnnotation', ann }).catch(() => {});
            });
          }
        });
      });
    });

    restoreBanner.querySelector('#restore-dismiss-btn').addEventListener('click', () => {
      restoreBanner.style.display = 'none';
    });
  }

  // ── Search ────────────────────────────────────────────────────────────────

  function openSearch() {
    if (settingsVisible || historyVisible) return;
    searchActive = true;
    searchBar.style.display = 'flex';
    searchBtn.classList.add('active');
    searchInput.focus();
    searchInput.select();
  }

  function closeSearch() {
    searchActive = false;
    searchBar.style.display = 'none';
    searchBtn.classList.remove('active');
    searchInput.value = '';
    clearSearchHighlights();
  }

  function clearSearchHighlights() {
    listEl.querySelectorAll('.item').forEach(el => {
      el.classList.remove('search-match', 'search-no-match', 'search-current');
    });
    // Restore code elements that were highlighted
    listEl.querySelectorAll('code').forEach(codeEl => {
      if (codeEl.querySelector('mark.search-hl')) {
        codeEl.textContent = codeEl.textContent; // strips all child elements
      }
    });
    listEl.querySelectorAll('.item-note-edit.search-note-match').forEach(ta => {
      ta.classList.remove('search-note-match');
    });
    searchMatches = [];
    if (searchCount) searchCount.textContent = '';
    if (searchCount) delete searchCount.dataset.empty;
  }

  function highlightCodeEl(codeEl, term) {
    const rawText = codeEl.textContent;
    const escapedText = escHtml(rawText);
    const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(${escapedTerm})`, 'gi');
    codeEl.innerHTML = escapedText.replace(re, '<mark class="search-hl">$1</mark>');
  }

  function applySearch(term) {
    clearSearchHighlights();
    if (!term) return;

    const termLower = term.toLowerCase();
    searchMatches = [];

    listEl.querySelectorAll('.item').forEach(item => {
      const codeEl   = item.querySelector('code');
      const ta       = item.querySelector('.item-note-edit');
      const codeText = codeEl ? codeEl.textContent : '';
      const noteText = ta ? ta.value : '';
      const codeMatch = codeText.toLowerCase().includes(termLower);
      const noteMatch = noteText.toLowerCase().includes(termLower);

      if (codeMatch || noteMatch) {
        item.classList.add('search-match');
        searchMatches.push(item);
        if (codeMatch && codeEl) highlightCodeEl(codeEl, term);
        if (noteMatch && ta) ta.classList.add('search-note-match');
      } else {
        item.classList.add('search-no-match');
      }
    });

    searchCurrentIdx = 0;
    scrollToCurrentMatch();
    updateSearchCount();
  }

  function scrollToCurrentMatch() {
    if (searchMatches.length === 0) return;
    searchMatches.forEach((el, i) => {
      el.classList.toggle('search-current', i === searchCurrentIdx);
    });
    searchMatches[searchCurrentIdx]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function updateSearchCount() {
    if (!searchCount) return;
    if (!searchInput.value.trim()) {
      searchCount.textContent = '';
      delete searchCount.dataset.empty;
      return;
    }
    if (searchMatches.length === 0) {
      searchCount.textContent = 'No results';
      searchCount.dataset.empty = 'true';
    } else {
      searchCount.textContent = `${searchCurrentIdx + 1}/${searchMatches.length}`;
      delete searchCount.dataset.empty;
    }
  }

  function nextMatch() {
    if (searchMatches.length === 0) return;
    searchCurrentIdx = (searchCurrentIdx + 1) % searchMatches.length;
    scrollToCurrentMatch();
    updateSearchCount();
  }

  function prevMatch() {
    if (searchMatches.length === 0) return;
    searchCurrentIdx = (searchCurrentIdx - 1 + searchMatches.length) % searchMatches.length;
    scrollToCurrentMatch();
    updateSearchCount();
  }

  // Keyboard: Ctrl+F / ⌘F open search; Escape closes it
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      if (searchActive) closeSearch();
      else openSearch();
      return;
    }
    if (e.key === 'Escape' && searchActive) {
      closeSearch();
    }
  });

  searchBtn.addEventListener('click', () => {
    if (searchActive) closeSearch();
    else openSearch();
  });

  searchInput.addEventListener('input', () => {
    applySearch(searchInput.value.trim());
  });

  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) prevMatch();
      else nextMatch();
    }
    if (e.key === 'Escape') closeSearch();
  });

  document.getElementById('search-prev').addEventListener('click', prevMatch);
  document.getElementById('search-next').addEventListener('click', nextMatch);
  document.getElementById('search-close').addEventListener('click', closeSearch);

  // ── History panel ──────────────────────────────────────────────────────────
  function showHistory() {
    historyVisible  = true;
    settingsVisible = false;
    if (restoreBanner) restoreBanner.style.display = 'none';
    if (searchActive) closeSearch();
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

  function renderAnnotationHistory() {
    chrome.storage.local.get({ [HISTORY_KEY]: [] }, r => {
      let hist = r[HISTORY_KEY];

      const cappedMsg = !isPremium() && hist.length > FREE_ANNOTATION_HISTORY_LIMIT
        ? `<p class="history-cap-notice">Showing the ${FREE_ANNOTATION_HISTORY_LIMIT} most recent deleted annotations.
            <a href="#" class="meta-link upgrade-link" data-url="${escHtml(PREMIUM_PURCHASE_URL)}">Upgrade to Premium</a> for unlimited history.</p>`
        : '';
      if (!isPremium()) hist = hist.slice(-FREE_ANNOTATION_HISTORY_LIMIT);

      if (hist.length === 0) {
        historyEl.innerHTML = historyTabsHTML('annotations') +
          `<p class="empty-msg">No annotation history yet.<br>Deleted annotations will appear here.</p>`;
        attachTabListeners();
        return;
      }

      const sorted = [...hist].reverse();
      const byUrl  = {};
      sorted.forEach(ann => (byUrl[ann.url] = byUrl[ann.url] || []).push(ann));

      let html = historyTabsHTML('annotations') + cappedMsg;
      Object.entries(byUrl).forEach(([url, items]) => {
        html += `<div class="url-group">
          <div class="url-header">
            <div class="url-label" title="${escHtml(url)}">${escHtml(url)}</div>
          </div>`;
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
      attachExternalLinks(historyEl);
      historyEl.querySelectorAll('.hist-restore-btn').forEach(btn => {
        btn.addEventListener('click', () => restoreAnnotation(btn.dataset.annId, btn.dataset.deletedAt));
      });
    });
  }

  function renderCopyHistory() {
    chrome.storage.local.get({ [COPY_HISTORY_KEY]: [] }, r => {
      let copyHist = r[COPY_HISTORY_KEY];

      const cappedMsg = !isPremium() && copyHist.length > FREE_COPY_HISTORY_LIMIT
        ? `<p class="history-cap-notice">Showing the ${FREE_COPY_HISTORY_LIMIT} most recent copy events.
            <a href="#" class="meta-link upgrade-link" data-url="${escHtml(PREMIUM_PURCHASE_URL)}">Upgrade to Premium</a> for unlimited history.</p>`
        : '';
      if (!isPremium()) copyHist = copyHist.slice(-FREE_COPY_HISTORY_LIMIT);

      if (copyHist.length === 0) {
        historyEl.innerHTML = historyTabsHTML('copies') +
          `<p class="empty-msg">No copy history yet.<br>Click "Copy All as Markdown" to record an output here.</p>`;
        attachTabListeners();
        return;
      }

      let html = historyTabsHTML('copies') + cappedMsg;
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
      attachExternalLinks(historyEl);
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
    if (restoreBanner) restoreBanner.style.display = 'none';
    if (searchActive) closeSearch();
    listEl.style.display      = 'none';
    footer.style.display      = 'none';
    historyEl.style.display   = 'none';
    historyBtn.textContent    = '🕐';
    historyBtn.title          = 'View annotation history';
    settingsEl.style.display  = 'block';
    settingsBtn.textContent   = '✕';
    settingsBtn.title         = 'Close settings';
    settingsBtn.classList.add('active');
    refreshPremiumStatus().then(() => renderSettings());
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
      let licenseSection = '';

      if (premium && !DEV_MODE) {
        chrome.storage.local.get({ [LICENSE_STORAGE_KEY]: null }, r => {
          const lic   = r[LICENSE_STORAGE_KEY];
          const email = lic?.email ? escHtml(lic.email) : ':';
          licenseSection = `
            <div class="settings-section">
              <div class="settings-section-title">⭐ Premium</div>
              <div class="settings-row">
                <span class="settings-label">Status</span>
                <span class="settings-value premium-active-badge">✅ Active</span>
              </div>
              <div class="settings-row">
                <span class="settings-label">Licensed to</span>
                <span class="settings-value" style="font-size:11px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${email}</span>
              </div>
              <div class="settings-row" style="justify-content:flex-end;">
                <button id="deactivate-btn" class="btn-deactivate">Remove License</button>
              </div>
            </div>`;
          buildAndInjectSettings(s, licenseSection, premium);
        });
      } else if (!premium) {
        const purchaseUrl = PREMIUM_PURCHASE_URL || '#';
        licenseSection = `
          <div class="settings-section">
            <div class="settings-section-title">⭐ Premium : $9.99 one-time</div>
            <ul class="premium-features-list">
              <li>🌙 Dark mode</li>
              <li>📝 Custom Markdown prepend &amp; append</li>
              <li>📋 Unlimited copy &amp; annotation history</li>
              <li>🚀 All future premium features</li>
            </ul>
            <a href="#" class="btn-premium-upgrade" data-url="${escHtml(purchaseUrl)}">⭐ Get Premium : $9.99</a>
            <div class="license-divider">Already purchased?</div>
            <div class="license-input-row">
              <input type="text" id="license-key-input" class="license-input" placeholder="Paste your license key…" spellcheck="false" autocomplete="off" />
              <button id="activate-btn" class="btn-activate">Activate</button>
            </div>
            <div id="license-status" class="license-status"></div>
          </div>`;
        buildAndInjectSettings(s, licenseSection, premium);
      } else {
        // DEV_MODE : no license section shown
        buildAndInjectSettings(s, licenseSection, premium);
      }
    });
  }

  function buildAndInjectSettings(s, licenseSection, premium) {
    const currentMod      = s.shortcut?.modifier || 'alt';
    const currentLabel    = escHtml(MODIFIER_LABELS[currentMod] || 'Alt');
    const currentMaxHist  = (s.maxHistoryLength !== undefined && s.maxHistoryLength !== null)
      ? s.maxHistoryLength : 100;
    const isIndefiniteHist = currentMaxHist === 0;

    settingsEl.innerHTML = `
      ${DEV_MODE ? `
      <div class="settings-section settings-section--dev">
        <div class="settings-section-title">🛠 Developer</div>
        <div class="settings-row">
          <span class="settings-label">Dev Mode</span>
          <span class="settings-value dev-mode-badge dev-mode-on">ON : all premium features unlocked</span>
        </div>
      </div>` : ''}

      <!-- ── Annotation Shortcut (FREE : all users) ── -->
      <div class="settings-section">
        <div class="settings-section-title">⌨ Annotation Shortcut</div>
        <div class="settings-row">
          <label class="settings-label" for="shortcut-modifier">Modifier key</label>
          <select id="shortcut-modifier" class="shortcut-select">
            <option value="alt"  ${currentMod === 'alt'   ? 'selected' : ''}>Alt (default)</option>
            <option value="ctrl" ${currentMod === 'ctrl'  ? 'selected' : ''}>Ctrl</option>
            <option value="shift"${currentMod === 'shift' ? 'selected' : ''}>Shift</option>
            <option value="meta" ${currentMod === 'meta'  ? 'selected' : ''}>Meta / ⌘ Cmd</option>
          </select>
        </div>
        <p class="settings-hint">
          Hold <strong id="shortcut-preview">${currentLabel}</strong> + Right-Click any element to annotate it.
        </p>
      </div>

      <!-- ── Auto-Backup (FREE : all users) ── -->
      <div class="settings-section" id="backup-status-section">
        <div class="settings-section-title">💾 Auto-Backup</div>
        <div class="settings-row">
          <span class="settings-label">Sync backup</span>
          <span class="settings-value" id="sync-backup-status">Checking…</span>
        </div>
        <div class="settings-row">
          <span class="settings-label">File backup</span>
          <span class="settings-value" id="file-backup-status">Checking…</span>
        </div>
        <p class="settings-hint" style="margin-top:4px;">
          ☁ Sync updates every time you annotate · 💾 File (<code style="font-size:10px;">annotator-backup.json</code>) overwrites in Downloads every 15 min
        </p>
        <div class="settings-row" style="justify-content:flex-end;margin-top:4px;">
          <button id="backup-now-btn" class="btn-history-action">⚡ Backup Now</button>
        </div>
      </div>

      <!-- ── History (FREE : all users) ── -->
      <div class="settings-section">
        <div class="settings-section-title">📜 History</div>
        <div class="settings-row">
          <label class="settings-label" for="max-history-input">Max length</label>
          <div class="history-limit-row">
            <input
              type="number"
              id="max-history-input"
              class="history-limit-input"
              min="1"
              max="10000"
              value="${isIndefiniteHist ? 100 : currentMaxHist}"
              ${isIndefiniteHist ? 'disabled' : ''}
            />
            <label class="history-indefinite-label">
              <input type="checkbox" id="indefinite-history" ${isIndefiniteHist ? 'checked' : ''} />
              Indefinite
            </label>
          </div>
        </div>
        <div class="settings-row settings-row--btns">
          <button id="export-history-btn" class="btn-history-action">📤 Export</button>
          <button id="import-history-btn" class="btn-history-action">📥 Import</button>
          <button id="clear-history-settings-btn" class="btn-history-action btn-history-danger">🗑 Clear</button>
        </div>
        <input type="file" id="import-history-file" accept=".json" style="display:none;" />
      </div>

      ${licenseSection}

      <!-- ── Appearance (PREMIUM) ── -->
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

      <!-- ── Markdown Copy (PREMIUM) ── -->
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

      <div class="settings-github-row">
        <a href="#" class="meta-link" data-url="https://github.com/asharma2027/ai-dev-annotator" title="View source on GitHub">View source on GitHub →</a>
      </div>
    `;

    attachExternalLinks(settingsEl);

    // ── Backup status section ─────────────────────────────────────────────
    chrome.storage.local.get({ _lastSyncBackup: null, _lastFileBackup: null, _syncBackupError: null, _fileBackupError: null }, bd => {
      const syncEl = settingsEl.querySelector('#sync-backup-status');
      const fileEl = settingsEl.querySelector('#file-backup-status');
      if (syncEl) {
        if (bd._syncBackupError) {
          syncEl.textContent = '⚠ ' + bd._syncBackupError;
          syncEl.style.color = '#dc2626';
        } else if (bd._lastSyncBackup) {
          syncEl.textContent = '✅ ' + new Date(bd._lastSyncBackup).toLocaleTimeString();
        } else {
          syncEl.textContent = 'Not yet';
        }
      }
      if (fileEl) {
        if (bd._fileBackupError) {
          fileEl.textContent = '⚠ Failed';
          fileEl.style.color = '#dc2626';
          fileEl.title = bd._fileBackupError;
        } else if (bd._lastFileBackup) {
          fileEl.textContent = '✅ ' + new Date(bd._lastFileBackup).toLocaleTimeString();
        } else {
          fileEl.textContent = 'Pending (first backup in ~1 min)';
        }
      }
    });

    settingsEl.querySelector('#backup-now-btn')?.addEventListener('click', e => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '…';
      chrome.runtime.sendMessage({ type: 'triggerBackup' }, () => {
        setTimeout(() => {
          btn.disabled = false;
          btn.textContent = '⚡ Backup Now';
          // Refresh status
          chrome.storage.local.get({ _lastSyncBackup: null, _lastFileBackup: null }, bd => {
            const syncEl = settingsEl.querySelector('#sync-backup-status');
            const fileEl = settingsEl.querySelector('#file-backup-status');
            if (syncEl && bd._lastSyncBackup) syncEl.textContent = '✅ ' + new Date(bd._lastSyncBackup).toLocaleTimeString();
            if (fileEl && bd._lastFileBackup) fileEl.textContent = '✅ ' + new Date(bd._lastFileBackup).toLocaleTimeString();
          });
        }, 3000);
      });
    });

    // ── Shortcut selector (free, always wired) ────────────────────────────
    const modSelect = settingsEl.querySelector('#shortcut-modifier');
    const preview   = settingsEl.querySelector('#shortcut-preview');
    if (modSelect) {
      modSelect.addEventListener('change', () => {
        const mod = modSelect.value;
        saveSettings({ shortcut: { modifier: mod } });
        if (preview) preview.textContent = MODIFIER_LABELS[mod] || 'Alt';
      });
    }

    // ── History settings (free, always wired) ─────────────────────────────
    const maxHistInput  = settingsEl.querySelector('#max-history-input');
    const indefiniteChk = settingsEl.querySelector('#indefinite-history');

    if (indefiniteChk && maxHistInput) {
      indefiniteChk.addEventListener('change', () => {
        if (indefiniteChk.checked) {
          maxHistInput.disabled = true;
          saveSettings({ maxHistoryLength: 0 });
        } else {
          maxHistInput.disabled = false;
          const val = Math.max(1, parseInt(maxHistInput.value, 10) || 100);
          maxHistInput.value = val;
          saveSettings({ maxHistoryLength: val });
        }
      });
    }

    if (maxHistInput) {
      maxHistInput.addEventListener('change', () => {
        const val = Math.max(1, parseInt(maxHistInput.value, 10) || 100);
        maxHistInput.value = val;
        saveSettings({ maxHistoryLength: val });
      });
    }

    // ── Export history ────────────────────────────────────────────────────
    settingsEl.querySelector('#export-history-btn')?.addEventListener('click', () => {
      chrome.storage.local.get({ [HISTORY_KEY]: [], [COPY_HISTORY_KEY]: [], annotations: [] }, r => {
        const data = {
          exported:          new Date().toISOString(),
          version:           '1.3.0',
          annotations:       r.annotations,
          annotationHistory: r[HISTORY_KEY],
          copyHistory:       r[COPY_HISTORY_KEY],
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `annotator-history-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      });
    });

    // ── Import history ────────────────────────────────────────────────────
    const importBtn  = settingsEl.querySelector('#import-history-btn');
    const importFile = settingsEl.querySelector('#import-history-file');
    if (importBtn && importFile) {
      importBtn.addEventListener('click', () => importFile.click());
      importFile.addEventListener('change', () => {
        const file = importFile.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = e => {
          try {
            const data    = JSON.parse(e.target.result);
            const annHist  = Array.isArray(data.annotationHistory) ? data.annotationHistory : [];
            const copyHist = Array.isArray(data.copyHistory)       ? data.copyHistory       : [];

            chrome.storage.local.get({ [HISTORY_KEY]: [], [COPY_HISTORY_KEY]: [] }, r => {
              const existingAnnIds  = new Set(r[HISTORY_KEY].map(a => a.id + (a.deletedAt || '')));
              const newAnn          = annHist.filter(a => !existingAnnIds.has(a.id + (a.deletedAt || '')));
              const existingCopyTs  = new Set(r[COPY_HISTORY_KEY].map(c => c.timestamp));
              const newCopy         = copyHist.filter(c => !existingCopyTs.has(c.timestamp));

              chrome.storage.local.set({
                [HISTORY_KEY]:      [...r[HISTORY_KEY], ...newAnn],
                [COPY_HISTORY_KEY]: [...r[COPY_HISTORY_KEY], ...newCopy],
              }, () => {
                alert(`Imported ${newAnn.length} annotation record(s) and ${newCopy.length} copy log(s).`);
              });
            });
          } catch {
            alert('Invalid file. Please select a valid annotator history JSON file.');
          }
        };
        reader.readAsText(file);
        importFile.value = '';
      });
    }

    // ── Clear history ─────────────────────────────────────────────────────
    settingsEl.querySelector('#clear-history-settings-btn')?.addEventListener('click', () => {
      if (confirm('Clear all annotation and copy history? This cannot be undone.')) {
        chrome.storage.local.set({ [HISTORY_KEY]: [], [COPY_HISTORY_KEY]: [] }, () => {
          alert('History cleared.');
        });
      }
    });

    if (premium) {
      // ── Dark mode toggle ────────────────────────────────────────────────
      const darkToggle = settingsEl.querySelector('#dark-mode-toggle');
      if (darkToggle) {
        darkToggle.addEventListener('change', () => {
          saveSettings({ darkMode: darkToggle.checked }, updated => applyDarkMode(updated.darkMode));
        });
      }

      // ── Prepend / append text ────────────────────────────────────────────
      let prependTimer, appendTimer;
      const prependTa = settingsEl.querySelector('#prepend-text');
      const appendTa  = settingsEl.querySelector('#append-text');
      if (prependTa) {
        prependTa.addEventListener('input', () => {
          clearTimeout(prependTimer);
          prependTimer = setTimeout(() => saveSettings({ prependText: prependTa.value }), 350);
        });
      }
      if (appendTa) {
        appendTa.addEventListener('input', () => {
          clearTimeout(appendTimer);
          appendTimer = setTimeout(() => saveSettings({ appendText: appendTa.value }), 350);
        });
      }

      // ── Remove License button ────────────────────────────────────────────
      const deactivateBtn = settingsEl.querySelector('#deactivate-btn');
      if (deactivateBtn) {
        deactivateBtn.addEventListener('click', async () => {
          if (confirm('Remove your license key? You can re-enter it any time.')) {
            await deactivateLicense();
            applyDarkMode(false);
            renderSettings();
          }
        });
      }
    } else {
      // ── Activate button ──────────────────────────────────────────────────
      const activateBtn   = settingsEl.querySelector('#activate-btn');
      const licenseInput  = settingsEl.querySelector('#license-key-input');
      const licenseStatus = settingsEl.querySelector('#license-status');

      if (activateBtn && licenseInput) {
        activateBtn.addEventListener('click', async () => {
          const key = licenseInput.value.trim();
          if (!key) {
            licenseStatus.textContent = 'Please enter a license key.';
            licenseStatus.className   = 'license-status error';
            return;
          }
          activateBtn.disabled    = true;
          activateBtn.textContent = '…';
          licenseStatus.textContent = '';
          licenseStatus.className   = 'license-status';

          const result = await activateLicense(key);

          activateBtn.disabled    = false;
          activateBtn.textContent = 'Activate';

          if (result.valid) {
            licenseStatus.textContent = '✅ Activated! Enjoy Premium.';
            licenseStatus.className   = 'license-status success';
            setTimeout(() => renderSettings(), 900);
          } else {
            licenseStatus.textContent = result.error || 'Invalid license key.';
            licenseStatus.className   = 'license-status error';
          }
        });

        licenseInput.addEventListener('keydown', e => {
          if (e.key === 'Enter') activateBtn.click();
        });
      }
    }
  }

  settingsBtn.addEventListener('click', () => {
    if (settingsVisible) hideSettings();
    else showSettings();
  });

  // ── Dense Markdown copy ────────────────────────────────────────────────────
  copyBtn.addEventListener('click', () => {
    chrome.storage.local.get({ annotations: [], [COPY_HISTORY_KEY]: [] }, r => {
      const anns = r.annotations.filter(a => a.comment && a.comment.trim());

      if (anns.length === 0) {
        alert('No annotations with notes to copy yet.');
        return;
      }

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

      // [PREMIUM] Apply prepend / append text from settings
      loadSettings(s => {
        let finalMd = md.trim();
        if (isPremium()) {
          if (s.prependText && s.prependText.trim()) finalMd = s.prependText.trim() + '\n\n' + finalMd;
          if (s.appendText  && s.appendText.trim())  finalMd = finalMd + '\n\n' + s.appendText.trim();
        }

        navigator.clipboard.writeText(finalMd).then(() => {
          const copyHist = r[COPY_HISTORY_KEY];
          copyHist.push({ timestamp: new Date().toISOString(), output: finalMd, count: anns.length });
          chrome.storage.local.set({ [COPY_HISTORY_KEY]: copyHist });

          const orig = copyBtn.textContent;
          copyBtn.textContent = '✅ Copied!';
          setTimeout(() => (copyBtn.textContent = orig), 1500);
        }).catch(() => alert('Clipboard write failed. Try again.'));
      });
    });
  });

  function formatLine(n, ann) {
    // Page-level annotation
    if (ann.pageLevel || ann.tag === 'page') {
      return `${n}. \`(whole page)\` → ${ann.comment.trim()}\n`;
    }
    const sel   = getSelector(ann);
    const hasId = ann.elId
      ? !!ann.elId
      : (ann.id && ann.id !== 'N/A' && !ann.id.startsWith('ann_'));
    if (hasId) return `${n}. \`${sel}\` → ${ann.comment.trim()}\n`;
    return `${n}. \`${sel}\` | \`${ann.xpath}\` → ${ann.comment.trim()}\n`;
  }

  // ── Clear All ──────────────────────────────────────────────────────────────
  clearBtn.addEventListener('click', () => {
    if (confirm('Clear all annotations? They will be saved to history.')) {
      chrome.storage.local.get({ annotations: [], [HISTORY_KEY]: [] }, r => {
        const anns = r.annotations;
        const hist = r[HISTORY_KEY];
        const now  = new Date().toISOString();
        anns.forEach(ann => hist.push({ ...ann, deletedAt: now }));
        isWritingFromPopup = true;
        chrome.storage.local.set({ annotations: [], [HISTORY_KEY]: hist }, () => {
          enforceHistoryLimitInStorage(() => {
            isWritingFromPopup = false;
            load();
          });
        });
      });
    }
  });

  // ── External link handler ──────────────────────────────────────────────────
  function attachExternalLinks(root) {
    root.querySelectorAll('[data-url]').forEach(el => {
      el.addEventListener('click', e => {
        e.preventDefault();
        const url = el.dataset.url;
        if (url && url !== '#') chrome.tabs.create({ url });
      });
    });
  }

  attachExternalLinks(document.body);

  // ── Star rating widget ─────────────────────────────────────────────────────
  const starContainer = document.getElementById('star-rating');
  const stars         = document.querySelectorAll('.star');

  stars.forEach((star, idx) => {
    star.addEventListener('mouseover', () => {
      stars.forEach((s, i) => s.classList.toggle('star-hover', i <= idx));
    });
  });
  if (starContainer) {
    starContainer.addEventListener('mouseleave', () => {
      stars.forEach(s => s.classList.remove('star-hover'));
    });
    starContainer.addEventListener('click', () => {
      const reviewUrl = `https://chromewebstore.google.com/detail/${chrome.runtime.id}/reviews`;
      chrome.tabs.create({ url: reviewUrl });
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  refreshPremiumStatus().then(() => {
    load();
    checkSyncRestore();
  });
});
