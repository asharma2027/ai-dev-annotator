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

// Button action definitions — values used in settings storage
const BUTTON_ACTIONS = {
  copyAll:      { emoji: '📋', label: 'Copy All'       },
  cutAll:       { emoji: '✂',  label: 'Cut All'        },
  clearAll:     { emoji: '🗑', label: 'Clear All'      },
  saveForLater: { emoji: '💾', label: 'Save for Later' },
};

// Human-readable labels for each modifier key
const MODIFIER_LABELS = {
  alt:   'Alt',
  ctrl:  'Ctrl',
  shift: 'Shift',
  meta:  'Meta / ⌘ Cmd',
};

// ─── Cached premium status ────────────────────────────────────────────────────
let _premium = true; // all features always unlocked

function isPremium() {
  return _premium;
}

async function refreshPremiumStatus() {
  _premium = true; // all features always enabled
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
  // ── Change 13: inline toast + confirm helpers (replaces native alert/confirm) ─
  function showToast(msg, opts) {
    opts = opts || {};
    const t = document.createElement('div');
    t.className = 'ann-toast' + (opts.kind ? ' ann-toast--' + opts.kind : '');
    t.textContent = msg;
    document.body.appendChild(t);
    void t.offsetWidth;
    t.classList.add('ann-toast--in');
    setTimeout(() => {
      t.classList.remove('ann-toast--in');
      setTimeout(() => { try { t.remove(); } catch(_){} }, 200);
    }, opts.duration || 2200);
  }

  // Returns Promise<boolean>. Renders an inline confirm banner inside `host`
  // (or document.body if none given).
  function showConfirm(msg, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const host = opts.host || document.body;
      const wrap = document.createElement('div');
      wrap.className = 'ann-confirm-banner';
      wrap.innerHTML = `
        <div class="ann-confirm-msg"></div>
        <div class="ann-confirm-actions">
          <button class="ann-confirm-cancel">Cancel</button>
          <button class="ann-confirm-ok">${opts.okLabel || 'OK'}</button>
        </div>`;
      wrap.querySelector('.ann-confirm-msg').textContent = msg;
      const cleanup = (val) => { try { wrap.remove(); } catch(_){} resolve(val); };
      wrap.querySelector('.ann-confirm-ok').addEventListener('click',     () => cleanup(true));
      wrap.querySelector('.ann-confirm-cancel').addEventListener('click', () => cleanup(false));
      host.appendChild(wrap);
      setTimeout(() => wrap.querySelector('.ann-confirm-ok').focus(), 0);
    });
  }

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
  // ── Copy-All snapshots ────────────────────────────────────────────────────
  // Each Copy All click writes a "snapshot" record here that groups the
  // annotations that were copied. The annotations themselves remain in the
  // main `annotations` list (so future Copy All actions still include them);
  // the snapshot is purely a UI grouping layer over the main list.
  // Schema: { id, timestamp, annotationIds: string[], expanded: boolean }
  const COPY_ALL_SNAPSHOTS_KEY = 'copyAllSnapshots';
  // ── Change 2: storage dedup ────────────────────────────────────────────────
  // Central reference store: history, copy logs, and saved-for-later sets all
  // store annotation IDs that point into _annStore instead of duplicating the
  // full annotation objects. Each entry is { ...ann, _refCount }. When refCount
  // reaches 0 the entry is removed.
  //
  // Estimated reduction: average annotation ~200 chars × ~3.2x duplication
  // (history + at most one saved-for-later set + one copy-log) → ~68% storage
  // savings on heavily-used datasets, ~50% on typical sessions.
  const ANN_STORE_KEY    = '_annStore';
  const MIGRATION_FLAG   = '_storageMigratedV2';
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

  // ── Multi-tab DOM sync helpers ───────────────────────────────────────────
  // Annotation chip state must stay consistent across every open tab and window,
  // not just the tab that happens to be active when the popup is open.
  //
  // broadcastRemove: safe to send to ALL tabs — the content script ignores the
  //   message when it finds no matching chip, so non-matching pages are no-ops.
  // broadcastRestore: scoped to the annotation's own URL — we only want to
  //   inject a chip on pages that are actually showing that URL.

  function broadcastRemove(annId, xpath) {
    chrome.tabs.query({}, tabs => {
      tabs.forEach(tab =>
        chrome.tabs.sendMessage(tab.id, { type: 'removeAnnotation', annId, xpath }).catch(() => {})
      );
    });
  }

  function broadcastRestore(ann) {
    const normUrl = (() => {
      try { const u = new URL(ann.url || ''); return u.origin + u.pathname; } catch { return ann.url || ''; }
    })();
    chrome.tabs.query({}, tabs => {
      tabs
        .filter(tab => {
          try { const u = new URL(tab.url || ''); return (u.origin + u.pathname) === normUrl; } catch { return tab.url === ann.url; }
        })
        .forEach(tab =>
          chrome.tabs.sendMessage(tab.id, { type: 'restoreAnnotation', ann }).catch(() => {})
        );
    });
  }

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
    text: 'tx',
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

  // ── Change 1: formatLine — format a single annotation as a Markdown bullet ─
  // Used by copy-all, cut-all, copy-by-url, and export flows.
  function formatLine(index, ann) {
    const sel  = getSelector(ann);   // uses existing getSelector helper
    const note = (ann.comment || '').trim();
    const text = (ann.text    || '').trim();
    const url  = (ann.url     || '').trim();
    const ts   = ann.timestamp ? new Date(ann.timestamp).toISOString() : '';

    // Escape pipes and backticks for inline code spans.
    const safeSel   = sel.replace(/`/g, '\\`');
    const noteBlock = note ? `\n   - ${note.replace(/\n/g, '\n     ')}` : '';
    const textBlock = text ? `\n   - _"${text.replace(/\n/g, ' ').slice(0, 240)}"_` : '';
    const urlBlock  = url  ? `\n   - ${url}` : '';
    const tsBlock   = ts   ? `\n   - ${ts}` : '';

    return `${index}. \`${safeSel}\`${noteBlock}${textBlock}${urlBlock}${tsBlock}\n`;
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
    // Suppress unhandled rejections from write/close — the error surfaces
    // through the readable side and is caught by the caller's try/catch.
    writer.write(bytes).catch(() => {});
    writer.close().catch(() => {});
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
    loadSettings(s => {
      if (s.backupEnabled === false) return;
      clearTimeout(syncBackupTimer);
      syncBackupTimer = setTimeout(() => { performSyncBackup(); }, 1500);
    });
  }

  async function performSyncBackup() {
    try {
      const local = await new Promise(res => chrome.storage.local.get({
        annotations: [], [HISTORY_KEY]: [], [COPY_HISTORY_KEY]: [],
        [SAVED_LATER_KEY]: [], [SETTINGS_KEY]: {}, [ANN_STORE_KEY]: {},
      }, res));

      const annotations   = local.annotations || [];
      const store         = local[ANN_STORE_KEY] || {};
      // Resolve refs to full data for the backup payload (consumers expect
      // the bundle to be self-describing). Skip orphans gracefully.
      let   history       = (local[HISTORY_KEY] || []).map(h => {
        const ann = resolveRef(h, store);
        return ann ? { ...ann, deletedAt: h.deletedAt || ann.deletedAt } : null;
      }).filter(Boolean);
      const copyHistory   = (local[COPY_HISTORY_KEY] || []).map(c => {
        const { annotationIds, ...rest } = c; return rest;
      });
      const savedForLater = (local[SAVED_LATER_KEY] || []).map(set => {
        const anns = Array.isArray(set.annotationIds)
          ? resolveList(set.annotationIds, store)
          : (set.annotations || []);
        return {
          id:          set.id,
          savedAt:     set.savedAt,
          count:       set.count || anns.length,
          annotations: anns,
        };
      });
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
    shortcut:         { modifier: 'alt' }, // customizable annotation trigger
    prependText:      '',                  // prepended to markdown output
    appendText:       '',                  // appended to markdown output
    darkMode:         false,               // dark / light theme toggle
    maxHistoryLength: 100,                 // 0 = indefinite
    backupEnabled:    true,               // enable/disable auto-backup to sync
    buttonActions: {
      copyBtn:  { left: 'copyAll',  right: 'cutAll'       },
      clearBtn: { left: 'clearAll', right: 'saveForLater' },
    },
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

  loadSettings(s => {
    applyDarkMode(s.darkMode);
    updateButtonLabels(s);
  });

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
      chrome.storage.local.get({ [HISTORY_KEY]: [], [ANN_STORE_KEY]: {} }, r => {
        const hist = r[HISTORY_KEY];
        if (hist.length <= maxLen) { if (cb) cb(); return; }
        const dropped = hist.slice(0, hist.length - maxLen);
        const trimmed = hist.slice(-maxLen); // keep newest
        const store   = { ...(r[ANN_STORE_KEY] || {}) };
        refStoreDec(store, dropped.map(h => h && h.id).filter(Boolean));
        chrome.storage.local.set({ [HISTORY_KEY]: trimmed, [ANN_STORE_KEY]: store }, cb);
      });
    });
  }

  // ── Change 2: storage dedup helpers ──────────────────────────────────────
  // Read raw storage with all dedup-related keys.
  function readDedupStorage(cb) {
    chrome.storage.local.get({
      annotations: [],
      [HISTORY_KEY]: [],
      [COPY_HISTORY_KEY]: [],
      [SAVED_LATER_KEY]: [],
      [ANN_STORE_KEY]: {},
    }, r => cb(r));
  }
  // Look up full annotation data given a reference (id) or a legacy full object.
  // Returns null if the reference is orphaned and no fallback data exists.
  function resolveRef(ref, store) {
    if (!ref) return null;
    if (typeof ref === 'string') return store[ref] ? stripRefMeta(store[ref]) : null;
    // Legacy object form — already has full data.
    if (ref.id && store[ref.id]) {
      const merged = { ...stripRefMeta(store[ref.id]), ...ref };
      return merged;
    }
    if (ref.tag !== undefined || ref.url !== undefined) return ref; // legacy full obj
    if (ref.id) return store[ref.id] ? stripRefMeta(store[ref.id]) : null;
    return null;
  }
  function stripRefMeta(entry) {
    const { _refCount, ...rest } = entry || {};
    return rest;
  }
  // Increment refcount for ids; create entries from snapshots if not present.
  function refStoreInc(store, ids, snapshotFn) {
    ids.forEach(id => {
      if (!id) return;
      if (!store[id]) {
        const snap = snapshotFn ? snapshotFn(id) : null;
        if (!snap) return; // can't materialize — skip rather than crash
        store[id] = { ...snap, _refCount: 0 };
      }
      store[id]._refCount = (store[id]._refCount || 0) + 1;
    });
  }
  function refStoreDec(store, ids) {
    ids.forEach(id => {
      if (!id || !store[id]) return;
      store[id]._refCount = (store[id]._refCount || 1) - 1;
      if (store[id]._refCount <= 0) delete store[id];
    });
  }
  // Resolve a list of references (history entries / saved set ann lists / copy
  // log id lists) into full annotation objects. Skips orphans gracefully.
  function resolveList(refs, store) {
    if (!Array.isArray(refs)) return [];
    const out = [];
    refs.forEach(r => {
      const full = resolveRef(r, store);
      if (full) out.push(full);
    });
    return out;
  }
  // Extract the annotation IDs out of a list of refs (whether new-format strings
  // or legacy full objects).
  function refIds(refs) {
    if (!Array.isArray(refs)) return [];
    return refs.map(r => (typeof r === 'string' ? r : r && r.id)).filter(Boolean);
  }

  // One-shot migration: convert legacy in-place full-data history/copy/saved
  // into the dedup format. Idempotent — checks MIGRATION_FLAG.
  function maybeMigrateStorage(cb) {
    chrome.storage.local.get({ [MIGRATION_FLAG]: false }, flag => {
      if (flag[MIGRATION_FLAG]) { if (cb) cb(); return; }
      readDedupStorage(r => {
        try {
          const store = { ...(r[ANN_STORE_KEY] || {}) };
          // Build snapshot lookup for live annotations (so refs in history that
          // share an id with a live annotation can recover full data if needed).
          const liveById = {};
          (r.annotations || []).forEach(a => { if (a && a.id) liveById[a.id] = a; });

          // History: convert legacy full annotations into id-only refs.
          const history = (r[HISTORY_KEY] || []).map(h => {
            if (!h || !h.id) return h;
            // Already migrated entry — keys are just {id, deletedAt}
            const isLegacyFull = h.tag !== undefined || h.url !== undefined || h.xpath !== undefined;
            if (isLegacyFull) {
              const { id, deletedAt, ...rest } = h;
              const snap = { id, ...rest };
              if (!store[id]) store[id] = { ...snap, _refCount: 0 };
              else store[id] = { ...snap, ...store[id], _refCount: store[id]._refCount };
              store[id]._refCount = (store[id]._refCount || 0) + 1;
              return { id, deletedAt };
            }
            // Already a ref — bump refcount if entry exists; otherwise leave as-is
            if (h.id && store[h.id]) {
              // count assumed already correct
            }
            return h;
          });

          // Saved-for-later: convert each set's annotations array.
          const savedForLater = (r[SAVED_LATER_KEY] || []).map(set => {
            if (!set) return set;
            if (Array.isArray(set.annotationIds)) return set; // already migrated
            const anns = Array.isArray(set.annotations) ? set.annotations : [];
            const ids = [];
            anns.forEach(a => {
              if (!a || !a.id) return;
              ids.push(a.id);
              if (!store[a.id]) store[a.id] = { ...a, _refCount: 0 };
              store[a.id]._refCount = (store[a.id]._refCount || 0) + 1;
            });
            return {
              id:           set.id,
              savedAt:      set.savedAt,
              count:        set.count || ids.length,
              annotationIds: ids,
            };
          });

          // Copy logs: legacy entries had no annotation id linkage. Leave
          // annotationIds empty for legacy entries — Change 1's button will
          // simply find nothing to remove for those, which is correct.
          const copyHistory = (r[COPY_HISTORY_KEY] || []).map(c => {
            if (!c) return c;
            if (Array.isArray(c.annotationIds)) return c;
            return { ...c, annotationIds: [] };
          });

          // Write everything back atomically. On failure, leave old data alone.
          chrome.storage.local.set({
            [HISTORY_KEY]:      history,
            [SAVED_LATER_KEY]:  savedForLater,
            [COPY_HISTORY_KEY]: copyHistory,
            [ANN_STORE_KEY]:    store,
            [MIGRATION_FLAG]:   true,
          }, () => { if (cb) cb(); });
        } catch (err) {
          console.warn('[Annotator] Storage migration failed; keeping legacy format.', err);
          if (cb) cb();
        }
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
    readDedupStorage(r => {
      const anns  = r.annotations;
      const hist  = r[HISTORY_KEY];
      const store = { ...(r[ANN_STORE_KEY] || {}) };
      const ann   = anns.find(a => a.id === annId);
      let newHist = hist;
      if (ann) {
        // Remove any existing history entries for the same id (refcount drop) and
        // re-add a fresh deletion record. The store entry is keyed off the live ann.
        const oldRefs = hist.filter(h => h.id === ann.id);
        if (oldRefs.length) refStoreDec(store, oldRefs.map(h => h.id));
        newHist = hist.filter(h => h.id !== ann.id);
        if (!store[ann.id]) store[ann.id] = { ...ann, _refCount: 0 };
        store[ann.id]._refCount = (store[ann.id]._refCount || 0) + 1;
        newHist.push({ id: ann.id, deletedAt: new Date().toISOString() });
      }
      const remaining = anns.filter(a => a.id !== annId);
      chrome.storage.local.set({
        annotations:  remaining,
        [HISTORY_KEY]: newHist,
        [ANN_STORE_KEY]: store,
      }, () => {
        enforceHistoryLimitInStorage(() => {
          isWritingFromPopup = false;
          render(remaining);
          if (ann) broadcastRemove(annId, ann.xpath);
        });
      });
    });
  }

  // ── Copy a single group's annotations as Markdown ─────────────────────────
  function copyGroup(url) {
    chrome.storage.local.get({ annotations: [] }, r => {
      const anns = r.annotations.filter(a => a.url === url && a.comment && a.comment.trim());
      if (anns.length === 0) {
        showToast('No annotations with notes in this group.');
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
      }).catch(() => showToast('Clipboard write failed.', { kind: 'error' }));
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
      }).catch(() => showToast('Clipboard write failed.', { kind: 'error' }));
    });
  }

  // ── Clear a URL group (saves to history) ───────────────────────────────────
  function clearGroup(url) {
    readDedupStorage(r => {
      const groupAnns = r.annotations.filter(a => a.url === url);
      if (groupAnns.length === 0) return;
      const remaining = r.annotations.filter(a => a.url !== url);
      let   hist  = r[HISTORY_KEY];
      const store = { ...(r[ANN_STORE_KEY] || {}) };
      const now   = new Date().toISOString();
      groupAnns.forEach(ann => {
        // Drop any prior history ref for this id (decrement) before re-adding.
        const oldRefs = hist.filter(h => h.id === ann.id);
        if (oldRefs.length) refStoreDec(store, oldRefs.map(h => h.id));
        hist = hist.filter(h => h.id !== ann.id);
        if (!store[ann.id]) store[ann.id] = { ...ann, _refCount: 0 };
        store[ann.id]._refCount = (store[ann.id]._refCount || 0) + 1;
        hist.push({ id: ann.id, deletedAt: now });
      });
      isWritingFromPopup = true;
      chrome.storage.local.set({
        annotations: remaining,
        [HISTORY_KEY]: hist,
        [ANN_STORE_KEY]: store,
      }, () => {
        enforceHistoryLimitInStorage(() => {
          isWritingFromPopup = false;
          render(remaining);
          groupAnns.forEach(ann => broadcastRemove(ann.id, ann.xpath));
        });
      });
    });
  }

  // ── Restore a history entry ────────────────────────────────────────────────
  function restoreAnnotation(annId, deletedAt) {
    readDedupStorage(r => {
      const anns    = r.annotations;
      const hist    = r[HISTORY_KEY];
      const store   = { ...(r[ANN_STORE_KEY] || {}) };
      const histIdx = hist.findIndex(a => a.id === annId && a.deletedAt === deletedAt);
      if (histIdx === -1) return;

      // Resolve via store; fall back to legacy inline data on the history entry.
      const ann = resolveRef(hist[histIdx], store) || { ...hist[histIdx] };
      delete ann.deletedAt;
      if (!ann || !ann.id) return;

      if (ann.url) {
        try {
          const u = new URL(ann.url);
          ann.url = u.origin + u.pathname;
        } catch (_) {}
      }

      if (anns.some(a => a.id === ann.id)) { showHistory(); return; }

      const newAnns = [...anns, ann];
      const newHist = hist.filter((_, i) => i !== histIdx);
      refStoreDec(store, [ann.id]);

      chrome.storage.local.set({
        annotations: newAnns,
        [HISTORY_KEY]: newHist,
        [ANN_STORE_KEY]: store,
      }, () => {
        showHistory();
        broadcastRestore(ann);
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
        // Remove the saved-for-later set and restore annotations.
        chrome.storage.local.get({ annotations: [], [SAVED_LATER_KEY]: [], [ANN_STORE_KEY]: {} }, r => {
          const set = r[SAVED_LATER_KEY].find(s => s.id === setId);
          const newSaved = r[SAVED_LATER_KEY].filter(s => s.id !== setId);
          const store = { ...(r[ANN_STORE_KEY] || {}) };
          if (set) {
            const ids = Array.isArray(set.annotationIds)
              ? set.annotationIds
              : (set.annotations || []).map(a => a.id);
            refStoreDec(store, ids.filter(Boolean));
          }
          isWritingFromPopup = true;
          chrome.storage.local.set({
            annotations: prevAnns,
            [SAVED_LATER_KEY]: newSaved,
            [ANN_STORE_KEY]: store,
          }, () => {
            isWritingFromPopup = false;
            render(prevAnns);
            prevAnns.forEach(ann => broadcastRestore(ann));
          });
        });
        return;
      }

      chrome.storage.local.get({ annotations: [], [HISTORY_KEY]: [], [ANN_STORE_KEY]: {} }, r => {
        const restoredIds = new Set(prevAnns.map(a => a.id));
        const removed = r[HISTORY_KEY].filter(a => restoredIds.has(a.id) && a.deletedAt === ts);
        const newHist = r[HISTORY_KEY].filter(a => !(restoredIds.has(a.id) && a.deletedAt === ts));
        const store   = { ...(r[ANN_STORE_KEY] || {}) };
        refStoreDec(store, removed.map(h => h.id));
        isWritingFromPopup = true;
        chrome.storage.local.set({
          annotations: prevAnns,
          [HISTORY_KEY]: newHist,
          [ANN_STORE_KEY]: store,
        }, () => {
          isWritingFromPopup = false;
          render(prevAnns);
          prevAnns.forEach(ann => broadcastRestore(ann));
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
  // Helper: build the inner HTML for a set of annotations grouped by URL.
  // Used both for the un-grouped "loose" annotations and for the contents of
  // each Copy-All snapshot ("big box").
  function buildGroupedAnnotationsHTML(anns, opts) {
    opts = opts || {};
    const showGroupCount = !!opts.showGroupCount;
    const byUrl = {};
    anns.forEach(ann => (byUrl[ann.url] = byUrl[ann.url] || []).push(ann));

    let html = '';
    Object.entries(byUrl).forEach(([url, items]) => {
      const countBadge = showGroupCount
        ? `<span class="count-badge copy-all-group-count" title="${items.length} annotation${items.length !== 1 ? 's' : ''}">${items.length}</span>`
        : '';
      html += `<div class="url-group">
        <div class="url-header">
          ${countBadge}
          <div class="url-label url-label--clickable copy-all-group-url" title="${escHtml(url)}" data-nav-url="${escHtml(url)}">${escHtml(url)}</div>
          <button class="url-copy-btn" data-url="${escHtml(url)}" title="Copy group as Markdown">📋 Copy group</button>
          <button class="url-clear-group-btn" data-url="${escHtml(url)}" title="Clear group (saves to history)">🗑</button>
        </div>`;
      items.forEach(ann => {
        const sel = getSelector(ann);
        const isPageLevel = !!(ann.pageLevel || ann.tag === 'page');
        html += `
        <div class="item${isPageLevel ? ' item--page-level' : ''}">
          <div class="item-sel">
            <code class="ann-code--clickable" data-nav-ann-id="${escHtml(ann.id)}" title="Click to navigate to this annotation">${escHtml(sel)}</code>
            <button class="item-copy-btn" data-ann-id="${escHtml(ann.id)}" title="Copy this annotation">📋</button>
            <button class="item-delete-btn" data-ann-id="${escHtml(ann.id)}" title="Clear annotation">🗑</button>
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
    return html;
  }

  // Format a snapshot's timestamp like "12:34 PM, Tuesday, Apr 30, 2026".
  function formatSnapshotTimestamp(ts) {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      const day  = d.toLocaleDateString(undefined, { weekday: 'long' });
      const date = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      return `${time}, ${day}, ${date}`;
    } catch { return ts; }
  }

  // Reconcile snapshots against the current annotation list: drop any
  // annotation IDs that are no longer in `anns`, and drop any snapshot whose
  // annotation set is empty. Returns the surviving snapshots.
  function reconcileSnapshots(snapshots, anns) {
    const liveIds = new Set(anns.map(a => a.id));
    const out = [];
    snapshots.forEach(s => {
      const ids  = (Array.isArray(s.annotationIds) ? s.annotationIds : []).filter(id => liveIds.has(id));
      if (ids.length > 0) out.push({ ...s, annotationIds: ids });
    });
    return out;
  }

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
      // Also clear stale snapshots so they don't reappear next time we have
      // annotations.
      chrome.storage.local.set({ [COPY_ALL_SNAPSHOTS_KEY]: [] });
      return;
    }

    chrome.storage.local.get({ [COPY_ALL_SNAPSHOTS_KEY]: [] }, snapR => {
      const rawSnaps  = snapR[COPY_ALL_SNAPSHOTS_KEY] || [];
      const snapshots = reconcileSnapshots(rawSnaps, anns);
      // Persist reconciliation if we actually trimmed anything.
      if (snapshots.length !== rawSnaps.length ||
          snapshots.some((s, i) => (rawSnaps[i] && s.annotationIds.length !== (rawSnaps[i].annotationIds || []).length))) {
        chrome.storage.local.set({ [COPY_ALL_SNAPSHOTS_KEY]: snapshots });
      }

      // Annotations covered by any snapshot become "boxed"; the rest are loose.
      const boxedIds = new Set();
      snapshots.forEach(s => (s.annotationIds || []).forEach(id => boxedIds.add(id)));
      const annsById = new Map(anns.map(a => [a.id, a]));
      const looseAnns = anns.filter(a => !boxedIds.has(a.id));

      let html = '';

      // Render each snapshot ("big box") in the order they were captured.
      snapshots.forEach(snap => {
        const ids = snap.annotationIds || [];
        const innerAnns = ids.map(id => annsById.get(id)).filter(Boolean);
        const expanded  = !!snap.expanded;
        const when      = formatSnapshotTimestamp(snap.timestamp);
        html += `
        <div class="copy-all-snapshot${expanded ? ' expanded' : ''}" data-snap-id="${escHtml(snap.id)}">
          <div class="copy-all-header" data-snap-toggle="${escHtml(snap.id)}" role="button" tabindex="0" title="Click to ${expanded ? 'collapse' : 'expand'}">
            <span class="copy-all-caret" aria-hidden="true">▸</span>
            <span class="copy-all-title">📋 ${innerAnns.length} annotation${innerAnns.length !== 1 ? 's' : ''} copied</span>
            <span class="copy-all-meta" title="${escHtml(snap.timestamp)}">at ${escHtml(when)}</span>
            <span class="copy-all-spacer"></span>
            <button class="copy-all-action copy-all-save" data-snap-id="${escHtml(snap.id)}" title="Save these annotations for later">💾 Save for later</button>
            <button class="copy-all-action copy-all-clear" data-snap-id="${escHtml(snap.id)}" title="Clear (move to history)">🗑 Clear</button>
            <button class="copy-all-action copy-all-collapse" data-snap-collapse="${escHtml(snap.id)}" title="Collapse">▴</button>
          </div>
          <div class="copy-all-summary">
            ${(() => {
              // Collapsed view: one row per URL group with a leading count badge.
              const byUrl = {};
              innerAnns.forEach(a => (byUrl[a.url] = byUrl[a.url] || []).push(a));
              return Object.entries(byUrl).map(([url, items]) => `
                <div class="copy-all-summary-row" data-snap-jump="${escHtml(snap.id)}" data-jump-url="${escHtml(url)}" role="button" tabindex="0" title="Click to expand and jump to this group">
                  <span class="count-badge copy-all-group-count">${items.length}</span>
                  <span class="copy-all-group-url" title="${escHtml(url)}">${escHtml(url)}</span>
                </div>`).join('');
            })()}
          </div>
          <div class="copy-all-body">
            ${buildGroupedAnnotationsHTML(innerAnns, { showGroupCount: true })}
          </div>
        </div>`;
      });

      // Render any loose annotations (those not in any snapshot) below.
      if (looseAnns.length > 0) {
        if (snapshots.length > 0) {
          html += `<div class="loose-anns-divider" title="Annotations added since the last Copy All">🆕 Since last Copy All</div>`;
        }
        html += buildGroupedAnnotationsHTML(looseAnns, { showGroupCount: false });
      }

      finishRender(html, anns);
    });
  }

  // Wire up listeners + finalize the rendered list.
  function finishRender(html, anns) {
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
    listEl.querySelectorAll('.url-clear-group-btn').forEach(btn => {
      btn.addEventListener('click', () => clearGroup(btn.dataset.url));
    });
    listEl.querySelectorAll('.item-copy-btn').forEach(btn => {
      btn.addEventListener('click', () => copyAnnotation(btn.dataset.annId));
    });

    // ── Copy-All snapshot listeners ─────────────────────────────────────────
    // Header click (or Enter/Space on focus) toggles expand/collapse.
    listEl.querySelectorAll('[data-snap-toggle]').forEach(hdr => {
      const handler = e => {
        // Don't toggle when interacting with action buttons inside the header.
        if (e.target.closest('button')) return;
        if (e.target.closest('.copy-all-summary-row')) return;
        if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
        if (e.type === 'keydown') e.preventDefault();
        toggleCopyAllSnapshot(hdr.dataset.snapToggle);
      };
      hdr.addEventListener('click',   handler);
      hdr.addEventListener('keydown', handler);
    });
    listEl.querySelectorAll('[data-snap-collapse]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        toggleCopyAllSnapshot(btn.dataset.snapCollapse, false);
      });
    });
    listEl.querySelectorAll('.copy-all-save').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        copyAllSnapshotSaveForLater(btn.dataset.snapId);
      });
    });
    listEl.querySelectorAll('.copy-all-clear').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const ok = await showConfirm('Clear all annotations in this group? They will be moved to history.', { okLabel: 'Clear' });
        if (!ok) return;
        copyAllSnapshotClear(btn.dataset.snapId);
      });
    });
    listEl.querySelectorAll('.copy-all-summary-row').forEach(row => {
      const handler = e => {
        if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
        if (e.type === 'keydown') e.preventDefault();
        e.stopPropagation();
        copyAllSnapshotJump(row.dataset.snapJump, row.dataset.jumpUrl);
      };
      row.addEventListener('click',   handler);
      row.addEventListener('keydown', handler);
    });

    // Re-apply search highlights if search is active
    if (searchActive && searchInput && searchInput.value.trim()) {
      applySearch(searchInput.value.trim());
    }
  }

  // ── Copy-All snapshot ops ────────────────────────────────────────────────
  function updateSnapshot(snapId, mut, cb) {
    chrome.storage.local.get({ [COPY_ALL_SNAPSHOTS_KEY]: [] }, r => {
      const snaps = (r[COPY_ALL_SNAPSHOTS_KEY] || []).map(s =>
        s.id === snapId ? mut(s) : s
      );
      chrome.storage.local.set({ [COPY_ALL_SNAPSHOTS_KEY]: snaps }, () => cb && cb(snaps));
    });
  }

  function toggleCopyAllSnapshot(snapId, force) {
    updateSnapshot(snapId, s => ({ ...s, expanded: typeof force === 'boolean' ? force : !s.expanded }), () => {
      // Local DOM-only toggle to avoid a full re-render (preserves textarea
      // focus, scroll, etc.).
      const el = listEl.querySelector(`.copy-all-snapshot[data-snap-id="${cssEscape(snapId)}"]`);
      if (!el) return;
      if (typeof force === 'boolean') el.classList.toggle('expanded', force);
      else el.classList.toggle('expanded');
    });
  }

  // Helper: minimal CSS-escape for use in attribute selectors.
  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/"/g, '\\"');
  }

  // Save the snapshot's annotations to "saved for later", remove them from
  // current annotations, and drop the snapshot.
  function copyAllSnapshotSaveForLater(snapId) {
    readDedupStorage(r => {
      chrome.storage.local.get({ [COPY_ALL_SNAPSHOTS_KEY]: [] }, snapR => {
        const snaps = snapR[COPY_ALL_SNAPSHOTS_KEY] || [];
        const snap  = snaps.find(s => s.id === snapId);
        if (!snap) return;
        const ids   = (snap.annotationIds || []).filter(Boolean);
        const idSet = new Set(ids);
        const targetAnns = r.annotations.filter(a => idSet.has(a.id));
        if (targetAnns.length === 0) {
          // Snapshot is empty — just drop it.
          chrome.storage.local.set({ [COPY_ALL_SNAPSHOTS_KEY]: snaps.filter(s => s.id !== snapId) },
            () => load());
          return;
        }
        const remaining = r.annotations.filter(a => !idSet.has(a.id));
        const store = { ...(r[ANN_STORE_KEY] || {}) };
        const now   = new Date().toISOString();
        const sflId = `sfl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

        // Mirror doSaveForLater: dedup identical sets, then bump refs.
        const newIdsKey = [...ids].sort().join(',');
        const dropped   = [];
        const dedupedSaved = (r[SAVED_LATER_KEY] || []).filter(s => {
          const sIds = Array.isArray(s.annotationIds) ? s.annotationIds : (s.annotations || []).map(a => a.id);
          const key  = [...sIds].sort().join(',');
          if (key === newIdsKey) { dropped.push(s); return false; }
          return true;
        });
        dropped.forEach(d => {
          const dIds = Array.isArray(d.annotationIds) ? d.annotationIds : (d.annotations || []).map(a => a.id);
          refStoreDec(store, dIds.filter(Boolean));
        });
        targetAnns.forEach(ann => {
          if (!store[ann.id]) store[ann.id] = { ...ann, _refCount: 0 };
          else store[ann.id] = { ...store[ann.id], ...ann };
          store[ann.id]._refCount = (store[ann.id]._refCount || 0) + 1;
        });

        const newSet = { id: sflId, savedAt: now, count: targetAnns.length, annotationIds: ids };
        const newSaved = [...dedupedSaved, newSet];
        const newSnaps = snaps.filter(s => s.id !== snapId);

        isWritingFromPopup = true;
        chrome.storage.local.set({
          annotations: remaining,
          [SAVED_LATER_KEY]: newSaved,
          [ANN_STORE_KEY]: store,
          [COPY_ALL_SNAPSHOTS_KEY]: newSnaps,
        }, () => {
          isWritingFromPopup = false;
          render(remaining);
          targetAnns.forEach(ann => broadcastRemove(ann.id, ann.xpath));
          showToast(`Saved ${targetAnns.length} annotation${targetAnns.length !== 1 ? 's' : ''} for later.`);
        });
      });
    });
  }

  // Clear the snapshot's annotations: move them to history and drop the snapshot.
  function copyAllSnapshotClear(snapId) {
    readDedupStorage(r => {
      chrome.storage.local.get({ [COPY_ALL_SNAPSHOTS_KEY]: [] }, snapR => {
        const snaps = snapR[COPY_ALL_SNAPSHOTS_KEY] || [];
        const snap  = snaps.find(s => s.id === snapId);
        if (!snap) return;
        const idSet = new Set((snap.annotationIds || []).filter(Boolean));
        const targetAnns = r.annotations.filter(a => idSet.has(a.id));
        const remaining  = r.annotations.filter(a => !idSet.has(a.id));
        const store = { ...(r[ANN_STORE_KEY] || {}) };
        let   hist  = r[HISTORY_KEY];
        const now   = new Date().toISOString();
        targetAnns.forEach(ann => {
          const oldRefs = hist.filter(h => h.id === ann.id);
          if (oldRefs.length) refStoreDec(store, oldRefs.map(h => h.id));
          hist = hist.filter(h => h.id !== ann.id);
          if (!store[ann.id]) store[ann.id] = { ...ann, _refCount: 0 };
          else store[ann.id] = { ...store[ann.id], ...ann };
          store[ann.id]._refCount = (store[ann.id]._refCount || 0) + 1;
          hist.push({ id: ann.id, deletedAt: now });
        });
        const newSnaps = snaps.filter(s => s.id !== snapId);
        isWritingFromPopup = true;
        chrome.storage.local.set({
          annotations: remaining,
          [HISTORY_KEY]: hist,
          [ANN_STORE_KEY]: store,
          [COPY_ALL_SNAPSHOTS_KEY]: newSnaps,
        }, () => {
          enforceHistoryLimitInStorage(() => {
            isWritingFromPopup = false;
            render(remaining);
            targetAnns.forEach(ann => broadcastRemove(ann.id, ann.xpath));
            showToast(`Cleared ${targetAnns.length} annotation${targetAnns.length !== 1 ? 's' : ''} (saved to history).`);
          });
        });
      });
    });
  }

  // Expand the snapshot and scroll the clicked URL group's header to the top
  // of the visible scroll area.
  function copyAllSnapshotJump(snapId, url) {
    updateSnapshot(snapId, s => ({ ...s, expanded: true }), () => {
      const snapEl = listEl.querySelector(`.copy-all-snapshot[data-snap-id="${cssEscape(snapId)}"]`);
      if (!snapEl) return;
      snapEl.classList.add('expanded');
      // Find the matching url-group header inside the body.
      const safeUrl = cssEscape(url);
      const target = snapEl.querySelector(
        `.copy-all-body .url-header [data-nav-url="${safeUrl}"]`
      );
      const headerRow = target ? target.closest('.url-header') : null;
      const scrollEl = headerRow || snapEl;
      // Scroll so the URL header is at the top of the viewport.
      try {
        scrollEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
      } catch (_) {
        scrollEl.scrollIntoView();
      }
      if (headerRow) {
        headerRow.classList.add('item-nav-flash');
        setTimeout(() => headerRow.classList.remove('item-nav-flash'), 700);
      }
    });
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

  // ── Update footer button labels from settings ────────────────────────────
  function updateButtonLabels(settings) {
    const btnActions = settings.buttonActions || DEFAULT_SETTINGS.buttonActions;
    const copyLeft   = btnActions.copyBtn?.left   || 'copyAll';
    const copyRight  = btnActions.copyBtn?.right  || 'cutAll';
    const clearLeft  = btnActions.clearBtn?.left  || 'clearAll';
    const clearRight = btnActions.clearBtn?.right || 'saveForLater';

    const copyLeftCfg   = BUTTON_ACTIONS[copyLeft]   || BUTTON_ACTIONS.copyAll;
    const copyRightCfg  = BUTTON_ACTIONS[copyRight]  || BUTTON_ACTIONS.cutAll;
    const clearLeftCfg  = BUTTON_ACTIONS[clearLeft]  || BUTTON_ACTIONS.clearAll;
    const clearRightCfg = BUTTON_ACTIONS[clearRight] || BUTTON_ACTIONS.saveForLater;

    copyBtn.innerHTML = `
      <span>${copyLeftCfg.emoji} ${escHtml(copyLeftCfg.label)}</span>
      <span class="cut-hint">right-click: ${escHtml(copyRightCfg.label.toLowerCase())}</span>`;
    clearBtn.innerHTML = `
      <span>${clearLeftCfg.emoji} ${escHtml(clearLeftCfg.label)}</span>
      <span class="cut-hint">right-click: ${escHtml(clearRightCfg.label.toLowerCase())}</span>`;
  }

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
  // Called on startup: if local storage is empty (e.g. after reinstall) but
  // chrome.storage.sync has data, auto-restores the full bundle so annotations
  // are never lost after reinstalling, without requiring any user action.
  function checkSyncRestore() {
    chrome.storage.local.get({ annotations: [] }, async local => {
      if (local.annotations.length > 0) return; // local has data — no restore needed
      const result = await readFromSync();
      if (!result) return;
      const hasData = (result.annotations   && result.annotations.length   > 0)
                   || (result.history        && result.history.length        > 0)
                   || (result.savedForLater  && result.savedForLater.length  > 0);
      if (!hasData) return;

      // Auto-restore full bundle — no banner required
      const toSet = {};
      if (result.annotations  && result.annotations.length)   toSet.annotations       = result.annotations;
      if (result.history       && result.history.length)       toSet[HISTORY_KEY]      = result.history;
      if (result.copyHistory   && result.copyHistory.length)   toSet[COPY_HISTORY_KEY] = result.copyHistory;
      if (result.savedForLater && result.savedForLater.length) toSet[SAVED_LATER_KEY]  = result.savedForLater;
      if (result.settings && Object.keys(result.settings).length) toSet[SETTINGS_KEY] = result.settings;

      // Reset the migration flag so the legacy-format sync payload is migrated
      // back into the dedup format on this fresh local state.
      toSet[MIGRATION_FLAG] = false;
      toSet[ANN_STORE_KEY]  = {};

      isWritingFromPopup = true;
      chrome.storage.local.set(toSet, () => {
        isWritingFromPopup = false;
        maybeMigrateStorage(() => {
          const anns = result.annotations || [];
          if (anns.length) {
            render(anns);
            anns.forEach(ann => broadcastRestore(ann));
          }
          if (result.settings) {
            if (result.settings.darkMode !== undefined) applyDarkMode(result.settings.darkMode);
            updateButtonLabels({ ...DEFAULT_SETTINGS, ...result.settings });
          }
        });
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
        annotations.forEach(ann => broadcastRestore(ann));
      });
    });

    restoreBanner.querySelector('#restore-dismiss-btn').addEventListener('click', () => {
      restoreBanner.style.display = 'none';
    });
  }

  // ── Search helpers ────────────────────────────────────────────────────────

  // Returns the currently visible content panel to search over
  function getSearchTargetPanel() {
    if (settingsVisible) return settingsEl;
    if (historyVisible)  return historyEl;
    return listEl;
  }

  function openSearch() {
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
    // Clear highlights from all panels we may have touched.
    [listEl, historyEl, settingsEl].forEach(panel => {
      panel.querySelectorAll('.item, .copy-all-snapshot, .sfl-set, .settings-section').forEach(el => {
        el.classList.remove('search-match', 'search-no-match', 'search-current');
      });
      // Restore any text nodes we wrapped in mark.search-hl.
      panel.querySelectorAll('mark.search-hl').forEach(m => {
        const parent = m.parentNode;
        if (!parent) return;
        parent.replaceChild(document.createTextNode(m.textContent), m);
        parent.normalize();
      });
      panel.querySelectorAll('.search-note-match').forEach(el => {
        el.classList.remove('search-note-match');
      });
      // Tear down any input/textarea overlays.
      panel.querySelectorAll('.search-overlay-wrap').forEach(wrap => unwrapSearchOverlay(wrap));
    });
    searchMatches = [];
    if (searchCount) searchCount.textContent = '';
    if (searchCount) delete searchCount.dataset.empty;
  }

  // Wrap a textarea/input with an overlay that mirrors content + highlight marks.
  // Returns the inner highlight container we can write to.
  function wrapSearchOverlay(field) {
    const parent = field.parentNode;
    if (!parent) return null;
    const wrap = document.createElement('span');
    wrap.className = 'search-overlay-wrap';
    const isTextarea = field.tagName === 'TEXTAREA';
    wrap.dataset.kind = isTextarea ? 'textarea' : 'input';
    parent.insertBefore(wrap, field);
    const overlay = document.createElement('div');
    overlay.className = 'search-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    wrap.appendChild(overlay);
    wrap.appendChild(field);
    field.classList.add('search-overlay-host');
    // Copy the field's font + padding metrics to the overlay so the marks line
    // up character-for-character with the underlying field text.
    const cs = window.getComputedStyle(field);
    overlay.style.font           = cs.font;
    overlay.style.lineHeight     = cs.lineHeight;
    overlay.style.letterSpacing  = cs.letterSpacing;
    overlay.style.padding        = cs.padding;
    overlay.style.borderWidth    = cs.borderWidth;
    overlay.style.borderStyle    = cs.borderStyle;
    overlay.style.boxSizing      = cs.boxSizing;
    overlay.style.borderRadius   = cs.borderRadius;
    overlay.style.textAlign      = cs.textAlign;
    if (!isTextarea) overlay.style.whiteSpace = 'pre';
    syncSearchOverlay(field);
    field.addEventListener('input',  syncSearchOverlayHandler);
    field.addEventListener('scroll', syncSearchOverlayScrollHandler);
    return overlay;
  }

  function syncSearchOverlayHandler(e) { syncSearchOverlay(e.target); }
  function syncSearchOverlayScrollHandler(e) {
    const wrap = e.target.closest('.search-overlay-wrap');
    const overlay = wrap?.querySelector('.search-overlay');
    if (overlay) {
      overlay.scrollTop  = e.target.scrollTop;
      overlay.scrollLeft = e.target.scrollLeft;
    }
  }

  function syncSearchOverlay(field) {
    const wrap    = field.parentNode;
    if (!wrap || !wrap.classList || !wrap.classList.contains('search-overlay-wrap')) return;
    const overlay = wrap.querySelector('.search-overlay');
    if (!overlay) return;
    const term = (searchInput && searchInput.value.trim()) || '';
    overlay.innerHTML = renderHighlightedText(field.value, term);
    overlay.scrollTop  = field.scrollTop;
    overlay.scrollLeft = field.scrollLeft;
  }

  function unwrapSearchOverlay(wrap) {
    const field = wrap.querySelector('textarea, input');
    if (field) {
      field.classList.remove('search-overlay-host');
      field.removeEventListener('input',  syncSearchOverlayHandler);
      field.removeEventListener('scroll', syncSearchOverlayScrollHandler);
      wrap.parentNode.insertBefore(field, wrap);
    }
    wrap.remove();
  }

  // Build escaped-HTML where every occurrence of term is wrapped in <mark>.
  function renderHighlightedText(text, term) {
    const safe = escHtml(text || '');
    if (!term) return safe;
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re  = new RegExp(`(${esc})`, 'gi');
    return safe.replace(re, '<mark class="search-hl">$1</mark>');
  }

  // Wrap matches in plain DOM text nodes (no rich formatting, e.g. <code>, .hist-note,
  // labels, hint paragraphs). Walks only text-node descendants of root.
  function highlightTextNodes(root, term) {
    if (!root || !term) return false;
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re  = new RegExp(esc, 'gi');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        // Skip text inside our own marks, scripts, and form controls' UA shadow.
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = node.parentNode;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.nodeName === 'SCRIPT' || p.nodeName === 'STYLE') return NodeFilter.FILTER_REJECT;
        if (p.classList && p.classList.contains('search-hl')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const targets = [];
    let n; while ((n = walker.nextNode())) targets.push(n);
    let any = false;
    targets.forEach(textNode => {
      const text = textNode.nodeValue;
      re.lastIndex = 0;
      if (!re.test(text)) return;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let lastIdx = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m.index > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
        const mark = document.createElement('mark');
        mark.className = 'search-hl';
        mark.textContent = m[0];
        frag.appendChild(mark);
        lastIdx = m.index + m[0].length;
        if (m[0].length === 0) re.lastIndex++; // safety
      }
      if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
      textNode.parentNode.replaceChild(frag, textNode);
      any = true;
    });
    return any;
  }

  // ── Apply search to a single "card" element. Returns true if the card matched. ─
  function applySearchToCard(card, term, termLower) {
    let matched = false;

    // 1. Plain-text content elements
    const textEls = card.querySelectorAll(
      'code, .hist-note, .url-label, .copy-hist-preview, ' +
      '.settings-label, .settings-hint, .settings-row-title, .settings-row-sub, ' +
      '.settings-section-title, .settings-value, ' +
      '.copy-all-meta, .copy-all-group-url, .copy-all-group-count'
    );
    textEls.forEach(el => {
      if ((el.textContent || '').toLowerCase().includes(termLower)) {
        if (highlightTextNodes(el, term)) matched = true;
      }
    });

    // 2. Form controls — textarea/input/select. Wrap with overlay for live highlight.
    const fields = card.querySelectorAll('textarea, input[type="text"], input:not([type])');
    fields.forEach(field => {
      const v = (field.value || '').toLowerCase();
      if (!v.includes(termLower)) return;
      matched = true;
      field.classList.add('search-note-match');
      // Re-use a wrap if already there from a previous match in same panel.
      if (!field.parentNode.classList || !field.parentNode.classList.contains('search-overlay-wrap')) {
        wrapSearchOverlay(field);
      } else {
        syncSearchOverlay(field);
      }
    });

    // 3. <select> can't host marks; just flag the row if the visible option matches.
    card.querySelectorAll('select').forEach(sel => {
      const opt = sel.options[sel.selectedIndex];
      const txt = (opt && opt.textContent ? opt.textContent : '').toLowerCase();
      if (txt.includes(termLower)) matched = true;
    });

    // 4. contenteditable nodes (none currently in popup, but supported defensively).
    card.querySelectorAll('[contenteditable="true"], [contenteditable=""]').forEach(ce => {
      if ((ce.textContent || '').toLowerCase().includes(termLower)) {
        if (highlightTextNodes(ce, term)) matched = true;
      }
    });

    return matched;
  }

  function applySearch(term) {
    clearSearchHighlights();
    if (!term) return;

    const termLower = term.toLowerCase();
    searchMatches = [];

    const panel = getSearchTargetPanel();

    if (panel === settingsEl) {
      // Settings: each top-level section is a "card"; do not dim non-matching
      // sections (settings is meant to be browseable while searching).
      panel.querySelectorAll('.settings-section').forEach(section => {
        if (applySearchToCard(section, term, termLower)) {
          section.classList.add('search-match');
          searchMatches.push(section);
        }
      });
    } else {
      // List or History: use either .item or .copy-all-snapshot or .sfl-set
      // as the unit. .copy-all-snapshot is treated as a single match group; if
      // any nested .item inside matches, the snapshot expands and the inner
      // .item is added to the match list instead, so navigation is precise.
      const cards = panel.querySelectorAll(
        '.copy-all-snapshot, .sfl-set, .item:not(.copy-all-snapshot .item)'
      );
      // First pass: snapshots — auto-expand if any match inside.
      panel.querySelectorAll('.copy-all-snapshot').forEach(snap => {
        const inner = snap.querySelectorAll('.item');
        let anyInner = false;
        inner.forEach(item => {
          if (applySearchToCard(item, term, termLower)) {
            item.classList.add('search-match');
            searchMatches.push(item);
            anyInner = true;
          }
        });
        // Also search the snapshot's header (timestamp / count) and the
        // collapsed summary rows (per-group URLs + counts) so collapsed boxes
        // are still findable.
        const head = snap.querySelector('.copy-all-header');
        const summary = snap.querySelector('.copy-all-summary');
        const headMatch = (head && applySearchToCard(head, term, termLower)) ||
                          (summary && applySearchToCard(summary, term, termLower));
        if (anyInner || headMatch) {
          snap.classList.add('search-match');
          if (anyInner) snap.dataset.searchAutoExpanded = 'true';
        }
      });
      // Second pass: top-level .item cards (not inside any .copy-all-snapshot).
      panel.querySelectorAll('.item').forEach(item => {
        if (item.closest('.copy-all-snapshot')) return; // handled above
        if (applySearchToCard(item, term, termLower)) {
          item.classList.add('search-match');
          searchMatches.push(item);
        } else {
          item.classList.add('search-no-match');
        }
      });
      // Saved-for-later sets (history panel)
      panel.querySelectorAll('.sfl-set').forEach(set => {
        if (applySearchToCard(set, term, termLower)) {
          set.classList.add('search-match');
          searchMatches.push(set);
        } else {
          set.classList.add('search-no-match');
        }
      });
    }

    searchCurrentIdx = 0;
    scrollToCurrentMatch();
    updateSearchCount();
  }

  function scrollToCurrentMatch() {
    if (searchMatches.length === 0) return;
    searchMatches.forEach((el, i) => {
      el.classList.toggle('search-current', i === searchCurrentIdx);
    });
    const cur = searchMatches[searchCurrentIdx];
    if (!cur) return;
    // If the current card lives inside a collapsed snapshot, expand the snapshot
    // first so the match becomes visible.
    const snap = cur.closest && cur.closest('.copy-all-snapshot');
    if (snap && !snap.classList.contains('expanded')) {
      snap.classList.add('expanded');
    }
    cur.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    // For form controls, also select the first occurrence of the term so
    // browser-native highlighting falls precisely on the matched range.
    const term = (searchInput && searchInput.value.trim()) || '';
    if (term) {
      const field = cur.querySelector('textarea.search-note-match, input.search-note-match');
      if (field && typeof field.setSelectionRange === 'function') {
        const v = field.value || '';
        const idx = v.toLowerCase().indexOf(term.toLowerCase());
        if (idx >= 0) {
          try { field.setSelectionRange(idx, idx + term.length); } catch (_) {}
        }
      }
    }
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
    chrome.storage.local.get({ [HISTORY_KEY]: [], [ANN_STORE_KEY]: {} }, r => {
      const hist  = r[HISTORY_KEY];
      const store = r[ANN_STORE_KEY] || {};

      if (hist.length === 0) {
        historyEl.innerHTML = historyTabsHTML('annotations') +
          `<p class="empty-msg">No annotation history yet.<br>Deleted annotations will appear here.</p>`;
        attachTabListeners();
        return;
      }

      // Dereference history into full ann objects, dropping orphans.
      const sorted = [];
      [...hist].reverse().forEach(h => {
        const full = resolveRef(h, store);
        if (!full) return; // orphan ref — skip rendering
        sorted.push({ ...full, deletedAt: h.deletedAt || full.deletedAt });
      });
      const byUrl  = {};
      sorted.forEach(ann => (byUrl[ann.url] = byUrl[ann.url] || []).push(ann));

      let html = historyTabsHTML('annotations');
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
              <button class="hist-perm-delete-btn"
                data-ann-id="${escHtml(ann.id)}"
                data-deleted-at="${escHtml(ann.deletedAt || '')}"
                title="Permanently delete">✕</button>
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

      historyEl.querySelectorAll('.hist-perm-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => permDeleteAnnotationHistory(btn.dataset.annId, btn.dataset.deletedAt));
      });

      // Re-apply search highlights if search is active
      if (searchActive && searchInput && searchInput.value.trim()) {
        applySearch(searchInput.value.trim());
      }
    });
  }

  function permDeleteAnnotationHistory(annId, deletedAt) {
    chrome.storage.local.get({ [HISTORY_KEY]: [], [ANN_STORE_KEY]: {} }, r => {
      const removed = r[HISTORY_KEY].filter(a => a.id === annId && a.deletedAt === deletedAt);
      const newHist = r[HISTORY_KEY].filter(a => !(a.id === annId && a.deletedAt === deletedAt));
      const store   = { ...(r[ANN_STORE_KEY] || {}) };
      refStoreDec(store, removed.map(h => h.id));
      chrome.storage.local.set({ [HISTORY_KEY]: newHist, [ANN_STORE_KEY]: store }, () => renderAnnotationHistory());
    });
  }

  function renderSavedForLater() {
    chrome.storage.local.get({ [SAVED_LATER_KEY]: [], [ANN_STORE_KEY]: {} }, r => {
      const sets  = r[SAVED_LATER_KEY] || [];
      const store = r[ANN_STORE_KEY] || {};
      if (sets.length === 0) {
        historyEl.innerHTML = historyTabsHTML('saved') +
          `<p class="empty-msg">No saved-for-later sets yet.<br>Right-click <strong>🗑 Clear All</strong> to save the current annotations here.</p>`;
        attachTabListeners();
        return;
      }

      let html = historyTabsHTML('saved');
      [...sets].reverse().forEach(set => {
        const when  = formatTimestamp(set.savedAt);
        // Resolve references; fall back to legacy inline annotations array.
        const resolved = Array.isArray(set.annotationIds)
          ? resolveList(set.annotationIds, store)
          : (set.annotations || []);
        const items = resolved.slice(0, 50);
        html += `
        <div class="sfl-set" data-set-id="${escHtml(set.id)}">
          <div class="sfl-set-header">
            <span class="sfl-set-meta">📅 ${escHtml(when)} · ${set.count || items.length} annotation${(set.count || items.length) !== 1 ? 's' : ''}</span>
            <div class="sfl-set-actions">
              <button class="hist-restore-btn sfl-restore" data-set-id="${escHtml(set.id)}" title="Restore these annotations">↺</button>
              <button class="sfl-set-btn sfl-set-btn--danger sfl-delete" data-set-id="${escHtml(set.id)}" title="Delete this set">🗑</button>
            </div>
          </div>
          <ul class="sfl-set-list">
            ${items.map(ann => {
              const sel = getSelector(ann);
              const note = ann.comment && ann.comment.trim() ? ann.comment.trim() : '(no note)';
              return `<li><code>${escHtml(sel)}</code>${escHtml(note.slice(0, 120))}${note.length > 120 ? '…' : ''}</li>`;
            }).join('')}
            ${resolved.length > items.length
              ? `<li><em>+${resolved.length - items.length} more…</em></li>`
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
        btn.addEventListener('click', async () => {
          const ok = await showConfirm('Delete this saved-for-later set? This cannot be undone.', { okLabel: 'Delete' });
          if (!ok) return;
          deleteSavedForLaterSet(btn.dataset.setId);
        });
      });
    });
  }

  function restoreSavedForLaterSet(setId) {
    readDedupStorage(r => {
      const set = r[SAVED_LATER_KEY].find(s => s.id === setId);
      if (!set) return;
      const store = { ...(r[ANN_STORE_KEY] || {}) };

      const annotations = Array.isArray(set.annotationIds)
        ? resolveList(set.annotationIds, store)
        : (set.annotations || []);
      const idsInSet = Array.isArray(set.annotationIds)
        ? set.annotationIds
        : (set.annotations || []).map(a => a.id);

      const existing = new Set(r.annotations.map(a => a.id));
      const toAdd    = annotations.filter(a => !existing.has(a.id));
      const merged   = [...r.annotations, ...toAdd];
      const newSaved = r[SAVED_LATER_KEY].filter(s => s.id !== setId);

      // Decrement refs for every id this set used to hold.
      refStoreDec(store, idsInSet.filter(Boolean));

      isWritingFromPopup = true;
      chrome.storage.local.set({
        annotations: merged,
        [SAVED_LATER_KEY]: newSaved,
        [ANN_STORE_KEY]: store,
      }, () => {
        isWritingFromPopup = false;
        toAdd.forEach(ann => broadcastRestore(ann));
        renderSavedForLater();
      });
    });
  }

  function deleteSavedForLaterSet(setId) {
    chrome.storage.local.get({ [SAVED_LATER_KEY]: [], [ANN_STORE_KEY]: {} }, r => {
      const set = r[SAVED_LATER_KEY].find(s => s.id === setId);
      const newSaved = r[SAVED_LATER_KEY].filter(s => s.id !== setId);
      const store    = { ...(r[ANN_STORE_KEY] || {}) };
      if (set) {
        const ids = Array.isArray(set.annotationIds)
          ? set.annotationIds
          : (set.annotations || []).map(a => a.id);
        refStoreDec(store, ids.filter(Boolean));
      }
      chrome.storage.local.set({ [SAVED_LATER_KEY]: newSaved, [ANN_STORE_KEY]: store }, () => renderSavedForLater());
    });
  }

  function renderCopyHistory() {
    chrome.storage.local.get({ [COPY_HISTORY_KEY]: [] }, r => {
      const copyHist = r[COPY_HISTORY_KEY];

      if (copyHist.length === 0) {
        historyEl.innerHTML = historyTabsHTML('copies') +
          `<p class="empty-msg">No copy history yet.<br>Use the copy button to record an output here.</p>`;
        attachTabListeners();
        return;
      }

      let html = historyTabsHTML('copies');
      [...copyHist].reverse().forEach(entry => {
        const idCount = Array.isArray(entry.annotationIds) ? entry.annotationIds.length : 0;
        // Change 1: "remove from current annotations" button — only useful when
        // the entry has tracked annotation IDs (legacy entries have none).
        const removeFromCurrentBtn = idCount > 0
          ? `<button class="copy-hist-remove-current-btn"
                  data-ts="${escHtml(entry.timestamp)}"
                  title="Remove these annotations from your current annotations">⤺ Remove from current</button>`
          : '';
        html += `
        <div class="item copy-hist-item">
          <div class="copy-hist-header">
            <span class="hist-ts">📋 ${escHtml(formatTimestamp(entry.timestamp))}</span>
            <span class="copy-hist-count">${entry.count} annotation${entry.count !== 1 ? 's' : ''}</span>
            ${removeFromCurrentBtn}
            <button class="copy-hist-perm-delete-btn" data-ts="${escHtml(entry.timestamp)}" title="Permanently delete">✕</button>
          </div>
          <div class="copy-hist-preview">${escHtml(entry.output)}</div>
        </div>`;
      });

      historyEl.innerHTML = html;
      attachTabListeners();
      attachExternalLinks(historyEl);

      historyEl.querySelectorAll('.copy-hist-perm-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const ts = btn.dataset.ts;
          chrome.storage.local.get({ [COPY_HISTORY_KEY]: [], [ANN_STORE_KEY]: {} }, r => {
            const removed = r[COPY_HISTORY_KEY].filter(c => c.timestamp === ts);
            const newHist = r[COPY_HISTORY_KEY].filter(c => c.timestamp !== ts);
            const store   = { ...(r[ANN_STORE_KEY] || {}) };
            removed.forEach(c => refStoreDec(store, refIds(c.annotationIds)));
            chrome.storage.local.set({
              [COPY_HISTORY_KEY]: newHist,
              [ANN_STORE_KEY]:    store,
            }, () => renderCopyHistory());
          });
        });
      });

      // Change 1: "Remove from current annotations" button handlers.
      historyEl.querySelectorAll('.copy-hist-remove-current-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const ts = btn.dataset.ts;
          removeCopyLogFromCurrent(ts);
        });
      });

      // Re-apply search highlights if search is active
      if (searchActive && searchInput && searchInput.value.trim()) {
        applySearch(searchInput.value.trim());
      }
    });
  }

  // ── Change 1: remove all annotations from the current set that came from
  //    a particular copy log. Returns to the main annotations view and shows
  //    the existing undo banner template so the action is reversible.
  function removeCopyLogFromCurrent(timestamp) {
    readDedupStorage(r => {
      const entry = r[COPY_HISTORY_KEY].find(c => c.timestamp === timestamp);
      if (!entry) { showToast('Copy log entry not found.', { kind: 'error' }); return; }
      const targetIds = Array.isArray(entry.annotationIds) ? entry.annotationIds : [];
      if (targetIds.length === 0) {
        showToast('This copy log has no linked annotations to remove.');
        return;
      }
      const targetSet = new Set(targetIds);
      const removed   = r.annotations.filter(a => targetSet.has(a.id));
      const remaining = r.annotations.filter(a => !targetSet.has(a.id));

      if (removed.length === 0) {
        showToast('None of those annotations are in your current set.');
        // Still close history view so the user lands on annotations.
        hideHistory();
        return;
      }

      // Snapshot copies of the removed annotations so undo can put them back
      // exactly as-is, then clear them from the active set. Don't bump the
      // ref store — the undo banner restores from the closure.
      isWritingFromPopup = true;
      chrome.storage.local.set({ annotations: remaining }, () => {
        isWritingFromPopup = false;
        removed.forEach(ann => broadcastRemove(ann.id, ann.xpath));
        // Switch back to the main annotations view first.
        hideHistory();
        // Show undo banner using the existing template.
        showCopyLogRemoveUndoBanner(removed, entry);
      });
    });
  }

  // Reuses the existing undo banner element + styling. Restoring puts the
  // removed annotations back into the active set verbatim.
  function showCopyLogRemoveUndoBanner(removedAnns, copyLogEntry) {
    undoClearData = null; // cancel any in-flight clear-undo state
    clearTimeout(undoBannerTimer);

    const count = removedAnns.length;
    const when  = formatTimestamp(copyLogEntry.timestamp);
    const text  = `Removed ${count} annotation${count !== 1 ? 's' : ''} from copy log (${when}) from your current annotations`;

    clearUndoBanner.innerHTML = `
      <span class="undo-banner-text">${escHtml(text)}</span>
      <button id="undo-clear-btn" class="undo-clear-btn">Undo</button>
    `;
    clearUndoBanner.style.display = 'flex';

    const btn = document.getElementById('undo-clear-btn');
    btn.addEventListener('click', () => {
      hideClearUndoBanner();
      readDedupStorage(r => {
        const existingIds = new Set(r.annotations.map(a => a.id));
        const toAdd = removedAnns.filter(a => !existingIds.has(a.id));
        const merged = [...r.annotations, ...toAdd];
        isWritingFromPopup = true;
        chrome.storage.local.set({ annotations: merged }, () => {
          isWritingFromPopup = false;
          render(merged);
          toAdd.forEach(ann => broadcastRestore(ann));
        });
      });
    });

    undoBannerTimer = setTimeout(hideClearUndoBanner, 5000);
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
    const premium = isPremium(); // always true — all features unlocked
    loadSettings(s => {
      // All features are always enabled — no license key required
      const licenseSection = `
        <div class="settings-section">
          <div class="settings-section-title">⭐ Features</div>
          <div class="settings-row">
            <span class="settings-label">Status</span>
            <span class="settings-value premium-active-badge">✅ All Features Enabled</span>
          </div>
        </div>`;
      buildAndInjectSettings(s, licenseSection, premium);
    });
  }

  function buildAndInjectSettings(s, licenseSection, premium) {
    const currentMod      = s.shortcut?.modifier || 'alt';
    const currentLabel    = escHtml(MODIFIER_LABELS[currentMod] || 'Alt');
    const currentMaxHist  = (s.maxHistoryLength !== undefined && s.maxHistoryLength !== null)
      ? s.maxHistoryLength : 100;
    const isIndefiniteHist = currentMaxHist === 0;

    // Button action current values
    const btnActions    = s.buttonActions || DEFAULT_SETTINGS.buttonActions;
    const copyBtnLeft   = btnActions.copyBtn?.left   || 'copyAll';
    const copyBtnRight  = btnActions.copyBtn?.right  || 'cutAll';
    const clearBtnLeft  = btnActions.clearBtn?.left  || 'clearAll';
    const clearBtnRight = btnActions.clearBtn?.right || 'saveForLater';

    // Build <option> list for a given action key
    const actionOptions = (selected) => Object.entries(BUTTON_ACTIONS)
      .map(([key, cfg]) =>
        `<option value="${escHtml(key)}" ${selected === key ? 'selected' : ''}>${cfg.emoji} ${escHtml(cfg.label)}</option>`)
      .join('');

    settingsEl.innerHTML = `
      <!-- ── Annotation Shortcut ── -->
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
        <div class="settings-row" id="open-popup-shortcut-row">
          <div class="settings-row-label">
            <div class="settings-row-title">Open popup shortcut</div>
            <div class="settings-row-sub">
              Default: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>.
              Click to customize in Chrome.
            </div>
          </div>
          <button id="open-popup-shortcut-btn" class="btn-secondary">Customize…</button>
        </div>
      </div>

      <!-- ── Button Actions ── -->
      <div class="settings-section">
        <div class="settings-section-title">🖱 Button Actions</div>
        <div class="settings-row">
          <label class="settings-label" for="copy-btn-left">Left button · left click</label>
          <select id="copy-btn-left" class="shortcut-select">${actionOptions(copyBtnLeft)}</select>
        </div>
        <div class="settings-row">
          <label class="settings-label" for="copy-btn-right">Left button · right click</label>
          <select id="copy-btn-right" class="shortcut-select">${actionOptions(copyBtnRight)}</select>
        </div>
        <div class="settings-row">
          <label class="settings-label" for="clear-btn-left">Right button · left click</label>
          <select id="clear-btn-left" class="shortcut-select">${actionOptions(clearBtnLeft)}</select>
        </div>
        <div class="settings-row">
          <label class="settings-label" for="clear-btn-right">Right button · right click</label>
          <select id="clear-btn-right" class="shortcut-select">${actionOptions(clearBtnRight)}</select>
        </div>
      </div>

      <!-- ── Auto-Backup ── -->
      <div class="settings-section" id="backup-status-section">
        <div class="settings-section-title">💾 Auto-Backup</div>
        <div class="settings-row settings-row--toggle">
          <span class="settings-label">Enable Auto-Backup</span>
          <div class="toggle-wrap">
            <label class="toggle-switch">
              <input type="checkbox" id="backup-enabled-toggle" ${s.backupEnabled !== false ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
        <div class="settings-row">
          <span class="settings-label">Sync backup</span>
          <span class="settings-value" id="sync-backup-status">Checking…</span>
        </div>
        <div class="settings-row">
          <span class="settings-label">Local backup</span>
          <span class="settings-value" id="file-backup-status">Checking…</span>
        </div>
        <p class="settings-hint" style="margin-top:4px;">
          Annotations and history live on your device (chrome.storage.local). Auto-Backup mirrors a compressed snapshot to Chrome Sync (chrome.storage.sync) so it follows your Google account across signed-in Chrome installs. Sync is end-to-end encrypted by Google when you set a Sync passphrase. Disable Auto-Backup to keep data strictly local.
        </p>
        <div class="settings-row" style="justify-content:flex-end;margin-top:4px;">
          <button id="backup-now-btn" class="btn-history-action">⚡ Backup Now</button>
        </div>
      </div>

      <!-- ── History ── -->
      <div class="settings-section">
        <div class="settings-section-title">📜 History</div>
        <div class="settings-row">
          <label class="settings-label" for="max-history-input">
            Max length
          </label>
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
              <input type="checkbox" id="indefinite-history"
                ${isIndefiniteHist ? 'checked' : ''} />
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

      <!-- ── Appearance ── -->
      <div class="settings-section">
        <div class="settings-section-title">🌙 Appearance</div>
        <div class="settings-row settings-row--toggle">
          <span class="settings-label">Dark Mode</span>
          <div class="toggle-wrap">
            <label class="toggle-switch">
              <input type="checkbox" id="dark-mode-toggle" ${s.darkMode ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
      </div>

      <!-- ── Markdown Copy ── -->
      <div class="settings-section">
        <div class="settings-section-title">📝 Markdown Copy</div>
        <div class="settings-field">
          <label class="settings-label" for="prepend-text">Prepend Text</label>
          <textarea
            id="prepend-text"
            class="settings-textarea"
            placeholder="Text added before the markdown output…"
          >${escHtml(s.prependText || '')}</textarea>
        </div>
        <div class="settings-field">
          <label class="settings-label" for="append-text">Append Text</label>
          <textarea
            id="append-text"
            class="settings-textarea"
            placeholder="Text added after the markdown output…"
          >${escHtml(s.appendText || '')}</textarea>
        </div>
      </div>

      <div class="settings-github-row">
        <a href="#" class="meta-link" data-url="https://github.com/asharma2027/ai-dev-annotator/tree/main" title="View source on GitHub">View source on GitHub →</a>
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
          chrome.storage.local.get({ _lastSyncBackup: null, _lastFileBackup: null }, bd => {
            const syncEl = settingsEl.querySelector('#sync-backup-status');
            const fileEl = settingsEl.querySelector('#file-backup-status');
            if (syncEl && bd._lastSyncBackup) syncEl.textContent = '✅ ' + new Date(bd._lastSyncBackup).toLocaleTimeString();
            if (fileEl && bd._lastFileBackup) fileEl.textContent = '✅ ' + new Date(bd._lastFileBackup).toLocaleTimeString();
          });
        }, 3000);
      });
    });

    // ── Shortcut selector ────────────────────────────────────────────────
    const modSelect = settingsEl.querySelector('#shortcut-modifier');
    const preview   = settingsEl.querySelector('#shortcut-preview');
    if (modSelect) {
      modSelect.addEventListener('change', () => {
        const mod = modSelect.value;
        saveSettings({ shortcut: { modifier: mod } });
        if (preview) preview.textContent = MODIFIER_LABELS[mod] || 'Alt';
      });
    }

    // ── Button Actions selects ────────────────────────────────────────────
    // ── Open popup shortcut button ─────────────────────────────────────────
    document.getElementById('open-popup-shortcut-btn')
      ?.addEventListener('click', () => {
        chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
      });

        const selCopyLeft   = settingsEl.querySelector('#copy-btn-left');
    const selCopyRight  = settingsEl.querySelector('#copy-btn-right');
    const selClearLeft  = settingsEl.querySelector('#clear-btn-left');
    const selClearRight = settingsEl.querySelector('#clear-btn-right');

    function saveButtonActions() {
      const actions = {
        copyBtn:  { left: selCopyLeft.value,  right: selCopyRight.value  },
        clearBtn: { left: selClearLeft.value, right: selClearRight.value },
      };
      saveSettings({ buttonActions: actions }, ss => updateButtonLabels(ss));
    }
    [selCopyLeft, selCopyRight, selClearLeft, selClearRight].forEach(sel => {
      if (sel) sel.addEventListener('change', saveButtonActions);
    });

    // ── History settings ─────────────────────────────────────────────────
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
    settingsEl.querySelector('#export-all-btn')?.addEventListener('click', async () => {
      const btn = settingsEl.querySelector('#export-all-btn');
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = '…';
      try {
        const r = await new Promise(res => chrome.storage.local.get({
          annotations: [], [HISTORY_KEY]: [], [COPY_HISTORY_KEY]: [],
          [SAVED_LATER_KEY]: [], [SETTINGS_KEY]: {}, [ANN_STORE_KEY]: {},
        }, res));
        const store = r[ANN_STORE_KEY] || {};
        // Resolve all references back to full annotation objects so exported
        // data is portable and self-contained (no raw IDs).
        const fullHistory = (r[HISTORY_KEY] || []).map(h => {
          const ann = resolveRef(h, store);
          if (!ann) return null;
          return { ...ann, deletedAt: h.deletedAt || ann.deletedAt };
        }).filter(Boolean);
        const fullSaved = (r[SAVED_LATER_KEY] || []).map(set => {
          const anns = Array.isArray(set.annotationIds)
            ? resolveList(set.annotationIds, store)
            : (set.annotations || []);
          return {
            id:          set.id,
            savedAt:     set.savedAt,
            count:       set.count || anns.length,
            annotations: anns,
          };
        });
        const exportedCopyHist = (r[COPY_HISTORY_KEY] || []).map(c => {
          // strip annotationIds — exported format mirrors legacy schema
          const { annotationIds, ...rest } = c;
          return rest;
        });
        const bundle = buildBundle({
          annotations:   r.annotations,
          history:       fullHistory,
          copyHistory:   exportedCopyHist,
          savedForLater: fullSaved,
          settings:      r[SETTINGS_KEY],
        });
        bundle._exported = new Date().toISOString();
        bundle._version  = '1.7.0';
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
        showToast('Export failed: ' + (e?.message || e), { kind: 'error' });
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    });

    // ── Import ALL data ───────────────────────────────────────────────────
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

          try {
            const json = await gunzipToString(new Uint8Array(buf));
            bundle = JSON.parse(json);
          } catch {
            try {
              const txt = new TextDecoder().decode(new Uint8Array(buf));
              bundle = JSON.parse(txt);
            } catch {
              showToast('Invalid file. Please select a valid .annotator export.', { kind: 'error' });
              importAllFile.value = '';
              return;
            }
          }

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

          const ok = await showConfirm(
            `Import this data?\n\n` +
            `• ${unpacked.annotations.length} active annotation(s)\n` +
            `• ${unpacked.history.length} history record(s)\n` +
            `• ${unpacked.savedForLater.length} saved-for-later set(s)\n` +
            `• ${unpacked.copyHistory.length} copy log(s)\n\n` +
            `Existing items will be merged (not overwritten).`,
            { host: settingsEl }
          );
          if (!ok) { importAllFile.value = ''; return; }

          chrome.storage.local.get({
            annotations: [], [HISTORY_KEY]: [], [COPY_HISTORY_KEY]: [],
            [SAVED_LATER_KEY]: [], [SETTINGS_KEY]: {}, [ANN_STORE_KEY]: {},
          }, r => {
            const store = { ...(r[ANN_STORE_KEY] || {}) };
            const annIds  = new Set(r.annotations.map(a => a.id));
            const newAnns = unpacked.annotations.filter(a => !annIds.has(a.id));

            // Imported history is in legacy full-data form; convert to refs.
            const histKeys = new Set(r[HISTORY_KEY].map(a => a.id + '|' + (a.deletedAt || '')));
            const newHistRefs = [];
            unpacked.history.forEach(h => {
              if (!h || !h.id) return;
              const k = h.id + '|' + (h.deletedAt || '');
              if (histKeys.has(k)) return;
              if (!store[h.id]) {
                const { deletedAt, ...rest } = h;
                store[h.id] = { ...rest, _refCount: 0 };
              }
              store[h.id]._refCount = (store[h.id]._refCount || 0) + 1;
              newHistRefs.push({ id: h.id, deletedAt: h.deletedAt });
            });

            const copyTs  = new Set(r[COPY_HISTORY_KEY].map(c => c.timestamp));
            const newCopy = unpacked.copyHistory.filter(c => !copyTs.has(c.timestamp))
              .map(c => Array.isArray(c.annotationIds) ? c : { ...c, annotationIds: [] });

            // Imported saved-for-later: convert to id-references.
            const slIds   = new Set(r[SAVED_LATER_KEY].map(s => s.id));
            const newSL = [];
            unpacked.savedForLater.forEach(set => {
              if (slIds.has(set.id)) return;
              const setAnns = Array.isArray(set.annotationIds)
                ? resolveList(set.annotationIds, store)
                : (set.annotations || []);
              const ids = setAnns.map(a => a.id).filter(Boolean);
              ids.forEach(id => {
                const ann = setAnns.find(a => a.id === id);
                if (!store[id]) store[id] = { ...ann, _refCount: 0 };
                store[id]._refCount = (store[id]._refCount || 0) + 1;
              });
              newSL.push({
                id:           set.id,
                savedAt:      set.savedAt,
                count:        set.count || ids.length,
                annotationIds: ids,
              });
            });

            chrome.storage.local.set({
              annotations:        [...r.annotations,       ...newAnns],
              [HISTORY_KEY]:      [...r[HISTORY_KEY],      ...newHistRefs],
              [COPY_HISTORY_KEY]: [...r[COPY_HISTORY_KEY], ...newCopy],
              [SAVED_LATER_KEY]:  [...r[SAVED_LATER_KEY],  ...newSL],
              [SETTINGS_KEY]:     { ...r[SETTINGS_KEY], ...unpacked.settings },
              [ANN_STORE_KEY]:    store,
            }, () => {
              const newHist = newHistRefs;
              showToast(
                `Imported: ${newAnns.length} annotation(s) · ${newHist.length} history · ` +
                `${newSL.length} saved-for-later · ${newCopy.length} copy log(s)`,
                { kind: 'ok' }
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
    settingsEl.querySelector('#clear-history-settings-btn')?.addEventListener('click', async () => {
      const ok = await showConfirm(
        'Clear all annotation and copy history? This cannot be undone.',
        { okLabel: 'Delete', host: settingsEl }
      );
      if (ok) {
        // Decrement refs for everything in history + copy logs.
        readDedupStorage(r => {
          const store = { ...(r[ANN_STORE_KEY] || {}) };
          (r[HISTORY_KEY] || []).forEach(h => h && h.id && refStoreDec(store, [h.id]));
          (r[COPY_HISTORY_KEY] || []).forEach(c => refStoreDec(store, refIds(c.annotationIds)));
          chrome.storage.local.set({
            [HISTORY_KEY]: [],
            [COPY_HISTORY_KEY]: [],
            [ANN_STORE_KEY]: store,
          }, () => {
            showToast('History cleared.', { kind: 'ok' });
          });
        });
      }
    });

    // ── Backup enabled toggle ────────────────────────────────────────────
    const backupEnabledToggle = settingsEl.querySelector('#backup-enabled-toggle');
    if (backupEnabledToggle) {
      backupEnabledToggle.addEventListener('change', () => {
        saveSettings({ backupEnabled: backupEnabledToggle.checked });
      });
    }

    // ── Dark mode toggle ──────────────────────────────────────────────────
    const darkToggle = settingsEl.querySelector('#dark-mode-toggle');
    if (darkToggle) {
      darkToggle.addEventListener('change', () => {
        saveSettings({ darkMode: darkToggle.checked }, updated => applyDarkMode(updated.darkMode));
      });
    }

    // ── Prepend / append text ─────────────────────────────────────────────
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

  // ── Button action implementations ─────────────────────────────────────────
  function doCopyAll(btn) {
    readDedupStorage(r => {
      if (r.annotations.length === 0) { showToast('No annotations with notes to copy yet.'); return; }
      loadSettings(s => {
        const result = buildMarkdown(r.annotations, s);
        if (!result) { showToast('No annotations with notes to copy yet.'); return; }
        navigator.clipboard.writeText(result.md).then(() => {
          const copyHist = r[COPY_HISTORY_KEY];
          const store    = { ...(r[ANN_STORE_KEY] || {}) };
          // Dedup: if an entry with identical output already exists, dec its ref ids.
          const dups = copyHist.filter(c => (c.output || '').trim() === result.md.trim());
          dups.forEach(d => refStoreDec(store, refIds(d.annotationIds)));
          const dedupedCopyHist = copyHist.filter(c => (c.output || '').trim() !== result.md.trim());
          // Take a snapshot of the annotations that contributed to the markdown
          // (filtered by buildMarkdown's "has comment" rule).
          const contribAnns = r.annotations.filter(a => a.comment && a.comment.trim());
          const contribIds  = contribAnns.map(a => a.id);
          contribAnns.forEach(ann => {
            if (!store[ann.id]) store[ann.id] = { ...ann, _refCount: 0 };
            else store[ann.id] = { ...store[ann.id], ...ann };
            store[ann.id]._refCount = (store[ann.id]._refCount || 0) + 1;
          });
          const ts = new Date().toISOString();
          dedupedCopyHist.push({
            timestamp: ts,
            output:    result.md,
            count:     result.count,
            annotationIds: contribIds,
          });
          // ── Copy-All "big box" snapshot ───────────────────────────────────
          // Group all currently-active annotations (not just contribAnns —
          // empty-note ones still belong to the visual group) into a single
          // collapsed snapshot so the user can collapse/expand and act on the
          // copied set. Annotations stay in r.annotations so future Copy All
          // calls still pick them up.
          chrome.storage.local.get({ [COPY_ALL_SNAPSHOTS_KEY]: [] }, snapR => {
            const prevSnaps = (snapR[COPY_ALL_SNAPSHOTS_KEY] || []);
            // Earlier snapshots may already cover some of these annotations.
            // Subsume any prior snapshot whose annotation set is a subset of
            // the new one (the new copy includes everything they did, plus
            // any newer additions) so we don't end up with overlapping boxes.
            const newIds = new Set(r.annotations.map(a => a.id));
            const survivors = prevSnaps.filter(snap => {
              const ids = Array.isArray(snap.annotationIds) ? snap.annotationIds : [];
              return !ids.every(id => newIds.has(id));
            });
            const newSnap = {
              id: `cas_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              timestamp: ts,
              annotationIds: r.annotations.map(a => a.id),
              expanded: false,
            };
            const newSnaps = [...survivors, newSnap];
            chrome.storage.local.set({
              [COPY_HISTORY_KEY]: dedupedCopyHist,
              [ANN_STORE_KEY]: store,
              [COPY_ALL_SNAPSHOTS_KEY]: newSnaps,
            }, () => {
              // Re-render so the new big box appears immediately. Read the
              // current annotations again (unchanged) and pass them to render.
              chrome.storage.local.get({ annotations: [] }, rr => render(rr.annotations));
            });
          });
          if (btn) {
            const origHtml = btn.innerHTML;
            btn.innerHTML = '<span>✅ Copied!</span>';
            setTimeout(() => (btn.innerHTML = origHtml), 1500);
          }
        }).catch(() => showToast('Clipboard write failed. Try again.', { kind: 'error' }));
      });
    });
  }

  function doCutAll(btn) {
    readDedupStorage(r => {
      if (r.annotations.length === 0) { showToast('No annotations with notes to copy yet.'); return; }
      loadSettings(s => {
        const result = buildMarkdown(r.annotations, s);
        if (!result) { showToast('No annotations with notes to copy yet.'); return; }
        navigator.clipboard.writeText(result.md).then(() => {
          const copyHist = r[COPY_HISTORY_KEY];
          const store    = { ...(r[ANN_STORE_KEY] || {}) };
          const contribAnns = r.annotations.filter(a => a.comment && a.comment.trim());
          const contribIds  = contribAnns.map(a => a.id);
          // Dedup any prior identical copy log entry (decrement its ids).
          const dups = copyHist.filter(c => (c.output || '').trim() === result.md.trim());
          dups.forEach(d => refStoreDec(store, refIds(d.annotationIds)));
          const dedupedCopyHist = copyHist.filter(c => (c.output || '').trim() !== result.md.trim());
          // First write the copy-log refs (which need their own snapshot in store).
          contribAnns.forEach(ann => {
            if (!store[ann.id]) store[ann.id] = { ...ann, _refCount: 0 };
            else store[ann.id] = { ...store[ann.id], ...ann };
            store[ann.id]._refCount = (store[ann.id]._refCount || 0) + 1;
          });
          dedupedCopyHist.push({
            timestamp: new Date().toISOString(),
            output:    result.md,
            count:     result.count,
            annotationIds: contribIds,
          });
          // Then move all annotations into history (refcount each).
          const now  = new Date().toISOString();
          let   hist = r[HISTORY_KEY];
          r.annotations.forEach(ann => {
            const oldRefs = hist.filter(h => h.id === ann.id);
            if (oldRefs.length) refStoreDec(store, oldRefs.map(h => h.id));
            hist = hist.filter(h => h.id !== ann.id);
            if (!store[ann.id]) store[ann.id] = { ...ann, _refCount: 0 };
            else store[ann.id] = { ...store[ann.id], ...ann };
            store[ann.id]._refCount = (store[ann.id]._refCount || 0) + 1;
            hist.push({ id: ann.id, deletedAt: now });
          });
          isWritingFromPopup = true;
          chrome.storage.local.set({
            annotations: [],
            [HISTORY_KEY]: hist,
            [COPY_HISTORY_KEY]: dedupedCopyHist,
            [ANN_STORE_KEY]: store,
          }, () => {
            enforceHistoryLimitInStorage(() => {
              isWritingFromPopup = false;
              render([]);
              r.annotations.forEach(ann => broadcastRemove(ann.id, ann.xpath));
              showClearUndoBanner(r.annotations, now);
            });
          });
          if (btn) {
            const origHtml = btn.innerHTML;
            btn.innerHTML = '<span>✅ Cut!</span>';
            setTimeout(() => (btn.innerHTML = origHtml), 1500);
          }
        }).catch(() => showToast('Clipboard write failed. Try again.', { kind: 'error' }));
      });
    });
  }

  function doClearAll() {
    readDedupStorage(r => {
      const anns = r.annotations;
      if (anns.length === 0) return;
      let   hist  = r[HISTORY_KEY];
      const store = { ...(r[ANN_STORE_KEY] || {}) };
      const now   = new Date().toISOString();
      anns.forEach(ann => {
        const oldRefs = hist.filter(h => h.id === ann.id);
        if (oldRefs.length) refStoreDec(store, oldRefs.map(h => h.id));
        hist = hist.filter(h => h.id !== ann.id);
        if (!store[ann.id]) store[ann.id] = { ...ann, _refCount: 0 };
        else store[ann.id] = { ...store[ann.id], ...ann };
        store[ann.id]._refCount = (store[ann.id]._refCount || 0) + 1;
        hist.push({ id: ann.id, deletedAt: now });
      });
      isWritingFromPopup = true;
      chrome.storage.local.set({
        annotations: [],
        [HISTORY_KEY]: hist,
        [ANN_STORE_KEY]: store,
      }, () => {
        enforceHistoryLimitInStorage(() => {
          isWritingFromPopup = false;
          render([]);
          anns.forEach(ann => broadcastRemove(ann.id, ann.xpath));
          showClearUndoBanner(anns, now, 'cleared');
        });
      });
    });
  }

  function doSaveForLater() {
    readDedupStorage(r => {
      const anns = r.annotations;
      if (anns.length === 0) return;
      const now   = new Date().toISOString();
      const setId = `sfl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const ids   = anns.map(a => a.id);
      const set   = { id: setId, savedAt: now, count: anns.length, annotationIds: ids };
      const store = { ...(r[ANN_STORE_KEY] || {}) };

      // Dedup: if a previous saved set held identical id list, drop it AND
      // dec refs for its ids (preserving previous behavior of "merge identical").
      const newIdsKey = [...ids].sort().join(',');
      const dropped = [];
      const dedupedSaved = r[SAVED_LATER_KEY].filter(s => {
        const sIds = Array.isArray(s.annotationIds) ? s.annotationIds : (s.annotations || []).map(a => a.id);
        const key  = [...sIds].sort().join(',');
        if (key === newIdsKey) { dropped.push(s); return false; }
        return true;
      });
      dropped.forEach(d => {
        const dIds = Array.isArray(d.annotationIds) ? d.annotationIds : (d.annotations || []).map(a => a.id);
        refStoreDec(store, dIds.filter(Boolean));
      });

      // Snapshot each annotation into the store and bump refcount.
      anns.forEach(ann => {
        if (!store[ann.id]) store[ann.id] = { ...ann, _refCount: 0 };
        else store[ann.id] = { ...store[ann.id], ...ann };
        store[ann.id]._refCount = (store[ann.id]._refCount || 0) + 1;
      });

      const newSaved = [...dedupedSaved, set];
      isWritingFromPopup = true;
      chrome.storage.local.set({
        annotations: [],
        [SAVED_LATER_KEY]: newSaved,
        [ANN_STORE_KEY]: store,
      }, () => {
        isWritingFromPopup = false;
        render([]);
        anns.forEach(ann => broadcastRemove(ann.id, ann.xpath));
        showClearUndoBanner(anns, now, 'saved', setId);
      });
    });
  }

  function dispatchBtnAction(action, btn) {
    if      (action === 'copyAll')      doCopyAll(btn);
    else if (action === 'cutAll')       doCutAll(btn);
    else if (action === 'clearAll')     doClearAll();
    else if (action === 'saveForLater') doSaveForLater();
  }

  // ── Left footer button (copy-btn) ────────────────────────────────────────
  copyBtn.addEventListener('click', () => {
    loadSettings(s => {
      const action = s.buttonActions?.copyBtn?.left || 'copyAll';
      dispatchBtnAction(action, copyBtn);
    });
  });

  copyBtn.addEventListener('contextmenu', e => {
    e.preventDefault();
    loadSettings(s => {
      const action = s.buttonActions?.copyBtn?.right || 'cutAll';
      dispatchBtnAction(action, copyBtn);
    });
  });

  // ── Right footer button (clear-btn) ──────────────────────────────────────
  clearBtn.addEventListener('click', () => {
    loadSettings(s => {
      const action = s.buttonActions?.clearBtn?.left || 'clearAll';
      dispatchBtnAction(action, clearBtn);
    });
  });

  clearBtn.addEventListener('contextmenu', e => {
    e.preventDefault();
    loadSettings(s => {
      const action = s.buttonActions?.clearBtn?.right || 'saveForLater';
      dispatchBtnAction(action, clearBtn);
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
    // Run one-shot migration (legacy → dedup) before loading the UI.
    maybeMigrateStorage(() => {
      load();
      checkSyncRestore();
    });
  });

  // Handle scroll-to-annotation intent from content.js element label click
  chrome.storage.local.get({ _popupScrollTarget: null }, r => {
    if (r._popupScrollTarget) {
      const targetAnnId = r._popupScrollTarget;
      chrome.storage.local.remove('_popupScrollTarget');
      setTimeout(() => {
        const codeEl = listEl.querySelector(`[data-nav-ann-id="${targetAnnId}"]`);
        const item = codeEl ? codeEl.closest('.item') : null;
        if (item) {
          item.scrollIntoView({ behavior: 'smooth', block: 'center' });
          item.classList.add('item-nav-flash');
          setTimeout(() => item.classList.remove('item-nav-flash'), 1500);
        }
      }, 350);
    }
  });
});
