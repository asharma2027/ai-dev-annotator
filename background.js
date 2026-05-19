importScripts("lib/firebase-app-compat.js", "lib/firebase-database-compat.js");

/**
 * MV3 service worker: periodic local snapshot + optional Chrome Sync mirror,
 * and small message handlers (debounced backup, open popup for scroll target).
 *
 * `writeToSyncStorage` runs only when Settings → Auto-Backup is on
 * (`annotatorSettings.backupEnabled !== false`). The 15-minute alarm, manual
 * "Backup Now", and `triggerBackup` all respect that. `writeToLocalSnapshot`
 * still runs so `_localBackupSnapshot` refreshes on the same schedule for
 * same-device recovery. Content scripts request a debounced backup via
 * `scheduleBackup` after annotation changes.
 */

const BACKUP_ALARM = "annotatorAutoBackup";
/** Matches `periodInMinutes` passed to chrome.alarms.create. */
const BACKUP_INTERVAL = 15;
const SYNC_PREFIX = "ann_sync_";
const SYNC_V2_PREFIX = "annv2_";
const SYNC_CHUNK_SIZE = 7e3;
const SYNC_MAX_BYTES = 95e3;
const VERSION = "1.0.0";
const HISTORY_KEY = "annotationHistory";
const COPY_HISTORY_KEY = "copyHistory";
const SETTINGS_KEY = "annotatorSettings";
const SAVED_LATER_KEY = "savedForLater";
const ANN_STORE_KEY = "_annStore";

function resolveRefBg(t, e) {
  return t
    ? "string" == typeof t
      ? e[t]
        ? stripBgMeta(e[t])
        : null
      : t.id && e[t.id]
        ? { ...stripBgMeta(e[t.id]), ...t }
        : void 0 !== t.tag || void 0 !== t.url
          ? t
          : t.id && e[t.id]
            ? stripBgMeta(e[t.id])
            : null
    : null;
}
function stripBgMeta(t) {
  const { _refCount: e, ...n } = t || {};
  return n;
}
function setupAlarm() {
  chrome.alarms.get(BACKUP_ALARM, (t) => {
    t ||
      chrome.alarms.create(BACKUP_ALARM, {
        delayInMinutes: 1,
        periodInMinutes: BACKUP_INTERVAL,
      });
  });
}
chrome.runtime.onInstalled.addListener(async () => {
  setupAlarm();
  try {
    const { annotations: annotationsList = [] } =
      await chrome.storage.local.get("annotations");
    let didStrip = false;
    for (const ann of annotationsList)
      if ("string" == typeof ann.url && /[?#]/.test(ann.url))
        try {
          const u = new URL(ann.url);
          ((ann.url = u.origin + u.pathname), (didStrip = true));
        } catch (_err) {}
    didStrip &&
      (await chrome.storage.local.set({ annotations: annotationsList }));
  } catch (_err) {}
});
chrome.runtime.onStartup.addListener(setupAlarm);
chrome.alarms.onAlarm.addListener((t) => {
  t.name === BACKUP_ALARM && performBackup();
});
const ANN_SHORT_KEYS = {
  id: "i",
  url: "u",
  tag: "g",
  elId: "e",
  classes: "c",
  xpath: "x",
  comment: "t",
  timestamp: "s",
  pageLevel: "p",
  deletedAt: "d",
  text: "tx",
};
function shortenAnn(t) {
  const e = {};
  for (const [n, o] of Object.entries(t))
    null != o && "" !== o && (e[ANN_SHORT_KEYS[n] || n] = o);
  return e;
}
function groupByUrl(t) {
  const e = new Map();
  return (
    t.forEach((t) => {
      const n = t.url || "",
        o = shortenAnn(t);
      (delete o.u, e.has(n) || e.set(n, []), e.get(n).push(o));
    }),
    Array.from(e.entries())
  );
}
function buildBundle({
  annotations: t = [],
  history: e = [],
  copyHistory: n = [],
  savedForLater: o = [],
  settings: r = {},
} = {}) {
  const a = { v: 2 };
  return (
    t.length && (a.a = groupByUrl(t)),
    e.length && (a.h = groupByUrl(e)),
    n.length &&
      (a.c = n.map((t) => {
        const e = {};
        return (
          t.timestamp && (e.s = t.timestamp),
          t.output && (e.o = t.output),
          t.count && (e.n = t.count),
          e
        );
      })),
    o.length &&
      (a.sl = o.map((t) => ({
        i: t.id,
        s: t.savedAt,
        n: t.count,
        a: groupByUrl(t.annotations || []),
      }))),
    r && Object.keys(r).length && (a.s = r),
    a
  );
}
async function gzipString(t) {
  const e = new CompressionStream("gzip"),
    n = e.writable.getWriter();
  (n.write(new TextEncoder().encode(t)).catch(() => {}),
    n.close().catch(() => {}));
  const o = await new Response(e.readable).arrayBuffer();
  return new Uint8Array(o);
}
function bytesToBase64(t) {
  let e = "";
  for (let n = 0; n < t.length; n += 32768)
    e += String.fromCharCode.apply(null, t.subarray(n, n + 32768));
  return btoa(e);
}
async function compressBundle(t) {
  const e = JSON.stringify(t);
  return bytesToBase64(await gzipString(e));
}
function performBackup() {
  chrome.storage.local.get(null, (t) => {
    const backupOn = (t[SETTINGS_KEY] || {}).backupEnabled !== false;
    backupOn && writeToSyncStorage(t);
    writeToLocalSnapshot(t);
  });
}
async function writeToSyncStorage(t) {
  try {
    const e = t.annotations || [],
      n = t._annStore || {};
    let o = (t[HISTORY_KEY] || [])
      .map((t) => {
        const e = resolveRefBg(t, n);
        return e ? { ...e, deletedAt: t.deletedAt || e.deletedAt } : null;
      })
      .filter(Boolean);
    const r = (t.copyHistory || []).map((t) => {
        const { annotationIds: e, ...n } = t;
        return n;
      }),
      a = (t.savedForLater || []).map((t) => {
        const e = Array.isArray(t.annotationIds)
          ? t.annotationIds.map((t) => resolveRefBg(t, n)).filter(Boolean)
          : t.annotations || [];
        return {
          id: t.id,
          savedAt: t.savedAt,
          count: t.count || e.length,
          annotations: e,
        };
      }),
      s = t[SETTINGS_KEY] || {};
    let c = !1,
      i = "";
    for (;;) {
      const t = buildBundle({
        annotations: e,
        history: o,
        copyHistory: r,
        savedForLater: a,
        settings: s,
      });
      if (((i = await compressBundle(t)), i.length <= SYNC_MAX_BYTES)) break;
      if (0 === o.length) break;
      const n = Math.max(1, Math.floor(0.1 * o.length));
      ((o = o.slice(n)), (c = !0));
    }
    if (i.length > SYNC_MAX_BYTES)
      return void chrome.storage.local.set({
        _syncBackupError:
          "Data still exceeds sync storage limit even after truncation.",
        _syncTruncated: c,
      });
    const l = [];
    for (let t = 0; t < i.length; t += SYNC_CHUNK_SIZE)
      l.push(i.slice(t, t + SYNC_CHUNK_SIZE));
    const u = await new Promise((t) => chrome.storage.sync.get(null, t)),
      p = Object.keys(u).filter(
        (t) => t.startsWith("ann_sync_") || t.startsWith("annv2_"),
      );
    p.length && (await new Promise((t) => chrome.storage.sync.remove(p, t)));
    const g = {
      annv2_count: l.length,
      annv2_ts: new Date().toISOString(),
      annv2_ver: 2,
    };
    l.forEach((t, e) => {
      g[`annv2_${e}`] = t;
    });
    try {
      (await chrome.storage.sync.set(g),
        chrome.storage.local.set({
          _lastSyncBackup: new Date().toISOString(),
          _syncBackupError: null,
          _syncTruncated: c,
        }));
    } catch (t) {
      (chrome.storage.local.set({
        _syncBackupError: "Sync write failed: " + (t?.message || t),
        _syncTruncated: c,
      }),
        console.warn("[Annotator bg] Sync write failed:", t));
    }
  } catch (t) {
    console.warn("[Annotator bg] Sync backup error:", t);
  }
}
function writeToLocalSnapshot(t) {
  const e = t._annStore || {},
    n = (t[HISTORY_KEY] || [])
      .map((t) => {
        const n = resolveRefBg(t, e);
        return n ? { ...n, deletedAt: t.deletedAt || n.deletedAt } : null;
      })
      .filter(Boolean),
    o = (t.savedForLater || []).map((t) => {
      const n = Array.isArray(t.annotationIds)
        ? t.annotationIds.map((t) => resolveRefBg(t, e)).filter(Boolean)
        : t.annotations || [];
      return {
        id: t.id,
        savedAt: t.savedAt,
        count: t.count || n.length,
        annotations: n,
      };
    }),
    r = (t.copyHistory || []).map((t) => {
      const { annotationIds: e, ...n } = t;
      return n;
    }),
    a = {
      _type: "annotator-backup",
      _version: VERSION,
      _saved: new Date().toISOString(),
      annotations: t.annotations || [],
      annotationHistory: n,
      copyHistory: r,
      savedForLater: o,
      annotatorSettings: t[SETTINGS_KEY] || {},
    };
  chrome.storage.local.set(
    {
      _localBackupSnapshot: a,
      _lastFileBackup: new Date().toISOString(),
      _fileBackupError: null,
    },
    () => {
      chrome.runtime.lastError &&
        (console.warn(
          "[Annotator bg] Local snapshot backup failed:",
          chrome.runtime.lastError.message,
        ),
        chrome.storage.local.set({
          _fileBackupError: chrome.runtime.lastError.message,
        }));
    },
  );
}
let _bgBackupTimer = null;
function scheduleBackup() {
  chrome.storage.local.get({ annotatorSettings: {} }, (t) => {
    !1 !== (t.annotatorSettings || {}).backupEnabled &&
      (clearTimeout(_bgBackupTimer),
      (_bgBackupTimer = setTimeout(performBackup, 1500)));
  });
}
chrome.runtime.onMessage.addListener((t, e, n) => {
  if ("triggerBackup" === t.type) return (performBackup(), n({ ok: !0 }), !1);
  if ("scheduleBackup" === t.type) return (scheduleBackup(), n({ ok: !0 }), !1);
  if ("openPopupAndFocus" === t.type) {
    const { annId: e } = t;
    return (
      chrome.storage.local.set({ _popupScrollTarget: e }, async () => {
        try {
          "function" == typeof chrome.action?.openPopup &&
            (await chrome.action.openPopup());
        } catch (t) {}
      }),
      n({ ok: !0 }),
      !1
    );
  }
});
// ── FIREBASE TEAM SYNC ──────────────────────────────────────────────────
let firebaseApp = null;
let firebaseDb = null;
let syncRefs = {};

function getTeamId(githubUrl) {
  if (!githubUrl) return null;
  const match = githubUrl.match(/github\.com\/([^/]+\/[^/]+)/);
  if (match) return match[1].replace(/[^a-zA-Z0-9-]/g, '_');
  return null;
}

function initFirebase() {
  chrome.storage.local.get({ annotatorSettings: {} }, (data) => {
    const s = data.annotatorSettings;
    const fbConfigStr = s.firebaseConfig;
    const teamId = getTeamId(s.githubUrl);

    if (!fbConfigStr || !teamId) {
      if (firebaseApp) {
        Object.values(syncRefs).forEach(ref => ref.off());
        syncRefs = {};
        if (firebaseDb) firebaseDb.goOffline();
      }
      return;
    }

    try {
      const config = JSON.parse(fbConfigStr);
      if (!firebaseApp) {
        firebaseApp = firebase.initializeApp(config);
      } else if (firebaseApp.options.databaseURL !== config.databaseURL) {
        firebaseApp.delete().then(() => {
          firebaseApp = firebase.initializeApp(config);
          firebaseDb = firebase.database();
          setupTeamListeners(teamId);
        });
        return;
      }

      if (!firebaseDb) {
        firebaseDb = firebase.database();
      } else {
        firebaseDb.goOnline();
      }

      setupTeamListeners(teamId);

      if (!s.userColor) {
        s.userColor = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
        chrome.storage.local.set({ annotatorSettings: s });
      }

    } catch (err) {
      console.warn("Invalid Firebase config JSON", err);
    }
  });
}

function setupTeamListeners(teamId) {
  Object.values(syncRefs).forEach(ref => ref.off());
  syncRefs = {};

  const teamRef = firebaseDb.ref(`teams/${teamId}/annotations`);
  syncRefs['team'] = teamRef;

  teamRef.on('value', (snapshot) => {
    const data = snapshot.val() || {};
    let allAnnotations = [];
    Object.keys(data).forEach(urlKey => {
      const annMap = data[urlKey] || {};
      Object.values(annMap).forEach(ann => {
        allAnnotations.push(ann);
      });
    });

    // Write remote state to local storage, appending a timestamp to identify it's from Firebase
    chrome.storage.local.set({
      annotations: allAnnotations,
      __firebase_sync_timestamp: Date.now()
    }, () => {
      chrome.runtime.sendMessage({ type: "remoteAnnotationsUpdated" }).catch(() => {});
      chrome.tabs.query({}, tabs => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, { type: "remoteAnnotationsUpdated" }).catch(() => {});
        });
      });
    });
  });
}

function pushAnnotationToFirebase(ann, teamId, isDelete = false) {
  if (!firebaseDb || !teamId) return;
  const safeUrl = (ann.url || "unknown").replace(/[\.\#\$\[\]]/g, '_');
  const annRef = firebaseDb.ref(`teams/${teamId}/annotations/${safeUrl}/${ann.id}`);

  if (isDelete) {
    annRef.remove().catch(e => console.warn("Firebase remove failed:", e));
  } else {
    annRef.set(ann).catch(e => console.warn("Firebase set failed:", e));
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  // Ignore changes that were written by the Firebase listener
  if (changes.__firebase_sync_timestamp) return;

  if (changes.annotations) {
    chrome.storage.local.get({ annotatorSettings: {} }, (data) => {
      const s = data.annotatorSettings;
      const teamId = getTeamId(s.githubUrl);
      if (!teamId || !firebaseDb) return;

      const oldList = changes.annotations.oldValue || [];
      const newList = changes.annotations.newValue || [];

      const oldMap = {};
      oldList.forEach(a => oldMap[a.id] = a);

      const newMap = {};
      newList.forEach(a => newMap[a.id] = a);

      newList.forEach(ann => {
        if (!oldMap[ann.id] || JSON.stringify(oldMap[ann.id]) !== JSON.stringify(ann)) {
          // If the annotation doesn't have an authorColor, attach the current user's color
          if (!ann.authorColor && s.userColor) {
            ann.authorColor = s.userColor;
            ann.authorName = s.username || "Anonymous";
          }
          pushAnnotationToFirebase(ann, teamId);
        }
      });

      oldList.forEach(ann => {
        if (!newMap[ann.id]) {
          pushAnnotationToFirebase(ann, teamId, true);
        }
      });
    });
  }
});

// Re-init when requested (e.g. from popup config change)
chrome.runtime.onMessage.addListener((t, e, n) => {
  if (t.type === "initFirebase") {
    initFirebase();
    n({ ok: true });
    return false;
  }
});

// Call on startup
initFirebase();
