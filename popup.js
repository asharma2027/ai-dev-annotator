// popup.js
document.addEventListener('DOMContentLoaded', () => {
  const listEl     = document.getElementById('annotations-list');
  const historyEl  = document.getElementById('history-panel');
  const badge      = document.getElementById('count-badge');
  const copyBtn    = document.getElementById('copy-btn');
  const clearBtn   = document.getElementById('clear-btn');
  const historyBtn = document.getElementById('history-btn');
  const footer     = document.querySelector('.footer');

  const HISTORY_KEY = 'annotationHistory';
  let historyVisible = false;

  // Prevent the storage.onChanged listener from triggering a re-render when
  // the popup itself is the one writing (avoids textarea cursor-position resets).
  let isWritingFromPopup = false;

  // ── Helpers ──────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s ?? '')
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Builds a compact CSS-selector-style string for an annotation.
   * Handles both the old storage format (id field = '#foo' or 'N/A')
   * and the new format (elId field = raw id string).
   */
  function getSelector(ann) {
    const rawId = ann.elId !== undefined
      ? (ann.elId ? `#${ann.elId}` : '')          // new format
      : (ann.id && ann.id !== 'N/A' && !ann.id.startsWith('ann_')
          ? ann.id                                 // old format: already has # prefix
          : '');
    const cls = ann.classes && ann.classes !== 'N/A' ? ann.classes : '';
    return `${ann.tag}${rawId}${cls}`;
  }

  function formatTimestamp(ts) {
    if (!ts) return '';
    try { return new Date(ts).toLocaleString(); } catch { return ts; }
  }

  // ── Save a single annotation's comment from the popup ────────────────────
  const saveTimers = {};
  function saveComment(annId, value) {
    clearTimeout(saveTimers[annId]);
    saveTimers[annId] = setTimeout(() => {
      isWritingFromPopup = true;
      chrome.storage.local.get({ annotations: [] }, r => {
        const anns = r.annotations;
        const ann = anns.find(a => a.id === annId);
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

  // ── Delete a single annotation (moves it to history) ─────────────────────
  function deleteAnnotation(annId) {
    isWritingFromPopup = true;
    chrome.storage.local.get({ annotations: [], [HISTORY_KEY]: [] }, r => {
      const anns = r.annotations;
      const hist = r[HISTORY_KEY];
      const ann = anns.find(a => a.id === annId);
      if (ann) {
        hist.push({ ...ann, deletedAt: new Date().toISOString() });
      }
      const remaining = anns.filter(a => a.id !== annId);
      chrome.storage.local.set({ annotations: remaining, [HISTORY_KEY]: hist }, () => {
        isWritingFromPopup = false;
        render(remaining);
        // Tell the content script to remove the visual highlight + chip badge
        if (ann) {
          chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
            if (tabs[0]) {
              chrome.tabs.sendMessage(tabs[0].id, {
                type: 'removeAnnotation',
                annId: annId,
                xpath: ann.xpath
              }).catch(() => {}); // Ignore errors when content script is unavailable
            }
          });
        }
      });
    });
  }

  // ── Restore a history entry back into current annotations ─────────────────
  function restoreAnnotation(annId, deletedAt) {
    chrome.storage.local.get({ annotations: [], [HISTORY_KEY]: [] }, r => {
      const anns = r.annotations;
      const hist = r[HISTORY_KEY];

      // Use annId + deletedAt to uniquely identify the entry (handles repeat deletions)
      const histIdx = hist.findIndex(a => a.id === annId && a.deletedAt === deletedAt);
      if (histIdx === -1) return;

      const ann = { ...hist[histIdx] };
      delete ann.deletedAt;

      // If the same annId is already in current annotations, skip to avoid duplicates
      if (anns.some(a => a.id === ann.id)) {
        showHistory();
        return;
      }

      const newAnns = [...anns, ann];
      const newHist = hist.filter((_, i) => i !== histIdx);

      chrome.storage.local.set({ annotations: newAnns, [HISTORY_KEY]: newHist }, () => {
        // Refresh the history view
        showHistory();
        // Tell the content script to re-inject the chip badge on the page
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
          if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
              type: 'restoreAnnotation',
              ann
            }).catch(() => {});
          }
        });
      });
    });
  }

  // ── Render annotation list ────────────────────────────────────────────────
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

    // Group by URL
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

    // Attach save-on-type listeners to every textarea
    listEl.querySelectorAll('.item-note-edit').forEach(ta => {
      ta.addEventListener('input', () => saveComment(ta.dataset.annId, ta.value));
    });

    // Attach delete listeners to every delete button
    listEl.querySelectorAll('.item-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => deleteAnnotation(btn.dataset.annId));
    });
  }

  function load() {
    chrome.storage.local.get({ annotations: [] }, r => render(r.annotations));
  }

  // Refresh popup in real-time if storage changes (e.g. user annotating on the page),
  // but skip re-renders triggered by the popup's own writes to avoid cursor resets.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.annotations && !isWritingFromPopup && !historyVisible) {
      render(changes.annotations.newValue || []);
    }
  });

  // ── History panel ─────────────────────────────────────────────────────────
  function showHistory() {
    chrome.storage.local.get({ [HISTORY_KEY]: [] }, r => {
      const hist = r[HISTORY_KEY];
      historyVisible = true;
      listEl.style.display = 'none';
      footer.style.display = 'none';
      historyEl.style.display = 'block';
      historyBtn.textContent = '✕';
      historyBtn.title = 'Close history';

      if (hist.length === 0) {
        historyEl.innerHTML = `<p class="empty-msg">No annotation history yet.<br>Deleted annotations will appear here.</p>`;
        return;
      }

      // Most recent deletions first
      const sorted = [...hist].reverse();
      const byUrl = {};
      sorted.forEach(ann => (byUrl[ann.url] = byUrl[ann.url] || []).push(ann));

      let html = '';
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

      // Attach restore-click listeners to every '+' button
      historyEl.querySelectorAll('.hist-restore-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          restoreAnnotation(btn.dataset.annId, btn.dataset.deletedAt);
        });
      });
    });
  }

  function hideHistory() {
    historyVisible = false;
    historyEl.style.display = 'none';
    footer.style.display = '';
    listEl.style.display = '';
    historyBtn.textContent = '🕐';
    historyBtn.title = 'View annotation history';
    load();
  }

  historyBtn.addEventListener('click', () => {
    if (historyVisible) hideHistory();
    else showHistory();
  });

  // ── Dense Markdown copy ───────────────────────────────────────────────────
  // Format: one line per annotation, grouped by URL.
  // Excludes: timestamps, verbose labels, redundant fields.
  // Keeps: URL (as section header), CSS selector, XPath (for element targeting), note.
  copyBtn.addEventListener('click', () => {
    chrome.storage.local.get({ annotations: [] }, r => {
      // Only include annotations that have a non-empty note
      const anns = r.annotations.filter(a => a.comment && a.comment.trim());

      if (anns.length === 0) {
        alert('No annotations with notes to copy yet.');
        return;
      }

      // Group by URL
      const byUrl = {};
      anns.forEach(ann => (byUrl[ann.url] = byUrl[ann.url] || []).push(ann));
      const urls = Object.keys(byUrl);

      let md = '';

      if (urls.length === 1) {
        // Single page — URL as header, no repeated prefix per line
        md += `## ${urls[0]}\n`;
        byUrl[urls[0]].forEach((ann, i) => {
          md += formatLine(i + 1, ann);
        });
      } else {
        // Multiple pages — group under sub-headers
        urls.forEach((url, ui) => {
          if (ui > 0) md += '\n';
          md += `### ${url}\n`;
          byUrl[url].forEach((ann, i) => {
            md += formatLine(i + 1, ann);
          });
        });
      }

      navigator.clipboard.writeText(md.trim()).then(() => {
        const orig = copyBtn.textContent;
        copyBtn.textContent = '✅ Copied!';
        setTimeout(() => (copyBtn.textContent = orig), 1500);
      }).catch(() => alert('Clipboard write failed. Try again.'));
    });
  });

  /**
   * Formats one annotation as a single dense line.
   *
   * If the element has an ID, the XPath is redundant (XPath would be
   * `id("foo")` anyway), so just emit the CSS selector.
   * Otherwise emit: `selector | xpath → note`
   */
  function formatLine(n, ann) {
    const sel = getSelector(ann);
    const hasId = ann.elId
      ? !!ann.elId
      : (ann.id && ann.id !== 'N/A' && !ann.id.startsWith('ann_'));

    if (hasId) {
      return `${n}. \`${sel}\` → ${ann.comment.trim()}\n`;
    }
    return `${n}. \`${sel}\` | \`${ann.xpath}\` → ${ann.comment.trim()}\n`;
  }

  // ── Clear All (moves all annotations to history) ──────────────────────────
  clearBtn.addEventListener('click', () => {
    if (confirm('Clear all annotations? They will be saved to history.')) {
      chrome.storage.local.get({ annotations: [], [HISTORY_KEY]: [] }, r => {
        const anns = r.annotations;
        const hist = r[HISTORY_KEY];
        const now = new Date().toISOString();
        anns.forEach(ann => hist.push({ ...ann, deletedAt: now }));
        isWritingFromPopup = true;
        chrome.storage.local.set({ annotations: [], [HISTORY_KEY]: hist }, () => {
          isWritingFromPopup = false;
          load();
        });
      });
    }
  });

  load();
});
