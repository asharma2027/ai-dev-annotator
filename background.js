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
const WEBSITE_VERSION_ALARM = "annotatorWebsiteVersion";
const WEBSITE_VERSION_INTERVAL = 1;
const LOCAL_SETUP_ORIGIN = "http://localhost:11454";
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
const TEAM_DEBUG_EVENTS_KEY = "_teamDebugEvents";
const TEAM_DEBUG_EVENT_LIMIT = 160;
const DESKTOP_FETCH_TIMEOUT_MS = 2500;
const DEFAULT_TEST_COLORS = ["#2563eb", "#059669", "#dc2626", "#7c3aed", "#ea580c", "#0891b2", "#be123c"];

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
  chrome.alarms.get(WEBSITE_VERSION_ALARM, (t) => {
    t ||
      chrome.alarms.create(WEBSITE_VERSION_ALARM, {
        delayInMinutes: 1,
        periodInMinutes: WEBSITE_VERSION_INTERVAL,
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
  await refreshLocalConfig({ initFirebaseAfter: true });
  await checkWebsiteVersion();
});
try {
  chrome.tabs.onRemoved.addListener(() => {
    maybeStopRepoServerWhenNoLocalTabs();
  });
} catch (_err) {}
chrome.runtime.onStartup.addListener(() => {
  setupAlarm();
  refreshLocalConfig({ initFirebaseAfter: true });
  checkWebsiteVersion();
});
chrome.alarms.onAlarm.addListener((t) => {
  t.name === BACKUP_ALARM && performBackup();
  t.name === WEBSITE_VERSION_ALARM && checkWebsiteVersion();
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
let teamAnnotationsRef = null;
let activeTeamId = null;
let activeFirebaseConfigKey = null;
let applyingRemoteAnnotations = false;

function storageLocalGet(defaults) {
  return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
}
function storageLocalSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}
function storageLocalRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}
function storageSessionGet(defaults) {
  return new Promise((resolve) => {
    if (!chrome.storage.session) return resolve(defaults || {});
    chrome.storage.session.get(defaults, resolve);
  });
}
function storageSessionSet(values) {
  return new Promise((resolve) => {
    if (!chrome.storage.session) return resolve();
    chrome.storage.session.set(values, resolve);
  });
}
function storageSessionRemove(keys) {
  return new Promise((resolve) => {
    if (!chrome.storage.session) return resolve();
    chrome.storage.session.remove(keys, resolve);
  });
}
async function desktopFetchJson(pathname, { method = "GET", body = undefined, timeoutMs = DESKTOP_FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const options = {
      method,
      cache: "no-store",
      signal: controller.signal,
    };
    if (body !== undefined) {
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(body);
    }
    const res = await fetch(`${LOCAL_SETUP_ORIGIN}${pathname}`, options);
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch (_err) {}
      throw new Error(`Setup app returned ${res.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
function recordTeamDebug(scope, message, details = {}, level = "info") {
  const event = {
    at: new Date().toISOString(),
    level,
    scope,
    message,
    details,
  };
  try {
    const log = level === "error" || level === "warn" ? console.warn : console.log;
    log("[Annotator team]", scope, message, details);
  } catch (_err) {}
  try {
    chrome.storage.local.get({ [TEAM_DEBUG_EVENTS_KEY]: [] }, (data) => {
      const events = Array.isArray(data[TEAM_DEBUG_EVENTS_KEY]) ? data[TEAM_DEBUG_EVENTS_KEY] : [];
      events.push(event);
      chrome.storage.local.set({ [TEAM_DEBUG_EVENTS_KEY]: events.slice(-TEAM_DEBUG_EVENT_LIMIT) });
    });
  } catch (_err) {}
  try {
    fetch(`${LOCAL_SETUP_ORIGIN}/api/debug-events`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    }).catch(() => {});
  } catch (_err) {}
  return event;
}
function parseGithubRepo(githubUrl) {
  if (!githubUrl) return null;
  let value = String(githubUrl).trim();
  const sshMatch = value.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (sshMatch) return sshMatch[1];
  try {
    const url = new URL(value);
    if (!/github\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1].replace(/\.git$/i, "")}`;
  } catch (_err) {
    const match = value.match(/github\.com[/:]([^/]+\/[^/#?]+?)(?:\.git)?(?:[#?].*)?$/i);
    return match ? match[1] : null;
  }
}
function getTeamId(githubUrl) {
  const repo = parseGithubRepo(githubUrl);
  return repo ? repo.replace(/[^a-zA-Z0-9-]/g, "_") : null;
}
function firebaseKey(value) {
  return String(value || "unknown").replace(/[.#$\/\[\]]/g, "_");
}
function legacyUrlKey(value) {
  return String(value || "unknown").replace(/[.#$\[\]]/g, "_");
}
function configKey(config) {
  return JSON.stringify({
    apiKey: config.apiKey || "",
    appId: config.appId || "",
    projectId: config.projectId || "",
    databaseURL: config.databaseURL || "",
  });
}
function withDatabaseUrlFallback(config) {
  const completed = { ...(config || {}) };
  if (!completed.databaseURL && completed.projectId) {
    completed.databaseURL = `https://${completed.projectId}-default-rtdb.firebaseio.com`;
  }
  return completed;
}
function annotationVersion(ann) {
  const updatedAt = Number(ann?._updatedAt || ann?.updatedAt || 0);
  if (updatedAt) return updatedAt;
  const ts = ann?.timestamp ? Date.parse(ann.timestamp) : 0;
  return Number.isFinite(ts) ? ts : 0;
}
function stableJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return "";
  }
}
function withAuthorMetadata(ann, settings, teamId) {
  return {
    ...ann,
    authorName: ann.authorName || settings.username || "Reviewer",
    authorColor: ann.authorColor || settings.userColor || "#2563eb",
    _teamId: teamId,
    _updatedAt: Date.now(),
  };
}
function getEffectiveIdentityForSender(sender = {}) {
  return storageLocalGet({ annotatorSettings: {} }).then((data) => {
    const settings = data.annotatorSettings || {};
    const windowId = sender.tab && Number.isInteger(sender.tab.windowId) ? sender.tab.windowId : null;
    const base = {
      username: settings.username || "Reviewer",
      userColor: settings.userColor || "#2563eb",
      source: "team",
      windowId,
    };
    recordTeamDebug("identity", "Resolved base team identity for annotation sender.", {
      windowId,
      username: base.username,
      tabId: sender.tab?.id,
      url: sender.tab?.url || "",
    });
    return base;
  });
}
function mergeRemoteAnnotations(localList, remoteList, teamId) {
  const remoteIds = new Set(remoteList.map((ann) => ann.id));
  const byId = new Map();
  (localList || []).forEach((ann) => {
    if (ann && ann.id) byId.set(ann.id, ann);
  });
  remoteList.forEach((remoteAnn) => {
    if (!remoteAnn || !remoteAnn.id) return;
    const localAnn = byId.get(remoteAnn.id);
    if (!localAnn || annotationVersion(remoteAnn) >= annotationVersion(localAnn))
      byId.set(remoteAnn.id, remoteAnn);
  });
  return Array.from(byId.values()).filter((ann) => {
    if (!ann || !ann.id) return false;
    if (ann._teamId === teamId && !remoteIds.has(ann.id)) return false;
    return !ann.deletedAt && !ann._deleted;
  });
}
function collectRemoteAnnotations(data) {
  const out = [];
  Object.values(data || {}).forEach((value) => {
    if (value && value.id) {
      out.push(value);
      return;
    }
    if (value && typeof value === "object") {
      Object.values(value).forEach((nested) => {
        if (nested && nested.id) out.push(nested);
      });
    }
  });
  const byId = new Map();
  out
    .filter((ann) => ann && ann.id && !ann.deletedAt && !ann._deleted)
    .forEach((ann) => {
      const existing = byId.get(ann.id);
      if (!existing || annotationVersion(ann) >= annotationVersion(existing)) byId.set(ann.id, ann);
    });
  return Array.from(byId.values());
}
function notifyAnnotationConsumers() {
  chrome.runtime.sendMessage({ type: "remoteAnnotationsUpdated" }).catch(() => {});
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, { type: "remoteAnnotationsUpdated" }).catch(() => {});
    });
  });
}
async function setTeamStatus(patch) {
  const current = await storageLocalGet({ _teamSyncStatus: {} });
  await storageLocalSet({
    _teamSyncStatus: {
      ...(current._teamSyncStatus || {}),
      ...patch,
      checkedAt: new Date().toISOString(),
    },
  });
}

async function refreshLocalConfig({ initFirebaseAfter = false } = {}) {
  try {
    recordTeamDebug("config", "Refreshing setup from desktop app.", { initFirebaseAfter });
    const res = await fetch(`${LOCAL_SETUP_ORIGIN}/api/config`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Setup app returned ${res.status}`);
    const config = await res.json();
    const data = await storageLocalGet({ annotatorSettings: {} });
    const settings = { ...(data.annotatorSettings || {}) };
    let changed = false;
    const changedKeys = [];
    ["githubUrl", "firebaseConfig", "username", "userColor"].forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(config, key) && settings[key] !== config[key]) {
        settings[key] = config[key] || "";
        changed = true;
        changedKeys.push(key);
      }
    });
    if (Object.prototype.hasOwnProperty.call(config, "localServerPort")) {
      const port = Number.isInteger(config.localServerPort) ? config.localServerPort : null;
      if (settings.localServerPort !== port) {
        settings.localServerPort = port;
        changed = true;
        changedKeys.push("localServerPort");
      }
    }
    const toSet = {
      _teamSetupLastChecked: new Date().toISOString(),
      _teamSetupError: null,
    };
    if (changed) toSet.annotatorSettings = settings;
    await storageLocalSet(toSet);
    if (initFirebaseAfter || changed) await initFirebase();
    recordTeamDebug("config", "Desktop setup refresh completed.", {
      changed,
      changedKeys,
      githubUrl: settings.githubUrl || "",
      username: settings.username || "",
      localServerPort: settings.localServerPort || null,
      firebaseConfigured: !!settings.firebaseConfig,
    });
    return { ok: true, changed };
  } catch (err) {
    await storageLocalSet({
      _teamSetupLastChecked: new Date().toISOString(),
      _teamSetupError: err?.message || String(err),
    });
    recordTeamDebug("config", "Desktop setup refresh failed.", { error: err?.message || String(err) }, "error");
    return { ok: false, error: err?.message || String(err) };
  }
}

async function disconnectFirebase() {
  if (teamAnnotationsRef) {
    try {
      teamAnnotationsRef.off();
    } catch (_err) {}
  }
  teamAnnotationsRef = null;
  activeTeamId = null;
  if (firebaseDb) {
    try {
      firebaseDb.goOffline();
    } catch (_err) {}
  }
  if (firebaseApp) {
    try {
      await firebaseApp.delete();
    } catch (_err) {}
  }
  firebaseApp = null;
  firebaseDb = null;
  activeFirebaseConfigKey = null;
}

async function initFirebase() {
  const data = await storageLocalGet({ annotatorSettings: {} });
  const settings = data.annotatorSettings || {};
  const fbConfigStr = settings.firebaseConfig;
  const teamId = getTeamId(settings.githubUrl);
  recordTeamDebug("firebase", "Firebase init requested.", {
    teamId,
    githubUrl: settings.githubUrl || "",
    firebaseConfigured: !!fbConfigStr,
  });

  if (!fbConfigStr || !teamId) {
    await disconnectFirebase();
    await setTeamStatus({
      connected: false,
      teamId: null,
      error: fbConfigStr ? "Add a valid GitHub repo in the desktop app." : "Add Firebase config in the desktop app.",
    });
    recordTeamDebug("firebase", "Firebase init skipped because setup is incomplete.", {
      hasFirebaseConfig: !!fbConfigStr,
      hasTeamId: !!teamId,
    }, "warn");
    return { ok: false };
  }

  let config;
  try {
    config = withDatabaseUrlFallback(JSON.parse(fbConfigStr));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Firebase config is not an object.");
  } catch (err) {
    console.warn("Invalid Firebase config JSON", err);
    await disconnectFirebase();
    await setTeamStatus({ connected: false, teamId, error: "Invalid Firebase config JSON." });
    recordTeamDebug("firebase", "Firebase config JSON is invalid.", { teamId, error: err?.message || String(err) }, "error");
    return { ok: false, error: err?.message || String(err) };
  }

  try {
    const nextKey = configKey(config);
    if (!firebaseApp || activeFirebaseConfigKey !== nextKey) {
      await disconnectFirebase();
      firebaseApp = firebase.initializeApp(config);
      firebaseDb = firebase.database();
      activeFirebaseConfigKey = nextKey;
    } else if (firebaseDb) {
      firebaseDb.goOnline();
    }
    setupTeamListeners(teamId);
    await setTeamStatus({ connected: true, teamId, githubUrl: settings.githubUrl, error: null });
    recordTeamDebug("firebase", "Firebase team sync connected.", {
      teamId,
      projectId: config.projectId || "",
      databaseURL: config.databaseURL || "",
    });
    return { ok: true };
  } catch (err) {
    console.warn("Firebase team sync failed:", err);
    await disconnectFirebase();
    await setTeamStatus({ connected: false, teamId, error: err?.message || String(err) });
    recordTeamDebug("firebase", "Firebase team sync failed.", { teamId, error: err?.message || String(err) }, "error");
    return { ok: false, error: err?.message || String(err) };
  }
}

function setupTeamListeners(teamId) {
  if (!firebaseDb) return;
  if (teamAnnotationsRef) {
    try {
      teamAnnotationsRef.off();
    } catch (_err) {}
  }
  activeTeamId = teamId;
  teamAnnotationsRef = firebaseDb.ref(`teams/${teamId}/annotations`);
  recordTeamDebug("firebase-listener", "Listening for team annotations.", { teamId });

  teamAnnotationsRef.on(
    "value",
    async (snapshot) => {
      const data = snapshot.val() || {};
      const remoteList = collectRemoteAnnotations(data);
      const local = await storageLocalGet({ annotations: [] });
      const before = local.annotations || [];
      const merged = mergeRemoteAnnotations(before, remoteList, teamId);
      recordTeamDebug("firebase-listener", "Remote annotation snapshot received.", {
        teamId,
        remoteCount: remoteList.length,
        localCount: before.length,
        mergedCount: merged.length,
        changed: stableJson(before) !== stableJson(merged),
      });
      if (stableJson(before) !== stableJson(merged)) {
        applyingRemoteAnnotations = true;
        await storageLocalSet({
          annotations: merged,
          __firebase_sync_timestamp: Date.now(),
        });
        applyingRemoteAnnotations = false;
        notifyAnnotationConsumers();
      }
      await setTeamStatus({
        connected: true,
        teamId,
        error: null,
        remoteCount: remoteList.length,
        lastSync: new Date().toISOString(),
      });
      pushMissingLocalAnnotations(before, remoteList, teamId);
    },
    async (err) => {
      console.warn("Firebase team listener failed:", err);
      await setTeamStatus({ connected: false, teamId, error: err?.message || String(err) });
      recordTeamDebug("firebase-listener", "Firebase listener failed.", { teamId, error: err?.message || String(err) }, "error");
    },
  );
}

function pushAnnotationToFirebase(ann, teamId, isDelete = false, settings = {}) {
  if (!firebaseDb || !teamId) return;
  const annRef = firebaseDb.ref(`teams/${teamId}/annotations/${firebaseKey(ann.id)}`);

  if (isDelete) {
    annRef.remove().catch(e => {
      console.warn("Firebase remove failed:", e);
      recordTeamDebug("firebase-write", "Firebase remove failed.", { teamId, annId: ann.id, error: e?.message || String(e) }, "error");
    });
    if (ann.url) {
      firebaseDb
        .ref(`teams/${teamId}/annotations/${legacyUrlKey(ann.url)}/${firebaseKey(ann.id)}`)
        .remove()
        .catch(() => {});
    }
  } else {
    const payload = withAuthorMetadata(ann, settings, teamId);
    recordTeamDebug("firebase-write", "Writing annotation to Firebase.", {
      teamId,
      annId: ann.id,
      authorName: payload.authorName,
      url: ann.url || "",
    });
    annRef.set(payload).catch(e => {
      console.warn("Firebase set failed:", e);
      recordTeamDebug("firebase-write", "Firebase set failed.", { teamId, annId: ann.id, error: e?.message || String(e) }, "error");
    });
  }
}
function pushMissingLocalAnnotations(localList, remoteList, teamId) {
  const remoteIds = new Set((remoteList || []).map((ann) => ann.id));
  if (!localList || !localList.length) return;
  chrome.storage.local.get({ annotatorSettings: {} }, ({ annotatorSettings }) => {
    (localList || []).forEach((ann) => {
      if (!ann || !ann.id || remoteIds.has(ann.id)) return;
      if (ann._teamId) return;
      recordTeamDebug("firebase-write", "Backfilling local-only annotation to Firebase.", {
        teamId,
        annId: ann.id,
        authorName: ann.authorName || annotatorSettings?.username || "",
      });
      pushAnnotationToFirebase(ann, teamId, false, annotatorSettings || {});
    });
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  // Ignore changes that were written by the Firebase listener
  if (applyingRemoteAnnotations || changes.__firebase_sync_timestamp) return;

  if (changes.annotations) {
    chrome.storage.local.get({ annotatorSettings: {} }, (data) => {
      const s = data.annotatorSettings;
      const teamId = getTeamId(s.githubUrl);
      if (!teamId || !firebaseDb || activeTeamId !== teamId) return;

      const oldList = changes.annotations.oldValue || [];
      const newList = changes.annotations.newValue || [];

      const oldMap = {};
      oldList.forEach(a => oldMap[a.id] = a);

      const newMap = {};
      newList.forEach(a => newMap[a.id] = a);

      recordTeamDebug("storage", "Local annotations changed; syncing diff to Firebase.", {
        teamId,
        oldCount: oldList.length,
        newCount: newList.length,
      });

      newList.forEach(ann => {
        if (!oldMap[ann.id] || JSON.stringify(oldMap[ann.id]) !== JSON.stringify(ann)) {
          pushAnnotationToFirebase(ann, teamId, false, s);
        }
      });

      oldList.forEach(ann => {
        if (!newMap[ann.id]) {
          pushAnnotationToFirebase(ann, teamId, true, s);
        }
      });
    });
  }
});

async function checkWebsiteVersion() {
  try {
    const res = await fetch(`${LOCAL_SETUP_ORIGIN}/api/site-version`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Setup app returned ${res.status}`);
    const info = await res.json();
    if (!info || !info.currentCommit) return;
    const prior = await storageLocalGet({
      _websiteVersionInfo: null,
      _websiteVersionCommit: null,
    });
    const changed = prior._websiteVersionCommit && prior._websiteVersionCommit !== info.currentCommit;
    await storageLocalSet({
      _websiteVersionInfo: info,
      _websiteVersionCommit: info.currentCommit,
      _websiteVersionError: null,
    });
    if (changed && info.localServerPort) refreshWebsiteTabs(info.localServerPort);
  } catch (err) {
    await storageLocalSet({ _websiteVersionError: err?.message || String(err) });
  }
}
async function stopDesktopRepoServer() {
  try {
    await desktopFetchJson("/api/repo/stop", { method: "POST", body: {} });
    recordTeamDebug("server", "Requested desktop app to stop the local repo server.");
  } catch (err) {
    recordTeamDebug("server", "Could not stop local repo server via desktop app.", { error: err?.message || String(err) }, "warn");
  }
}

function maybeStopRepoServerWhenNoLocalTabs() {
  chrome.storage.local.get({ annotatorSettings: {} }, (data) => {
    const port = data?.annotatorSettings?.localServerPort;
    if (!Number.isInteger(port)) return;
    const patterns = [`http://localhost:${port}/*`, `http://127.0.0.1:${port}/*`];
    chrome.tabs.query({ url: patterns }, (tabs) => {
      if ((tabs || []).length === 0) stopDesktopRepoServer();
    });
  });
}

function refreshWebsiteTabs(port) {
  const patterns = [
    `http://localhost:${port}/*`,
    `http://127.0.0.1:${port}/*`,
  ];
  chrome.tabs.query({ url: patterns }, (tabs) => {
    (tabs || []).forEach((tab) => {
      try {
        chrome.tabs.reload(tab.id, { bypassCache: true });
      } catch (_err) {}
    });
  });
}

function firebaseConfigSummary(value) {
  try {
    const config = value ? withDatabaseUrlFallback(JSON.parse(value)) : null;
    if (!config) return { configured: false };
    return {
      configured: true,
      projectId: config.projectId || "",
      databaseURL: config.databaseURL || "",
      authDomain: config.authDomain || "",
      appIdSuffix: config.appId ? String(config.appId).slice(-8) : "",
      hasApiKey: !!config.apiKey,
    };
  } catch (err) {
    return {
      configured: !!String(value || "").trim(),
      error: err?.message || String(err),
    };
  }
}

function getPermissionDiagnostics() {
  return new Promise((resolve) => {
    const out = {
      tabs: null,
      windows: typeof chrome.windows?.getAll === "function",
      localhost: null,
    };
    if (!chrome.permissions?.contains) return resolve(out);
    let pending = 2;
    const done = () => {
      pending -= 1;
      if (pending === 0) resolve(out);
    };
    chrome.permissions.contains({ permissions: ["tabs"] }, (allowed) => {
      out.tabs = !!allowed;
      done();
    });
    chrome.permissions.contains({ origins: [`${LOCAL_SETUP_ORIGIN}/*`] }, (allowed) => {
      out.localhost = !!allowed;
      done();
    });
  });
}

async function getTeamDebugSnapshot() {
  const local = await storageLocalGet({
    annotatorSettings: {},
    _teamSyncStatus: {},
    _teamSetupLastChecked: null,
    _teamSetupError: null,
    _websiteVersionInfo: null,
    _websiteVersionError: null,
    [TEAM_DEBUG_EVENTS_KEY]: [],
  });
  const settings = local.annotatorSettings || {};
  const manifest = chrome.runtime.getManifest();
  let desktop = null;
  try {
    desktop = await desktopFetchJson("/api/diagnostics");
  } catch (err) {
    desktop = { ok: false, error: err?.message || String(err) };
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    runtime: {
      id: chrome.runtime.id,
      version: manifest.version,
      manifestPermissions: manifest.permissions || [],
      hostPermissions: manifest.host_permissions || [],
    },
    permissions: await getPermissionDiagnostics(),
    setup: {
      lastChecked: local._teamSetupLastChecked,
      error: local._teamSetupError,
    },
    settings: {
      githubUrl: settings.githubUrl || "",
      username: settings.username || "",
      userColor: settings.userColor || "",
      localServerPort: settings.localServerPort || null,
      firebase: firebaseConfigSummary(settings.firebaseConfig),
    },
    teamSync: local._teamSyncStatus || {},
    website: {
      info: local._websiteVersionInfo || null,
      error: local._websiteVersionError || null,
    },
    desktop,
    events: Array.isArray(local[TEAM_DEBUG_EVENTS_KEY])
      ? local[TEAM_DEBUG_EVENTS_KEY].slice(-80)
      : [],
  };
}

function respondAsync(sendResponse, scope, promise) {
  Promise.resolve(promise)
    .then((result) => sendResponse(result))
    .catch((err) => {
      const message = err?.message || String(err);
      recordTeamDebug("message", `${scope} failed.`, { error: message }, "error");
      sendResponse({ ok: false, error: message });
    });
  return true;
}

// Re-init when requested (e.g. from popup config change)
chrome.runtime.onMessage.addListener((t, e, n) => {
  if (t.type === "initFirebase") {
    return respondAsync(n, "initFirebase", initFirebase());
  }
  if (t.type === "refreshLocalConfig") {
    return respondAsync(n, "refreshLocalConfig", refreshLocalConfig({ initFirebaseAfter: true }));
  }
  if (t.type === "checkWebsiteVersion") {
    return respondAsync(n, "checkWebsiteVersion", checkWebsiteVersion().then(() => ({ ok: true })));
  }
  if (t.type === "getEffectiveIdentity") {
    return respondAsync(n, "getEffectiveIdentity", getEffectiveIdentityForSender(e).then((identity) => ({ ok: true, identity })));
  }
  if (t.type === "getTeamDebugSnapshot") {
    return respondAsync(n, "getTeamDebugSnapshot", getTeamDebugSnapshot());
  }
  if (t.type === "clearTeamDebugLog") {
    return respondAsync(n, "clearTeamDebugLog", Promise.all([
      storageLocalRemove(TEAM_DEBUG_EVENTS_KEY),
      storageSessionRemove(TEAM_DEBUG_EVENTS_KEY),
    ]).then(() => {
      recordTeamDebug("diagnostics", "Team debug log cleared.");
      return { ok: true };
    }));
  }
});

// Call on startup. Prefer the desktop app's latest config when it is
// available, but keep cached sync working if the app is closed.
refreshLocalConfig({ initFirebaseAfter: true })
  .then((result) => {
    if (!result || result.ok === false) return initFirebase();
    return null;
  })
  .catch(() => initFirebase());
checkWebsiteVersion();
