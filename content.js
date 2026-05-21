/**
 * Content script — annotation UI injected into normal web pages (MV3
 * content_scripts and host permission `<all_urls>`).
 *
 * Gestures:
 *   - Modifier + context menu (right-click) on an element → new annotation.
 *   - While the edit panel is open: modifier + click → add that element as
 *     extra selector context on the active annotation (contextElements).
 * Chips anchor to elements or the page; storage keys align with popup.js.
 */
const ANN = "aiann";
let __aiann_contextDead = !1;
function showContextInvalidatedNotice() {
  if (!__aiann_contextDead) {
    __aiann_contextDead = !0;
    try {
      const e = document.createElement("div");
      ((e.id = "aiann-context-dead"),
        (e.textContent =
          "AI Website Dev Annotator was updated — refresh this page to keep annotating."),
        (e.style.cssText = [
          "position:fixed",
          "bottom:16px",
          "right:16px",
          "z-index:2147483647",
          "background:#1f1f23",
          "color:#fff",
          "font:13px/1.4 system-ui,sans-serif",
          "padding:10px 14px",
          "border-radius:8px",
          "box-shadow:0 6px 24px rgba(0,0,0,0.25)",
          "max-width:320px",
          "cursor:pointer",
        ].join(";")),
        e.addEventListener("click", () => e.remove()),
        document.body.appendChild(e),
        setTimeout(() => {
          try {
            e.remove();
          } catch (e) {}
        }, 12e3));
    } catch (e) {}
  }
}
let cachedShortcut = { modifier: "alt" };
/** Matches popup.js DEFAULT_HISTORY_LIMITS.annotations when unset. */
const DEFAULT_ANNOTATION_HISTORY_LIMIT = 200;
/**
 * Cached premium status. Populated from chrome.storage.local['license'].valid
 * which the popup writes after verifying the Ed25519 signature on every open.
 * Used to gate the in-page "+ Add note" button (Premium "multiple notes per
 * element" feature). Soft enforcement only — the popup is the source of
 * truth for verification.
 */
let cachedPremium = false;
/**
 * Multi-note helpers (mirror popup.js definitions). The first note lives in
 * `ann.comment` (back-compat); extras live in `ann.extraComments` (string[]).
 */
function getAnnNotes(ann) {
  if (!ann) return [""];
  const out = [ann.comment || ""];
  if (Array.isArray(ann.extraComments)) {
    for (const c of ann.extraComments) out.push(c == null ? "" : String(c));
  }
  return out;
}
function getCombinedNoteText(ann) {
  return getAnnNotes(ann)
    .map((n) => (n || "").trim())
    .filter(Boolean)
    .join(" • ");
}
function annHasAnyNote(ann) {
  if (!ann) return false;
  if (ann.comment && ann.comment.trim()) return true;
  return (
    Array.isArray(ann.extraComments) &&
    ann.extraComments.some((c) => c && String(c).trim())
  );
}
function modifierKeyLabel(shortcut) {
  const t = String((shortcut && shortcut.modifier) || "alt").toLowerCase();
  return (
    { alt: "Alt", ctrl: "Ctrl", shift: "Shift", meta: "⌘ / Meta" }[t] || "Alt"
  );
}
function isShortcutModifierHeld(e, t) {
  const n = String((t && t.modifier) || "alt").toLowerCase();
  return !!{ alt: e.altKey, ctrl: e.ctrlKey, shift: e.shiftKey, meta: e.metaKey }[
    n
  ];
}
function getAnnotationHistoryLimit(e) {
  const t = e || {},
    n = t.historyLimits || {};
  if (
    Object.prototype.hasOwnProperty.call(n, "annotations") &&
    null != n.annotations
  )
    return Math.max(0, parseInt(n.annotations, 10) || 0);
  if (void 0 !== t.maxHistoryLength && null !== t.maxHistoryLength)
    return Math.max(0, parseInt(t.maxHistoryLength, 10) || 0);
  return DEFAULT_ANNOTATION_HISTORY_LIMIT;
}
function updateContextElementHint() {
  const e = document.getElementById(`${ANN}-context-hint`);
  e &&
    (e.textContent = `${modifierKeyLabel(cachedShortcut)}+click any element to add it to this annotation`);
}
function loadShortcut() {
  try {
    chrome.storage.local.get({ annotatorSettings: {} }, (e) => {
      if (
        chrome.runtime.lastError &&
        String(chrome.runtime.lastError.message).includes(
          "Extension context invalidated",
        )
      )
        return void showContextInvalidatedNotice();
      const t = e.annotatorSettings || {};
      ((cachedShortcut = t.shortcut || { modifier: "alt" }),
        updateContextElementHint());
    });
  } catch (e) {
    if (String(e && e.message).includes("Extension context invalidated"))
      return void showContextInvalidatedNotice();
  }
}
function loadPremium() {
  try {
    chrome.storage.local.get({ license: null }, (r) => {
      if (
        chrome.runtime.lastError &&
        String(chrome.runtime.lastError.message).includes(
          "Extension context invalidated",
        )
      )
        return void showContextInvalidatedNotice();
      cachedPremium = !!(r && r.license && r.license.valid);
      updateAddNoteButtonVisibility();
    });
  } catch (e) {
    if (String(e && e.message).includes("Extension context invalidated"))
      return void showContextInvalidatedNotice();
  }
}
try {
  chrome.storage.onChanged.addListener((e, t) => {
    if ("local" !== t) return;
    if (e.annotatorSettings) {
      const next = (e.annotatorSettings && e.annotatorSettings.newValue) || {};
      ((cachedShortcut = next.shortcut || { modifier: "alt" }),
        updateContextElementHint());
    }
    if (e.license) {
      const next = e.license.newValue || null;
      cachedPremium = !!(next && next.valid);
      updateAddNoteButtonVisibility();
    }
  });
} catch (e) {}
function injectStyles() {
  if (document.getElementById(`${ANN}-styles`)) return;
  const e = document.createElement("style");
  ((e.id = `${ANN}-styles`),
    (e.textContent = `\n    /* Highlighted annotated element */\n    .${ANN}-hl {\n      outline: 2px solid #f59e0b !important;\n      background-color: rgba(253, 230, 138, 0.3) !important;\n      border-radius: 2px;\n    }\n    /* Chip badge rendered in the overlay */\n    .${ANN}-chip {\n      display: inline-flex;\n      align-items: center;\n      cursor: pointer;\n      background: #fbbf24;\n      color: #78350f;\n      font: 700 11px/1 system-ui, sans-serif;\n      padding: 2px 7px;\n      border-radius: 12px;\n      vertical-align: middle;\n      margin: 0 4px;\n      user-select: none;\n      white-space: nowrap;\n      box-shadow: 0 1px 4px rgba(0,0,0,0.18);\n      transition: background 0.12s;\n      position: relative;\n      z-index: 2147483600;\n    }\n    .${ANN}-chip:hover { background: #d97706; color: #fff; }\n    .${ANN}-chip.has-note { background: #f59e0b; }\n\n    /* Page-level annotation chip: fixed position, blue tint */\n    #${ANN}-page-chips {\n      position: fixed;\n      bottom: 16px;\n      right: 16px;\n      z-index: 2147483647;\n      display: flex;\n      flex-direction: column-reverse;\n      gap: 6px;\n      align-items: flex-end;\n      pointer-events: none;\n    }\n    .${ANN}-page-chip {\n      pointer-events: all;\n      background: #3b82f6 !important;\n      color: #fff !important;\n      font-size: 13px !important;\n    }\n    .${ANN}-page-chip:hover { background: #1d4ed8 !important; color: #fff !important; }\n    .${ANN}-page-chip.has-note { background: #2563eb !important; }\n\n    /* Shared editing panel : fixed, appended to body */\n    #${ANN}-panel {\n      position: fixed;\n      width: 272px;\n      background: #fff;\n      border: 1.5px solid #fbbf24;\n      border-radius: 10px;\n      box-shadow: 0 8px 32px rgba(0,0,0,0.18);\n      padding: 12px;\n      z-index: 2147483647;\n      display: none;\n      font-family: system-ui, sans-serif;\n    }\n    #${ANN}-panel-header {\n      display: flex;\n      justify-content: space-between;\n      align-items: center;\n      gap: 4px;\n      margin-bottom: 8px;\n      font: 700 11px system-ui, sans-serif;\n      color: #78350f;\n      letter-spacing: 0.04em;\n      text-transform: uppercase;\n    }\n    .${ANN}-label-copy-btn {\n      flex: 0 0 auto;\n      opacity: 0;\n      pointer-events: none;\n      background: none;\n      border: 1px solid transparent;\n      color: #9ca3af;\n      font-size: 11px;\n      padding: 0 3px;\n      cursor: pointer;\n      border-radius: 4px;\n      line-height: 1;\n      transition: opacity 0.15s, color 0.12s, background 0.12s;\n    }\n    #${ANN}-panel-header:hover .${ANN}-label-copy-btn {\n      opacity: 1;\n      pointer-events: auto;\n    }\n    .${ANN}-label-copy-btn:hover {\n      color: #374151;\n      background: #f3f4f6;\n      border-color: #d1d5db;\n    }\n    #${ANN}-close-btn {\n      background: none;\n      border: none;\n      color: #9ca3af;\n      font-size: 14px;\n      line-height: 1;\n      cursor: pointer;\n      padding: 0 2px;\n    }\n    #${ANN}-close-btn:hover { color: #374151; }\n    .${ANN}-note {\n      width: 100%;\n      min-height: 160px;\n      border: 1px solid #d1d5db;\n      border-radius: 6px;\n      padding: 7px 9px;\n      font: 12.5px/1.5 system-ui, sans-serif;\n      resize: vertical;\n      box-sizing: border-box;\n      outline: none;\n      color: #111827;\n      display: block;\n    }\n    .${ANN}-note:focus {\n      border-color: #f59e0b;\n      box-shadow: 0 0 0 2px rgba(251,191,36,0.25);\n    }\n    /* Extra notes belong to the same selector — keep them visually grouped */\n    /* but separate enough that a user can tell where one ends and the next begins. */\n    .${ANN}-note--extra {\n      margin-top: 8px;\n      min-height: 60px;\n      border-top: 2px dashed #fbcfe8;\n    }\n    #${ANN}-notes-container {\n      display: block;\n    }\n    #${ANN}-add-note-btn {\n      display: none; /* shown only when premium status is true */\n      margin-top: 6px;\n      width: 100%;\n      background: #fdf2f8;\n      border: 1px solid #f9a8d4;\n      color: #9d174d;\n      font: 600 11px system-ui, sans-serif;\n      padding: 5px 7px;\n      border-radius: 5px;\n      cursor: pointer;\n      transition: background 0.12s, border-color 0.12s, color 0.12s;\n    }\n    #${ANN}-add-note-btn:hover:not(:disabled) {\n      background: #fce7f3;\n      border-color: #db2777;\n      color: #831843;\n    }\n    #${ANN}-add-note-btn:disabled {\n      opacity: 0.5;\n      cursor: not-allowed;\n    }\n    #${ANN}-panel-footer {\n      display: flex;\n      justify-content: space-between;\n      align-items: center;\n      margin-top: 7px;\n      gap: 6px;\n    }\n    #${ANN}-save-status {\n      flex: 1;\n      font-size: 10px;\n      color: #9ca3af;\n      font-family: system-ui, sans-serif;\n      text-align: center;\n    }\n    #${ANN}-delete-btn {\n      flex: 0 0 auto;\n      background: none;\n      border: none;\n      color: #ef4444;\n      font: 600 11px system-ui, sans-serif;\n      cursor: pointer;\n      padding: 2px 7px;\n      border-radius: 4px;\n    }\n    #${ANN}-delete-btn:hover { background: #fee2e2; }\n\n    /* Page-level toggle button */\n    #${ANN}-page-btn {\n      flex: 0 0 auto;\n      background: none;\n      border: 1px solid #d1d5db;\n      color: #6b7280;\n      font: 600 11px system-ui, sans-serif;\n      cursor: pointer;\n      padding: 3px 8px;\n      border-radius: 4px;\n      white-space: nowrap;\n      transition: background 0.15s, border-color 0.15s, color 0.15s;\n    }\n    #${ANN}-page-btn:hover {\n      border-color: #f59e0b;\n      color: #92400e;\n      background: #fef3c7;\n    }\n    #${ANN}-page-btn.${ANN}-page-btn--active {\n      background: #dbeafe !important;\n      border-color: #3b82f6 !important;\n      color: #1d4ed8 !important;\n    }\n\n    /* Panel hint */\n    .aiann-panel-hint {\n      font-size: 10px;\n      white-space: nowrap;\n      overflow: hidden;\n      opacity: 0.65;\n      margin-top: 4px;\n      line-height: 1.35;\n      font-family: system-ui, sans-serif;\n      color: #6b7280;\n    }\n  `),
    document.head.appendChild(e));
}
function getXPath(e) {
  if (!e || 1 !== e.nodeType) return "";
  if (e.id) return `id("${e.id}")`;
  if (e === document.body) return "body";
  let t = 0;
  const n = e.parentNode ? e.parentNode.childNodes : [];
  for (let o = 0; o < n.length; o++) {
    const a = n[o];
    if (a === e)
      return (
        getXPath(e.parentNode) +
        "/" +
        e.tagName.toLowerCase() +
        "[" +
        (t + 1) +
        "]"
      );
    1 === a.nodeType && a.tagName === e.tagName && t++;
  }
  return e.tagName.toLowerCase();
}
function resolveXPath(e) {
  try {
    return document.evaluate(
      e,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    ).singleNodeValue;
  } catch {
    return null;
  }
}
loadShortcut();
loadPremium();
const STORE_KEY = "annotations",
  HISTORY_KEY = "annotationHistory";
function getAll(e) {
  try {
    chrome.storage.local.get({ [STORE_KEY]: [] }, (t) => {
      if (
        chrome.runtime.lastError &&
        String(chrome.runtime.lastError.message).includes(
          "Extension context invalidated",
        )
      )
        return (showContextInvalidatedNotice(), void e([]));
      e(t[STORE_KEY]);
    });
  } catch (t) {
    (String(t && t.message).includes("Extension context invalidated") &&
      showContextInvalidatedNotice(),
      e([]));
  }
}
function setAll(e, t) {
  try {
    (chrome.storage.local.set({ [STORE_KEY]: e }, t),
      backupAnnotationsToSync(e));
  } catch (e) {
    String(e && e.message).includes("Extension context invalidated") &&
      showContextInvalidatedNotice();
  }
}
function genId() {
  return `ann_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}
function backupAnnotationsToSync(e) {
  try {
    chrome.runtime.sendMessage({ type: "scheduleBackup" }).catch(() => {});
  } catch (e) {
    String(e && e.message).includes("Extension context invalidated") &&
      showContextInvalidatedNotice();
  }
}
function getEffectiveIdentity(callback) {
  try {
    chrome.runtime.sendMessage({ type: "getEffectiveIdentity" }, (response) => {
      if (
        chrome.runtime.lastError &&
        String(chrome.runtime.lastError.message).includes(
          "Extension context invalidated",
        )
      )
        return (showContextInvalidatedNotice(), callback(null));
      callback(response && response.ok ? response.identity || null : null);
    });
  } catch (e) {
    String(e && e.message).includes("Extension context invalidated") &&
      showContextInvalidatedNotice();
    callback(null);
  }
}
function enforceHistoryLimit() {
  try {
    chrome.storage.local.get(
      { annotatorSettings: {}, [HISTORY_KEY]: [] },
      (e) => {
        if (
          chrome.runtime.lastError &&
          String(chrome.runtime.lastError.message).includes(
            "Extension context invalidated",
          )
        )
          return void showContextInvalidatedNotice();
        const t = e.annotatorSettings || {},
          n = getAnnotationHistoryLimit(t);
        if (n <= 0) return;
        const o = e[HISTORY_KEY];
        if (!(o.length <= n))
          try {
            chrome.storage.local.set({ [HISTORY_KEY]: o.slice(-n) });
          } catch {}
      },
    );
  } catch {}
}
const __aiann_pageKey = window.location.origin + window.location.pathname;
let activeChip = null,
  activeAnnId = null,
  /**
   * Legacy single-timer alias kept around for code paths that still call
   * `clearTimeout(saveTimer)` (e.g. closePanel). Modern per-textarea timers
   * live in `__aiann_saveTimers` keyed by `${annId}::${noteIdx}` so concurrent
   * edits to the primary note + Premium extras don't clobber each other.
   */
  saveTimer = null,
  originalAnnData = null;
const __aiann_saveTimers = {};
function __aiann_clearAllSaveTimersFor(annId) {
  Object.keys(__aiann_saveTimers).forEach((k) => {
    if (k.startsWith(annId + "::")) {
      clearTimeout(__aiann_saveTimers[k]);
      delete __aiann_saveTimers[k];
    }
  });
}
function getAnnSelector(e) {
  if (!e) return "(unknown)";
  if (e.pageLevel || "page" === e.tag) return "(whole page)";
  const t = e.elId ? `#${e.elId}` : "",
    n = e.classes && "N/A" !== e.classes ? e.classes : "";
  return `${e.tag || "?"}${t}${n}`;
}
function getFullLabelText(e) {
  if (!e) return "(unknown)";
  const t = getAnnSelector(e);
  return e.contextElements && 0 !== e.contextElements.length
    ? [
        t,
        ...e.contextElements.map(
          (e) =>
            `${e.tag || "?"}${e.elId ? "#" + e.elId : ""}${e.classes || ""}`,
        ),
      ].join(", ")
    : t;
}
function updatePanelLabel(e) {
  const t = document.getElementById(`${ANN}-element-label`),
    n = document.getElementById(`${ANN}-page-label`);
  if (!e) return;
  const o = !(!e.pageLevel && "page" !== e.tag);
  if (t) {
    const n = getFullLabelText(e);
    ((t.textContent = n),
      (t.title = `Click to open in popup\n${n}`),
      (t.style.display = o ? "none" : ""));
  }
  if (n) {
    const t = e.url || __aiann_pageKey;
    ((n.textContent = t),
      (n.title = `Page annotation\n${t}`),
      (n.style.display = o ? "" : "none"));
  }
}
function buildPanel() {
  const e = document.createElement("div");
  return (
    (e.id = `${ANN}-panel`),
    (e.innerHTML = `\n    <div id="${ANN}-panel-header">\n      <span id="${ANN}-element-label" title="Click to open in popup" style="cursor:pointer;color:#db2777;font-family:'Menlo','Consolas',monospace;font-size:11px;font-weight:700;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;">...</span>\n      <span id="${ANN}-page-label" title="Page annotation" style="display:none;color:#2563eb;font-family:'Menlo','Consolas',monospace;font-size:11px;font-weight:700;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;"></span>\n      <button class="${ANN}-label-copy-btn" title="Copy selector(s) to clipboard">📋</button>\n      <button id="${ANN}-close-btn" title="Close">✕</button>\n    </div>\n    <div id="${ANN}-notes-container"></div>\n    <button id="${ANN}-add-note-btn" type="button" title="Add another note for this element">+ Add another note</button>\n    <div class="aiann-panel-hint">Empty notes auto-discarded. Esc to save &amp; close</div>\n    <div id="${ANN}-context-hint" style="font-size:9px;opacity:0.5;margin-top:2px;font-family:system-ui,sans-serif;color:#6b7280;"></div>\n    <div id="${ANN}-panel-footer">\n      <button id="${ANN}-page-btn" title="Mark as whole-page annotation (not element-specific)">🌐 Page Note</button>\n      <span id="${ANN}-save-status"></span>\n      <button id="${ANN}-delete-btn">🗑 Delete</button>\n    </div>`),
    document.body.appendChild(e),
    // Delegated input/blur on the notes container so it works for any
    // textarea — the primary one and any Premium "+ Add note" extras alike.
    e
      .querySelector(`#${ANN}-notes-container`)
      .addEventListener("input", (ev) => {
        const ta = ev.target;
        if (!ta || !ta.classList || !ta.classList.contains(`${ANN}-note`))
          return;
        const idx = parseInt(ta.dataset.noteIdx, 10) || 0;
        setSaveStatus("Saving…");
        // Per-(annId, idx) debounce so editing the primary note doesn't
        // cancel a pending save for an extra (and vice versa).
        const annId = activeAnnId;
        if (!annId) return;
        const key = `${annId}::${idx}`;
        clearTimeout(__aiann_saveTimers[key]);
        __aiann_saveTimers[key] = setTimeout(() => {
          delete __aiann_saveTimers[key];
          persistNote(annId, ta.value, idx);
        }, 400);
        updateAddNoteButtonVisibility();
      }),
    e
      .querySelector(`#${ANN}-notes-container`)
      .addEventListener(
        "blur",
        (ev) => {
          const ta = ev.target;
          if (!ta || !ta.classList || !ta.classList.contains(`${ANN}-note`))
            return;
          const idx = parseInt(ta.dataset.noteIdx, 10) || 0;
          // Auto-prune empty extras on blur so the panel doesn't accumulate
          // empty stacks. The primary note (idx 0) is left alone — the
          // "all-empty → delete" check happens in closePanel.
          if (idx > 0 && !ta.value.trim()) {
            pruneEmptyExtrasInPanel(activeAnnId);
          }
        },
        true,
      ),
    e
      .querySelector(`#${ANN}-add-note-btn`)
      .addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!cachedPremium) return; // soft enforcement
        panelAddNote(activeAnnId);
      }),
    e
      .querySelector(`#${ANN}-delete-btn`)
      .addEventListener("click", () => deleteAnnotation(activeAnnId)),
    e.querySelector(`#${ANN}-close-btn`).addEventListener("click", closePanel),
    e.addEventListener("keydown", (e) => {
      "Escape" === e.key && (e.stopPropagation(), closePanel());
    }),
    e.querySelector(`#${ANN}-page-btn`).addEventListener("click", () => {
      activeAnnId &&
        getAll((e) => {
          const t = e.find((e) => e.id === activeAnnId);
          if (t) {
            if (t.pageLevel) {
              if (originalAnnData) {
                ((t.tag = originalAnnData.tag),
                  (t.elId = originalAnnData.elId),
                  (t.classes = originalAnnData.classes),
                  (t.xpath = originalAnnData.xpath));
                const e = resolveXPath(t.xpath);
                if (e) {
                  e.classList.add(`${ANN}-hl`);
                  const n = document.querySelector(
                    `#${ANN}-page-chips .${ANN}-chip[data-ann-id="${t.id}"]`,
                  );
                  (n && n.remove(),
                    injectChip(e, t.id, getCombinedNoteText(t), t.authorColor),
                    (activeChip = __aiann_chipMap.get(t.id) || null));
                }
              }
              delete t.pageLevel;
            } else {
              originalAnnData = {
                tag: t.tag,
                elId: t.elId,
                classes: t.classes,
                xpath: t.xpath,
              };
              const e = resolveXPath(t.xpath);
              e && e.classList.remove(`${ANN}-hl`);
              const n = document.querySelector(
                `.${ANN}-chip[data-ann-id="${t.id}"]`,
              );
              (n &&
                !n.closest(`#${ANN}-page-chips`) &&
                (removeChip(t.id),
                injectPageChip(t.id, getCombinedNoteText(t), t.authorColor),
                (activeChip = document.querySelector(
                  `#${ANN}-page-chips .${ANN}-chip[data-ann-id="${t.id}"]`,
                ))),
                (t.tag = "page"),
                (t.elId = ""),
                (t.classes = ""),
                (t.xpath = "body"),
                (t.pageLevel = !0));
            }
            setAll(e, () => {
              const e = document.getElementById(`${ANN}-page-btn`);
              if (e) {
                const n = !!t.pageLevel;
                (e.classList.toggle(`${ANN}-page-btn--active`, n),
                  (e.title = n
                    ? "Currently: whole-page — click to revert to element-specific"
                    : "Mark as whole-page annotation (not element-specific)"));
              }
              (updatePanelLabel(t), setSaveStatus("Saved ✓"));
            });
          }
        });
    }),
    e.querySelector(`#${ANN}-element-label`).addEventListener("click", () => {
      const e = document.getElementById(`${ANN}-element-label`)?.dataset.annId;
      if (e)
        try {
          chrome.storage.local.set({ _popupScrollTarget: e }, () => {
            chrome.runtime
              .sendMessage({ type: "openPopupAndFocus", annId: e })
              .catch(() => {});
          });
        } catch (e) {}
    }),
    e.querySelector(`.${ANN}-label-copy-btn`).addEventListener("click", (t) => {
      t.stopPropagation();
      const n = document.getElementById(`${ANN}-element-label`),
        o = n ? n.textContent : "";
      o &&
        "..." !== o &&
        navigator.clipboard
          .writeText(o)
          .then(() => {
            const t = e.querySelector(`.${ANN}-label-copy-btn`),
              n = t.textContent;
            ((t.textContent = "✓"),
              (t.style.opacity = "1"),
              (t.style.color = "#16a34a"),
              setTimeout(() => {
                ((t.textContent = n),
                  (t.style.color = ""),
                  (t.style.opacity = ""));
              }, 1200));
          })
          .catch(() => {});
    }),
    document.addEventListener(
      "mousedown",
      (e) => {
        const t = document.getElementById(`${ANN}-panel`);
        if (
          t &&
          "block" === t.style.display &&
          !t.contains(e.target) &&
          !e.target.closest(`.${ANN}-chip`)
        ) {
          if (isShortcutModifierHeld(e, cachedShortcut)) return;
          closePanel();
        }
      },
      !0,
    ),
    updateContextElementHint(),
    e
  );
}
function getPanel() {
  return document.getElementById(`${ANN}-panel`) || buildPanel();
}
function renderContextChips(e, t) {
  const n = document.getElementById(`${ANN}-panel`);
  if (!n || activeAnnId !== e) return;
  let o = n.querySelector(`#${ANN}-ctx-container`);
  if (!o) {
    ((o = document.createElement("div")),
      (o.id = `${ANN}-ctx-container`),
      (o.style.cssText =
        "margin-top:5px;display:flex;flex-wrap:wrap;gap:3px;"));
    const e = n.querySelector(".aiann-panel-hint");
    e ? e.parentNode.insertBefore(o, e) : n.appendChild(o);
  }
  ((o.innerHTML = ""),
    t &&
      0 !== t.length &&
      t.forEach((e, t) => {
        const n = `${e.tag}${e.elId ? "#" + e.elId : ""}${e.classes || ""}`,
          a = document.createElement("span");
        ((a.style.cssText =
          "font:600 9.5px/1 Menlo,monospace;background:#fce7f3;color:#9d174d;padding:2px 5px;border-radius:4px;cursor:default;"),
          (a.title = e.text || n),
          (a.textContent = n.slice(0, 28) + (n.length > 28 ? "…" : "")),
          o.appendChild(a));
      }));
}
/**
 * Render N textareas (one per saved note) into the panel's notes container.
 * Used both when openPanel() runs and after auto-prune mutations re-shape
 * `extraComments`. Always preserves the per-textarea data-note-idx so the
 * saveTimer / persistNote routing stays correct.
 */
function renderNotesIntoContainer(ann) {
  const container = document.getElementById(`${ANN}-notes-container`);
  if (!container) return;
  const notes = getAnnNotes(ann);
  container.innerHTML = "";
  notes.forEach((n, idx) => {
    const ta = document.createElement("textarea");
    ta.className = `${ANN}-note${idx > 0 ? " " + ANN + "-note--extra" : ""}`;
    ta.dataset.noteIdx = String(idx);
    ta.placeholder = idx === 0 ? "" : "Add another note…";
    ta.value = n;
    container.appendChild(ta);
  });
  updateAddNoteButtonVisibility();
}

/**
 * Show / hide and enable / disable the "+ Add another note" button based on
 * the current cachedPremium status and the contents of the LAST textarea
 * (so users can't pile up empty stacks).
 */
function updateAddNoteButtonVisibility() {
  const btn = document.getElementById(`${ANN}-add-note-btn`);
  if (!btn) return;
  if (!cachedPremium) {
    btn.style.display = "none";
    return;
  }
  btn.style.display = "block";
  const tas = document.querySelectorAll(
    `#${ANN}-notes-container .${ANN}-note`,
  );
  const last = tas[tas.length - 1];
  const enabled = !last || !!last.value.trim();
  btn.disabled = !enabled;
  btn.title = enabled
    ? "Add another note for this element"
    : "Fill the current note first";
}

/**
 * Append a fresh empty extra to `extraComments` and re-render the notes
 * container so the new textarea appears (auto-focused). Premium-only.
 *
 * Snapshots in-flight DOM textarea values BEFORE re-rendering so a quick
 * type-then-click-Add sequence never loses the just-typed text (the
 * debounced save may not have fired yet).
 */
function panelAddNote(annId) {
  if (!annId || activeAnnId !== annId) return;
  // 1. Snapshot every textarea's current value — these are the source of
  //    truth (more recent than what's in storage).
  const liveTas = Array.from(
    document.querySelectorAll(`#${ANN}-notes-container .${ANN}-note`),
  );
  const liveValues = liveTas.map((ta) => ta.value || "");
  // 2. Cancel pending debounced saves for this annotation; we'll persist
  //    everything atomically below.
  __aiann_clearAllSaveTimersFor(annId);
  getAll((anns) => {
    const ann = anns.find((a) => a.id === annId);
    if (!ann) return;
    // 3. Apply the in-flight values onto the stored annotation so the
    //    re-render shows what the user actually typed.
    if (liveValues.length > 0) {
      ann.comment = liveValues[0] || "";
      const extras = liveValues.slice(1);
      if (extras.length > 0) ann.extraComments = extras;
      else delete ann.extraComments;
    }
    if (!Array.isArray(ann.extraComments)) ann.extraComments = [];
    let targetIdx;
    const lastIdx = ann.extraComments.length - 1;
    if (lastIdx >= 0 && !String(ann.extraComments[lastIdx] || "").trim()) {
      targetIdx = lastIdx + 1;
    } else {
      ann.extraComments.push("");
      targetIdx = ann.extraComments.length;
    }
    setAll(anns, () => {
      renderNotesIntoContainer(ann);
      const sel = `#${ANN}-notes-container .${ANN}-note[data-note-idx="${targetIdx}"]`;
      const target = document.querySelector(sel);
      if (target) target.focus();
      // Update the chip too (combined-note may have changed by overlaying
      // the in-flight values).
      const chip = document.querySelector(
        `.${ANN}-chip[data-ann-id="${annId}"]`,
      );
      if (chip) {
        const combined = getCombinedNoteText(ann);
        chip.title = combined ? combined.slice(0, 80) : "(no note)";
        chip.classList.toggle("has-note", !!combined);
      }
    });
  });
}

/**
 * Drop empty/whitespace-only entries from extraComments and re-render the
 * notes container. Called from blur of an empty extra. Safe to call when no
 * pruning is needed (no-op).
 *
 * Captures in-flight DOM values from sibling textareas first so the
 * just-blurred empty extra doesn't accidentally roll back a half-typed
 * primary note that hadn't hit the debounce yet.
 */
function pruneEmptyExtrasInPanel(annId) {
  if (!annId || activeAnnId !== annId) return;
  // Snapshot live DOM values + cancel pending debounced saves so we don't
  // lose anything when we re-render.
  const liveTas = Array.from(
    document.querySelectorAll(`#${ANN}-notes-container .${ANN}-note`),
  );
  const liveValues = liveTas.map((ta) => ta.value || "");
  __aiann_clearAllSaveTimersFor(annId);
  getAll((anns) => {
    const ann = anns.find((a) => a.id === annId);
    if (!ann) return;
    // Apply live values first so the prune operates on the freshest data.
    if (liveValues.length > 0) {
      ann.comment = liveValues[0] || "";
      const extras = liveValues.slice(1);
      if (extras.length > 0) ann.extraComments = extras;
      else delete ann.extraComments;
    }
    if (!Array.isArray(ann.extraComments)) {
      updateAddNoteButtonVisibility();
      // Still might need to write the primary if it changed.
      setAll(anns);
      return;
    }
    const before = ann.extraComments.length;
    ann.extraComments = ann.extraComments.filter(
      (c) => c && String(c).trim(),
    );
    if (ann.extraComments.length === 0) delete ann.extraComments;
    setAll(anns, () => {
      // Only re-render if the visible textarea count actually changed.
      const after = Array.isArray(ann.extraComments)
        ? ann.extraComments.length
        : 0;
      if (after !== before) renderNotesIntoContainer(ann);
      else updateAddNoteButtonVisibility();
      // Reflect the (possibly) shorter combined note on the chip.
      const chip = document.querySelector(
        `.${ANN}-chip[data-ann-id="${ann.id}"]`,
      );
      if (chip) {
        const combined = getCombinedNoteText(ann);
        chip.title = combined ? combined.slice(0, 80) : "(no note)";
        chip.classList.toggle("has-note", !!combined);
      }
    });
  });
}

function openPanel(e, t) {
  (activeAnnId && activeAnnId !== t && closePanel(),
    getAll((n) => {
      const o = n.find((e) => e.id === t);
      o &&
        !o.pageLevel &&
        (originalAnnData = {
          tag: o.tag,
          elId: o.elId,
          classes: o.classes,
          xpath: o.xpath,
        });
      const i = getPanel();
      (positionPanel(i, e), (i.style.display = "block"));
      // Render every note (primary + Premium extras) into the container.
      renderNotesIntoContainer(o || {});
      setSaveStatus("");
      const l = i.querySelector(`#${ANN}-element-label`);
      l && o && ((l.dataset.annId = t), updatePanelLabel(o));
      const r = i.querySelector(`#${ANN}-page-btn`);
      if (r && o) {
        const e = !!o.pageLevel;
        (r.classList.toggle(`${ANN}-page-btn--active`, e),
          (r.title = e
            ? "Currently: whole-page — click to revert to element-specific"
            : "Mark as whole-page annotation (not element-specific)"));
      }
      (updateContextElementHint(),
        (activeChip = e),
        (activeAnnId = t));
      // Focus the first textarea so the existing UX (panel opens → start
      // typing immediately) is preserved.
      const firstTa = i.querySelector(
        `#${ANN}-notes-container .${ANN}-note[data-note-idx="0"]`,
      );
      if (firstTa) firstTa.focus();
    }));
}
function positionPanel(e, t) {
  const n = t.getBoundingClientRect();
  let o = n.bottom + 6,
    a = n.left;
  (a + 276 > window.innerWidth - 4 && (a = window.innerWidth - 280),
    o + 290 > window.innerHeight - 4 && (o = Math.max(4, n.top - 296)),
    (e.style.top = o + "px"),
    (e.style.left = Math.max(4, a) + "px"));
}
function closePanel() {
  const e = activeAnnId,
    t = document.getElementById(`${ANN}-panel`);
  // Snapshot every textarea's current value (primary + Premium extras) so the
  // close path can either save them all or — if every one is empty — drop
  // the annotation entirely (preserves the original "blank → discarded" UX).
  const tas = t
    ? Array.from(
        t.querySelectorAll(`#${ANN}-notes-container .${ANN}-note`),
      )
    : [];
  const values = tas.map((ta) => ta.value || "");
  const allEmpty = values.every((v) => !v || !v.trim());
  (t && (t.style.display = "none"),
    (activeChip = null),
    (activeAnnId = null),
    e &&
      (clearTimeout(saveTimer),
      __aiann_clearAllSaveTimersFor(e),
      getAll((t) => {
        const n = t.find((t) => t.id === e);
        if (n)
          if (allEmpty) {
            // Whole annotation has no text in any note → discard it (and
            // any chip / highlight that goes with it).
            if ((removeChip(e), !n.pageLevel)) {
              const e = resolveXPath(n.xpath);
              e && e.classList.remove(`${ANN}-hl`);
            }
            setAll(t.filter((t) => t.id !== e));
          } else {
            // Save primary + extras (filtering empty extras as we go so the
            // panel re-opens with a clean stack next time).
            const newPrimary = values[0] || "";
            const newExtras = values.slice(1).filter((v) => v && v.trim());
            const oldExtras = Array.isArray(n.extraComments)
              ? n.extraComments
              : [];
            const sameExtras =
              newExtras.length === oldExtras.length &&
              newExtras.every((v, i) => v === oldExtras[i]);
            const samePrimary = (n.comment || "") === newPrimary;
            if (!samePrimary || !sameExtras) {
              n.comment = newPrimary;
              if (newExtras.length === 0) delete n.extraComments;
              else n.extraComments = newExtras;
              setAll(t, () => {
                const chip = document.querySelector(
                  `.${ANN}-chip[data-ann-id="${e}"]`,
                );
                if (chip) {
                  const combined = getCombinedNoteText(n);
                  chip.title = combined ? combined.slice(0, 80) : "(no note)";
                  chip.classList.toggle("has-note", !!combined);
                }
              });
            }
          }
      })));
}
function setSaveStatus(e) {
  const t = document.getElementById(`${ANN}-save-status`);
  t && (t.textContent = e);
}
/**
 * Persist a single textarea's content. noteIdx 0 → ann.comment (back-compat
 * with all existing data); noteIdx >= 1 → ann.extraComments[idx-1] (the
 * Premium "multiple notes per element" feature). Updates the chip's tooltip
 * + has-note state to reflect the *combined* note text so the chip stays
 * accurate when extras carry the only content.
 */
function persistNote(annId, value, noteIdx) {
  if (!annId) return;
  const idx = parseInt(noteIdx, 10) || 0;
  getAll((anns) => {
    const ann = anns.find((a) => a.id === annId);
    if (!ann) return;
    if (idx === 0) {
      ann.comment = value;
    } else {
      if (!Array.isArray(ann.extraComments)) ann.extraComments = [];
      const arrIdx = idx - 1;
      while (ann.extraComments.length <= arrIdx) ann.extraComments.push("");
      ann.extraComments[arrIdx] = value;
    }
    setAll(anns, () => {
      setSaveStatus("Saved ✓");
      const chip = document.querySelector(
        `.${ANN}-chip[data-ann-id="${annId}"]`,
      );
      if (chip) {
        const combined = getCombinedNoteText(ann);
        chip.title = combined ? combined.slice(0, 80) : "(no note)";
        chip.classList.toggle("has-note", !!combined);
      }
    });
  });
}
function deleteAnnotation(e) {
  if (!e) return;
  const t = e;
  (closePanel(),
    getAll((e) => {
      const n = e.find((e) => e.id === t);
      if (n) {
        if (!n.pageLevel) {
          const e = resolveXPath(n.xpath);
          e && e.classList.remove(`${ANN}-hl`);
        }
        try {
          chrome.storage.local.get({ [HISTORY_KEY]: [] }, (e) => {
            if (
              chrome.runtime.lastError &&
              String(chrome.runtime.lastError.message).includes(
                "Extension context invalidated",
              )
            )
              return void showContextInvalidatedNotice();
            const t = e[HISTORY_KEY].filter((e) => e.id !== n.id);
            t.push({ ...n, deletedAt: new Date().toISOString() });
            try {
              chrome.storage.local.set(
                { [HISTORY_KEY]: t },
                enforceHistoryLimit,
              );
            } catch {}
          });
        } catch {}
      }
      (removeChip(t), setAll(e.filter((e) => e.id !== t)));
    }));
}
function addElementToContext(e, t) {
  if (!e || !t) return;
  const n = {
    tag: t.tagName ? t.tagName.toLowerCase() : "?",
    elId: t.id || "",
    classes:
      "string" == typeof t.className
        ? t.className
            .trim()
            .split(/\s+/)
            .filter((e) => !e.startsWith(ANN))
            .map((e) => `.${e}`)
            .join("")
        : "",
    xpath: getXPath(t),
    text: (() => {
      try {
        return (t.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120);
      } catch {
        return "";
      }
    })(),
  };
  getAll((o) => {
    const a = o.find((t) => t.id === e);
    a &&
      (a.contextElements || (a.contextElements = []),
      a.contextElements.push(n),
      setAll(o, () => {
        (setSaveStatus("Element added ✓"),
          updatePanelLabel(a),
          t.classList.add(`${ANN}-hl`),
          setTimeout(() => {
            if (!a.pageLevel) {
              const e = resolveXPath(a.xpath);
              t !== e && t.classList.remove(`${ANN}-hl`);
            }
          }, 1200));
      }));
  });
}
function getPageChipContainer() {
  let e = document.getElementById(`${ANN}-page-chips`);
  return (
    e ||
      ((e = document.createElement("div")),
      (e.id = `${ANN}-page-chips`),
      document.body.appendChild(e)),
    e
  );
}
let __aiann_chipOverlay = null;
const __aiann_chipMap = new Map(),
  __aiann_targetMap = new Map();
function getChipOverlay() {
  if (__aiann_chipOverlay && document.body.contains(__aiann_chipOverlay))
    return __aiann_chipOverlay;
  const e = document.createElement("div");
  return (
    (e.id = "aiann-chip-overlay"),
    (e.style.cssText = [
      "position:fixed",
      "top:0",
      "left:0",
      "width:0",
      "height:0",
      "pointer-events:none",
      "z-index:2147483646",
      "contain:layout style",
    ].join(";")),
    document.body.appendChild(e),
    (__aiann_chipOverlay = e),
    e
  );
}
function positionChipAtElement(e, t) {
  if (!t || !t.getBoundingClientRect) return void (e.style.display = "none");
  const n = t.getBoundingClientRect();
  0 !== n.width || 0 !== n.height
    ? ((e.style.display = ""),
      (e.style.position = "fixed"),
      (e.style.pointerEvents = "auto"),
      (e.style.top = Math.max(0, n.top - 2) + "px"),
      (e.style.left = Math.min(window.innerWidth - 24, n.right - 8) + "px"))
    : (e.style.display = "none");
}
function repositionPageChipContainer() {
  const e = document.getElementById(`${ANN}-page-chips`);
  if (!e) return;
  const t = 16,
    n = e.offsetWidth || 220,
    o = e.offsetHeight || 56,
    a = [
      { bottom: t, right: t },
      { bottom: t + o + 12, right: t },
      { bottom: t, right: t + n + 12 },
      { top: t, right: t },
      { top: t, left: t },
    ],
    i = (t) => {
      const a = { left: 0, top: 0, right: 0, bottom: 0 };
      (null != t.right &&
        ((a.right = window.innerWidth - t.right), (a.left = a.right - n)),
        null != t.left && ((a.left = t.left), (a.right = a.left + n)),
        null != t.bottom &&
          ((a.bottom = window.innerHeight - t.bottom), (a.top = a.bottom - o)),
        null != t.top && ((a.top = t.top), (a.bottom = a.top + o)));
      const i = [
        [a.left + 4, a.top + 4],
        [a.right - 4, a.top + 4],
        [a.left + 4, a.bottom - 4],
        [a.right - 4, a.bottom - 4],
        [(a.left + a.right) / 2, (a.top + a.bottom) / 2],
      ];
      for (const [t, n] of i) {
        const o = document.elementsFromPoint(t, n) || [];
        for (const t of o) {
          if (!t || t === e || e.contains(t)) continue;
          if (t.id && t.id.startsWith("aiann-")) continue;
          const n = getComputedStyle(t);
          if (
            "fixed" === n.position &&
            "hidden" !== n.visibility &&
            "none" !== n.display
          ) {
            const e = t.getBoundingClientRect();
            if (e.width >= 32 && e.height >= 32) return !0;
          }
        }
      }
      return !1;
    },
    s = (t) => {
      ((e.style.top = e.style.right = e.style.bottom = e.style.left = ""),
        Object.entries(t).forEach(([t, n]) => {
          e.style[t] = n + "px";
        }));
    };
  for (const e of a) if (!i(e)) return void s(e);
  s(a[0]);
}
let __aiann_reposPending = !1;
function repositionAllChips() {
  __aiann_reposPending ||
    ((__aiann_reposPending = !0),
    requestAnimationFrame(() => {
      (__aiann_chipMap.forEach((e, t) => {
        positionChipAtElement(e, __aiann_targetMap.get(t) || null);
      }),
        repositionPageChipContainer(),
        (__aiann_reposPending = !1));
    }));
}
function injectChip(e, t, n, authorColor) {
  e.classList.add(`${ANN}-hl`);
  const o = getChipOverlay();
  let a = __aiann_chipMap.get(t);
  (a ||
    ((a = document.createElement("span")),
    (a.className = `${ANN}-chip`),
    (a.dataset.annId = t),
    (a.textContent = "✏"),
    a.addEventListener("click", (e) => {
      (e.stopPropagation(), e.preventDefault());
      const n = document.getElementById(`${ANN}-panel`);
      activeAnnId === t && n && "block" === n.style.display
        ? closePanel()
        : openPanel(a, t);
    }),
    o.appendChild(a),
    __aiann_chipMap.set(t, a)),
    (a.className = `${ANN}-chip${n && n.trim() ? " has-note" : ""}`),
    (authorColor ? (a.style.backgroundColor = authorColor, a.style.color = '#fff') : null),
    (a.title = n && n.trim() ? n.trim().slice(0, 80) : "(no note)"),
    (a.textContent = "✏"),
    __aiann_targetMap.set(t, e),
    positionChipAtElement(a, e));
}
function removeChip(e) {
  const t = __aiann_chipMap.get(e);
  (t && t.parentNode && t.parentNode.removeChild(t),
    __aiann_chipMap.delete(e),
    __aiann_targetMap.delete(e));
}
function injectPageChip(e, t, authorColor) {
  if (document.querySelector(`.${ANN}-chip[data-ann-id="${e}"]`)) return;
  const n = document.createElement("span");
  ((n.className = `${ANN}-chip ${ANN}-page-chip${t && t.trim() ? " has-note" : ""}`),
    (authorColor ? (n.style.backgroundColor = authorColor, n.style.color = '#fff', n.style.borderColor = authorColor) : null),
    (n.dataset.annId = e),
    (n.textContent = "📄"),
    (n.title = t && t.trim() ? t.trim().slice(0, 80) : "(page annotation)"),
    n.addEventListener("click", (t) => {
      (t.stopPropagation(), t.preventDefault());
      const o = document.getElementById(`${ANN}-panel`);
      activeAnnId === e && o && "block" === o.style.display
        ? closePanel()
        : openPanel(n, e);
    }),
    getPageChipContainer().appendChild(n));
}
function restoreAnnotations() {
  const e = __aiann_pageKey;
  getAll((t) => {
    (t
      .filter((t) => {
        if (!t.url) return !1;
        try {
          const n = new URL(t.url);
          return n.origin + n.pathname === e;
        } catch (n) {
          return t.url === e;
        }
      })
      .forEach((e) => {
        // Use combined-note text so chips show ALL note content (primary +
        // Premium extras) in their tooltip / has-note state from the start.
        const combined = getCombinedNoteText(e);
        if (e.pageLevel || "page" === e.tag)
          injectPageChip(e.id, combined, e.authorColor);
        else {
          const t = resolveXPath(e.xpath);
          t && injectChip(t, e.id, combined, e.authorColor);
        }
      }),
      consumeNavIntent());
  });
}
function consumeNavIntent() {
  try {
    chrome.storage.local.get({ _navIntent: null }, (e) => {
      if (
        chrome.runtime.lastError &&
        String(chrome.runtime.lastError.message).includes(
          "Extension context invalidated",
        )
      )
        return void showContextInvalidatedNotice();
      const t = e._navIntent;
      if (t)
        if (t.expiresAt && Date.now() > t.expiresAt)
          try {
            chrome.storage.local.remove("_navIntent");
          } catch {}
        else {
          if (t.url)
            try {
              const e = new URL(t.url);
              if (e.origin + e.pathname !== __aiann_pageKey) return;
            } catch (e) {
              if (t.url !== window.location.href) return;
            }
          try {
            chrome.storage.local.remove("_navIntent");
          } catch {}
          "focusAnnotation" === t.type && t.annId
            ? setTimeout(() => focusAnnotationOnPage(t.annId), 200)
            : "openAllForUrl" === t.type &&
              setTimeout(() => openAllChipsOnPage(), 200);
        }
    });
  } catch (e) {
    String(e && e.message).includes("Extension context invalidated") &&
      showContextInvalidatedNotice();
  }
}
function focusAnnotationOnPage(e) {
  const t = document.querySelector(`.${ANN}-chip[data-ann-id="${e}"]`);
  t &&
    (t.scrollIntoView({ behavior: "smooth", block: "center" }),
    openPanel(t, e));
}
function openAllChipsOnPage() {
  const e = Array.from(document.querySelectorAll(`.${ANN}-chip`));
  if (0 === e.length) return;
  e.forEach((e) => {
    ((e.style.transition = "transform 0.15s"),
      (e.style.transform = "scale(1.25)"),
      setTimeout(() => {
        e.style.transform = "";
      }, 400));
    const t = e.dataset.annId;
    t &&
      getAll((e) => {
        const n = e.find((e) => e.id === t);
        if (n && !n.pageLevel && n.xpath) {
          const e = resolveXPath(n.xpath);
          e && e.classList.add(`${ANN}-hl`);
        }
      });
  });
  const t = e[0];
  t &&
    t.dataset.annId &&
    (t.scrollIntoView({ behavior: "smooth", block: "center" }),
    openPanel(t, t.dataset.annId));
}
(window.__aiann_chipReposBound ||
  ((window.__aiann_chipReposBound = !0),
  window.addEventListener("scroll", repositionAllChips, {
    passive: !0,
    capture: !0,
  }),
  window.addEventListener("resize", repositionAllChips, { passive: !0 }),
  new ResizeObserver(repositionAllChips).observe(document.documentElement),
  new MutationObserver((e) => {
    e.every((e) => {
      let t = e.target;
      for (; t && t !== document.documentElement; ) {
        if (
          t.id &&
          ("aiann-chip-overlay" === t.id ||
            "aiann-page-chips" === t.id ||
            "aiann-panel" === t.id ||
            t.id.startsWith("aiann-"))
        )
          return !0;
        t = t.parentNode;
      }
      return !1;
    }) || repositionAllChips();
  }).observe(document.documentElement, {
    childList: !0,
    subtree: !0,
    attributes: !0,
    attributeFilter: ["style", "class"],
  })),
  document.addEventListener(
    "contextmenu",
    (e) => {
      const t = (cachedShortcut.modifier || "alt").toLowerCase();
      if (
        !{ alt: e.altKey, ctrl: e.ctrlKey, shift: e.shiftKey, meta: e.metaKey }[
          t
        ]
      )
        return;
      e.preventDefault();
      const n = e.target;
      if (
        n.closest(`#${ANN}-panel`) ||
        n.classList.contains(`${ANN}-chip`) ||
        n === document.body ||
        n === document.documentElement
      )
        return;
      if (n.classList.contains(`${ANN}-hl`)) {
        const e =
          __aiann_chipMap.get(
            [...__aiann_targetMap.entries()].find(([, e]) => e === n)?.[0],
          ) || null;
        if (e) return void openPanel(e, e.dataset.annId);
        {
          let e = n.nextSibling;
          for (; e; ) {
            if (e.classList && e.classList.contains(`${ANN}-chip`))
              return void openPanel(e, e.dataset.annId);
            e = e.nextSibling;
          }
        }
      }
      const o =
        "string" == typeof n.className && n.className.trim()
          ? n.className
              .trim()
              .split(/\s+/)
              .filter((e) => !e.startsWith(ANN))
              .map((e) => `.${e}`)
              .join("")
          : "";
      getEffectiveIdentity((identity) => {
        const a = {
          id: genId(),
          url: __aiann_pageKey,
          tag: n.tagName.toLowerCase(),
          elId: n.id || "",
          classes: o,
          xpath: getXPath(n),
          comment: "",
          timestamp: new Date().toISOString(),
          text: (() => {
            try {
              return (n && n.innerText ? n.innerText : "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 240);
            } catch (e) {
              return "";
            }
          })(),
        };
        if (identity && identity.username) {
          a.authorName = identity.username;
          a.authorColor = identity.userColor || "#2563eb";
        }
        getAll((e) => {
          (e.push(a),
            setAll(e, () => {
              injectChip(n, a.id, "", a.authorColor);
              const e = __aiann_chipMap.get(a.id);
              e && openPanel(e, a.id);
            }));
        });
      });
    },
    { capture: !0, passive: !1 },
  ));
try {
  chrome.runtime.onMessage.addListener((e) => {
    if ("removeAnnotation" === e.type) {
      const { annId: t, xpath: n } = e;
      if (
        (activeAnnId === t && closePanel(), removeChip(t), n && "body" !== n)
      ) {
        const e = resolveXPath(n);
        e && e.classList.remove(`${ANN}-hl`);
      }
    }
    if ("restoreAnnotation" === e.type) {
      const t = e.ann;
      if (!t) return;
      const combined = getCombinedNoteText(t);
      if (t.pageLevel || "page" === t.tag)
        injectPageChip(t.id, combined);
      else if (t.xpath) {
        const e = resolveXPath(t.xpath);
        e && injectChip(e, t.id, combined, t.authorColor);
      }
    }
    if ("focusAnnotation" === e.type) {
      const { annId: t } = e;
      getAll((e) => {
        const n = e.find((e) => e.id === t);
        if (!n) return;
        const o = document.querySelector(`.${ANN}-chip[data-ann-id="${t}"]`);
        if (
          (o &&
            (o.scrollIntoView({ behavior: "smooth", block: "center" }),
            openPanel(o, t)),
          !n.pageLevel && n.xpath && "body" !== n.xpath)
        ) {
          const e = resolveXPath(n.xpath);
          if (e) {
            e.scrollIntoView({ behavior: "smooth", block: "center" });
            const t = e.style.outline,
              n = e.style.transition;
            ((e.style.transition = "outline 0.15s"),
              (e.style.outline = "3px solid #f59e0b"),
              setTimeout(() => {
                ((e.style.outline = t), (e.style.transition = n));
              }, 2e3));
          }
        }
      });
    }
    "openAllAnnotations" === e.type && openAllChipsOnPage();
    if ("remoteAnnotationsUpdated" === e.type) { try { __aiann_chipMap.forEach((e, t) => removeChip(t)); } catch(err){} restoreAnnotations(); }
  });
} catch (e) {
  String(e && e.message).includes("Extension context invalidated") &&
    showContextInvalidatedNotice();
}
(!(function () {
  if (window.__aiann_navInstalled) return;
  window.__aiann_navInstalled = !0;
  let e = location.href;
  const t = () => {
    const t = location.href;
    if (t !== e) {
      e = t;
      try {
        __aiann_chipMap.forEach((e, t) => removeChip(t));
      } catch (e) {}
      restoreAnnotations();
    }
  };
  (window.addEventListener("popstate", t),
    window.addEventListener("hashchange", t));
  const n = history.pushState,
    o = history.replaceState;
  ((history.pushState = function () {
    const e = n.apply(this, arguments);
    return (t(), e);
  }),
    (history.replaceState = function () {
      const e = o.apply(this, arguments);
      return (t(), e);
    }));
})(),
  document.addEventListener(
    "click",
    (e) => {
      if (!isShortcutModifierHeld(e, cachedShortcut)) return;
      if (!activeAnnId) return;
      const t = document.getElementById(`${ANN}-panel`);
      if (!t || "block" !== t.style.display) return;
      const n = e.target;
      n &&
        (n.closest(`#${ANN}-panel`) ||
          n.classList.contains(`${ANN}-chip`) ||
          n === document.body ||
          n === document.documentElement ||
          (n !== __aiann_targetMap.get(activeAnnId) &&
            (e.preventDefault(),
            e.stopPropagation(),
            addElementToContext(activeAnnId, n))));
    },
    { capture: !0 },
  ),
  injectStyles(),
  "loading" === document.readyState
    ? document.addEventListener("DOMContentLoaded", restoreAnnotations)
    : restoreAnnotations());
