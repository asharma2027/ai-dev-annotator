// popup.js : AI Website Dev Annotator

// ─────────────────────────────────────────────────────────────────────────────
// PREMIUM / LICENSE SYSTEM (Stripe + offline Ed25519)
//
// Flow:
//   1. User clicks "Get Premium ($9.99)" on the landing page or in the
//      extension popup → Stripe Payment Link → Stripe checkout.
//   2. After payment Stripe redirects the buyer to docs/success.html with
//      ?session_id=cs_xxx. The page calls our Cloudflare Worker's
//      /license endpoint and shows the license key with a copy button.
//      The same key is also stamped into the Stripe receipt description
//      so it appears in Stripe's automatic receipt email.
//   3. The user pastes the key in Settings → Premium → Activate.
//   4. The extension verifies the signature locally with the public key
//      embedded below — no network call, no allow-list lookup, no
//      runtime dependency on any third party. Works fully offline.
// Security model: same as any signed-license system (1Password, Tana,
// Sublime Text, etc.). The private key never leaves the Worker.
// If it ever leaks, rotate the keypair, ship a new extension version
// with the new public key, and optionally include the old key for a
// transition window.
// ─────────────────────────────────────────────────────────────────────────────

// Stripe Payment Link for the fixed-price $9.99 Premium SKU.
const PREMIUM_PURCHASE_URL = 'https://buy.stripe.com/6oU9AS4Kjc9h6x1bxocfK01';

// Stripe Payment Link for the optional "Leave a tip" flow (custom amount,
// minimum $0.50). Used only by the meta-footer Stripe button.
const TIP_URL = 'https://buy.stripe.com/6oU5kCa4D4GPaNhatkcfK00';

// Ed25519 public key, base64url, no padding. Matches the private key held
// only by the Cloudflare Worker. SAFE to commit — public keys can verify
// signatures but cannot create them.
const LICENSE_PUBLIC_KEY = '9fUNyAhaRFDGxX3sN3uMjfG49Wj4LGEnGiLpYjAamy0';

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
let _premium = false;

function isPremium() {
  return _premium;
}

async function refreshPremiumStatus() {
  const stored = await new Promise(resolve =>
    chrome.storage.local.get({ [LICENSE_STORAGE_KEY]: null }, r =>
      resolve(r[LICENSE_STORAGE_KEY])));
  if (!stored || !stored.key) { _premium = false; return; }
  // Re-verify the stored key on every popup open. This is cheap (pure
  // crypto) and prevents tampering with chrome.storage.local from
  // unlocking premium without a valid signature.
  const verified = await verifyLicenseSignature(stored.key);
  _premium = !!verified.valid;
}

// ─── base64url helpers (no padding) ──────────────────────────────────────────
function _b64uDecode(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function _utf8(s) { return new TextEncoder().encode(s); }
function _bytesToString(bytes) { return new TextDecoder().decode(bytes); }

// Convert a raw 32-byte Ed25519 public key into the SPKI DER format that
// WebCrypto's importKey expects. Per RFC 8410, the SPKI prefix for
// Ed25519 is the fixed 12-byte header below.
function _ed25519RawPubToSpki(raw32) {
  if (raw32.length !== 32) throw new Error(`Ed25519 public key must be 32 bytes, got ${raw32.length}`);
  const prefix = new Uint8Array([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
    0x70, 0x03, 0x21, 0x00,
  ]);
  const out = new Uint8Array(prefix.length + raw32.length);
  out.set(prefix, 0);
  out.set(raw32, prefix.length);
  return out;
}

let _publicKeyPromise = null;
function _getPublicKey() {
  if (!_publicKeyPromise) {
    const spki = _ed25519RawPubToSpki(_b64uDecode(LICENSE_PUBLIC_KEY));
    _publicKeyPromise = crypto.subtle.importKey(
      'spki', spki, { name: 'Ed25519' }, false, ['verify'],
    );
  }
  return _publicKeyPromise;
}

// License key format produced by the Worker:
//   v1.<b64u(email)>.<b64u(sessionId)>.<b64u(issuedAtUnix)>.<b64u(signature)>
// We verify the signature over the joined first four parts.
async function verifyLicenseSignature(key) {
  try {
    const trimmed = String(key || '').trim();
    const parts = trimmed.split('.');
    if (parts.length !== 5) {
      return { valid: false, error: 'License key format looks invalid.' };
    }
    if (parts[0] !== 'v1') {
      return { valid: false, error: 'Unsupported license version.' };
    }
    const payload   = parts.slice(0, 4).join('.');
    const sigBytes  = _b64uDecode(parts[4]);
    const pubKey    = await _getPublicKey();
    const ok = await crypto.subtle.verify(
      { name: 'Ed25519' }, pubKey, sigBytes, _utf8(payload),
    );
    if (!ok) return { valid: false, error: 'Invalid license key.' };
    const email = _bytesToString(_b64uDecode(parts[1]));
    return { valid: true, email };
  } catch (e) {
    return { valid: false, error: 'Invalid license key.' };
  }
}

async function activateLicense(key) {
  const result = await verifyLicenseSignature(key);
  if (result.valid) {
    await new Promise(resolve => {
      chrome.storage.local.set({
        [LICENSE_STORAGE_KEY]: {
          valid:       true,
          key:         String(key).trim(),
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
  // ── Inline toast + confirm helpers ─────────────────────────────────────
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

  // ── History tab clickable-text modal ──────────────────────────────────────
  // Clicking element names, URLs, or annotation text inside a history tab
  // opens a small read-only popover with the full text, so the user can
  // select/copy it. Only active inside historyEl.
  function showTextSelectModal(text) {
    const existing = document.getElementById('hist-text-modal');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'hist-text-modal';
    overlay.className = 'hist-text-modal';
    overlay.innerHTML = `
      <div class="hist-text-modal-box" role="dialog" aria-label="Selectable text">
        <button class="hist-text-modal-close" title="Close (Esc)" aria-label="Close">✕</button>
        <textarea readonly class="hist-text-modal-area"></textarea>
      </div>`;
    const ta = overlay.querySelector('.hist-text-modal-area');
    ta.value = text || '';
    const closeBtn = overlay.querySelector('.hist-text-modal-close');
    const close = () => { try { overlay.remove(); } catch(_){} document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    closeBtn.addEventListener('click', close);
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    setTimeout(() => { ta.focus(); ta.select(); }, 0);
  }

  // Single delegated click handler on the history panel.
  document.getElementById('history-panel').addEventListener('click', e => {
    if (e.target.closest('button')) return;
    const tgt = e.target.closest('.hist-clickable-text');
    if (!tgt) return;
    const text = tgt.dataset.fullText != null ? tgt.dataset.fullText : tgt.textContent;
    showTextSelectModal(text);
  });

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
  // ── Storage dedup ───────────────────────────────────────────────────────
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
  // One-time backfill flag: recover annotationIds for legacy copy-log entries
  // that were stored as raw markdown only.
  const COPY_LOG_BACKFILL_FLAG = '_copyLogIdsBackfilledV1';
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

  // ── Universal undo/redo state ────────────────────────────────────────────
  // Tracked storage keys whose changes should be undoable/redoable.
  const UNDO_TRACKED_KEYS = [
    'annotations',
    HISTORY_KEY,
    COPY_HISTORY_KEY,
    SAVED_LATER_KEY,
    COPY_ALL_SNAPSHOTS_KEY,
    ANN_STORE_KEY,
    SETTINGS_KEY,
  ];
  const UNDO_STACK_LIMIT = 100;
  let undoStack = [];
  let redoStack = [];
  // Pending change accumulator: coalesce changes from one storage.set call
  // (which fires onChanged with one entry per key) into a single undo step.
  let pendingUndoOld  = null;
  let pendingUndoTask = null;
  // Start >0 so init-time writes (migration, sync restore) don't pollute
  // the undo stack. Decremented to 0 once init completes.
  let suppressUndoCapture = 1;
  let undoBtn = document.getElementById('undo-btn'), redoBtn = document.getElementById('redo-btn');

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
    // Premium "multiple notes per element" feature: extras live in a string[].
    extraComments: 'et',
  };
  const ANN_LONG_KEYS = Object.fromEntries(
    Object.entries(ANN_SHORT_KEYS).map(([l, s]) => [s, l])
  );

  function shortenAnn(ann) {
    const out = {};
    for (const [k, v] of Object.entries(ann)) {
      if (v === null || v === undefined || v === '') continue;
      // Skip empty arrays (e.g. extraComments [], contextElements []) so we
      // don't waste sync bytes on metadata-free fields.
      if (Array.isArray(v) && v.length === 0) continue;
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
      // Preserve annotation IDs and snapshot objects so restore buttons
      // survive export → import round-trips.
      if (Array.isArray(c.annotationIds) && c.annotationIds.length) o.a = c.annotationIds;
      if (Array.isArray(c.annotations)   && c.annotations.length)   o.x = groupByUrl(c.annotations);
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
        timestamp:     o.s || o.timestamp,
        output:        o.o || o.output,
        count:         o.n || o.count || 0,
        annotationIds: Array.isArray(o.a) ? o.a : [],
        annotations:   o.x ? ungroupByUrl(o.x) : [],
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

  // ── Multi-note helpers ─────────────────────────────────────────────────
  // Premium users can attach more than one note to a single annotation. The
  // first note lives in `ann.comment` (back-compat with all existing data);
  // any extras live in `ann.extraComments` (string[]). Free users cannot add
  // new extra notes, but existing extras stay visible/editable so no data is
  // silently lost after a downgrade.

  // Return [primary, ...extras] without trimming. Always at least one entry.
  function getAnnNotes(ann) {
    if (!ann) return [''];
    const out = [ann.comment || ''];
    if (Array.isArray(ann.extraComments)) {
      for (const c of ann.extraComments) out.push(c == null ? '' : String(c));
    }
    return out;
  }

  // True when the annotation has any non-whitespace note (primary OR extras).
  function hasAnyNote(ann) {
    if (!ann) return false;
    if (ann.comment && ann.comment.trim()) return true;
    return Array.isArray(ann.extraComments)
      && ann.extraComments.some(c => c && String(c).trim());
  }

  // For chip tooltips, history previews, etc.: a single string combining
  // every note. Empty notes are skipped; multiple notes are joined with " • ".
  function getCombinedNoteText(ann) {
    return getAnnNotes(ann)
      .map(n => (n || '').trim())
      .filter(Boolean)
      .join(' • ');
  }

  // ── Markdown formatting ────────────────────────────────────────────────
  // Used by copy-all, cut-all, copy-by-url, and export flows.
  function formatLine(index, ann) {
    const sel  = getSelector(ann);   // uses existing getSelector helper
    const text = (ann.text    || '').trim();
    const url  = (ann.url     || '').trim();
    const ts   = ann.timestamp ? new Date(ann.timestamp).toISOString() : '';

    // Escape pipes and backticks for inline code spans.
    const safeSel = sel.replace(/`/g, '\\`');

    // Each non-empty note (primary + extras) becomes its own bullet under the
    // selector — never repeats the element context. This is the visible
    // contract for the Premium "multiple notes per element" feature.
    const notes = getAnnNotes(ann)
      .map(n => (n || '').trim())
      .filter(Boolean);
    const noteBlock = notes
      .map(n => `\n   - ${n.replace(/\n/g, '\n     ')}`)
      .join('');

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
  // Per-tab history limits (0 = indefinite for that tab). These are sized to
  // be "generous by default" so typical users never hit them, while still
  // keeping storage bounded.
  const DEFAULT_HISTORY_LIMITS = {
    annotations: 200,   // Annotation History tab (deleted annotations)
    saved:       20,    // Saved for Later tab (sets)
    copies:      50,    // Copy Log tab (copy snapshots)
  };
  const DEFAULT_SETTINGS = {
    shortcut:         { modifier: 'alt' }, // customizable annotation trigger
    prependText:      '',                  // prepended to markdown output
    appendText:       '',                  // appended to markdown output
    darkMode:         false,               // dark / light theme toggle
    maxHistoryLength: 200,                 // legacy key, kept for back-compat / fallback
    historyLimits:    { ...DEFAULT_HISTORY_LIMITS }, // per-tab limits, 0 = indefinite
    backupEnabled:    true,               // enable/disable auto-backup to sync
    buttonActions: {
      copyBtn:  { left: 'copyAll',  right: 'cutAll'       },
      clearBtn: { left: 'clearAll', right: 'saveForLater' },
    },
    // 'mod' = Ctrl on Win/Linux, Cmd on macOS.
    undoShortcut:     { modifier: 'mod', key: 'z' },
    redoShortcut:     { modifier: 'mod', key: 'y' },
  };

  // Resolve per-tab limit from a settings object, falling back to legacy
  // maxHistoryLength for the annotation tab only (so existing installs keep
  // their old preference for that tab).
  function getHistoryLimit(s, tab) {
    const limits = (s && s.historyLimits) || {};
    if (Object.prototype.hasOwnProperty.call(limits, tab)
        && limits[tab] !== undefined && limits[tab] !== null) {
      return Math.max(0, parseInt(limits[tab], 10) || 0);
    }
    if (tab === 'annotations'
        && s && s.maxHistoryLength !== undefined && s.maxHistoryLength !== null) {
      return Math.max(0, parseInt(s.maxHistoryLength, 10) || 0);
    }
    return DEFAULT_HISTORY_LIMITS[tab];
  }

  function loadSettings(cb) {
    chrome.storage.local.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS }, r => {
      const stored = r[SETTINGS_KEY] || {};
      const merged = { ...DEFAULT_SETTINGS, ...stored };
      // Deep-merge historyLimits so a partial stored object doesn't wipe
      // defaults for other tabs.
      merged.historyLimits = {
        ...DEFAULT_HISTORY_LIMITS,
        ...(stored.historyLimits || {}),
      };
      cb(merged);
    });
  }

  function saveSettings(patch, cb) {
    loadSettings(current => {
      const updated = { ...current, ...patch };
      // Deep-merge historyLimits so partial patches don't wipe other tabs.
      if (patch && patch.historyLimits) {
        updated.historyLimits = {
          ...(current.historyLimits || DEFAULT_HISTORY_LIMITS),
          ...patch.historyLimits,
        };
      }
      chrome.storage.local.set({ [SETTINGS_KEY]: updated }, () => {
        if (cb) cb(updated);
      });
    });
  }

  // ── Dark mode ─────────────────────────────────────────────────────────────
  function applyDarkMode(enabled) {
    // Dark mode is a Premium feature. If the user isn't premium, ignore
    // any stored darkMode value (including ones set while previously
    // licensed) and stay on the light theme.
    const effective = !!enabled && isPremium();
    document.body.dataset.theme = effective ? 'dark' : 'light';
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
  // Display-only variant of getSelector: appends every contextElements
  // selector after the main one, comma-separated. Used in current-annotation
  // listings so multi-element (Alt+click) annotations show all their picks.
  // Markdown output (formatLine) intentionally keeps using getSelector so
  // copy/cut output is unchanged.
  function getSelectorDisplay(ann) {
    const main = getSelector(ann);
    if (!ann || ann.pageLevel || ann.tag === 'page') return main;
    if (!Array.isArray(ann.contextElements) || ann.contextElements.length === 0) return main;
    const ctxParts = ann.contextElements.map(ctx => {
      const cId  = ctx.elId ? `#${ctx.elId}` : '';
      const cCls = ctx.classes && ctx.classes !== 'N/A' ? ctx.classes : '';
      return `${ctx.tag || '?'}${cId}${cCls}`;
    });
    return [main, ...ctxParts].join(', ');
  }

  function formatTimestamp(ts) {
    if (!ts) return '';
    try {
      // Round to the nearest whole minute (drop seconds), and show only the
      // last 2 digits of the year (e.g. 2026 → 26).
      const d = new Date(ts);
      const rounded = new Date(d.getTime());
      if (rounded.getSeconds() >= 30) rounded.setMinutes(rounded.getMinutes() + 1);
      rounded.setSeconds(0, 0);
      const date = rounded.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: '2-digit' });
      const time = rounded.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      return `${date}, ${time}`;
    } catch { return ts; }
  }

  // Compressed timestamp for tight UI rows (e.g. "Apr 30, 3:42p").
  function formatCompactTimestamp(ts) {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      let h = d.getHours();
      const m = d.getMinutes();
      const ampm = h >= 12 ? 'p' : 'a';
      h = h % 12; if (h === 0) h = 12;
      const mm = m < 10 ? `0${m}` : `${m}`;
      return `${date}, ${h}:${mm}${ampm}`;
    } catch { return ts; }
  }

  function modLabel(mod) {
    return MODIFIER_LABELS[mod] || 'Alt';
  }

  // ── Enforce history length limit ──────────────────────────────────────────
  function enforceHistoryLimitInStorage(cb) {
    loadSettings(s => {
      const annLimit   = getHistoryLimit(s, 'annotations');
      const savedLimit = getHistoryLimit(s, 'saved');
      const copyLimit  = getHistoryLimit(s, 'copies');

      chrome.storage.local.get({
        [HISTORY_KEY]:      [],
        [SAVED_LATER_KEY]:  [],
        [COPY_HISTORY_KEY]: [],
        [ANN_STORE_KEY]:    {},
      }, r => {
        const store = { ...(r[ANN_STORE_KEY] || {}) };
        const toSet = {};

        // Annotation History — newest stay (slice from the tail).
        if (annLimit > 0) {
          const hist = r[HISTORY_KEY] || [];
          if (hist.length > annLimit) {
            const dropped = hist.slice(0, hist.length - annLimit);
            const trimmed = hist.slice(-annLimit);
            refStoreDec(store, dropped.map(h => h && h.id).filter(Boolean));
            toSet[HISTORY_KEY] = trimmed;
          }
        }

        // Saved-for-Later sets — newest by savedAt stay. Decrement ref counts
        // for annotations that belonged only to dropped sets.
        if (savedLimit > 0) {
          const sets = r[SAVED_LATER_KEY] || [];
          if (sets.length > savedLimit) {
            const sorted = [...sets].sort((a, b) => {
              const ta = a && a.savedAt ? new Date(a.savedAt).getTime() : 0;
              const tb = b && b.savedAt ? new Date(b.savedAt).getTime() : 0;
              return ta - tb;
            });
            const dropped = sorted.slice(0, sorted.length - savedLimit);
            const keepIds = new Set(sorted.slice(-savedLimit).map(s => s && s.id));
            const trimmed = sets.filter(s => s && keepIds.has(s.id));
            dropped.forEach(set => {
              if (!set) return;
              const ids = Array.isArray(set.annotationIds)
                ? set.annotationIds
                : (set.annotations || []).map(a => a && a.id);
              refStoreDec(store, (ids || []).filter(Boolean));
            });
            toSet[SAVED_LATER_KEY] = trimmed;
          }
        }

        // Copy Log — newest by timestamp stay; decrement refs for dropped rows.
        if (copyLimit > 0) {
          const copyHist = r[COPY_HISTORY_KEY] || [];
          if (copyHist.length > copyLimit) {
            const sorted = [...copyHist].sort((a, b) => {
              const ta = a && a.timestamp ? new Date(a.timestamp).getTime() : 0;
              const tb = b && b.timestamp ? new Date(b.timestamp).getTime() : 0;
              return ta - tb;
            });
            const dropped = sorted.slice(0, sorted.length - copyLimit);
            const keepTs  = new Set(sorted.slice(-copyLimit).map(c => c && c.timestamp));
            const trimmed = copyHist.filter(c => c && keepTs.has(c.timestamp));
            dropped.forEach(c => refStoreDec(store, refIds(c && c.annotationIds)));
            toSet[COPY_HISTORY_KEY] = trimmed;
          }
        }

        const keys = Object.keys(toSet);
        if (keys.length === 0) { if (cb) cb(); return; }
        toSet[ANN_STORE_KEY] = store;
        chrome.storage.local.set(toSet, cb);
      });
    });
  }

  // ── Storage dedup helpers ───────────────────────────────────────────────
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
          // annotationIds empty for legacy entries. Remove actions will simply
          // find nothing to remove for those, which is correct.
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

  // ── Save a single annotation's note (primary or extra) ───────────────────
  // For the Premium "multiple notes per element" feature: noteIdx 0 maps to
  // ann.comment (back-compat); noteIdx >= 1 maps to ann.extraComments[idx-1].
  // We key the debounce timer per (annId, noteIdx) so concurrent edits to
  // different notes on the same annotation don't clobber each other.
  const saveTimers = {};
  function saveComment(annId, value, noteIdx) {
    const idx = parseInt(noteIdx, 10) || 0;
    const key = `${annId}::${idx}`;
    clearTimeout(saveTimers[key]);
    saveTimers[key] = setTimeout(() => {
      isWritingFromPopup = true;
      chrome.storage.local.get({ annotations: [] }, r => {
        const anns = r.annotations;
        const ann  = anns.find(a => a.id === annId);
        if (ann) {
          if (idx === 0) {
            ann.comment = value;
          } else {
            if (!Array.isArray(ann.extraComments)) ann.extraComments = [];
            const arrIdx = idx - 1;
            while (ann.extraComments.length <= arrIdx) ann.extraComments.push('');
            ann.extraComments[arrIdx] = value;
          }
          chrome.storage.local.set({ annotations: anns }, () => { isWritingFromPopup = false; });
        } else {
          isWritingFromPopup = false;
        }
      });
    }, 350);
  }

  // Atomically commit a textarea's value and (optionally) prune an empty
  // extra note. Returns a Promise so blur handlers can chain side-effects.
  // Used both by the snapshot-blur ungroup flow and by the empty-extra
  // auto-prune flow so we never end up with double writes that race.
  //
  // To avoid races with sibling textareas that have pending debounced saves,
  // we snapshot EVERY textarea's live DOM value for this annotation and
  // overlay them into the write — and we cancel every saveTimer for this
  // annotation. That way no later write can clobber the just-typed values.
  function commitNoteOnBlur(annId, noteIdx, value, opts = {}) {
    const idx        = parseInt(noteIdx, 10) || 0;
    const removeSnap = !!opts.removeFromSnapshots;
    const pruneIfEmpty = idx > 0 && !value.trim();
    const wantsNewSnaps = removeSnap;
    // 1. Capture every sibling textarea's value for this annotation BEFORE
    //    the storage round-trip so concurrent debounced saves can't undo
    //    typed-but-not-saved edits in other notes.
    const safeId = annId.replace(/"/g, '\\"');
    const sample = listEl.querySelector(`.item-note-edit[data-ann-id="${safeId}"]`);
    const item   = sample ? sample.closest('.item') : null;
    const liveTas = item ? Array.from(item.querySelectorAll('.item-note-edit')) : [];
    const liveValues = liveTas.length > 0
      ? liveTas.map(t => t.value || '')
      : null;
    // 2. Cancel ALL pending debounced saves for this annotation so they
    //    can't fire after our atomic write and clobber the freshest data.
    Object.keys(saveTimers).forEach(k => {
      if (k.startsWith(annId + '::')) {
        clearTimeout(saveTimers[k]);
        delete saveTimers[k];
      }
    });
    return new Promise(resolve => {
      isWritingFromPopup = true;
      const reads = { annotations: [] };
      if (wantsNewSnaps) reads[COPY_ALL_SNAPSHOTS_KEY] = [];
      chrome.storage.local.get(reads, r => {
        const anns = r.annotations.slice();
        const ann  = anns.find(a => a.id === annId);
        const toStore = {};
        if (ann) {
          // Apply live DOM values first (covers all notes atomically).
          if (liveValues) {
            ann.comment = liveValues[0] || '';
            const extras = liveValues.slice(1);
            if (extras.length > 0) ann.extraComments = extras;
            else delete ann.extraComments;
          }
          // Then apply this textarea's authoritative value (in case
          // liveValues missed it — e.g. element already detached).
          if (idx === 0) {
            ann.comment = value;
          } else {
            if (!Array.isArray(ann.extraComments)) ann.extraComments = [];
            const arrIdx = idx - 1;
            while (ann.extraComments.length <= arrIdx) ann.extraComments.push('');
            ann.extraComments[arrIdx] = value;
            if (pruneIfEmpty) {
              ann.extraComments.splice(arrIdx, 1);
              if (ann.extraComments.length === 0) delete ann.extraComments;
            }
          }
          toStore.annotations = anns;
        }
        if (wantsNewSnaps) {
          const snaps = r[COPY_ALL_SNAPSHOTS_KEY] || [];
          const newSnaps = snaps
            .map(s => ({ ...s, annotationIds: (s.annotationIds || []).filter(id => id !== annId) }))
            .filter(s => (s.annotationIds || []).length > 0);
          toStore[COPY_ALL_SNAPSHOTS_KEY] = newSnaps;
        }
        if (Object.keys(toStore).length === 0) {
          isWritingFromPopup = false;
          resolve(false);
          return;
        }
        chrome.storage.local.set(toStore, () => {
          isWritingFromPopup = false;
          resolve(true);
        });
      });
    });
  }

  // Append a new empty extra note slot to an annotation and re-render so the
  // popup grows a new textarea (auto-focused). Premium-only — callers should
  // gate with isPremium() before invoking.
  //
  // Carefully folds in any in-flight DOM textarea values that haven't yet
  // been flushed by the debounced saveComment timers, so a quick
  // type-then-click-Add sequence never loses the just-typed text.
  function addExtraNote(annId) {
    // 1. Snapshot every textarea's current DOM value for this annotation
    //    BEFORE the re-render so we don't drop an in-flight typed value.
    const safeId = annId.replace(/"/g, '\\"');
    const sample = listEl.querySelector(`.item-note-edit[data-ann-id="${safeId}"]`);
    const item   = sample ? sample.closest('.item') : null;
    const liveTas = item ? Array.from(item.querySelectorAll('.item-note-edit')) : [];
    const liveValues = liveTas.map(ta => ta.value || '');
    // 2. Cancel any pending debounced saves for this annotation — we'll
    //    persist the canonical DOM values atomically below.
    Object.keys(saveTimers).forEach(k => {
      if (k.startsWith(annId + '::')) {
        clearTimeout(saveTimers[k]);
        delete saveTimers[k];
      }
    });
    isWritingFromPopup = true;
    chrome.storage.local.get({ annotations: [] }, r => {
      const anns = r.annotations.slice();
      const ann  = anns.find(a => a.id === annId);
      if (!ann) { isWritingFromPopup = false; return; }
      // 3. Overlay the in-flight DOM values onto the stored annotation so
      //    the post-render textareas reflect what the user actually typed.
      if (liveValues.length > 0) {
        ann.comment = liveValues[0] || '';
        const extras = liveValues.slice(1);
        if (extras.length > 0) ann.extraComments = extras;
        else delete ann.extraComments;
      }
      if (!Array.isArray(ann.extraComments)) ann.extraComments = [];
      // Re-use a trailing empty slot if there is one (clicking "+" twice in a
      // row should still only land you on a single empty textarea).
      let targetIdx;
      const lastIdx = ann.extraComments.length - 1;
      if (lastIdx >= 0 && !String(ann.extraComments[lastIdx] || '').trim()) {
        targetIdx = lastIdx + 1; // textarea index = 1 + extras index
      } else {
        ann.extraComments.push('');
        targetIdx = ann.extraComments.length; // new textarea index
      }
      _focusNoteAfterRender = { annId, noteIdx: targetIdx };
      chrome.storage.local.set({ annotations: anns }, () => {
        isWritingFromPopup = false;
        render(anns);
      });
    });
  }
  // After the next render, focus the matching textarea (used after Add Note).
  let _focusNoteAfterRender = null;

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
      const anns = r.annotations.filter(a => a.url === url && hasAnyNote(a));
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
  // Always sizes the textarea to fully fit the complete textual contents of
  // the annotation. If the textarea is currently hidden (e.g. inside a
  // collapsed accordion) its scrollHeight reads as 0 — in that case we defer
  // the measurement until it becomes visible so the height is still correct
  // when the user expands the section.
  function autoResizeTextarea(ta) {
    if (!ta || !ta.isConnected) return;
    ta.style.height = 'auto';
    const sh = ta.scrollHeight;
    if (sh > 0) {
      ta.style.height = Math.max(46, sh) + 'px';
      return;
    }
    // Hidden / not yet laid out — wait for it to become visible, then size.
    if (typeof IntersectionObserver !== 'function' || ta.dataset._autosizeObs === '1') return;
    ta.dataset._autosizeObs = '1';
    const io = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.target.scrollHeight > 0) {
          io.disconnect();
          delete entry.target.dataset._autosizeObs;
          entry.target.style.height = 'auto';
          entry.target.style.height = Math.max(46, entry.target.scrollHeight) + 'px';
          return;
        }
      }
    });
    io.observe(ta);
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
    // Per-group accordion: when `accordion` is true, each URL group
    // independently opens/closes. `openUrls` is the set of URLs currently
    // expanded; `snapId` is forwarded onto each header so the click handler
    // can persist state for the right snapshot.
    const accordion  = !!opts.accordion;
    const openUrls   = opts.openUrls instanceof Set ? opts.openUrls : new Set();
    const snapId     = opts.snapId || '';
    const byUrl = {};
    anns.forEach(ann => (byUrl[ann.url] = byUrl[ann.url] || []).push(ann));

    let html = '';
    Object.entries(byUrl).forEach(([url, items]) => {
      // Inside the big box (showGroupCount), put the blue count badge AFTER
      // the link (truncating the link if necessary). For loose groups the
      // count is hidden entirely.
      const countBadge = showGroupCount
        ? `<span class="count-badge copy-all-group-count" title="${items.length} annotation${items.length !== 1 ? 's' : ''}">${items.length}</span>`
        : '';
      const isOpen     = !accordion || openUrls.has(url);
      const groupCls   = `url-group${accordion ? ' url-group--accordion' : ''}${accordion && isOpen ? ' open' : ''}`;
      const headerExtra = accordion
        ? ` data-accordion-snap="${escHtml(snapId)}" data-accordion-url="${escHtml(url)}" role="button" tabindex="0"`
        : '';
      const caret = accordion
        ? `<span class="url-group-caret" aria-hidden="true">▸</span>`
        : '';
      html += `<div class="${groupCls}">
        <div class="url-header"${headerExtra}>
          ${caret}<div class="url-label url-label--clickable copy-all-group-url" title="${escHtml(url)}" data-nav-url="${escHtml(url)}">${escHtml(url)}</div>
          <button class="url-copy-btn" data-url="${escHtml(url)}" title="Copy group as Markdown">📋 Copy group</button>
          <button class="url-clear-group-btn" data-url="${escHtml(url)}" title="Clear group (saves to history)">🗑</button>
          ${countBadge}
        </div>`;
      // Wrap items in an accordion body so we can hide them per-group without
      // affecting the URL header itself.
      if (accordion) html += `<div class="url-group-body">`;
      items.forEach(ann => {
        const sel = getSelectorDisplay(ann);
        const isPageLevel = !!(ann.pageLevel || ann.tag === 'page');
        const isMulti = Array.isArray(ann.contextElements) && ann.contextElements.length > 0;
        const codeTitle = isMulti
          ? `Click to navigate to this annotation\n${sel}`
          : 'Click to navigate to this annotation';
        const notes = getAnnNotes(ann);
        const isMultiNote = notes.length > 1;
        // Render one textarea per note. Extras get a thin pink top border (CSS)
        // so it's visually clear they all belong to the same selector. The
        // selector header is rendered once, never repeated per note.
        const notesHtml = notes.map((n, idx) => `
            <textarea
              class="item-note-edit${idx > 0 ? ' item-note-edit--extra' : ''}"
              data-ann-id="${escHtml(ann.id)}"
              data-note-idx="${idx}"
              placeholder="${idx === 0 ? 'Add a note…' : 'Add another note…'}"
            >${escHtml(n)}</textarea>`).join('');
        // The "+ Add note" button is Premium-only. Disabled while the last
        // textarea is empty so users can't accumulate empty stacks.
        const lastNote = notes[notes.length - 1] || '';
        const addDisabled = !lastNote.trim();
        const authorBadge = ann.authorName ? `<div style="font-size: 10px; margin-top: 2px; margin-bottom: 4px; color: ${escHtml(ann.authorColor || '#888')}; font-weight: 600;">👤 ${escHtml(ann.authorName)}</div>` : '';
        const addBtnHtml = isPremium()
          ? `<button class="item-add-note-btn" data-ann-id="${escHtml(ann.id)}"${addDisabled ? ' disabled aria-disabled="true"' : ''} title="${addDisabled ? 'Fill the current note first' : 'Add another note for this element'}">+ Add note</button>`
          : '';
        html += `
        <div class="item${isPageLevel ? ' item--page-level' : ''}${isMultiNote ? ' item--multi-note' : ''}">
          ${authorBadge}<div class="item-sel">
            <code class="ann-code--clickable${isMulti ? ' ann-code--multi' : ''}" data-nav-ann-id="${escHtml(ann.id)}" title="${escHtml(codeTitle)}">${escHtml(sel)}</code>
            <button class="item-copy-btn" data-ann-id="${escHtml(ann.id)}" title="Copy this annotation">📋</button>
            <button class="item-delete-btn" data-ann-id="${escHtml(ann.id)}" title="Clear annotation">🗑</button>
          </div>
          <div class="item-notes">${notesHtml}
          </div>
          ${addBtnHtml}
        </div>`;
      });
      if (accordion) html += `</div>`;
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

  // "12:34 PM, 4/30" — short label used in the big-box header.
  function formatBigBoxLabel(ts) {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      const time  = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      const month = d.getMonth() + 1;
      const day   = d.getDate();
      return `${time}, ${month}/${day}`;
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
        const whenFull  = formatSnapshotTimestamp(snap.timestamp);
        const whenShort = formatCompactTimestamp(snap.timestamp);
        const bigBoxLabel = formatBigBoxLabel(snap.timestamp);
        html += `
        <div class="copy-all-snapshot${expanded ? ' expanded' : ''}" data-snap-id="${escHtml(snap.id)}">
          <div class="copy-all-header" data-snap-toggle="${escHtml(snap.id)}" role="button" tabindex="0" title="Click to ${expanded ? 'collapse' : 'expand'}">
            <span class="copy-all-caret" aria-hidden="true">▸</span>
            <span class="count-badge copy-all-title-count" title="${innerAnns.length} annotation${innerAnns.length !== 1 ? 's' : ''} copied">${innerAnns.length}</span>
            <span class="copy-all-meta copy-all-meta--copied" title="${escHtml(whenFull)}">${escHtml(bigBoxLabel)}</span>
            <span class="copy-all-spacer"></span>
            <button class="copy-all-action copy-all-save copy-all-save--icon" data-snap-id="${escHtml(snap.id)}" title="Save for later — move these annotations to the Saved for Later tab" aria-label="Save for later">🕐</button>
            <button class="copy-all-action copy-all-ungroup" data-snap-ungroup="${escHtml(snap.id)}" title="Unpack — move these annotations back into the main list">⇱ Unpack</button>
            <button class="copy-all-action copy-all-clear copy-all-clear--icon" data-snap-id="${escHtml(snap.id)}" title="Clear (move to history)" aria-label="Clear group (move to history)">🗑</button>
          </div>
          <div class="copy-all-summary">
            ${(() => {
              // Collapsed view: one row per URL group with a leading count badge.
              const byUrl = {};
              innerAnns.forEach(a => (byUrl[a.url] = byUrl[a.url] || []).push(a));
              return Object.entries(byUrl).map(([url, items]) => `
                <div class="copy-all-summary-row" data-snap-jump="${escHtml(snap.id)}" data-jump-url="${escHtml(url)}" role="button" tabindex="0" title="Click to expand and jump to this group">
                  <span class="copy-all-group-url" title="${escHtml(url)}">${escHtml(url)}</span>
                  <span class="count-badge copy-all-group-count">${items.length}</span>
                </div>`).join('');
            })()}
          </div>
          <div class="copy-all-body">
            ${buildGroupedAnnotationsHTML(innerAnns, {
              showGroupCount: true,
              accordion:      true,
              snapId:         snap.id,
              openUrls:       new Set(Array.isArray(snap.openUrls) ? snap.openUrls : []),
            })}
          </div>
        </div>`;
      });

      // Render any loose annotations (those not in any snapshot) below.
      if (looseAnns.length > 0) {
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
      let _dirtyInSnap = false;
      const annId   = ta.dataset.annId;
      const noteIdx = parseInt(ta.dataset.noteIdx, 10) || 0;
      ta.addEventListener('input', () => {
        saveComment(annId, ta.value, noteIdx);
        autoResizeTextarea(ta);
        // Track whether this note was edited while inside a Copy-All snapshot
        if (!_dirtyInSnap && ta.closest('.copy-all-snapshot')) _dirtyInSnap = true;
        // Toggle the sibling "+ Add note" button enabled state in real-time
        // so the user gets immediate feedback as they fill / clear notes.
        const addBtn = ta.closest('.item')?.querySelector('.item-add-note-btn');
        if (addBtn) {
          // Find the LAST textarea in this item — only that one's emptiness
          // controls the button (intermediate empty notes would auto-prune
          // on blur anyway).
          const allTas = ta.closest('.item').querySelectorAll('.item-note-edit');
          const last = allTas[allTas.length - 1];
          const enabled = !!(last && last.value.trim());
          addBtn.disabled = !enabled;
          addBtn.title = enabled ? 'Add another note for this element' : 'Fill the current note first';
        }
      });
      // Blur handler: covers two flows that need to write atomically.
      //   1. Snapshot ungroup: a note inside a Copy-All "big box" was edited
      //      → save and move the annotation back into the loose list.
      //   2. Empty-extra prune: a non-primary note was emptied → drop it from
      //      extraComments so we don't leave a phantom textarea behind.
      ta.addEventListener('blur', () => {
        const inSnap        = !!ta.closest('.copy-all-snapshot');
        const needsUngroup  = inSnap && _dirtyInSnap;
        const needsPrune    = noteIdx > 0 && !ta.value.trim();
        if (!needsUngroup && !needsPrune) return;
        _dirtyInSnap = false;
        commitNoteOnBlur(annId, noteIdx, ta.value, { removeFromSnapshots: needsUngroup }).then(changed => {
          if (changed) load();
        });
      });
    });

    // ── Premium: "+ Add note" button — append another textarea to the item.
    listEl.querySelectorAll('.item-add-note-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (btn.disabled) return;
        if (!isPremium()) {
          showToast('Multiple notes per element is a Premium feature.');
          return;
        }
        addExtraNote(btn.dataset.annId);
      });
    });

    // Apply any pending "focus this textarea after render" intent (set when
    // the user clicks Add Note — we want their cursor in the new textarea
    // immediately after the re-render).
    if (_focusNoteAfterRender) {
      const { annId, noteIdx } = _focusNoteAfterRender;
      _focusNoteAfterRender = null;
      const sel = `.item-note-edit[data-ann-id="${annId.replace(/"/g, '\\"')}"][data-note-idx="${noteIdx}"]`;
      const target = listEl.querySelector(sel);
      if (target) {
        target.focus();
        try { target.scrollIntoView({ block: 'nearest' }); } catch (_) {}
      }
    }
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
    listEl.querySelectorAll('[data-snap-ungroup]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        copyAllSnapshotUngroup(btn.dataset.snapUngroup);
      });
      btn.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          copyAllSnapshotUngroup(btn.dataset.snapUngroup);
        }
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

    // ── Per-URL-group accordion inside expanded big-boxes ─────────────────────
    // Clicking a URL header inside an expanded snapshot toggles ONLY that
    // group, leaving sibling groups in their current state. Behavior is gated
    // by the data-accordion-snap attribute so non-snapshot url-headers are
    // unaffected.
    listEl.querySelectorAll('.url-header[data-accordion-snap]').forEach(hdr => {
      const handler = e => {
        if (e.target.closest('button')) return;
        if (e.target.closest('.url-label--clickable')) return;
        if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
        if (e.type === 'keydown') e.preventDefault();
        e.stopPropagation();
        toggleSnapshotUrlGroup(hdr.dataset.accordionSnap, hdr.dataset.accordionUrl);
      };
      hdr.addEventListener('click',   handler);
      hdr.addEventListener('keydown', handler);
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

  // Toggle a single URL group inside a snapshot's expanded body. Persists the
  // open/closed set on the snapshot as `openUrls`. DOM-only DOM update so
  // sibling textareas / scroll positions stay intact.
  function toggleSnapshotUrlGroup(snapId, url, force) {
    if (!snapId) return;
    updateSnapshot(snapId, s => {
      const open = new Set(Array.isArray(s.openUrls) ? s.openUrls : []);
      const next = typeof force === 'boolean' ? force : !open.has(url);
      if (next) open.add(url); else open.delete(url);
      return { ...s, openUrls: [...open] };
    }, () => {
      const snapEl = listEl.querySelector(`.copy-all-snapshot[data-snap-id="${cssEscape(snapId)}"]`);
      if (!snapEl) return;
      const hdr = snapEl.querySelector(
        `.url-header[data-accordion-snap="${cssEscape(snapId)}"][data-accordion-url="${cssEscape(url)}"]`
      );
      if (!hdr) return;
      const group = hdr.closest('.url-group--accordion');
      if (!group) return;
      if (typeof force === 'boolean') group.classList.toggle('open', force);
      else group.classList.toggle('open');
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

  // Ungroup: drop the snapshot only. The annotations themselves remain in the
  // current set and re-appear as loose items in the normal list.
  function copyAllSnapshotUngroup(snapId) {
    chrome.storage.local.get({ [COPY_ALL_SNAPSHOTS_KEY]: [] }, snapR => {
      const snaps = snapR[COPY_ALL_SNAPSHOTS_KEY] || [];
      const snap  = snaps.find(s => s.id === snapId);
      if (!snap) return;
      const remaining = snaps.filter(s => s.id !== snapId);
      const count = (snap.annotationIds || []).length;
      chrome.storage.local.set({ [COPY_ALL_SNAPSHOTS_KEY]: remaining }, () => {
        load();
        showToast(`Ungrouped ${count} annotation${count !== 1 ? 's' : ''}.`);
      });
    });
  }

  // Expand the snapshot and scroll the clicked URL group's header to the top
  // of the visible scroll area.
  function copyAllSnapshotJump(snapId, url) {
    // Expand the snapshot AND open just this URL group (per-group accordion).
    updateSnapshot(snapId, s => {
      const open = new Set(Array.isArray(s.openUrls) ? s.openUrls : []);
      open.add(url);
      return { ...s, expanded: true, openUrls: [...open] };
    }, () => {
      const snapEl = listEl.querySelector(`.copy-all-snapshot[data-snap-id="${cssEscape(snapId)}"]`);
      if (!snapEl) return;
      snapEl.classList.add('expanded');
      // Find the matching url-group header inside the body.
      const safeUrl = cssEscape(url);
      const target = snapEl.querySelector(
        `.copy-all-body .url-header [data-nav-url="${safeUrl}"]`
      );
      const headerRow = target ? target.closest('.url-header') : null;
      const groupEl   = headerRow ? headerRow.closest('.url-group--accordion') : null;
      if (groupEl) groupEl.classList.add('open');
      const scrollEl = headerRow || snapEl;
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
    // Capture undo/redo deltas across tracked keys.
    if (suppressUndoCapture === 0) captureUndoFromChanges(changes);

    if (changes.annotations) {
      const newAnns = changes.annotations.newValue || [];
      if (!isWritingFromPopup && !historyVisible && !settingsVisible) {
        render(newAnns);
      }
      // When the history panel is open (especially the Copy Log), the live
      // row state (red row + minus button vs restore button) depends on the
      // current annotation set. If annotations change from any source while
      // history is visible, re-render the active history tab so the
      // highlight stays accurate. We always do this — whether the change
      // came from the popup itself or another tab — because removeAnnotation
      // / restore flows mutate `annotations` and we must reflect the result.
      if (historyVisible) {
        renderHistoryTab();
      }
    }
    // Copy Log rows are also affected by changes to the copy-history list
    // itself (e.g., a row gets backfilled or removed in another window).
    // Re-render so live highlighting stays in sync there too.
    if (changes[COPY_HISTORY_KEY] && historyVisible && historyTab === 'copies'
        && !isWritingFromPopup) {
      renderHistoryTab();
    }
  });

  // ── Universal undo / redo ────────────────────────────────────────────────
  // Listen for storage changes on tracked keys; coalesce them per-tick and
  // push a single undo entry capturing the prior state. Mutations driven by
  // applyState (undo / redo) are skipped via suppressUndoCapture.
  function captureUndoFromChanges(changes) {
    let touched = false;
    UNDO_TRACKED_KEYS.forEach(key => {
      if (!Object.prototype.hasOwnProperty.call(changes, key)) return;
      touched = true;
      if (!pendingUndoOld) pendingUndoOld = {};
      // Only the first old-value seen in this coalesced batch is the real
      // "before" state; later events for the same key in the same tick are
      // intermediate states from chained writes.
      if (!Object.prototype.hasOwnProperty.call(pendingUndoOld, key)) {
        pendingUndoOld[key] = changes[key].oldValue;
      }
    });
    if (!touched) return;
    if (pendingUndoTask) return;
    pendingUndoTask = setTimeout(() => {
      const snap = pendingUndoOld;
      pendingUndoOld  = null;
      pendingUndoTask = null;
      if (!snap) return;
      undoStack.push(snap);
      if (undoStack.length > UNDO_STACK_LIMIT) undoStack.shift();
      // Any new user mutation invalidates the redo stack.
      redoStack = [];
      updateUndoButtons();
    }, 0);
  }

  function readTrackedState(cb) {
    const defaults = {};
    UNDO_TRACKED_KEYS.forEach(k => { defaults[k] = undefined; });
    chrome.storage.local.get(defaults, r => {
      const out = {};
      UNDO_TRACKED_KEYS.forEach(k => { out[k] = r[k]; });
      cb(out);
    });
  }

  function applyState(state, cb) {
    if (!state) { if (cb) cb(); return; }
    const toSet    = {};
    const toRemove = [];
    UNDO_TRACKED_KEYS.forEach(k => {
      if (Object.prototype.hasOwnProperty.call(state, k)) {
        const v = state[k];
        if (v === undefined) toRemove.push(k);
        else toSet[k] = v;
      }
    });
    suppressUndoCapture++;
    isWritingFromPopup = true;
    const finishWrite = () => {
      isWritingFromPopup = false;
      // Decrement suppress after a small delay so any onChanged events
      // queued for this write see the suppression flag.
      setTimeout(() => { suppressUndoCapture = Math.max(0, suppressUndoCapture - 1); }, 50);
      // Reload UI from authoritative storage state.
      chrome.storage.local.get({ annotations: [], [SETTINGS_KEY]: DEFAULT_SETTINGS }, r => {
        if (historyVisible) renderHistoryTab();
        else if (settingsVisible) renderSettings();
        else render(r.annotations);
        applyDarkMode((r[SETTINGS_KEY] || {}).darkMode);
        updateButtonLabels({ ...DEFAULT_SETTINGS, ...(r[SETTINGS_KEY] || {}) });
      });
      if (cb) cb();
    };
    const doRemove = () => {
      if (toRemove.length === 0) return finishWrite();
      chrome.storage.local.remove(toRemove, finishWrite);
    };
    if (Object.keys(toSet).length === 0) doRemove();
    else chrome.storage.local.set(toSet, doRemove);
  }

  function doUndo() {
    if (undoStack.length === 0) return;
    const prev = undoStack.pop();
    readTrackedState(curr => {
      // Build a forward-state for redo from the *current* values of just
      // those keys that the undo step touches.
      const forward = {};
      Object.keys(prev).forEach(k => { forward[k] = curr[k]; });
      redoStack.push(forward);
      if (redoStack.length > UNDO_STACK_LIMIT) redoStack.shift();
      applyState(prev, updateUndoButtons);
    });
  }

  function doRedo() {
    if (redoStack.length === 0) return;
    const next = redoStack.pop();
    readTrackedState(curr => {
      const back = {};
      Object.keys(next).forEach(k => { back[k] = curr[k]; });
      undoStack.push(back);
      if (undoStack.length > UNDO_STACK_LIMIT) undoStack.shift();
      applyState(next, updateUndoButtons);
    });
  }

  function updateUndoButtons() {
    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
  }

  // Match a keyboard event against a configured shortcut.
  // Shortcut shape: { modifier: 'mod' | 'ctrl' | 'meta' | 'alt' | 'shift', key: 'z' }
  // 'mod' (default) accepts Ctrl on Windows/Linux and Cmd (meta) on macOS.
  function shortcutMatches(e, sc) {
    if (!sc || !sc.key) return false;
    const key = (e.key || '').toLowerCase();
    if (key !== String(sc.key).toLowerCase()) return false;
    const mod = sc.modifier || 'mod';
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
    if (mod === 'mod')   return (isMac ? e.metaKey : e.ctrlKey) && !e.altKey;
    if (mod === 'ctrl')  return e.ctrlKey  && !e.metaKey;
    if (mod === 'meta')  return e.metaKey  && !e.ctrlKey;
    if (mod === 'alt')   return e.altKey   && !e.ctrlKey && !e.metaKey;
    if (mod === 'shift') return e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
    return false;
  }

  // Global keydown for undo/redo. Settings panel inputs still see the events
  // first (we only act if the target isn't a text field handling its own undo).
  document.addEventListener('keydown', e => {
    // Don't hijack browser undo inside text fields — let the textarea/input
    // handle its own undo/redo of typed content.
    const tgt = e.target;
    const inTextField = tgt && (
      tgt.tagName === 'TEXTAREA' ||
      (tgt.tagName === 'INPUT' && /^(text|search|url|email|password|number)$/i.test(tgt.type || 'text'))
    );
    if (inTextField) return;
    loadSettings(s => {
      const undoSc = s.undoShortcut || DEFAULT_SETTINGS.undoShortcut;
      const redoSc = s.redoShortcut || DEFAULT_SETTINGS.redoShortcut;
      if (shortcutMatches(e, undoSc)) {
        e.preventDefault();
        doUndo();
      } else if (shortcutMatches(e, redoSc)) {
        e.preventDefault();
        doRedo();
      }
    });
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
      // back into the dedup format on this fresh local state. Also reset the
      // copy-log backfill flag so any legacy copy-log entries in the restored
      // payload get matched back to their annotation IDs.
      toSet[MIGRATION_FLAG] = false;
      toSet[COPY_LOG_BACKFILL_FLAG] = false;
      toSet[ANN_STORE_KEY]  = {};

      isWritingFromPopup = true;
      chrome.storage.local.set(toSet, () => {
        isWritingFromPopup = false;
        maybeMigrateStorage(() => {
          backfillCopyLogIds(() => {});
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
      '.copy-hist-url, .copy-hist-ann-sels, .copy-hist-fix-body, ' +
      '.sfl-url, ' +
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

  if (undoBtn) undoBtn.addEventListener('click', () => doUndo());
  if (redoBtn) redoBtn.addEventListener('click', () => doRedo());
  updateUndoButtons();

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
            <div class="url-label hist-clickable-text" data-full-text="${escHtml(url)}" title="${escHtml(url)}">${escHtml(url)}</div>
          </div>`;
        items.forEach(ann => {
          const sel = getSelector(ann);
          const authorBadge = ann.authorName ? `<div style="font-size: 10px; margin-top: 2px; margin-bottom: 4px; color: ${escHtml(ann.authorColor || '#888')}; font-weight: 600;">👤 ${escHtml(ann.authorName)}</div>` : '';
          html += `
          <div class="item hist-item">
            ${authorBadge}<div class="item-sel">
              <code class="hist-clickable-text" data-full-text="${escHtml(sel)}">${escHtml(sel)}</code>
              <button class="hist-restore-btn"
                data-ann-id="${escHtml(ann.id)}"
                data-deleted-at="${escHtml(ann.deletedAt || '')}"
                title="Restore annotation">↺</button>
              <button class="hist-perm-delete-btn"
                data-ann-id="${escHtml(ann.id)}"
                data-deleted-at="${escHtml(ann.deletedAt || '')}"
                title="Permanently delete">✕</button>
            </div>
            <div class="hist-meta">
              <span class="hist-ts">📅 ${escHtml(formatTimestamp(ann.timestamp))}</span>
              <span class="hist-ts hist-deleted">🗑 ${escHtml(formatTimestamp(ann.deletedAt))}</span>
            </div>
            ${(() => {
              // Render every non-empty note (primary + extras) as a separate
              // line so multi-note Premium annotations don't lose any
              // content in the History view.
              const notesArr = getAnnNotes(ann)
                .map(n => (n || '').trim())
                .filter(Boolean);
              if (notesArr.length === 0) return `<div class="hist-note empty-note">(no note)</div>`;
              return notesArr.map(n =>
                `<div class="hist-note hist-clickable-text" data-full-text="${escHtml(n)}">${escHtml(n)}</div>`
              ).join('');
            })()}
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
        // Group by URL so we can render thin blue URL separators between
        // annotation groups while preserving the original order. Multi-element
        // annotations stay as a single row (selectors joined with ellipsis).
        const groups = [];
        const groupIdx = new Map();
        items.forEach(ann => {
          const u = ann.url || '';
          if (!groupIdx.has(u)) {
            groupIdx.set(u, groups.length);
            groups.push({ url: u, items: [] });
          }
          groups[groupIdx.get(u)].items.push(ann);
        });
        const overflow = resolved.length > items.length
          ? `<li class="sfl-overflow"><em>+${resolved.length - items.length} more…</em></li>`
          : '';
        html += `
        <div class="sfl-set" data-set-id="${escHtml(set.id)}">
          <div class="sfl-set-header">
            <span class="sfl-set-meta">📅 ${escHtml(when)} · ${set.count || items.length} annotation${(set.count || items.length) !== 1 ? 's' : ''}</span>
            <div class="sfl-set-actions">
              <button class="hist-restore-btn sfl-restore" data-set-id="${escHtml(set.id)}" title="Restore these annotations">↺</button>
              <button class="hist-perm-delete-btn sfl-delete" data-set-id="${escHtml(set.id)}" title="Delete this set">✕</button>
            </div>
          </div>
          ${groups.map(g => `
            <div class="sfl-url-group">
              <div class="sfl-url hist-clickable-text" data-full-text="${escHtml(g.url || '')}" title="${escHtml(g.url)}">${escHtml(g.url || '(no url)')}</div>
              <ul class="sfl-set-list">
                ${g.items.map(ann => {
                  const sel  = getSelectorDisplay(ann);
                  // Combined notes preview (primary + extras joined with " • ")
                  // gives the same compact summary for both single- and multi-
                  // note annotations.
                  const note = getCombinedNoteText(ann) || '(no note)';
                  const noteShort = note.slice(0, 120) + (note.length > 120 ? '…' : '');
                  // Per-row clear button — every item in the list must have an
                  // action button (mirrors the rule in Annotation History and
                  // Copy Log). Uses the same trash-can button as the Current
                  // Annotations tab. Clearing removes the annotation from this
                  // saved-for-later set but preserves it in the Annotations
                  // History tab so it can never be permanently lost from a
                  // single click.
                  const rowBtn = ann.id
                    ? `<button class="item-delete-btn sfl-row-clear-btn" data-set-id="${escHtml(set.id)}" data-ann-id="${escHtml(ann.id)}" title="Clear annotation (kept in Annotation History)">🗑</button>`
                    : `<button class="item-delete-btn sfl-row-clear-btn sfl-row-clear-btn--dom" title="Clear row">🗑</button>`;
                  return `<li title="${escHtml(sel)}"><code class="hist-clickable-text" data-full-text="${escHtml(sel)}">${escHtml(sel)}</code><span class="hist-clickable-text" data-full-text="${escHtml(note)}">${escHtml(noteShort)}</span>${rowBtn}</li>`;
                }).join('')}
              </ul>
            </div>`).join('')}
          ${overflow ? `<ul class="sfl-set-list">${overflow}</ul>` : ''}
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

      // Per-row clear: remove a single annotation from a saved-for-later set
      // but preserve it in the Annotation History tab (so it is never
      // permanently deleted by a single click).
      // For DOM-only fallbacks (legacy items missing an id), just hide the row.
      historyEl.querySelectorAll('.sfl-row-clear-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          if (btn.classList.contains('sfl-row-clear-btn--dom')) {
            const li = btn.closest('li');
            if (li) li.remove();
            return;
          }
          clearAnnotationFromSavedForLater(btn.dataset.setId, btn.dataset.annId);
        });
      });
    });
  }

  // Remove a single annotation id from a saved-for-later set without touching
  // the others. If the set becomes empty, the set itself is removed.
  // NOTE: this version decrements the store refcount, which can permanently
  // drop the annotation if it isn't also referenced elsewhere. Kept for
  // internal callers that truly want a full remove. The per-row clear button
  // now uses clearAnnotationFromSavedForLater() below, which preserves the
  // annotation in Annotation History.
  function removeAnnotationFromSavedForLater(setId, annId) {
    chrome.storage.local.get({ [SAVED_LATER_KEY]: [], [ANN_STORE_KEY]: {} }, r => {
      const sets  = r[SAVED_LATER_KEY] || [];
      const idx   = sets.findIndex(s => s.id === setId);
      if (idx < 0) return;
      const set   = sets[idx];
      const store = { ...(r[ANN_STORE_KEY] || {}) };

      // Modern sets carry `annotationIds`; legacy carry inline `annotations`.
      let newSet;
      if (Array.isArray(set.annotationIds)) {
        const newIds = set.annotationIds.filter(id => id !== annId);
        if (newIds.length === set.annotationIds.length) return;
        refStoreDec(store, [annId]);
        newSet = { ...set, annotationIds: newIds, count: newIds.length };
      } else if (Array.isArray(set.annotations)) {
        const newAnns = set.annotations.filter(a => a.id !== annId);
        if (newAnns.length === set.annotations.length) return;
        newSet = { ...set, annotations: newAnns, count: newAnns.length };
      } else {
        return;
      }

      const newSets = (newSet.count > 0)
        ? sets.map((s, i) => i === idx ? newSet : s)
        : sets.filter((_, i) => i !== idx);

      chrome.storage.local.set({
        [SAVED_LATER_KEY]: newSets,
        [ANN_STORE_KEY]: store,
      }, () => renderSavedForLater());
    });
  }

  // Per-row clear button in the Saved for Later tab. Removes the annotation
  // from the saved-for-later set but pushes it into the Annotation History
  // tab with a fresh deletedAt timestamp, so the annotation is preserved and
  // can still be restored from history. Net effect on the ref store is
  // neutral: one SFL reference is dropped, one History reference is added.
  function clearAnnotationFromSavedForLater(setId, annId) {
    chrome.storage.local.get({
      [SAVED_LATER_KEY]: [],
      [HISTORY_KEY]:     [],
      [ANN_STORE_KEY]:   {},
    }, r => {
      const sets  = r[SAVED_LATER_KEY] || [];
      const idx   = sets.findIndex(s => s.id === setId);
      if (idx < 0) return;
      const set   = sets[idx];
      const store = { ...(r[ANN_STORE_KEY] || {}) };
      const hist  = Array.isArray(r[HISTORY_KEY]) ? [...r[HISTORY_KEY]] : [];

      // Resolve the full annotation before we touch the store, so that
      // history entries created from legacy inline-annotations sets also
      // have a proper store snapshot to point at.
      let annSnapshot = null;
      if (Array.isArray(set.annotationIds)) {
        if (!set.annotationIds.includes(annId)) return;
        annSnapshot = store[annId] ? stripRefMeta(store[annId]) : null;
      } else if (Array.isArray(set.annotations)) {
        const inline = set.annotations.find(a => a.id === annId);
        if (!inline) return;
        annSnapshot = { ...inline };
        // Legacy inline sets never created a store entry — seed one here so
        // the new history reference can resolve back to a real annotation.
        if (!store[annSnapshot.id]) {
          store[annSnapshot.id] = { ...annSnapshot, _refCount: 0 };
        }
      } else {
        return;
      }

      // Rebuild the set without this annotation. When it becomes empty the
      // set itself is dropped (same behaviour as the old remove path).
      let newSet;
      if (Array.isArray(set.annotationIds)) {
        const newIds = set.annotationIds.filter(id => id !== annId);
        if (newIds.length === set.annotationIds.length) return;
        newSet = { ...set, annotationIds: newIds, count: newIds.length };
      } else {
        const newAnns = set.annotations.filter(a => a.id !== annId);
        if (newAnns.length === set.annotations.length) return;
        newSet = { ...set, annotations: newAnns, count: newAnns.length };
      }

      // Refcount bookkeeping:
      //   - modern SFL sets hold a ref — decrement it
      //   - legacy inline sets never incremented, so skip
      //   - then add a fresh history reference (increment)
      if (Array.isArray(set.annotationIds)) {
        refStoreDec(store, [annId]);
      }
      // Make sure a store entry exists before we re-increment (refStoreDec
      // may have removed it if this was the last reference).
      if (!store[annId] && annSnapshot) {
        store[annId] = { ...annSnapshot, _refCount: 0 };
      }
      if (store[annId]) {
        store[annId]._refCount = (store[annId]._refCount || 0) + 1;
      }

      // Drop any stale history ref for the same id so the newest clear
      // timestamp wins (mirrors deleteAnnotation()). We already accounted
      // for the new reference above.
      const oldHistRefs = hist.filter(h => h.id === annId);
      if (oldHistRefs.length) {
        refStoreDec(store, oldHistRefs.map(h => h.id));
      }
      const newHist = hist.filter(h => h.id !== annId);
      newHist.push({ id: annId, deletedAt: new Date().toISOString() });

      const newSets = (newSet.count > 0)
        ? sets.map((s, i) => i === idx ? newSet : s)
        : sets.filter((_, i) => i !== idx);

      chrome.storage.local.set({
        [SAVED_LATER_KEY]: newSets,
        [HISTORY_KEY]:     newHist,
        [ANN_STORE_KEY]:   store,
      }, () => {
        enforceHistoryLimitInStorage(() => renderSavedForLater());
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

  // ── One-time backfill: recover annotationIds for legacy copy-log entries ──
  //
  // Older copy-log entries were stored as raw markdown with no annotation-id
  // linkage. Without IDs the row buttons can't function correctly. This pass
  // parses the markdown of any entry with an empty annotationIds list and
  // looks each row up against the annotation store (preferring xpath, then
  // falling back to (url, selector, note prefix)). The recovered IDs are
  // persisted back to storage so subsequent renders can use them directly.
  //
  // The match logic only runs against the existing _annStore + current
  // annotations — it doesn't fabricate new annotations. Rows that can't be
  // matched are simply not rendered (the entry's header + Raw button still
  // appear, and the user can permanently delete it from there).
  function backfillCopyLogIds(cb) {
    chrome.storage.local.get({
      [COPY_HISTORY_KEY]: [], [ANN_STORE_KEY]: {}, annotations: [],
      [COPY_LOG_BACKFILL_FLAG]: false,
    }, r => {
      if (r[COPY_LOG_BACKFILL_FLAG]) { if (cb) cb(); return; }
      const copyHist = r[COPY_HISTORY_KEY] || [];
      const store    = { ...(r[ANN_STORE_KEY] || {}) };
      const liveAnns = r.annotations || [];

      // Build lookup indices over every annotation we know about (current +
      // store). Same id may appear in both — current wins (fresher data).
      const annPool = new Map();
      Object.entries(store).forEach(([id, ann]) => {
        if (id && ann) annPool.set(id, stripRefMeta(ann));
      });
      liveAnns.forEach(a => { if (a && a.id) annPool.set(a.id, a); });

      const normUrl = u => (u || '').split('#')[0];
      const xpathIdx  = new Map(); // "normUrl|xpath" -> id
      const selNoteIdx = new Map(); // "normUrl|sel|notePrefix" -> [ids]
      annPool.forEach((ann, id) => {
        const nu = normUrl(ann.url);
        if (ann.xpath) {
          const k = nu + '|' + ann.xpath;
          if (!xpathIdx.has(k)) xpathIdx.set(k, id);
        }
        const sel  = getSelector(ann);
        // Match against the combined-note text so multi-note Premium
        // annotations still dedup correctly during copy-log backfill.
        const note = (getCombinedNoteText(ann) || (ann.comment || '')).trim().slice(0, 120);
        const k2   = nu + '|' + sel + '|' + note;
        const arr  = selNoteIdx.get(k2) || [];
        arr.push(id);
        selNoteIdx.set(k2, arr);
      });

      // Parse one copy-log entry's markdown output into a list of row
      // descriptors: { sel, xpath, url, note }.
      function parseRows(output) {
        if (!output || !output.trim()) return [];
        const lines = output.split('\n');
        const rows  = [];
        let curUrl = '';
        let i = 0;
        const URL_RE = /^#{2,3}\s+(.+)$/;
        // Old format: "N. `sel` | `xpath` → note" (single line)
        const OLD_RE = /^\d+\.\s+`([^`]*)`\s*(?:\|\s+`([^`]*)`)?\s*(?:→|->)\s*(.*)$/;
        // New format: "N. `sel`" with sub-items on following "   - …" lines
        const NEW_RE = /^\d+\.\s+`([^`]*)`\s*$/;
        while (i < lines.length) {
          const line = lines[i];
          const um = line.match(URL_RE);
          if (um) { curUrl = um[1].trim(); i++; continue; }
          const om = line.match(OLD_RE);
          if (om) {
            rows.push({ sel: om[1], xpath: om[2] || '', url: curUrl, note: (om[3] || '').trim() });
            i++; continue;
          }
          const nm = line.match(NEW_RE);
          if (nm) {
            let j = i + 1, note = '';
            while (j < lines.length && lines[j].startsWith('   - ')) {
              const content = lines[j].slice(5);
              const isTs   = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(content);
              const isUrl  = /^https?:\/\//.test(content);
              const isText = content.startsWith('_"') && content.endsWith('"_');
              if (!isTs && !isUrl && !isText) {
                note = note ? note + '\n' + content : content;
              }
              j++;
            }
            rows.push({ sel: nm[1], xpath: '', url: curUrl, note });
            i = j; continue;
          }
          i++;
        }
        return rows;
      }

      let changed = false;
      const rebuilt = copyHist.map(entry => {
        if (!entry) return entry;
        if (Array.isArray(entry.annotationIds) && entry.annotationIds.length) return entry;
        const rows = parseRows(entry.output);
        if (!rows.length) return entry;
        const recovered = [];
        const used = new Set();
        rows.forEach(row => {
          const nu = normUrl(row.url);
          let id = null;
          if (row.xpath) id = xpathIdx.get(nu + '|' + row.xpath) || null;
          if (!id) {
            const cands = selNoteIdx.get(nu + '|' + row.sel + '|' + row.note.slice(0, 120)) || [];
            id = cands.find(c => !used.has(c)) || null;
          }
          if (id) { recovered.push(id); used.add(id); }
        });
        if (!recovered.length) return entry;
        // Bump refcounts for recovered ids so the store entries aren't garbage
        // collected later.
        recovered.forEach(id => {
          if (store[id]) store[id]._refCount = (store[id]._refCount || 0) + 1;
        });
        changed = true;
        return { ...entry, annotationIds: recovered };
      });

      if (!changed) {
        chrome.storage.local.set({ [COPY_LOG_BACKFILL_FLAG]: true }, () => { if (cb) cb(); });
        return;
      }
      chrome.storage.local.set({
        [COPY_HISTORY_KEY]: rebuilt,
        [ANN_STORE_KEY]: store,
        [COPY_LOG_BACKFILL_FLAG]: true,
      }, () => { if (cb) cb(); });
    });
  }

  function renderCopyHistory() {
    chrome.storage.local.get({ [COPY_HISTORY_KEY]: [], annotations: [], [ANN_STORE_KEY]: {} }, r => {
      const copyHist = r[COPY_HISTORY_KEY];
      const store    = r[ANN_STORE_KEY] || {};
      const currentById = new Map((r.annotations || []).map(a => [a.id, a]));

      if (copyHist.length === 0) {
        historyEl.innerHTML = historyTabsHTML('copies') +
          `<p class="empty-msg">No copy history yet.<br>Use the copy button to record an output here.</p>`;
        attachTabListeners();
        return;
      }

      // Build a per-annotation list of selector pieces (main + every
      // contextElements entry). Multi-element annotations stay as a single
      // row but show all their selectors joined.
      function annSelectors(ann) {
        if (!ann) return [];
        if (ann.pageLevel || ann.tag === 'page') return ['(whole page)'];
        const parts = [];
        const rawId = ann.elId !== undefined
          ? (ann.elId ? `#${ann.elId}` : '')
          : (ann.id && ann.id !== 'N/A' && !ann.id.startsWith('ann_') ? ann.id : '');
        const cls = ann.classes && ann.classes !== 'N/A' ? ann.classes : '';
        parts.push(`${ann.tag || '?'}${rawId}${cls}`);
        if (Array.isArray(ann.contextElements)) {
          ann.contextElements.forEach(ctx => {
            const cId  = ctx.elId ? `#${ctx.elId}` : '';
            const cCls = ctx.classes && ctx.classes !== 'N/A' ? ctx.classes : '';
            parts.push(`${ctx.tag || '?'}${cId}${cCls}`);
          });
        }
        return parts;
      }

      let html = historyTabsHTML('copies');
      // Sort newest-first regardless of storage/import order.
      [...copyHist]
        .sort((a, b) => {
          const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          return tb - ta;
        })
        .forEach(entry => {
        const ids = Array.isArray(entry.annotationIds) ? entry.annotationIds : [];

        // Resolve each id into its full annotation snapshot, preferring a
        // current-set match (so any edits to the note since the copy show
        // through), and falling back to the ref-store snapshot.
        const resolved = ids
          .map(id => currentById.get(id) || (store[id] ? stripRefMeta(store[id]) : null))
          .filter(Boolean);

        // Group resolved annotations by URL, preserving original order.
        // Every row must resolve to a real annotation id — there is no
        // markdown-parsing fallback. Legacy entries that couldn't be matched
        // to any annotation during the one-time backfill simply render with
        // no rows (the entry's header + Raw button still appear).
        const groups = [];
        const groupIdx = new Map();
        resolved.forEach(ann => {
          const u = ann.url || '';
          if (!groupIdx.has(u)) {
            groupIdx.set(u, groups.length);
            groups.push({ url: u, items: [] });
          }
          groups[groupIdx.get(u)].items.push(ann);
        });

        // Build a set of ids that are still live for per-row red-minus/restore button.
        const liveIdSet = new Set(resolved.filter(a => currentById.has(a.id)).map(a => a.id));

        const when     = formatTimestamp(entry.timestamp);
        const annCount = entry.count != null ? entry.count : resolved.length;
        const hasRaw   = !!(entry.output && String(entry.output).trim());

        // SFL-style layout for the copy log entry. Adds a "Raw" button to
        // toggle the verbatim copied output.
        html += `
        <div class="sfl-set copy-hist-item" data-set-id="${escHtml(entry.timestamp)}">
          <div class="sfl-set-header">
            <span class="sfl-set-meta">📅 ${escHtml(when)} · ${annCount} annotation${annCount !== 1 ? 's' : ''}</span>
            <div class="sfl-set-actions">
              ${hasRaw ? `<button class="sfl-set-btn copy-hist-raw-btn" data-ts="${escHtml(entry.timestamp)}" title="View raw output">📄 Raw</button>` : ''}
              <button class="copy-hist-perm-delete-btn" data-ts="${escHtml(entry.timestamp)}" title="Permanently delete">✕</button>
            </div>
          </div>
          ${groups.map(g => `
            <div class="sfl-url-group">
              <div class="sfl-url hist-clickable-text" data-full-text="${escHtml(g.url || '')}" title="${escHtml(g.url)}">${escHtml(g.url || '(no url)')}</div>
              <ul class="sfl-set-list">
                ${g.items.map(ann => {
                  const fullSels = annSelectors(ann).join(', ');
                  // Combined notes preview (primary + extras joined with " • ")
                  // so the Copy Log row reflects the full note set even when
                  // the annotation has multiple Premium notes.
                  const note = getCombinedNoteText(ann) || '(no note)';
                  const noteShort = note.slice(0, 120) + (note.length > 120 ? '…' : '');
                  const isLive = ann.id && liveIdSet.has(ann.id);
                  // Every row resolves to a real annotation id, so we always
                  // render either the red-minus (live) or restore (history)
                  // button — no DOM-only fallback exists.
                  const rowBtn = isLive
                    ? `<button class="copy-hist-row-remove-btn" data-ann-id="${escHtml(ann.id)}" title="Remove this annotation from current">−</button>`
                    : `<button class="hist-restore-btn copy-hist-row-restore-btn" data-ann-id="${escHtml(ann.id)}" title="Restore annotation">↺</button>`;
                  const rowClass = isLive ? ' copy-hist-row--live' : '';
                  return `<li class="copy-hist-li${rowClass}" title="${escHtml(fullSels)}"><code class="hist-clickable-text" data-full-text="${escHtml(fullSels)}">${escHtml(fullSels)}</code><span class="hist-clickable-text" data-full-text="${escHtml(note)}">${escHtml(noteShort)}</span>${rowBtn}</li>`;
                }).join('')}
              </ul>
            </div>`).join('')}
          ${hasRaw ? `<pre class="copy-hist-raw-body" data-ts="${escHtml(entry.timestamp)}" style="display:none;">${escHtml(entry.output)}</pre>` : ''}
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

      // Per-row red minus: remove a single annotation from the current list,
      // staying on the Copy Log tab afterwards.
      historyEl.querySelectorAll('.copy-hist-row-remove-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          removeAnnotationFromCurrent(btn.dataset.annId);
        });
      });

      // Per-row green restore: add annotation back to current set.
      historyEl.querySelectorAll('.copy-hist-row-restore-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          restoreAnnotationFromCopyLog(btn.dataset.annId);
        });
      });

      // "📄 Raw" — toggles the verbatim copied output for that entry.
      historyEl.querySelectorAll('.copy-hist-raw-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const ts = btn.dataset.ts;
          const safeTs = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(ts) : ts;
          const body = historyEl.querySelector(`.copy-hist-raw-body[data-ts="${safeTs}"]`);
          if (!body) return;
          const showing = body.style.display !== 'none';
          body.style.display = showing ? 'none' : 'block';
          btn.classList.toggle('active', !showing);
        });
      });

      // Re-apply search highlights if search is active
      if (searchActive && searchInput && searchInput.value.trim()) {
        applySearch(searchInput.value.trim());
      }
    });
  }

  // Remove a single annotation from the current set without leaving the
  // history view. Used by the per-row red minus button in the Copy Log tab.
  function removeAnnotationFromCurrent(annId) {
    readDedupStorage(r => {
      const ann = r.annotations.find(a => a.id === annId);
      if (!ann) {
        showToast('Annotation not in current set.');
        renderHistoryTab();
        return;
      }
      const remaining = r.annotations.filter(a => a.id !== annId);
      isWritingFromPopup = true;
      chrome.storage.local.set({ annotations: remaining }, () => {
        isWritingFromPopup = false;
        broadcastRemove(ann.id, ann.xpath);
        // Stay on the copy log tab — re-render the active history tab.
        renderHistoryTab();
      });
    });
  }

  // Restore a single annotation from the copy-log store back into the current
  // annotation list. Used by the per-row "Restore" button in the Copy Log tab.
  function restoreAnnotationFromCopyLog(annId) {
    readDedupStorage(r => {
      if (r.annotations.some(a => a.id === annId)) {
        showToast('Annotation is already in current set.');
        renderHistoryTab();
        return;
      }
      const store = r[ANN_STORE_KEY] || {};
      const ann = store[annId] ? stripRefMeta(store[annId]) : null;
      if (!ann) {
        showToast('Annotation data not available.');
        renderHistoryTab();
        return;
      }
      const newAnns = [...r.annotations, ann];
      isWritingFromPopup = true;
      chrome.storage.local.set({ annotations: newAnns }, () => {
        isWritingFromPopup = false;
        broadcastRestore(ann);
        renderHistoryTab();
      });
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
      let licenseSection;
      if (premium) {
        chrome.storage.local.get({ [LICENSE_STORAGE_KEY]: null }, r => {
          const lic = r[LICENSE_STORAGE_KEY] || {};
          const emailLine = lic.email
            ? `<div class="settings-row"><span class="settings-label">Licensed to</span><span class="settings-value">${escHtml(lic.email)}</span></div>`
            : '';
          licenseSection = `
            <div class="settings-section">
              <div class="settings-section-title">⭐ Premium</div>
              <div class="settings-row">
                <span class="settings-label">Status</span>
                <span class="settings-value premium-active-badge">✅ Premium Active</span>
              </div>
              ${emailLine}
              <div class="settings-row">
                <button id="deactivate-license-btn" class="btn-secondary" type="button">Remove license from this device</button>
              </div>
            </div>`;
          buildAndInjectSettings(s, licenseSection, premium);
        });
      } else {
        licenseSection = `
          <div class="settings-section">
            <div class="settings-section-title">⭐ Premium</div>
            <p class="settings-hint">Premium unlocks dark mode, custom prepend/append text on every Markdown export, multiple notes per element, and all future Premium features. One-time $9.99, no subscription.</p>
            <div class="settings-row">
              <button id="get-premium-btn" class="btn-primary" type="button">Get Premium ($9.99)</button>
            </div>
            <div class="settings-field">
              <label class="settings-label" for="license-key-input">License key</label>
              <input id="license-key-input" type="text" class="settings-input" placeholder="Paste your license key here…" autocomplete="off" spellcheck="false" />
            </div>
            <div class="settings-row">
              <button id="activate-license-btn" class="btn-primary" type="button">Activate</button>
              <span id="license-status" class="settings-value" style="margin-left:8px;"></span>
            </div>
          </div>`;
        buildAndInjectSettings(s, licenseSection, premium);
      }
    });
  }

  function buildAndInjectSettings(s, licenseSection, premium) {
    const currentMod      = s.shortcut?.modifier || 'alt';
    const currentLabel    = escHtml(MODIFIER_LABELS[currentMod] || 'Alt');
    // Per-tab history limits (0 = indefinite). The annotation tab falls back
    // to the legacy maxHistoryLength so existing installs keep their value.
    const histAnnLimit   = getHistoryLimit(s, 'annotations');
    const histSavedLimit = getHistoryLimit(s, 'saved');
    const histCopyLimit  = getHistoryLimit(s, 'copies');
    const isIndefAnn     = histAnnLimit   === 0;
    const isIndefSaved   = histSavedLimit === 0;
    const isIndefCopy    = histCopyLimit  === 0;

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

    // Undo/redo shortcut state for this render.
    const undoSc  = s.undoShortcut || DEFAULT_SETTINGS.undoShortcut;
    const redoSc  = s.redoShortcut || DEFAULT_SETTINGS.redoShortcut;
    const undoMod = undoSc.modifier || 'mod';
    const undoKey = undoSc.key      || 'z';
    const redoMod = redoSc.modifier || 'mod';
    const redoKey = redoSc.key      || 'y';
    const shortcutModOptions = (selected) => {
      const mods = [
        ['mod',   'Ctrl / ⌘ Cmd'],
        ['ctrl',  'Ctrl'],
        ['meta',  'Meta / ⌘ Cmd'],
        ['alt',   'Alt / Option'],
        ['shift', 'Shift'],
      ];
      return mods.map(([v, l]) =>
        `<option value="${v}" ${selected === v ? 'selected' : ''}>${escHtml(l)}</option>`
      ).join('');
    };

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

      <!-- ── Team Sync ── -->
      <div class="settings-section">
        <div class="settings-section-title">☁️ Team Sync</div>
        <div class="settings-row">
          <span class="settings-label">Status</span>
          <span class="settings-value" id="team-sync-status">Checking…</span>
        </div>
        <div class="settings-row">
          <span class="settings-label">Repository</span>
          <span class="settings-value settings-value--truncate" title="${escHtml(s.githubUrl || '')}">${escHtml(s.githubUrl || 'Not configured')}</span>
        </div>
        <div class="settings-row">
          <span class="settings-label">You</span>
          <span class="settings-value team-identity-value">
            <span class="team-color-dot" style="background:${escHtml(s.userColor || '#2563eb')}"></span>
            ${escHtml(s.username || 'Assigned in desktop app')}
          </span>
        </div>
        <p class="settings-hint">Set Firebase, GitHub, name, and color once in the desktop app. Use refresh only after changing those values there.</p>
        <div class="settings-row settings-row--btns">
          <button id="refresh-team-config-btn" class="btn-history-action">Refresh from desktop app</button>
        </div>
      </div>
      <!-- ── Undo / Redo Shortcuts ── -->
      <div class="settings-section">
        <div class="settings-section-title">↶ Undo / Redo</div>
        <div class="settings-row">
          <label class="settings-label" for="undo-mod">Undo</label>
          <div class="shortcut-pair">
            <select id="undo-mod" class="shortcut-select">${shortcutModOptions(undoMod)}</select>
            <span class="shortcut-plus">+</span>
            <input id="undo-key" class="shortcut-key-input" maxlength="1" value="${escHtml(undoKey)}" />
          </div>
        </div>
        <div class="settings-row">
          <label class="settings-label" for="redo-mod">Redo</label>
          <div class="shortcut-pair">
            <select id="redo-mod" class="shortcut-select">${shortcutModOptions(redoMod)}</select>
            <span class="shortcut-plus">+</span>
            <input id="redo-key" class="shortcut-key-input" maxlength="1" value="${escHtml(redoKey)}" />
          </div>
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
          Annotations and history live on your device (chrome.storage.local). Auto-Backup mirrors a compressed snapshot to Chrome Sync (chrome.storage.sync) so it follows your Google account across signed-in Chrome installs. Sync is end-to-end encrypted by Google when you set a Sync passphrase. Disable Auto-Backup to stop syncing to your Google account; data remains on this device and the local snapshot still refreshes periodically.
        </p>
        <div class="settings-row" style="justify-content:flex-end;margin-top:4px;">
          <button id="backup-now-btn" class="btn-history-action">⚡ Backup Now</button>
        </div>
      </div>

      <!-- ── History ── -->
      <div class="settings-section">
        <div class="settings-section-title">📜 History</div>
        <p class="settings-hint" style="margin-top:-4px;margin-bottom:8px;">
          Customize how many entries each history tab keeps. Set Indefinite to keep everything.
        </p>

        <div class="settings-row">
          <label class="settings-label" for="max-hist-annotations">
            Annotation History
          </label>
          <div class="history-limit-row">
            <input
              type="number"
              id="max-hist-annotations"
              class="history-limit-input"
              min="1"
              max="10000"
              value="${isIndefAnn ? 200 : histAnnLimit}"
              ${isIndefAnn ? 'disabled' : ''}
            />
            <label class="history-indefinite-label">
              <input type="checkbox" id="indef-hist-annotations"
                ${isIndefAnn ? 'checked' : ''} />
              Indefinite
            </label>
          </div>
        </div>

        <div class="settings-row">
          <label class="settings-label" for="max-hist-saved">
            Saved for Later
          </label>
          <div class="history-limit-row">
            <input
              type="number"
              id="max-hist-saved"
              class="history-limit-input"
              min="1"
              max="10000"
              value="${isIndefSaved ? 20 : histSavedLimit}"
              ${isIndefSaved ? 'disabled' : ''}
            />
            <label class="history-indefinite-label">
              <input type="checkbox" id="indef-hist-saved"
                ${isIndefSaved ? 'checked' : ''} />
              Indefinite
            </label>
          </div>
        </div>

        <div class="settings-row">
          <label class="settings-label" for="max-hist-copies">
            Copy Log
          </label>
          <div class="history-limit-row">
            <input
              type="number"
              id="max-hist-copies"
              class="history-limit-input"
              min="1"
              max="10000"
              value="${isIndefCopy ? 50 : histCopyLimit}"
              ${isIndefCopy ? 'disabled' : ''}
            />
            <label class="history-indefinite-label">
              <input type="checkbox" id="indef-hist-copies"
                ${isIndefCopy ? 'checked' : ''} />
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
        <input type="file" id="import-all-file" accept=".annotator,.gz,.json" style="display:none;" multiple />
        <div id="sync-truncation-warning" class="sync-truncation-warning" style="display:none;">
          ⚠ History is being truncated to fit sync storage limits. Your full history is preserved locally and in the latest export.
        </div>
      </div>

      ${licenseSection}

      <!-- ── Appearance ── -->
      <div class="settings-section">
        <div class="settings-section-title">🌙 Appearance${premium ? '' : ' <span class="premium-lock">🔒 Premium</span>'}</div>
        <div class="settings-row settings-row--toggle">
          <span class="settings-label">Dark Mode</span>
          <div class="toggle-wrap">
            <label class="toggle-switch">
              <input type="checkbox" id="dark-mode-toggle" ${s.darkMode ? 'checked' : ''} ${premium ? '' : 'disabled'}>
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
        ${premium ? '' : '<p class="settings-hint">Unlock with Premium ($9.99 one-time).</p>'}
      </div>

      <!-- ── Markdown Copy ── -->
      <div class="settings-section">
        <div class="settings-section-title">📝 Markdown Copy${premium ? '' : ' <span class="premium-lock">🔒 Premium</span>'}</div>
        <div class="settings-field">
          <label class="settings-label" for="prepend-text">Prepend Text</label>
          <textarea
            id="prepend-text"
            class="settings-textarea"
            placeholder="Text added before the markdown output…"
            ${premium ? '' : 'disabled'}
          >${escHtml(s.prependText || '')}</textarea>
        </div>
        <div class="settings-field">
          <label class="settings-label" for="append-text">Append Text</label>
          <textarea
            id="append-text"
            class="settings-textarea"
            placeholder="Text added after the markdown output…"
            ${premium ? '' : 'disabled'}
          >${escHtml(s.appendText || '')}</textarea>
        </div>
        ${premium ? '' : '<p class="settings-hint">Unlock with Premium ($9.99 one-time).</p>'}
      </div>

      <div class="settings-github-row">
        <a href="#" class="meta-link" data-url="https://github.com/asharma2027/ai-dev-annotator/tree/release" title="View source on GitHub">View source on GitHub →</a>
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

    // ── Undo / Redo shortcut inputs ──────────────────────────────────────
    const undoModSel = settingsEl.querySelector('#undo-mod');
    const undoKeyIn  = settingsEl.querySelector('#undo-key');
    const redoModSel = settingsEl.querySelector('#redo-mod');
    const redoKeyIn  = settingsEl.querySelector('#redo-key');
    function saveUndoShortcut() {
      const k = (undoKeyIn.value || 'z').trim().slice(0, 1).toLowerCase() || 'z';
      undoKeyIn.value = k;
      saveSettings({ undoShortcut: { modifier: undoModSel.value, key: k } });
    }
    function saveRedoShortcut() {
      const k = (redoKeyIn.value || 'y').trim().slice(0, 1).toLowerCase() || 'y';
      redoKeyIn.value = k;
      saveSettings({ redoShortcut: { modifier: redoModSel.value, key: k } });
    }
    if (undoModSel) undoModSel.addEventListener('change', saveUndoShortcut);
    if (undoKeyIn)  undoKeyIn.addEventListener('change',  saveUndoShortcut);
    if (redoModSel) redoModSel.addEventListener('change', saveRedoShortcut);
    if (redoKeyIn)  redoKeyIn.addEventListener('change',  saveRedoShortcut);

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

    // ── History settings (per-tab limits) ────────────────────────────────
    // Each tab gets its own number input + indefinite checkbox. After every
    // edit we (a) persist via saveSettings (deep-merged on historyLimits),
    // (b) trim existing data immediately via enforceHistoryLimitInStorage,
    // and (c) re-render the active history tab if visible.
    const HIST_TAB_DEFAULTS = { annotations: 200, saved: 20, copies: 50 };
    const HIST_TAB_LEGACY   = { annotations: true, saved: false, copies: false };

    function wireHistoryLimitTab(tabKey, inputId, chkId) {
      const inputEl = settingsEl.querySelector('#' + inputId);
      const chkEl   = settingsEl.querySelector('#' + chkId);
      if (!inputEl || !chkEl) return;

      const persist = (val) => {
        const patch = { historyLimits: { [tabKey]: val } };
        // For the annotations tab also mirror into legacy maxHistoryLength so
        // content.js (which still reads it) stays in sync.
        if (HIST_TAB_LEGACY[tabKey]) patch.maxHistoryLength = val;
        saveSettings(patch, () => {
          enforceHistoryLimitInStorage(() => {
            if (historyVisible) renderHistoryTab();
          });
        });
      };

      chkEl.addEventListener('change', () => {
        if (chkEl.checked) {
          inputEl.disabled = true;
          persist(0);
        } else {
          inputEl.disabled = false;
          const val = Math.max(1, parseInt(inputEl.value, 10) || HIST_TAB_DEFAULTS[tabKey]);
          inputEl.value = val;
          persist(val);
        }
      });

      inputEl.addEventListener('change', () => {
        const val = Math.max(1, parseInt(inputEl.value, 10) || HIST_TAB_DEFAULTS[tabKey]);
        inputEl.value = val;
        persist(val);
      });
    }

    wireHistoryLimitTab('annotations', 'max-hist-annotations', 'indef-hist-annotations');
    wireHistoryLimitTab('saved',       'max-hist-saved',       'indef-hist-saved');
    wireHistoryLimitTab('copies',      'max-hist-copies',      'indef-hist-copies');

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
          // Resolve annotation objects so the export is self-contained:
          // restore buttons will work correctly after import.
          const anns = Array.isArray(c.annotationIds)
            ? c.annotationIds.map(id =>
                (r.annotations || []).find(a => a.id === id)
                || (store[id] ? stripRefMeta(store[id]) : null)
              ).filter(Boolean)
            : [];
          return { ...c, annotations: anns };
        });
        const bundle = buildBundle({
          annotations:   r.annotations,
          history:       fullHistory,
          copyHistory:   exportedCopyHist,
          savedForLater: fullSaved,
          settings:      r[SETTINGS_KEY],
        });
        bundle._exported = new Date().toISOString();
        bundle._version  = '1.0.0';
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
      importAllFile.addEventListener('change', async () => {
        const files = Array.from(importAllFile.files);
        if (!files.length) return;

        // ── Helper: read one file and return its unpacked bundle ───────────
        async function readOneFile(file) {
          const buf = await new Promise((res, rej) => {
            const reader = new FileReader();
            reader.onload = e => res(e.target.result);
            reader.onerror = rej;
            reader.readAsArrayBuffer(file);
          });
          let bundle = null;
          try {
            const json = await gunzipToString(new Uint8Array(buf));
            bundle = JSON.parse(json);
          } catch {
            try {
              const txt = new TextDecoder().decode(new Uint8Array(buf));
              bundle = JSON.parse(txt);
            } catch {
              return null; // signal invalid file
            }
          }
          if (!bundle) return null;
          if (bundle.v === 2) return unpackBundle(bundle);
          return {
            annotations:   Array.isArray(bundle.annotations)       ? bundle.annotations       : [],
            history:       Array.isArray(bundle.annotationHistory) ? bundle.annotationHistory : [],
            copyHistory:   Array.isArray(bundle.copyHistory)       ? bundle.copyHistory       : [],
            savedForLater: Array.isArray(bundle.savedForLater)     ? bundle.savedForLater     : [],
            settings:      bundle.annotatorSettings && typeof bundle.annotatorSettings === 'object'
                             ? bundle.annotatorSettings : {},
          };
        }

        // ── Parse all selected files ───────────────────────────────────
        const parsedFiles = [];
        let invalidCount  = 0;
        for (const file of files) {
          const unpacked = await readOneFile(file);
          if (!unpacked) { invalidCount++; continue; }
          parsedFiles.push(unpacked);
        }
        if (invalidCount > 0) {
          showToast(`${invalidCount} file(s) were invalid and skipped.`, { kind: 'error' });
        }
        if (!parsedFiles.length) { importAllFile.value = ''; return; }

        // ── Merge across all files, deduplicating entries ──────────────
        const merged = parsedFiles.reduce((acc, u) => {
          // Annotations: dedup by id
          const annIds = new Set(acc.annotations.map(a => a.id));
          u.annotations.forEach(a => { if (a && a.id && !annIds.has(a.id)) { annIds.add(a.id); acc.annotations.push(a); } });
          // History: dedup by id+deletedAt
          const histKeys = new Set(acc.history.map(h => h.id + '|' + (h.deletedAt || '')));
          u.history.forEach(h => {
            if (!h || !h.id) return;
            const k = h.id + '|' + (h.deletedAt || '');
            if (!histKeys.has(k)) { histKeys.add(k); acc.history.push(h); }
          });
          // Copy history: dedup by timestamp
          const copyTs = new Set(acc.copyHistory.map(c => c.timestamp));
          u.copyHistory.forEach(c => { if (c && c.timestamp && !copyTs.has(c.timestamp)) { copyTs.add(c.timestamp); acc.copyHistory.push(c); } });
          // Saved-for-later: dedup by id
          const slIds = new Set(acc.savedForLater.map(s => s.id));
          u.savedForLater.forEach(s => { if (s && s.id && !slIds.has(s.id)) { slIds.add(s.id); acc.savedForLater.push(s); } });
          // Settings: merge (later files override earlier)
          acc.settings = { ...acc.settings, ...u.settings };
          return acc;
        }, { annotations: [], history: [], copyHistory: [], savedForLater: [], settings: {} });

        const fileWord = files.length === 1 ? '1 file' : `${files.length} files`;
        const ok = await showConfirm(
          `Import ${fileWord}?\n\n` +
          `• ${merged.annotations.length} active annotation(s)\n` +
          `• ${merged.history.length} history record(s)\n` +
          `• ${merged.savedForLater.length} saved-for-later set(s)\n` +
          `• ${merged.copyHistory.length} copy log(s)\n\n` +
          `Existing items will be merged (not overwritten). Duplicates across files are automatically skipped.`,
          { host: settingsEl }
        );
        if (!ok) { importAllFile.value = ''; return; }

        chrome.storage.local.get({
          annotations: [], [HISTORY_KEY]: [], [COPY_HISTORY_KEY]: [],
          [SAVED_LATER_KEY]: [], [SETTINGS_KEY]: {}, [ANN_STORE_KEY]: {},
        }, r => {
          const store = { ...(r[ANN_STORE_KEY] || {}) };
          // Only import annotations not already present (dedup against existing data)
          const annIds  = new Set(r.annotations.map(a => a.id));
          const newAnns = merged.annotations.filter(a => a && a.id && !annIds.has(a.id));

          // Imported history: convert to id-refs, skip duplicates
          const histKeys = new Set(r[HISTORY_KEY].map(a => a.id + '|' + (a.deletedAt || '')));
          const newHistRefs = [];
          merged.history.forEach(h => {
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

          // Copy history: skip already-present timestamps
          const copyTs  = new Set(r[COPY_HISTORY_KEY].map(c => c.timestamp));
          const newCopy = merged.copyHistory
            .filter(c => c && c.timestamp && !copyTs.has(c.timestamp))
            .map(c => {
              const withIds = Array.isArray(c.annotationIds) ? c : { ...c, annotationIds: [] };
              // Populate _annStore from annotation snapshots bundled in the export
              // so that restore buttons work correctly after import.
              if (withIds.annotationIds.length && Array.isArray(c.annotations)) {
                withIds.annotationIds.forEach(id => {
                  const ann = c.annotations.find(a => a && a.id === id);
                  if (!ann) return;
                  if (!store[id]) store[id] = { ...ann, _refCount: 0 };
                  else store[id] = { ...store[id], ...ann };
                  store[id]._refCount = (store[id]._refCount || 0) + 1;
                });
              }
              // Drop the inline `annotations` array — data now lives in _annStore via IDs
              const { annotations: _snap, ...rest } = withIds;
              return rest;
            });

          // Saved-for-later: convert to id-references, skip duplicates
          const slIds   = new Set(r[SAVED_LATER_KEY].map(s => s.id));
          const newSL = [];
          merged.savedForLater.forEach(set => {
            if (!set || slIds.has(set.id)) return;
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
              id:            set.id,
              savedAt:       set.savedAt,
              count:         set.count || ids.length,
              annotationIds: ids,
            });
          });

          chrome.storage.local.set({
            annotations:        [...r.annotations,       ...newAnns],
            [HISTORY_KEY]:      [...r[HISTORY_KEY],      ...newHistRefs],
            [COPY_HISTORY_KEY]: [...r[COPY_HISTORY_KEY], ...newCopy],
            [SAVED_LATER_KEY]:  [...r[SAVED_LATER_KEY],  ...newSL],
            [SETTINGS_KEY]:     { ...r[SETTINGS_KEY], ...merged.settings },
            [ANN_STORE_KEY]:    store,
            // Imports may carry legacy copy-log entries with no annotationIds;
            // re-arm the backfill so they get matched on the next pass.
            [COPY_LOG_BACKFILL_FLAG]: false,
          }, () => {
            backfillCopyLogIds(() => {
              if (historyVisible) renderHistoryTab();
            });
            showToast(
              `Imported: ${newAnns.length} annotation(s) · ${newHistRefs.length} history · ` +
              `${newSL.length} saved-for-later · ${newCopy.length} copy log(s)`,
              { kind: 'ok' }
            );
            if (merged.settings && merged.settings.darkMode !== undefined) {
              applyDarkMode(merged.settings.darkMode);
            }
          });
        });
        importAllFile.value = '';
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
        if (!isPremium()) {
          darkToggle.checked = false;
          showToast('Dark mode is a Premium feature. Get Premium for $9.99.');
          return;
        }
        saveSettings({ darkMode: darkToggle.checked }, updated => applyDarkMode(updated.darkMode));
      });
    }

    // ── Premium buttons (Get Premium / Activate / Deactivate) ─────────────
    const getPremiumBtn = settingsEl.querySelector('#get-premium-btn');
    if (getPremiumBtn) {
      getPremiumBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: PREMIUM_PURCHASE_URL });
      });
    }
    const activateBtn   = settingsEl.querySelector('#activate-license-btn');
    const licenseInput  = settingsEl.querySelector('#license-key-input');
    const licenseStatus = settingsEl.querySelector('#license-status');
    if (activateBtn && licenseInput) {
      const doActivate = async () => {
        const key = (licenseInput.value || '').trim();
        if (!key) { if (licenseStatus) licenseStatus.textContent = 'Paste your license key first.'; return; }
        activateBtn.disabled = true;
        if (licenseStatus) licenseStatus.textContent = 'Verifying…';
        const result = await activateLicense(key);
        activateBtn.disabled = false;
        if (result.valid) {
          showToast('Premium activated. Thanks for the support!', { kind: 'success' });
          renderSettings();
        } else if (licenseStatus) {
          licenseStatus.textContent = result.error || 'Invalid license key.';
        }
      };
      activateBtn.addEventListener('click', doActivate);
      licenseInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); doActivate(); }
      });
    }
    const deactivateBtn = settingsEl.querySelector('#deactivate-license-btn');
    if (deactivateBtn) {
      deactivateBtn.addEventListener('click', async () => {
        await deactivateLicense();
        showToast('License removed from this device.');
        renderSettings();
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

    // ── Team Sync status ─────────────────────────────────────────────────
    chrome.storage.local.get({
      _teamSyncStatus: {},
      _teamSetupLastChecked: null,
      _teamSetupError: null,
    }, data => {
      const statusEl = settingsEl.querySelector('#team-sync-status');
      if (!statusEl) return;
      const sync = data._teamSyncStatus || {};
      if (data._teamSetupError && !sync.connected) {
        statusEl.textContent = 'Desktop app not available';
        statusEl.style.color = '#dc2626';
        statusEl.title = data._teamSetupError;
      } else if (sync.connected) {
        statusEl.textContent = sync.lastSync
          ? 'Connected · ' + new Date(sync.lastSync).toLocaleTimeString()
          : 'Connected';
        statusEl.style.color = '#16a34a';
        statusEl.title = sync.teamId || '';
      } else if (sync.error) {
        statusEl.textContent = 'Not connected';
        statusEl.style.color = '#dc2626';
        statusEl.title = sync.error;
      } else {
        statusEl.textContent = 'Not configured';
        statusEl.title = data._teamSetupLastChecked
          ? 'Last checked ' + new Date(data._teamSetupLastChecked).toLocaleString()
          : '';
      }
    });

    settingsEl.querySelector('#refresh-team-config-btn')?.addEventListener('click', e => {
      const btn = e.currentTarget;
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Refreshing…';
      chrome.runtime.sendMessage({ type: 'refreshLocalConfig' }, result => {
        btn.disabled = false;
        btn.textContent = original;
        if (chrome.runtime.lastError || !result || result.ok === false) {
          const msg = chrome.runtime.lastError?.message || result?.error || 'Desktop app not available.';
          showToast('Could not refresh setup: ' + msg, { kind: 'error' });
          renderSettings();
          return;
        }
        showToast(result.changed ? 'Team setup refreshed.' : 'Team setup already current.', { kind: 'ok' });
        renderSettings();
      });
    });
  }

  settingsBtn.addEventListener('click', () => {
    if (settingsVisible) hideSettings();
    else showSettings();
  });

  // ── Markdown generation helper ─────────────────────────────────────────────
  function buildMarkdown(annotations, settings) {
    const anns = annotations.filter(hasAnyNote);
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
          // (filtered by buildMarkdown's "has any note" rule — primary OR extras).
          const contribAnns = r.annotations.filter(hasAnyNote);
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
            prependText: (s && s.prependText && s.prependText.trim()) ? s.prependText.trim() : '',
            appendText:  (s && s.appendText  && s.appendText.trim())  ? s.appendText.trim()  : '',
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
          const contribAnns = r.annotations.filter(hasAnyNote);
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
            prependText: (s && s.prependText && s.prependText.trim()) ? s.prependText.trim() : '',
            appendText:  (s && s.appendText  && s.appendText.trim())  ? s.appendText.trim()  : '',
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
  // Sync the meta-footer Stripe (tip) link with the canonical TIP_URL so
  // there is a single source of truth.
  const _tipLink = document.getElementById('stripe-tip-link');
  if (_tipLink) _tipLink.setAttribute('data-url', TIP_URL);

  refreshPremiumStatus().then(() => {
    // Re-apply dark mode now that the real premium status is known.
    loadSettings(s => applyDarkMode(s.darkMode));
    // Run one-shot migration (legacy → dedup) before loading the UI.
    maybeMigrateStorage(() => {
      // One-time backfill so legacy copy-log entries (stored as raw
      // markdown only) render with real per-row buttons instead of a
      // markdown-parsing fallback. Chained before load() so the Copy
      // Log tab is in its final shape on first render.
      backfillCopyLogIds(() => {
        load();
        checkSyncRestore();
      });
      // Init writes are done; allow user actions to start populating the
      // undo stack. Drain any pending coalesced capture from init.
      setTimeout(() => {
        pendingUndoOld = null;
        if (pendingUndoTask) { clearTimeout(pendingUndoTask); pendingUndoTask = null; }
        suppressUndoCapture = Math.max(0, suppressUndoCapture - 1);
        undoStack = [];
        redoStack = [];
        updateUndoButtons();
      }, 50);
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
