// popup.js
document.addEventListener('DOMContentLoaded', () => {
  const listEl   = document.getElementById('annotations-list');
  const badge    = document.getElementById('count-badge');
  const copyBtn  = document.getElementById('copy-btn');
  const clearBtn = document.getElementById('clear-btn');

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
        const hasNote = ann.comment && ann.comment.trim();
        html += `
        <div class="item">
          <div class="item-sel"><code>${escHtml(sel)}</code></div>
          <div class="item-note">${
            hasNote
              ? escHtml(ann.comment)
              : '<em class="empty-note">No note yet — click ✏ on the page to edit</em>'
          }</div>
        </div>`;
      });
      html += '</div>';
    });

    listEl.innerHTML = html;
  }

  function load() {
    chrome.storage.local.get({ annotations: [] }, r => render(r.annotations));
  }

  // Refresh popup in real-time if storage changes (e.g. user is typing on the page)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.annotations) {
      render(changes.annotations.newValue || []);
    }
  });

  // ── Dense Markdown copy ───────────────────────────────────────────────────
  // Format: one line per annotation, grouped by URL.
  // Excludes: timestamps, verbose labels, redundant fields.
  // Keeps: URL, CSS selector, XPath (for element targeting), note.
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
        // Single page — URL in header, no repeated prefix per line
        md += `## Annotations — ${urls[0]}\n`;
        byUrl[urls[0]].forEach((ann, i) => {
          md += formatLine(i + 1, ann);
        });
      } else {
        // Multiple pages — group under sub-headers
        md += `## Annotations\n`;
        urls.forEach(url => {
          md += `\n### ${url}\n`;
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

  // ── Clear All ─────────────────────────────────────────────────────────────
  clearBtn.addEventListener('click', () => {
    if (confirm('Delete all annotations? This cannot be undone.')) {
      chrome.storage.local.set({ annotations: [] }, load);
    }
  });

  load();
});
