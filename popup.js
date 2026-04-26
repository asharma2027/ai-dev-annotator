// popup.js : AI Website Dev Annotator

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
//   2. Create a product ("AI Website Dev Annotator Premium"), enable "Generate a
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
  const clearUndoBanner = document.getElementById('clear-undo-banner');
  const footer        = document.querySelector('.footer');

  const HISTORY_KEY      = 'annotationHistory';
  const COPY_HISTORY_KEY = 'copyHistory';
  const SETTINGS_KEY     = 'annotatorSettings';
  const SAVED_LATER_KEY  = 'savedForLater';
  // v2 sync: single compressed bundle, chunked. Old keys (ann_sync_*) are still read for back-compat.
  const SYNC_PREFIX      = 'ann_sync_';
  const SYNC_V2_PREFIX   = 'annv2_';
  const SYNC_CHUNK_SIZE  = 7000;
  // chrome.storage.sync limits: 102_400 bytes total, 8_192 bytes per item.
  // Reserve overhead for metadata keys and base64 expansion (~4/3).
  const SYNC_MAX_BYTES   = 95000;

  let historyVisible  = false;
  let settingsVisible = false;
  let historyTab      = 'annotations'; // 'annotations' | 'copies' | 'saved'
  let isWritingFromPopup = false;

  // ── Search state ──────────────────────────────────────────────────────────
  let searchActive     = false;
  let searchMatches    = [];
  let searchCurrentIdx = 0;

  // ── Sync backup state ─────────────────────────────────────────────────────
  let syncBackupTimer = null;

  // ── Undo-clear state ──────────────────────────────────────────────────────
  let undoClearData   = null; // { annotations: [], deletedAt: string }
  let undoBannerTimer = null;

  // ─── Compression / serialization helpers ─────────────────────────────────
  // Pre-process a payload to make it as small as possible BEFORE compression:
  //   - drop null/undefined/empty fields
  //   - rename annotation keys to single-letter equivalents
  //   - group annotations by URL so the URL string isn't repeated per item
  // Then gzip with maximum compression via the CompressionStream API and
  // base64-encode so it can be stored as a string in chrome.storage.sync.
  //
  // File format: a single object {v, a, h, c, sl, s} → gzip → base64.
  const ANN_SHORT_KEYS = {
    id: 'i', url: 'u', tag: 'g', elId: 'e', classes: 'c',
    xpath: 'x', comment: 't', timestamp: 's', pageLevel: 'p', deletedAt: 'd',
  };
  const ANN_LONG_KEYS = Object.fromEntries(
    Object.entries(ANN_SHORT_KEYS).map(([l, s]) => [s, l])
  );

  function shortenAnn(ann) {
    const out = {};
    for (const [k, v] of Object.entries(ann)) {
      if (v === null || v === undefined || v === '') continue;
      const sk = ANN_SHORT_KEYS[k] || k;
      out[sk] = v;
    }
    return out;
  }

  function expandAnn(short) {
    const out = {};
    for (const [k, v] of Object.entries(short)) {
      const lk = ANN_LONG_KEYS[k] || k;
      out[lk] = v;
    }
    return out;
  }

  // Group annotations by URL into [[url, [shortAnnWithoutUrl, ...]], ...]
  function groupByUrl(anns) {
    const map = new Map();
    anns.forEach(ann => {
      const url = ann.url || '';
      const short = shortenAnn(ann);
      delete short.u; // url moved to group key
      if (!map.has(url)) map.set(url, []);
      map.get(url).push(short);
    });
    return Array.from(map.entries());
  }

  function ungroupByUrl(grouped) {
    const out = [];
    grouped.forEach(([url, items]) => {
      items.forEach(s => {
        const ann = expandAnn(s);
        ann.url = url;
        out.push(ann);
      });
    });
    return out;
  }

  function buildBundle({ annotations = [], history = [], copyHistory = [], savedForLater = [], settings = {} } = {}) {
    const bundle = { v: 2 };
    if (annotations.length) bundle.a = groupByUrl(annotations);
    if (history.length)     bundle.h = groupByUrl(history);
    if (copyHistory.length) bundle.c = copyHistory.map(c => {
      const o = {};
      if (c.timestamp) o.s = c.timestamp;
      if (c.output)    o.o = c.output;
      if (c.count)     o.n = c.count;
      return o;
    });
    if (savedForLater.length) bundle.sl = savedForLater.map(set => ({
      i: set.id,
      s: set.savedAt,
      n: set.count,
      a: groupByUrl(set.annotations || []),
    }));
    if (settings && Object.keys(settings).length) bundle.s = settings;
    return bundle;
  }

  function unpackBundle(bundle) {
    if (!bundle || typeof bundle !== 'object') return {};
    return {
      annotations:   bundle.a  ? ungroupByUrl(bundle.a)  : [],
      history:       bundle.h  ? ungroupByUrl(bundle.h)  : [],
      copyHistory:   Array.isArray(bundle.c) ? bundle.c.map(o => ({
        timestamp: o.s || o.timestamp,
        output:    o.o || o.output,
        count:     o.n || o.count || 0,
      })) : [],
      savedForLater: Array.isArray(bundle.sl) ? bundle.sl.map(s => ({
        id:          s.i || s.id,
        savedAt:     s.s || s.savedAt,
        count:       s.n || s.count || 0,
        annotations: s.a ? ungroupByUrl(s.a) : (s.annotations || []),
      })) : [],
      settings:      bundle.s || {},
    };
  }

  async function gzipString(str) {
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(new TextEncoder().encode(str));
    writer.close();
    const buf = await new Response(cs.readable).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function gunzipToString(bytes) {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const buf = await new Response(ds.readable).arrayBuffer();
    return new TextDecoder().decode(buf);
  }

  function bytesToBase64(bytes) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  function base64ToBytes(b64) {
    const s = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
  }

  async function compressBundle(bundle) {
    const json = JSON.stringify(bundle);
    const gz   = await gzipString(json);
    return bytesToBase64(gz);
  }

  async function decompressBundle(b64) {
    const gz   = base64ToBytes(b64);
    const json = await gunzipToString(gz);
    return JSON.parse(json);
  }

  // ── Sync backup ─────────────────────────────────────────────────────────
  // Compresses the FULL dataset (annotations + history + saved-for-later +
  // copy log + settings) and writes it to chrome.storage.sync in chunks. If
  // the compressed payload doesn't fit, history is truncated oldest-first
  // until it does. Truncation is signaled via _syncTruncated for the UI.
  function backupToSync() {
    clearTimeout(syncBackupTimer);
    syncBackupTimer = setTimeout(() => { performSyncBackup(); }, 1500);
  }

  async function performSyncBackup() {
    try {
      const local = await new Promise(res => chrome.storage.local.get({
        annotations: [], [HISTORY_KEY]: [], [COPY_HISTORY_KEY]: [],
        [SAVED_LATER_KEY]: [], [SETTINGS_KEY]: {},
      }, res));

      const annotations   = local.annotations || [];
      let   history       = local[HISTORY_KEY] || [];
      const copyHistory   = local[COPY_HISTORY_KEY] || [];
      const savedForLater = local[SAVED_LATER_KEY] || [];
      const settings      = local[SETTINGS_KEY] || {};

      let truncated = false;
      let payload   = '';

      // Try compressing; if too large, drop oldest history entries until it fits.
      while (true) {
        const bundle = buildBundle({ annotations, history, copyHistory, savedForLater, settings });
        payload = await compressBundle(bundle);
        if (payload.length <= SYNC_MAX_BYTES) break;
        if (history.length === 0) break; // nothing more we can shed
        // Drop oldest 10% (at least 1) — newer entries are at the end
        const drop = Math.max(1, Math.floor(history.length * 0.1));
        history = history.slice(drop);
        truncated = true;
      }

      if (payload.length > SYNC_MAX_BYTES) {
        chrome.storage.local.set({
          _syncBackupError: 'Data still exceeds sync storage limit even after truncation.',
          _syncTruncated:   truncated,
        });
        return;
      }

      // Chunk and write
      const chunks = [];
      for (let i = 0; i < payload.length; i += SYNC_CHUNK_SIZE) {
        chunks.push(payload.slice(i, i + SYNC_CHUNK_SIZE));
      }

      const existing  = await new Promise(res => chrome.storage.sync.get(null, res));
      const staleKeys = Object.keys(existing).filter(k => k.startsWith(SYNC_PREFIX) || k.startsWith(SYNC_V2_PREFIX));
      if (staleKeys.length) {
        await new Promise(res => chrome.storage.sync.remove(staleKeys, res));
      }

      const data = {
        [`${SYNC_V2_PREFIX}count`]: chunks.length,
        [`${SYNC_V2_PREFIX}ts`]:    new Date().toISOString(),
        [`${SYNC_V2_PREFIX}ver`]:   2,
      };
      chunks.forEach((c, i) => { data[`${SYNC_V2_PREFIX}${i}`] = c; });

      try {
        await chrome.storage.sync.set(data);
        chrome.storage.local.set({
          _lastSyncBackup:  new Date().toISOString(),
          _syncBackupError: null,
          _syncTruncated:   truncated,
        });
      } catch (err) {
        chrome.storage.local.set({
          _syncBackupError: 'Sync write failed: ' + (err?.message || err),
          _syncTruncated:   truncated,
        });
        console.warn('[Annotator] Sync write failed:', err);
      }
    } catch (e) {
      console.warn('[Annotator] Sync backup error:', e);
    }
  }

  // Read sync. Returns the unpacked bundle (annotations, history, copyHistory,
  // savedForLater, settings) plus the timestamp. Falls back to the legacy
  // (annotations-only) sync format if v2 isn't present.
  async function readFromSync() {
    const sync = await new Promise(res => chrome.storage.sync.get(null, res));
    const v2Count = sync[`${SYNC_V2_PREFIX}count`];
    const v2Ts    = sync[`${SYNC_V2_PREFIX}ts`];
    if (v2Count && v2Count > 0) {
      let payload = '';
      for (let i = 0; i < v2Count; i++) payload += sync[`${SYNC_V2_PREFIX}${i}`] || '';
      try {
        const bundle = await decompressBundle(payload);
        return { ...unpackBundle(bundle), ts: v2Ts, format: 'v2' };
      } catch (e) {
        console.warn('[Annotator] v2 sync parse error:', e);
      }
    }
    // Legacy fallback (annotations only, plain chunks)
    const count = sync[`${SYNC_PREFIX}count`];
    const ts    = sync[`${SYNC_PREFIX}ts`];
    if (!count || count === 0) return null;
    let json = '';
    for (let i = 0; i < count; i++) json += sync[`${SYNC_PREFIX}${i}`] || '';
    try {
      const anns = JSON.parse(json);
      return {
        annotations:   Array.isArray(anns) ? anns : [],
        history:       [], copyHistory: [], savedForLater: [], settings: {},
        ts, format: 'v1',
      };
    } catch { return null; }
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
          const orig = btn.innerHTML;
          btn.innerHTML = '✅ Copied!';
          setTimeout(() => (btn.innerHTML = orig), 1500);
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
          const orig = btn.innerHTML;
          btn.innerHTML = '✅';
          setTimeout(() => (btn.innerHTML = orig), 1500);
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

  // ── Auto-resize a textarea to fit its content ─────────────────────────────
  function autoResizeTextarea(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.max(46, ta.scrollHeight) + 'px';
  }

  function autoResizeAll(container) {
    container.querySelectorAll('.item-note-edit').forEach(ta => autoResizeTextarea(ta));
  }

  // ── Navigation intent helpers ─────────────────────────────────────────────
  // Stash the desired post-navigation action into chrome.storage.local so the
  // content script can pick it up after the page loads. Each intent expires
  // after 30 s so stale intents don't trigger on unrelated future loads.
  function setNavIntent(intent) {
    const payload = { ...intent, expiresAt: Date.now() + 30_000 };
    return new Promise(res => chrome.storage.local.set({ _navIntent: payload }, res));
  }

  // ── Navigate to a specific annotation: redirect current tab to its URL,
  //    then have the content script open the panel + focus the textarea.
  async function navigateToAnnotation(annId, itemEl) {
    if (itemEl) {
      itemEl.classList.add('item-nav-flash');
      setTimeout(() => itemEl.classList.remove('item-nav-flash'), 700);
    }

    chrome.storage.local.get({ annotations: [] }, async r => {
      const ann = r.annotations.find(a => a.id === annId);
      if (!ann) return;

      await setNavIntent({ type: 'focusAnnotation', annId, url: ann.url });

      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab  = tabs[0];
      if (!tab) return;

      if (tab.url === ann.url) {
        // Already on the page — just send the focus message
        try { await chrome.tabs.sendMessage(tab.id, { type: 'focusAnnotation', annId }); } catch {}
      } else {
        await chrome.tabs.update(tab.id, { url: ann.url });
      }
      window.close(); // popup closes so the user sees the page
    });
  }

  // ── Navigate to a URL group: redirect current tab, then open ALL chips on
  //    that page (equivalent to clicking every amber chip).
  async function navigateToUrl(url) {
    await setNavIntent({ type: 'openAllForUrl', url });

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab  = tabs[0];
    if (!tab) return;

    if (tab.url === url) {
      try { await chrome.tabs.sendMessage(tab.id, { type: 'openAllAnnotations', url }); } catch {}
    } else {
      await chrome.tabs.update(tab.id, { url });
    }
    window.close();
  }

  // ── Undo-clear banner ─────────────────────────────────────────────────────
  // action: 'cleared' (default — moved to history) | 'saved' (saved-for-later set)
  function showClearUndoBanner(previousAnnotations, deletedAt, action = 'cleared', savedSetId = null) {
    undoClearData = { annotations: previousAnnotations, deletedAt, action, savedSetId };
    clearTimeout(undoBannerTimer);

    const count = previousAnnotations.length;
    const text = action === 'saved'
      ? `Saved ${count} annotation${count !== 1 ? 's' : ''} for later`
      : 'Annotations saved to history';

    clearUndoBanner.innerHTML = `
      <span class="undo-banner-text">${escHtml(text)}</span>
      <button id="undo-clear-btn" class="undo-clear-btn">Undo</button>
    `;
    clearUndoBanner.style.display = 'flex';

    document.getElementById('undo-clear-btn').addEventListener('click', () => {
      if (!undoClearData) return;
      const { annotations: prevAnns, deletedAt: ts, action: act, savedSetId: setId } = undoClearData;
      undoClearData = null;
      hideClearUndoBanner();

      if (act === 'saved') {
        // Remove the saved-for-later set and restore annotations
        chrome.storage.local.get({ annotations: [], [SAVED_LATER_KEY]: [] }, r => {
          const newSaved = r[SAVED_LATER_KEY].filter(s => s.id !== setId);
          isWritingFromPopup = true;
          chrome.storage.local.set({ annotations: prevAnns, [SAVED_LATER_KEY]: newSaved }, () => {
            isWritingFromPopup = false;
            render(prevAnns);
            chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
              if (tabs[0]) {
                prevAnns.forEach(ann => {
                  chrome.tabs.sendMessage(tabs[0].id, { type: 'restoreAnnotation', ann }).catch(() => {});
                });
              }
            });
          });
        });
        return;
      }

      chrome.storage.local.get({ annotations: [], [HISTORY_KEY]: [] }, r => {
        // Remove the cleared annotations from history by matching id + deletedAt
        const restoredIds = new Set(prevAnns.map(a => a.id));
        const newHist = r[HISTORY_KEY].filter(a => !(restoredIds.has(a.id) && a.deletedAt === ts));
        isWritingFromPopup = true;
        chrome.storage.local.set({ annotations: prevAnns, [HISTORY_KEY]: newHist }, () => {
          isWritingFromPopup = false;
          render(prevAnns);
          chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
            if (tabs[0]) {
              prevAnns.forEach(ann => {
                chrome.tabs.sendMessage(tabs[0].id, { type: 'restoreAnnotation', ann }).catch(() => {});
              });
            }
          });
        });
      });
    });

    undoBannerTimer = setTimeout(hideClearUndoBanner, 5000);
  }

  function hideClearUndoBanner() {
    clearTimeout(undoBannerTimer);
    clearUndoBanner.style.display = 'none';
    clearUndoBanner.innerHTML = '';
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
          <div class="url-label url-label--clickable" title="${escHtml(url)}" data-nav-url="${escHtml(url)}">${escHtml(url)}</div>
          <button class="url-copy-btn" data-url="${escHtml(url)}" title="Copy group as Markdown">📋 Copy group</button>
        </div>`;
      items.forEach(ann => {
        const sel = getSelector(ann);
        const isPageLevel = !!(ann.pageLevel || ann.tag === 'page');
        html += `
        <div class="item${isPageLevel ? ' item--page-level' : ''}">
          <div class="item-sel">
            <code class="ann-code--clickable" data-nav-ann-id="${escHtml(ann.id)}" title="Click to navigate to this annotation">${escHtml(sel)}</code>
            <button class="item-copy-btn" data-ann-id="${escHtml(ann.id)}" title="Copy this annotation">📋 Copy</button>
            <button class="item-delete-btn" data-ann-id="${escHtml(ann.id)}" title="Delete annotation">✕</button>
          </div>
          <textarea
            class="item-note-edit"
            data-ann-id="${escHtml(ann.id)}"
            placeholder="Add a note…"
          >${escHtml(ann.comment || '')}</textarea>
        </div>`;
      });
      html += '</div>';
    });

    listEl.innerHTML = html;

    // Auto-resize all textareas to fit their content
    autoResizeAll(listEl);

    listEl.querySelectorAll('.item-note-edit').forEach(ta => {
      ta.addEventListener('input', () => {
        saveComment(ta.dataset.annId, ta.value);
        autoResizeTextarea(ta);
      });
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

  // ── Navigation click delegation on the main list ───────────────────────────
  listEl.addEventListener('click', e => {
    // Click on annotation code element → navigate to that annotation
    const codeEl = e.target.closest('.ann-code--clickable');
    if (codeEl && !e.target.closest('button')) {
      const annId = codeEl.dataset.navAnnId;
      if (annId) {
        const item = codeEl.closest('.item');
        navigateToAnnotation(annId, item);
      }
      return;
    }

    // Click on URL group label → navigate to that URL
    const urlLabel = e.target.closest('.url-label--clickable');
    if (urlLabel && !e.target.closest('button')) {
      const url = urlLabel.dataset.navUrl;
      if (url) navigateToUrl(url);
      return;
    }
  });

  function load() {
    chrome.storage.local.get({ annotations: [] }, r => render(r.annotations));
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // Trigger a debounced sync backup any time tracked data changes
    if (changes.annotations || changes[HISTORY_KEY] || changes[COPY_HISTORY_KEY]
        || changes[SAVED_LATER_KEY] || changes[SETTINGS_KEY]) {
      backupToSync();
    }
    if (changes.annotations) {
      const newAnns = changes.annotations.newValue || [];
      if (!isWritingFromPopup && !historyVisible && !settingsVisible) {
        render(newAnns);
      }
    }
  });

  // ── Sync restore banner ───────────────────────────────────────────────────
  function checkSyncRestore() {
    chrome.storage.local.get({ annotations: [] }, async local => {
      if (local.annotations.length > 0) return; // local has data — no restore needed
      const result = await readFromSync();
      if (!result || !result.annotations || result.annotations.length === 0) return;
      showRestoreBanner(result.annotations, result.ts);
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

  // ── Search helpers ────────────────────────────────────────────────────────

  // Returns the currently visible content panel to search over
  function getSearchTargetPanel() {
    return historyVisible ? historyEl : listEl;
  }

  function openSearch() {
    if (settingsVisible) return; // settings open: no search
    searchActive = true;
    searchBar.style.display = 'flex';
    searchBtn.classList.add('active');
    searchInput.focus();
    searchInput.select();
    // Re-apply search to whatever panel is now visible
    if (searchInput.value.trim()) applySearch(searchInput.value.trim());
  }

  function closeSearch() {
    searchActive = false;
    searchBar.style.display = 'none';
    searchBtn.classList.remove('active');
    searchInput.value = '';
    clearSearchHighlights();
  }

  function clearSearchHighlights() {
    // Clear highlights from both panels
    [listEl, historyEl].forEach(panel => {
      panel.querySelectorAll('.item').forEach(el => {
        el.classList.remove('search-match', 'search-no-match', 'search-current');
      });
      panel.querySelectorAll('code').forEach(codeEl => {
        if (codeEl.querySelector('mark.search-hl')) {
          codeEl.textContent = codeEl.textContent; // strips all child elements
        }
      });
      panel.querySelectorAll('.item-note-edit.search-note-match').forEach(ta => {
        ta.classList.remove('search-note-match');
      });
      panel.querySelectorAll('.hist-note.search-note-match').forEach(div => {
        div.classList.remove('search-note-match');
      });
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

    const panel = getSearchTargetPanel();

    panel.querySelectorAll('.item').forEach(item => {
      const codeEl   = item.querySelector('code');
      const codeText = codeEl ? codeEl.textContent : '';
      const codeMatch = codeText.toLowerCase().includes(termLower);

      let noteMatch = false;
      let noteEl    = null;

      if (historyVisible) {
        noteEl = item.querySelector('.hist-note');
        const noteText = noteEl ? noteEl.textContent : '';
        noteMatch = noteText.toLowerCase().includes(termLower);
      } else {
        noteEl = item.querySelector('.item-note-edit');
        const noteText = noteEl ? noteEl.value : '';
        noteMatch = noteText.toLowerCase().includes(termLower);
      }

      if (codeMatch || noteMatch) {
        item.classList.add('search-match');
        searchMatches.push(item);
        if (codeMatch && codeEl) highlightCodeEl(codeEl, term);
        if (noteMatch && noteEl) noteEl.classList.add('search-note-match');
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
    // Search stays active — it will search history items instead
    listEl.style.display      = 'none';
    footer.style.display      = 'none';
    settingsEl.style.display  = 'none';
    historyEl.style.display   = 'block';
    settingsBtn.textContent   = '⚙️';
    settingsBtn.title         = 'Settings';
    settingsBtn.classList.remove('active');
    historyBtn.textContent    = '✕';
    historyBtn.title          = 'Close history';
    renderHistoryTab();
  }

  function renderHistoryTab() {
    if (historyTab === 'annotations') renderAnnotationHistory();
    else if (historyTab === 'saved')  renderSavedForLater();
    else renderCopyHistory();
  }

  function historyTabsHTML(active) {
    return `
      <div class="hist-tabs">
        <button class="hist-tab${active === 'annotations' ? ' active' : ''}" data-tab="annotations">Annotations</button>
        <button class="hist-tab${active === 'saved'       ? ' active' : ''}" data-tab="saved">Saved for Later</button>
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

      // Re-apply search highlights if search is active
      if (searchActive && searchInput && searchInput.value.trim()) {
        applySearch(searchInput.value.trim());
      }
    });
  }

  function renderSavedForLater() {
    chrome.storage.local.get({ [SAVED_LATER_KEY]: [] }, r => {
      const sets = r[SAVED_LATER_KEY] || [];
      if (sets.length === 0) {
        historyEl.innerHTML = historyTabsHTML('saved') +
          `<p class="empty-msg">No saved-for-later sets yet.<br>Right-click <strong>🗑 Clear All</strong> to save the current annotations here.</p>`;
        attachTabListeners();
        return;
      }

      let html = historyTabsHTML('saved');
      [...sets].reverse().forEach(set => {
        const when  = formatTimestamp(set.savedAt);
        const items = (set.annotations || []).slice(0, 50);
        html += `
        <div class="sfl-set" data-set-id="${escHtml(set.id)}">
          <div class="sfl-set-header">
            <span class="sfl-set-meta">📅 ${escHtml(when)} · ${set.count || items.length} annotation${(set.count || items.length) !== 1 ? 's' : ''}</span>
            <div class="sfl-set-actions">
              <button class="sfl-set-btn sfl-restore" data-set-id="${escHtml(set.id)}" title="Restore these annotations">↺ Restore</button>
              <button class="sfl-set-btn sfl-set-btn--danger sfl-delete" data-set-id="${escHtml(set.id)}" title="Delete this set">🗑</button>
            </div>
          </div>
          <ul class="sfl-set-list">
            ${items.map(ann => {
              const sel = getSelector(ann);
              const note = ann.comment && ann.comment.trim() ? ann.comment.trim() : '(no note)';
              return `<li><code>${escHtml(sel)}</code>${escHtml(note.slice(0, 120))}${note.length > 120 ? '…' : ''}</li>`;
            }).join('')}
            ${(set.annotations || []).length > items.length
              ? `<li><em>+${(set.annotations || []).length - items.length} more…</em></li>`
              : ''}
          </ul>
        </div>`;
      });

      historyEl.innerHTML = html;
      attachTabListeners();

      historyEl.querySelectorAll('.sfl-restore').forEach(btn => {
        btn.addEventListener('click', () => restoreSavedForLaterSet(btn.dataset.setId));
      });
      historyEl.querySelectorAll('.sfl-delete').forEach(btn => {
        btn.addEventListener('click', () => {
          if (!confirm('Delete this saved-for-later set? This cannot be undone.')) return;
          deleteSavedForLaterSet(btn.dataset.setId);
        });
      });
    });
  }

  function restoreSavedForLaterSet(setId) {
    chrome.storage.local.get({ annotations: [], [SAVED_LATER_KEY]: [] }, r => {
      const set = r[SAVED_LATER_KEY].find(s => s.id === setId);
      if (!set) return;

      const existing = new Set(r.annotations.map(a => a.id));
      const toAdd    = (set.annotations || []).filter(a => !existing.has(a.id));
      const merged   = [...r.annotations, ...toAdd];
      const newSaved = r[SAVED_LATER_KEY].filter(s => s.id !== setId);

      isWritingFromPopup = true;
      chrome.storage.local.set({ annotations: merged, [SAVED_LATER_KEY]: newSaved }, () => {
        isWritingFromPopup = false;
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
          if (tabs[0]) {
            toAdd.forEach(ann => {
              chrome.tabs.sendMessage(tabs[0].id, { type: 'restoreAnnotation', ann }).catch(() => {});
            });
          }
        });
        renderSavedForLater();
      });
    });
  }

  function deleteSavedForLaterSet(setId) {
    chrome.storage.local.get({ [SAVED_LATER_KEY]: [] }, r => {
      const newSaved = r[SAVED_LATER_KEY].filter(s => s.id !== setId);
      chrome.storage.local.set({ [SAVED_LATER_KEY]: newSaved }, () => renderSavedForLater());
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
          `<p class="empty-msg">No copy history yet.<br>Use the copy button to record an output here.</p>`;
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

      // Re-apply search highlights if search is active
      if (searchActive && searchInput && searchInput.value.trim()) {
        applySearch(searchInput.value.trim());
      }
    });
  }

  function hideHistory() {
    historyVisible = false;
    historyEl.style.display = 'none';
    footer.style.display    = '';
    listEl.style.display    = '';
    historyBtn.textContent  = '🕐';
    historyBtn.title        = 'View annotation history';
    load(); // render() re-applies search to listEl automatically
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
    settingsBtn.textContent  = '⚙️';
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
          <span class="settings-label">Local backup</span>
          <span class="settings-value" id="file-backup-status">Checking…</span>
        </div>
        <p class="settings-hint" style="margin-top:4px;">
          ☁ Sync updates every time you annotate · 💾 Local snapshot saved every 15 min
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
          <button id="clear-history-settings-btn" class="btn-history-action btn-history-danger">🗑 Clear History</button>
        </div>
      </div>

      <!-- ── All Data Export/Import ── -->
      <div class="settings-section">
        <div class="settings-section-title">📦 All Data</div>
        <div class="settings-row settings-row--btns">
          <button id="export-all-btn" class="btn-history-action">📤 Export All Data</button>
          <button id="import-all-btn" class="btn-history-action">📥 Import All Data</button>
        </div>
        <p class="settings-hint" style="margin-top:4px;">
          Compressed bundle of every annotation, history entry, saved-for-later set, copy log, and setting. Nothing is truncated.
        </p>
        <input type="file" id="import-all-file" accept=".annotator,.gz,.json" style="display:none;" />
        <div id="sync-truncation-warning" class="sync-truncation-warning" style="display:none;">
          ⚠ History is being truncated to fit sync storage limits. Your full history is preserved locally and in the latest export.
        </div>
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
    chrome.storage.local.get({
      _lastSyncBackup: null, _lastFileBackup: null,
      _syncBackupError: null, _fileBackupError: null,
      _syncTruncated: false,
    }, bd => {
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
      const truncWarn = settingsEl.querySelector('#sync-truncation-warning');
      if (truncWarn) truncWarn.style.display = bd._syncTruncated ? 'block' : 'none';
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

    // ── Export ALL data ───────────────────────────────────────────────────
    // File format: gzipped JSON of the v2 bundle (same compact format used
    // for sync, but never truncated). File extension: `.annotator`.
    settingsEl.querySelector('#export-all-btn')?.addEventListener('click', async () => {
      const btn = settingsEl.querySelector('#export-all-btn');
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = '…';
      try {
        const r = await new Promise(res => chrome.storage.local.get({
          annotations: [], [HISTORY_KEY]: [], [COPY_HISTORY_KEY]: [],
          [SAVED_LATER_KEY]: [], [SETTINGS_KEY]: {},
        }, res));
        const bundle = buildBundle({
          annotations:   r.annotations,
          history:       r[HISTORY_KEY],
          copyHistory:   r[COPY_HISTORY_KEY],
          savedForLater: r[SAVED_LATER_KEY],
          settings:      r[SETTINGS_KEY],
        });
        bundle._exported = new Date().toISOString();
        bundle._version  = '1.6.0';
        const json = JSON.stringify(bundle);
        const gz   = await gzipString(json);
        const blob = new Blob([gz], { type: 'application/gzip' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `annotator-all-${new Date().toISOString().slice(0, 10)}.annotator`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (e) {
        alert('Export failed: ' + (e?.message || e));
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    });

    // ── Import ALL data ───────────────────────────────────────────────────
    // Accepts either the new gzipped `.annotator` format or a legacy plain
    // JSON history file (for backward compatibility with old exports).
    const importAllBtn  = settingsEl.querySelector('#import-all-btn');
    const importAllFile = settingsEl.querySelector('#import-all-file');
    if (importAllBtn && importAllFile) {
      importAllBtn.addEventListener('click', () => importAllFile.click());
      importAllFile.addEventListener('change', () => {
        const file = importAllFile.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async e => {
          const buf = e.target.result;
          let bundle = null;
          let unpacked = null;

          // First try gzipped binary
          try {
            const json = await gunzipToString(new Uint8Array(buf));
            bundle = JSON.parse(json);
          } catch {
            // Fall back to plain JSON
            try {
              const txt = new TextDecoder().decode(new Uint8Array(buf));
              bundle = JSON.parse(txt);
            } catch {
              alert('Invalid file. Please select a valid .annotator export.');
              importAllFile.value = '';
              return;
            }
          }

          // Two shapes: new compact bundle (has v=2) or legacy export
          if (bundle && bundle.v === 2) {
            unpacked = unpackBundle(bundle);
          } else {
            unpacked = {
              annotations:   Array.isArray(bundle.annotations)       ? bundle.annotations       : [],
              history:       Array.isArray(bundle.annotationHistory) ? bundle.annotationHistory : [],
              copyHistory:   Array.isArray(bundle.copyHistory)       ? bundle.copyHistory       : [],
              savedForLater: Array.isArray(bundle.savedForLater)     ? bundle.savedForLater     : [],
              settings:      bundle.annotatorSettings && typeof bundle.annotatorSettings === 'object'
                               ? bundle.annotatorSettings : {},
            };
          }

          if (!confirm(
            `Import this data?\n\n` +
            `• ${unpacked.annotations.length} active annotation(s)\n` +
            `• ${unpacked.history.length} history record(s)\n` +
            `• ${unpacked.savedForLater.length} saved-for-later set(s)\n` +
            `• ${unpacked.copyHistory.length} copy log(s)\n\n` +
            `Existing items will be merged (not overwritten).`
          )) {
            importAllFile.value = '';
            return;
          }

          chrome.storage.local.get({
            annotations: [], [HISTORY_KEY]: [], [COPY_HISTORY_KEY]: [],
            [SAVED_LATER_KEY]: [], [SETTINGS_KEY]: {},
          }, r => {
            const annIds = new Set(r.annotations.map(a => a.id));
            const newAnns = unpacked.annotations.filter(a => !annIds.has(a.id));

            const histKeys = new Set(r[HISTORY_KEY].map(a => a.id + '|' + (a.deletedAt || '')));
            const newHist  = unpacked.history.filter(a => !histKeys.has(a.id + '|' + (a.deletedAt || '')));

            const copyTs = new Set(r[COPY_HISTORY_KEY].map(c => c.timestamp));
            const newCopy = unpacked.copyHistory.filter(c => !copyTs.has(c.timestamp));

            const slIds = new Set(r[SAVED_LATER_KEY].map(s => s.id));
            const newSL = unpacked.savedForLater.filter(s => !slIds.has(s.id));

            chrome.storage.local.set({
              annotations:        [...r.annotations,       ...newAnns],
              [HISTORY_KEY]:      [...r[HISTORY_KEY],      ...newHist],
              [COPY_HISTORY_KEY]: [...r[COPY_HISTORY_KEY], ...newCopy],
              [SAVED_LATER_KEY]:  [...r[SAVED_LATER_KEY],  ...newSL],
              [SETTINGS_KEY]:     { ...r[SETTINGS_KEY], ...unpacked.settings },
            }, () => {
              alert(
                `Imported:\n` +
                `• ${newAnns.length} annotation(s)\n` +
                `• ${newHist.length} history record(s)\n` +
                `• ${newSL.length} saved-for-later set(s)\n` +
                `• ${newCopy.length} copy log(s)`
              );
              if (unpacked.settings && unpacked.settings.darkMode !== undefined) {
                applyDarkMode(unpacked.settings.darkMode);
              }
            });
          });
          importAllFile.value = '';
        };
        reader.readAsArrayBuffer(file);
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

  // ── Markdown generation helper ─────────────────────────────────────────────
  function buildMarkdown(annotations, settings) {
    const anns = annotations.filter(a => a.comment && a.comment.trim());
    if (anns.length === 0) return null;

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

    let finalMd = md.trim();
    if (isPremium() && settings) {
      if (settings.prependText && settings.prependText.trim()) finalMd = settings.prependText.trim() + '\n\n' + finalMd;
      if (settings.appendText  && settings.appendText.trim())  finalMd = finalMd + '\n\n' + settings.appendText.trim();
    }
    return { md: finalMd, count: anns.length };
  }

  // ── Cut All (left-click: copy + clear) ───────────────────────────────────
  copyBtn.addEventListener('click', () => {
    chrome.storage.local.get({ annotations: [], [COPY_HISTORY_KEY]: [], [HISTORY_KEY]: [] }, r => {
      if (r.annotations.length === 0) {
        alert('No annotations with notes to copy yet.');
        return;
      }

      loadSettings(s => {
        const result = buildMarkdown(r.annotations, s);
        if (!result) {
          alert('No annotations with notes to copy yet.');
          return;
        }

        navigator.clipboard.writeText(result.md).then(() => {
          // Add to copy history log
          const copyHist = r[COPY_HISTORY_KEY];
          copyHist.push({ timestamp: new Date().toISOString(), output: result.md, count: result.count });

          // Move all annotations to history (the "cut" part)
          const now  = new Date().toISOString();
          const hist = r[HISTORY_KEY];
          r.annotations.forEach(ann => hist.push({ ...ann, deletedAt: now }));

          isWritingFromPopup = true;
          chrome.storage.local.set({ annotations: [], [HISTORY_KEY]: hist, [COPY_HISTORY_KEY]: copyHist }, () => {
            enforceHistoryLimitInStorage(() => {
              isWritingFromPopup = false;
              render([]);
              // Notify content script to remove chips
              chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
                if (tabs[0]) {
                  r.annotations.forEach(ann => {
                    chrome.tabs.sendMessage(tabs[0].id, { type: 'removeAnnotation', annId: ann.id, xpath: ann.xpath }).catch(() => {});
                  });
                }
              });
              // Show undo banner
              showClearUndoBanner(r.annotations, now);
            });
          });

          // Brief button feedback
          const origHtml = copyBtn.innerHTML;
          copyBtn.innerHTML = '<span>✅ Cut!</span>';
          setTimeout(() => (copyBtn.innerHTML = origHtml), 1500);
        }).catch(() => alert('Clipboard write failed. Try again.'));
      });
    });
  });

  // Right-click on cut button: copy only (no clear)
  copyBtn.addEventListener('contextmenu', e => {
    e.preventDefault();
    chrome.storage.local.get({ annotations: [], [COPY_HISTORY_KEY]: [] }, r => {
      loadSettings(s => {
        const result = buildMarkdown(r.annotations, s);
        if (!result) {
          alert('No annotations with notes to copy yet.');
          return;
        }
        navigator.clipboard.writeText(result.md).then(() => {
          const copyHist = r[COPY_HISTORY_KEY];
          copyHist.push({ timestamp: new Date().toISOString(), output: result.md, count: result.count });
          chrome.storage.local.set({ [COPY_HISTORY_KEY]: copyHist });

          const origHtml = copyBtn.innerHTML;
          copyBtn.innerHTML = '<span>✅ Copied!</span>';
          setTimeout(() => (copyBtn.innerHTML = origHtml), 1500);
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

  // ── Clear All (undo banner instead of confirm dialog) ─────────────────────
  clearBtn.addEventListener('click', () => {
    chrome.storage.local.get({ annotations: [], [HISTORY_KEY]: [] }, r => {
      const anns = r.annotations;
      if (anns.length === 0) return; // nothing to clear

      const hist = r[HISTORY_KEY];
      const now  = new Date().toISOString();
      anns.forEach(ann => hist.push({ ...ann, deletedAt: now }));

      isWritingFromPopup = true;
      chrome.storage.local.set({ annotations: [], [HISTORY_KEY]: hist }, () => {
        enforceHistoryLimitInStorage(() => {
          isWritingFromPopup = false;
          render([]);
          // Notify content script to remove chips
          chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
            if (tabs[0]) {
              anns.forEach(ann => {
                chrome.tabs.sendMessage(tabs[0].id, { type: 'removeAnnotation', annId: ann.id, xpath: ann.xpath }).catch(() => {});
              });
            }
          });
          // Show undo banner instead of confirm dialog
          showClearUndoBanner(anns, now, 'cleared');
        });
      });
    });
  });

  // ── Clear All (right-click): save current annotations to "Saved for Later"
  clearBtn.addEventListener('contextmenu', e => {
    e.preventDefault();
    chrome.storage.local.get({ annotations: [], [SAVED_LATER_KEY]: [] }, r => {
      const anns = r.annotations;
      if (anns.length === 0) return;

      const now = new Date().toISOString();
      const setId = `sfl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const set = {
        id:          setId,
        savedAt:     now,
        count:       anns.length,
        annotations: anns.map(a => ({ ...a })), // snapshot
      };
      const newSaved = [...r[SAVED_LATER_KEY], set];

      isWritingFromPopup = true;
      chrome.storage.local.set({ annotations: [], [SAVED_LATER_KEY]: newSaved }, () => {
        isWritingFromPopup = false;
        render([]);
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
          if (tabs[0]) {
            anns.forEach(ann => {
              chrome.tabs.sendMessage(tabs[0].id, { type: 'removeAnnotation', annId: ann.id, xpath: ann.xpath }).catch(() => {});
            });
          }
        });
        showClearUndoBanner(anns, now, 'saved', setId);
      });
    });
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
