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
const DESKTOP_BRIDGE_ALARM = "annotatorDesktopBridge";
const DESKTOP_BRIDGE_ORIGIN = "http://127.0.0.1:11454";
const DESKTOP_BRIDGE_STATE_KEY = "_desktopBridgeState";
const DESKTOP_TAB_SESSIONS_KEY = "desktopTabSessions";
const MAX_DESKTOP_SNAPSHOT_BYTES = 768 * 1024;

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
  chrome.alarms.get(DESKTOP_BRIDGE_ALARM, (alarm) => {
    alarm ||
      chrome.alarms.create(DESKTOP_BRIDGE_ALARM, {
        delayInMinutes: 1,
        periodInMinutes: 1,
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
  t.name === DESKTOP_BRIDGE_ALARM && refreshDesktopBridge();
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

// Local desktop bridge. Annotation data never leaves this device: the bridge
// is loopback-only and becomes authorized only after the desktop app opens a
// short-lived launch page in the exact Chrome tab it wants tracked.
let _desktopAnnotationSyncTimer = null;
const DESKTOP_CHALLENGE_CONTEXT = "ai-dev-annotator-desktop-v1:";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "getDesktopProjectContext") {
    const tabId = sender.tab?.id;
    getDesktopTabSessions()
      .then((sessions) => sendResponse({
        ok: true,
        projectId: sessions[String(tabId)]?.projectId || "",
      }))
      .catch(() => sendResponse({ ok: false, projectId: "" }));
    return true;
  }
  if (message?.type !== "registerDesktopTestTab") return undefined;
  const tabId = sender.tab?.id;
  const launchUrl = sender.tab?.url || message.url;
  registerDesktopTestTab(tabId, launchUrl)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const launchUrl = changeInfo.url || tab?.url;
  if (!isDesktopLaunchUrl(launchUrl)) return;
  registerDesktopTestTab(tabId, launchUrl).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  removeDesktopTabSession(tabId).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (!changes.annotations && !changes.annotationHistory && !changes[ANN_STORE_KEY]) return;
  scheduleDesktopAnnotationSync();
});

chrome.runtime.onInstalled.addListener(() => {
  refreshDesktopBridge();
});
chrome.runtime.onStartup.addListener(() => {
  refreshDesktopBridge();
});

function parseDesktopLaunchUrl(urlValue) {
  try {
    const url = new URL(urlValue);
    if (url.origin !== DESKTOP_BRIDGE_ORIGIN) return null;
    const match = url.pathname.match(/^\/launch\/([a-zA-Z0-9_-]+)$/);
    const ticket = url.searchParams.get("ticket");
    if (!match || !/^[a-f0-9]{64}$/.test(ticket || "")) return null;
    return { sessionId: match[1], ticket };
  } catch (_error) {
    return null;
  }
}

function isDesktopLaunchUrl(urlValue) {
  return !!parseDesktopLaunchUrl(urlValue);
}

async function registerDesktopTestTab(tabId, launchUrl) {
  if (!Number.isInteger(tabId)) throw new Error("Chrome did not provide a test tab id.");
  const launch = parseDesktopLaunchUrl(launchUrl);
  if (!launch) throw new Error("This is not a valid desktop launch page.");
  const pairedToken = await readDesktopBridgeToken();
  if (pairedToken) await verifyDesktopBridgeServer(pairedToken);
  const attached = await pairDesktopTestTab(launch, tabId);
  if (!attached.token || (pairedToken && !constantTimeTextEqual(pairedToken, attached.token))) {
    throw new Error("This launch page does not match the paired desktop app.");
  }
  const token = pairedToken || attached.token;
  await verifyDesktopBridgeServer(token);
  const registered = await desktopBridgeFetch(`/api/extension/sessions/${encodeURIComponent(launch.sessionId)}/attach`, {
    body: { tabId },
    method: "POST",
    token,
  });

  const sessions = await getDesktopTabSessions();
  sessions[String(tabId)] = {
    projectId: registered.projectId || attached.projectId || "",
    sessionId: launch.sessionId,
    token,
  };
  await setDesktopTabSessions(sessions);
  await chrome.storage.local.set({
    [DESKTOP_BRIDGE_STATE_KEY]: {
      token,
      updatedAt: new Date().toISOString(),
    },
  });
  await sendDesktopHeartbeat(token);
  scheduleDesktopAnnotationSync(token);
  return { projectId: registered.projectId || attached.projectId || "", sessionId: launch.sessionId, tabId };
}

async function pairDesktopTestTab(launch, tabId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`${DESKTOP_BRIDGE_ORIGIN}/api/extension/pair`, {
      body: JSON.stringify({ sessionId: launch.sessionId, tabId, ticket: launch.ticket }),
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Desktop pairing returned ${response.status}.`);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function removeDesktopTabSession(tabId) {
  const sessions = await getDesktopTabSessions();
  const session = sessions[String(tabId)];
  if (!session) return;
  await desktopBridgeFetch(`/api/extension/sessions/${encodeURIComponent(session.sessionId)}/closed`, {
    body: { tabId },
    method: "POST",
    token: session.token,
  });
  delete sessions[String(tabId)];
  await setDesktopTabSessions(sessions);
}

async function getDesktopTabSessions() {
  const storageArea = chrome.storage.session || chrome.storage.local;
  const result = await storageArea.get({ [DESKTOP_TAB_SESSIONS_KEY]: {} });
  const sessions = result[DESKTOP_TAB_SESSIONS_KEY];
  return sessions && typeof sessions === "object" && !Array.isArray(sessions) ? sessions : {};
}

async function setDesktopTabSessions(sessions) {
  const storageArea = chrome.storage.session || chrome.storage.local;
  await storageArea.set({ [DESKTOP_TAB_SESSIONS_KEY]: sessions });
}

async function readDesktopBridgeToken() {
  const result = await chrome.storage.local.get({ [DESKTOP_BRIDGE_STATE_KEY]: null });
  return result[DESKTOP_BRIDGE_STATE_KEY]?.token || "";
}

async function refreshDesktopBridge() {
  const token = await readDesktopBridgeToken();
  if (!token) return;
  try {
    await sendDesktopHeartbeat(token);
    await syncDesktopAnnotations(token);
    await reconcileDesktopTabSessions(token);
  } catch (_error) {}
}

async function sendDesktopHeartbeat(token) {
  return desktopBridgeFetch("/api/extension/heartbeat", {
    body: { version: chrome.runtime.getManifest().version },
    method: "POST",
    token,
  });
}

function scheduleDesktopAnnotationSync(knownToken) {
  clearTimeout(_desktopAnnotationSyncTimer);
  _desktopAnnotationSyncTimer = setTimeout(async () => {
    const token = knownToken || (await readDesktopBridgeToken());
    if (!token) return;
    await syncDesktopAnnotations(token).catch(() => {});
  }, 500);
}

async function syncDesktopAnnotations(token) {
  const stored = await chrome.storage.local.get({
    [ANN_STORE_KEY]: {},
    annotationHistory: [],
    annotations: [],
  });
  const snapshotStore = stored[ANN_STORE_KEY] || {};
  const current = (stored.annotations || []).map((annotation) => sanitizeDesktopAnnotation(annotation, "active"));
  const history = (stored.annotationHistory || [])
    .map((entry) => {
      const resolved = entry && entry.id && snapshotStore[entry.id]
        ? { ...snapshotStore[entry.id], deletedAt: entry.deletedAt || snapshotStore[entry.id].deletedAt }
        : entry;
      return sanitizeDesktopAnnotation(resolved, "history");
    })
    .filter(Boolean);
  const byId = new Map();
  for (const annotation of [...history, ...current]) {
    if (annotation?.id) byId.set(annotation.id, annotation);
  }
  const payload = buildDesktopSnapshotPayload(Array.from(byId.values()));
  return desktopBridgeFetch("/api/extension/annotations", {
    body: payload,
    method: "POST",
    token,
  });
}

function buildDesktopSnapshotPayload(annotations) {
  const encoder = new TextEncoder();
  const ordered = annotations.slice().sort((left, right) => {
    const lifecycleDifference = Number(right.lifecycle === "active") - Number(left.lifecycle === "active");
    if (lifecycleDifference) return lifecycleDifference;
    return desktopAnnotationTimestamp(right) - desktopAnnotationTimestamp(left);
  });
  const payload = {
    annotations: [],
    capturedAt: new Date().toISOString(),
    totalAnnotations: ordered.length,
    truncated: false,
    version: 1,
  };
  let encodedBytes = encoder.encode(JSON.stringify(payload)).byteLength;
  for (const annotation of ordered) {
    const itemBytes = encoder.encode(JSON.stringify(annotation)).byteLength + 1;
    if (encodedBytes + itemBytes > MAX_DESKTOP_SNAPSHOT_BYTES) {
      payload.truncated = true;
      continue;
    }
    payload.annotations.push(annotation);
    encodedBytes += itemBytes;
  }
  payload.truncated ||= payload.annotations.length < payload.totalAnnotations;
  return payload;
}

function desktopAnnotationTimestamp(annotation) {
  for (const value of [annotation.updatedAt, annotation.timestamp, annotation.createdAt, annotation.deletedAt]) {
    const timestamp = Date.parse(value || "");
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function sanitizeDesktopAnnotation(annotation, lifecycle) {
  if (!annotation || typeof annotation !== "object") return null;
  const contextElements = Array.isArray(annotation.contextElements)
    ? annotation.contextElements.slice(0, 20).map((element) => ({
        classes: element?.classes || "",
        elId: element?.elId || "",
        tag: element?.tag || "",
        text: element?.text || "",
        xpath: element?.xpath || "",
      }))
    : [];
  return {
    classes: annotation.classes || "",
    comment: annotation.comment || "",
    contextElements,
    deletedAt: annotation.deletedAt || "",
    elId: annotation.elId || "",
    extraComments: Array.isArray(annotation.extraComments) ? annotation.extraComments.slice(0, 20) : [],
    id: annotation.id || "",
    lifecycle,
    pageLevel: !!annotation.pageLevel,
    projectId: annotation.projectId || "",
    tag: annotation.tag || "",
    text: annotation.text || "",
    timestamp: annotation.timestamp || "",
    url: annotation.url || "",
    xpath: annotation.xpath || "",
  };
}

async function reconcileDesktopTabSessions(token) {
  const response = await desktopBridgeFetch("/api/extension/sessions", { token });
  const activeSessionIds = new Set((response.sessions || []).map((session) => session.sessionId));
  const sessions = await getDesktopTabSessions();
  let changed = false;
  for (const [tabId, session] of Object.entries(sessions)) {
    if (!activeSessionIds.has(session.sessionId)) {
      delete sessions[tabId];
      changed = true;
      continue;
    }
    try {
      await chrome.tabs.get(Number(tabId));
    } catch (_error) {
      await desktopBridgeFetch(`/api/extension/sessions/${encodeURIComponent(session.sessionId)}/closed`, {
        body: { tabId: Number(tabId) },
        method: "POST",
        token: session.token,
      });
      delete sessions[tabId];
      changed = true;
    }
  }
  if (changed) await setDesktopTabSessions(sessions);
}

async function desktopBridgeFetch(pathname, options = {}) {
  if (!options.token) throw new Error("Desktop bridge pairing is unavailable.");
  await verifyDesktopBridgeServer(options.token);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const headers = { Authorization: `Bearer ${options.token}` };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${DESKTOP_BRIDGE_ORIGIN}${pathname}`, {
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      headers,
      method: options.method || "GET",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Desktop bridge returned ${response.status}.`);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyDesktopBridgeServer(token) {
  const nonceBytes = new Uint8Array(32);
  crypto.getRandomValues(nonceBytes);
  const nonce = Array.from(nonceBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(
      `${DESKTOP_BRIDGE_ORIGIN}/api/extension/challenge?nonce=${encodeURIComponent(nonce)}`,
      { cache: "no-store", method: "GET", signal: controller.signal },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.protocol !== 1 || typeof payload.proof !== "string") {
      throw new Error("The local dashboard could not prove its identity.");
    }
    const expectedProof = await createDesktopChallengeProof(token, nonce);
    if (!constantTimeTextEqual(payload.proof, expectedProof)) {
      throw new Error("The local dashboard did not match the paired desktop app.");
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function createDesktopChallengeProof(token, nonce) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(token),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${DESKTOP_CHALLENGE_CONTEXT}${nonce}`),
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeTextEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
