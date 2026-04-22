// popup.js — Dev Annotator

// ─────────────────────────────────────────────────────────────────────────────
// DEV MODE
// Set DEV_MODE = true in your *local* copy to unlock all premium features
// during development. Never commit with DEV_MODE = true — it bypasses all
// license checks and exposes the dev-only UI.
// ─────────────────────────────────────────────────────────────────────────────
const DEV_MODE = false;

// ─────────────────────────────────────────────────────────────────────────────
// PREMIUM / LICENSE SYSTEM (Gumroad)
//
// SETUP — one-time steps before publishing:
//   1. Create a free Gumroad account → https://gumroad.com
//   2. Create a product ("Dev Annotator Premium"), enable "Generate a unique
//      license key" in product settings, and set your price.
//   3. Replace GUMROAD_PRODUCT_PERMALINK with the slug at the end of your
//      product URL (e.g. for gumroad.com/l/devann → use "devann").
//   4. Replace PREMIUM_PURCHASE_URL with your full product URL.
//
// Flow: user purchases → Gumroad emails them a license key → they paste it
// in Settings → Premium → extension validates via Gumroad's public API →
// result cached in chrome.storage.local.
// ─────────────────────────────────────────────────────────────────────────────
const GUMROAD_PRODUCT_PERMALINK = ''; // TODO: your Gumroad product permalink
const PREMIUM_PURCHASE_URL      = ''; // TODO: your Gumroad product URL

const LICENSE_STORAGE_KEY = 'license';

// Free-tier history caps (premium = unlimited)
const FREE_ANNOTATION_HISTORY_LIMIT = 30;
const FREE_COPY_HISTORY_LIMIT       = 10;

// ─── Cached premium status ────────────────────────────────────────────────────
// Loaded once at startup from chrome.storage.local; refreshed whenever
// Settings is opened or a license is activated/deactivated.
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
        product_permalink:   GUMROAD_PRODUCT_PERMALINK,
        license_key:         key.trim(),
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
  const footer      = document.querySelector('.footer');

  const HISTORY_KEY      = 'annotationHistory';
  const COPY_HISTORY_KEY = 'copyHistory';
  const SETTINGS_KEY     = 'annotatorSettings';

  let historyVisible  = false;
  let settingsVisible = false;
  let historyTab      = 'annotations'; // 'annotations' | 'copies'

  // Prevent storage.onChanged from triggering a re-render when the popup itself
  // is the one writing (avoids textarea cursor-position resets).
  let isWritingFromPopup = false;

  // ── Settings defaults ────────────────────────────────────────────────────
  const DEFAULT_SETTINGS = {
    prependText: '', // [PREMIUM] prepended to "copy all as markdown" output
    appendText:  '', // [PREMIUM] appended  to "copy all as markdown" output
    darkMode:    false, // [PREMIUM] dark / light theme toggle
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
  // [PREMIUM] Applies the chosen theme to the popup body.
  function applyDarkMode(enabled) {
    document.body.dataset.theme = enabled ? 'dark' : 'light';
  }

  // Apply dark mode as early as possible (avoid a flash of unstyled theme)
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

  // ── Save a single annotation's comment from the popup ─────────────────────
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

  // Refresh popup when storage changes (e.g. user annotating on the page),
  // but skip re-renders triggered by the popup's own writes.
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

      // Free tier: cap visible history; premium: unlimited
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
    listEl.style.display      = 'none';
    footer.style.display      = 'none';
    historyEl.style.display   = 'none';
    historyBtn.textContent    = '🕐';
    historyBtn.title          = 'View annotation history';
    settingsEl.style.display  = 'block';
    settingsBtn.textContent   = '✕';
    settingsBtn.title         = 'Close settings';
    settingsBtn.classList.add('active');
    // Refresh premium status each time settings is opened, then render
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
        // Show active license info + remove button
        chrome.storage.local.get({ [LICENSE_STORAGE_KEY]: null }, r => {
          const lic   = r[LICENSE_STORAGE_KEY];
          const email = lic?.email ? escHtml(lic.email) : '—';
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
        // Show upgrade CTA + license key input
        const purchaseUrl = PREMIUM_PURCHASE_URL || '#';
        licenseSection = `
          <div class="settings-section">
            <div class="settings-section-title">⭐ Premium — $9.99 one-time</div>
            <ul class="premium-features-list">
              <li>🌙 Dark mode</li>
              <li>📝 Custom Markdown prepend &amp; append</li>
              <li>📋 Unlimited copy &amp; annotation history</li>
              <li>🚀 All future premium features</li>
            </ul>
            <a href="#" class="btn-premium-upgrade" data-url="${escHtml(purchaseUrl)}">⭐ Get Premium — $9.99</a>
            <div class="license-divider">Already purchased?</div>
            <div class="license-input-row">
              <input type="text" id="license-key-input" class="license-input" placeholder="Paste your license key…" spellcheck="false" autocomplete="off" />
              <button id="activate-btn" class="btn-activate">Activate</button>
            </div>
            <div id="license-status" class="license-status"></div>
          </div>`;
        buildAndInjectSettings(s, licenseSection, premium);
      } else {
        // DEV_MODE active — show dev indicator only
        buildAndInjectSettings(s, licenseSection, premium);
      }
    });
  }

  function buildAndInjectSettings(s, licenseSection, premium) {
    settingsEl.innerHTML = `
      ${DEV_MODE ? `
      <div class="settings-section settings-section--dev">
        <div class="settings-section-title">🛠 Developer</div>
        <div class="settings-row">
          <span class="settings-label">Dev Mode</span>
          <span class="settings-value dev-mode-badge dev-mode-on">ON — all premium features unlocked</span>
        </div>
      </div>` : ''}

      ${licenseSection}

      <!-- Appearance — [PREMIUM] -->
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

      <!-- Markdown Copy — [PREMIUM] -->
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

    if (premium) {
      const darkToggle = settingsEl.querySelector('#dark-mode-toggle');
      if (darkToggle) {
        darkToggle.addEventListener('change', () => {
          saveSettings({ darkMode: darkToggle.checked }, updated => applyDarkMode(updated.darkMode));
        });
      }

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

      // "Remove License" button
      const deactivateBtn = settingsEl.querySelector('#deactivate-btn');
      if (deactivateBtn) {
        deactivateBtn.addEventListener('click', async () => {
          if (confirm('Remove your license key? You can re-enter it any time.')) {
            await deactivateLicense();
            applyDarkMode(false); // reset dark mode if premium is removed
            renderSettings();
          }
        });
      }
    } else {
      // "Activate" button handler
      const activateBtn     = settingsEl.querySelector('#activate-btn');
      const licenseInput    = settingsEl.querySelector('#license-key-input');
      const licenseStatus   = settingsEl.querySelector('#license-status');

      if (activateBtn && licenseInput) {
        activateBtn.addEventListener('click', async () => {
          const key = licenseInput.value.trim();
          if (!key) { licenseStatus.textContent = 'Please enter a license key.'; licenseStatus.className = 'license-status error'; return; }

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

        // Allow Enter key to trigger activation
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

  function formatLine(n, ann) {
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
          isWritingFromPopup = false;
          load();
        });
      });
    }
  });

  // ── External link handler ──────────────────────────────────────────────────
  // Opens [data-url] links and star-rating in new tabs via chrome.tabs.create.
  function attachExternalLinks(root) {
    root.querySelectorAll('[data-url]').forEach(el => {
      el.addEventListener('click', e => {
        e.preventDefault();
        const url = el.dataset.url;
        if (url && url !== '#') chrome.tabs.create({ url });
      });
    });
  }

  // Attach to always-visible elements (footer links, stars)
  attachExternalLinks(document.body);

  // ── Star rating widget ─────────────────────────────────────────────────────
  const starContainer = document.getElementById('star-rating');
  const stars         = document.querySelectorAll('.star');

  // Hover: fill stars up to hovered index
  stars.forEach((star, idx) => {
    star.addEventListener('mouseover', () => {
      stars.forEach((s, i) => s.classList.toggle('star-hover', i <= idx));
    });
  });
  if (starContainer) {
    starContainer.addEventListener('mouseleave', () => {
      stars.forEach(s => s.classList.remove('star-hover'));
    });

    // Click any star → open Chrome Web Store review page
    starContainer.addEventListener('click', () => {
      const reviewUrl = `https://chromewebstore.google.com/detail/${chrome.runtime.id}/reviews`;
      chrome.tabs.create({ url: reviewUrl });
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  // Refresh premium status on load, then render annotations
  refreshPremiumStatus().then(() => load());
});
