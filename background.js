// background.js : AI Website Dev Annotator Service Worker
// Runs silently in the background to keep two independent backup layers in sync:
//   1. chrome.storage.sync  – cloud backup tied to your Google account, not the extension install
//   2. chrome.storage.local snapshot – local JSON backup, survives browser restarts

const BACKUP_ALARM    = 'annotatorAutoBackup';
const BACKUP_INTERVAL = 15;   // minutes between local snapshot backups
const SYNC_PREFIX     = 'ann_sync_';
const SYNC_CHUNK_SIZE = 7000; // chars per chunk — safely under chrome.storage.sync's 8 192-byte item limit
const VERSION         = '1.5.0';

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

// ── Main backup routine ────────────────────────────────────────────────────
function performBackup() {
  chrome.storage.local.get(null, localData => {
    writeToSyncStorage(localData.annotations || []);
    writeToLocalSnapshot(localData);
  });
}

// ── Write to chrome.storage.sync (cloud / cross-reinstall) ────────────────
// Data is chunked because sync has an 8 192-byte per-item limit.
// The full annotations array is reconstructed by reading chunks in order.
function writeToSyncStorage(annotations) {
  try {
    const json   = JSON.stringify(annotations);
    const chunks = [];
    for (let i = 0; i < json.length; i += SYNC_CHUNK_SIZE) {
      chunks.push(json.slice(i, i + SYNC_CHUNK_SIZE));
    }

    // Clear stale chunks, then write new ones
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
        chunks.forEach((chunk, i) => { data[`${SYNC_PREFIX}${i}`] = chunk; });

        chrome.storage.sync.set(data).then(() => {
          chrome.storage.local.set({ _lastSyncBackup: new Date().toISOString() });
        }).catch(err => {
          // Quota exceeded: try with an empty placeholder so the UI knows sync attempted
          console.warn('[Annotator] Sync backup quota exceeded:', err.message);
          chrome.storage.local.set({ _syncBackupError: 'Quota exceeded — too many annotations for free sync storage.' });
        });
      });
    });
  } catch (e) {
    console.warn('[Annotator] Sync backup error:', e);
  }
}

// ── Write a local JSON snapshot to chrome.storage.local ───────────────────
// Stores a complete backup snapshot under _localBackupSnapshot without any
// download prompt — the data stays in the browser's own storage.
// Users can export this data at any time via Settings → Export.
function writeToLocalSnapshot(localData) {
  const backup = {
    _type:    'annotator-backup',
    _version: VERSION,
    _saved:   new Date().toISOString(),
    annotations:       localData.annotations       || [],
    annotationHistory: localData.annotationHistory || [],
    copyHistory:       localData.copyHistory       || [],
    annotatorSettings: localData.annotatorSettings || {},
  };

  chrome.storage.local.set({
    _localBackupSnapshot: backup,
    _lastFileBackup:      new Date().toISOString(),
    _fileBackupError:     null,
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn('[Annotator] Local snapshot backup failed:', chrome.runtime.lastError.message);
      chrome.storage.local.set({ _fileBackupError: chrome.runtime.lastError.message });
    }
  });
}

// ── Message listener — popup can trigger an immediate backup ───────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'triggerBackup') {
    performBackup();
    sendResponse({ ok: true });
    return false;
  }
});
