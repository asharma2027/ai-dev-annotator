// background.js : AI Website Dev Annotator Service Worker
// Runs silently in the background to keep two independent backup layers in sync:
//   1. chrome.storage.sync  – cloud backup tied to your Google account, not the extension install
//   2. chrome.storage.local snapshot – local JSON backup, survives browser restarts
//
// Sync format v2: a single compressed (gzip) bundle containing the entire
// dataset (annotations, history, saved-for-later, copy log, settings),
// chunked into items under chrome.storage.sync's 8 192-byte per-item cap.
// History is truncated oldest-first if the compressed payload would exceed
// the 102 400-byte total quota; the truncation flag is mirrored to local
// storage so the popup UI can warn the user.

const BACKUP_ALARM    = 'annotatorAutoBackup';
const BACKUP_INTERVAL = 15;   // minutes between local snapshot backups
const SYNC_PREFIX     = 'ann_sync_';   // legacy v1 keys (cleaned up on every write)
const SYNC_V2_PREFIX  = 'annv2_';
const SYNC_CHUNK_SIZE = 7000;
const SYNC_MAX_BYTES  = 95000;
const VERSION         = '1.7.0';

const HISTORY_KEY      = 'annotationHistory';
const COPY_HISTORY_KEY = 'copyHistory';
const SETTINGS_KEY     = 'annotatorSettings';
const SAVED_LATER_KEY  = 'savedForLater';

// ── Alarm setup ────────────────────────────────────────────────────────────
function setupAlarm() {
  chrome.alarms.get(BACKUP_ALARM, existing => {
    if (!existing) {
      chrome.alarms.create(BACKUP_ALARM, {
        delayInMinutes:  1,
        periodInMinutes: BACKUP_INTERVAL,
      });
    }
  });
}

chrome.runtime.onInstalled.addListener(setupAlarm);
chrome.runtime.onStartup.addListener(setupAlarm);

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === BACKUP_ALARM) performBackup();
});

// ── Compact-bundle helpers (mirrors the popup-side format) ─────────────────
const ANN_SHORT_KEYS = {
  id: 'i', url: 'u', tag: 'g', elId: 'e', classes: 'c',
  xpath: 'x', comment: 't', timestamp: 's', pageLevel: 'p', deletedAt: 'd',
};

function shortenAnn(ann) {
  const out = {};
  for (const [k, v] of Object.entries(ann)) {
    if (v === null || v === undefined || v === '') continue;
    const sk = ANN_SHORT_KEYS[k] || k;
    out[sk] = v;
  }
  return out;
}

function groupByUrl(anns) {
  const map = new Map();
  anns.forEach(ann => {
    const url = ann.url || '';
    const short = shortenAnn(ann);
    delete short.u;
    if (!map.has(url)) map.set(url, []);
    map.get(url).push(short);
  });
  return Array.from(map.entries());
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

async function gzipString(str) {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  // Suppress unhandled rejections — any error surfaces via the readable side.
  writer.write(new TextEncoder().encode(str)).catch(() => {});
  writer.close().catch(() => {});
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

function bytesToBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

async function compressBundle(bundle) {
  const json = JSON.stringify(bundle);
  const gz   = await gzipString(json);
  return bytesToBase64(gz);
}

// ── Main backup routine ────────────────────────────────────────────────────
function performBackup() {
  chrome.storage.local.get(null, localData => {
    writeToSyncStorage(localData);
    writeToLocalSnapshot(localData);
  });
}

// ── Write to chrome.storage.sync (v2 compressed bundle, chunked) ──────────
async function writeToSyncStorage(localData) {
  try {
    const annotations   = localData.annotations || [];
    let   history       = localData[HISTORY_KEY] || [];
    const copyHistory   = localData[COPY_HISTORY_KEY] || [];
    const savedForLater = localData[SAVED_LATER_KEY] || [];
    const settings      = localData[SETTINGS_KEY] || {};

    let truncated = false;
    let payload   = '';

    while (true) {
      const bundle = buildBundle({ annotations, history, copyHistory, savedForLater, settings });
      payload = await compressBundle(bundle);
      if (payload.length <= SYNC_MAX_BYTES) break;
      if (history.length === 0) break;
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

    const chunks = [];
    for (let i = 0; i < payload.length; i += SYNC_CHUNK_SIZE) {
      chunks.push(payload.slice(i, i + SYNC_CHUNK_SIZE));
    }

    const existing = await new Promise(res => chrome.storage.sync.get(null, res));
    const stale = Object.keys(existing).filter(k => k.startsWith(SYNC_PREFIX) || k.startsWith(SYNC_V2_PREFIX));
    if (stale.length) await new Promise(res => chrome.storage.sync.remove(stale, res));

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
      console.warn('[Annotator bg] Sync write failed:', err);
    }
  } catch (e) {
    console.warn('[Annotator bg] Sync backup error:', e);
  }
}

// ── Write a local JSON snapshot to chrome.storage.local ───────────────────
function writeToLocalSnapshot(localData) {
  const backup = {
    _type:    'annotator-backup',
    _version: VERSION,
    _saved:   new Date().toISOString(),
    annotations:       localData.annotations            || [],
    annotationHistory: localData[HISTORY_KEY]           || [],
    copyHistory:       localData[COPY_HISTORY_KEY]      || [],
    savedForLater:     localData[SAVED_LATER_KEY]       || [],
    annotatorSettings: localData[SETTINGS_KEY]          || {},
  };

  chrome.storage.local.set({
    _localBackupSnapshot: backup,
    _lastFileBackup:      new Date().toISOString(),
    _fileBackupError:     null,
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn('[Annotator bg] Local snapshot backup failed:', chrome.runtime.lastError.message);
      chrome.storage.local.set({ _fileBackupError: chrome.runtime.lastError.message });
    }
  });
}

// ── Debounced backup trigger from popup / content scripts ─────────────────
let _bgBackupTimer = null;
function scheduleBackup() {
  clearTimeout(_bgBackupTimer);
  _bgBackupTimer = setTimeout(performBackup, 1500);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'triggerBackup') {
    performBackup();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'scheduleBackup') {
    scheduleBackup();
    sendResponse({ ok: true });
    return false;
  }
});
