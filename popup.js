// popup.js
document.addEventListener('DOMContentLoaded', () => {
  const listContainer = document.getElementById('annotations-list');
  const countBadge = document.getElementById('count-badge');
  const copyBtn = document.getElementById('copy-btn');
  const clearBtn = document.getElementById('clear-btn');

  // ── Load & render saved annotations ──────────────────────────────────────
  function loadAnnotations() {
    chrome.storage.local.get({ annotations: [] }, (result) => {
      const data = result.annotations;

      // Update the count badge
      countBadge.textContent = data.length > 0 ? `${data.length}` : '';

      if (data.length === 0) {
        listContainer.innerHTML = `
          <p class="empty-msg">
            No annotations yet.<br>
            Hold <strong>Alt + Right-Click</strong> any element on a page.
          </p>`;
        return;
      }

      // FIX: Gemini used {item.tag} / {item.id} instead of ${item.tag} / ${item.id}
      //      (missing $ prefix — would render as literal text "{item.tag}")
      // FIX: Gemini's template only showed url/tag/comment — now shows all fields
      let html = '';
      data.forEach((item, index) => {
        html += `
          <div class="item">
            <div class="item-meta">#${index + 1} &nbsp;&bull;&nbsp; ${item.timestamp}</div>
            <div class="item-row"><span class="label">Page</span><span class="url">${escapeHtml(item.url)}</span></div>
            <div class="item-row"><span class="label">Element</span><code>&lt;${escapeHtml(item.tag)}&gt;</code></div>
            <div class="item-row"><span class="label">ID</span><code>${escapeHtml(item.id)}</code></div>
            <div class="item-row"><span class="label">Classes</span><code>${escapeHtml(item.classes)}</code></div>
            <div class="item-row"><span class="label">XPath</span><code class="xpath">${escapeHtml(item.xpath)}</code></div>
            <div class="item-note"><span class="label">Note</span> ${escapeHtml(item.comment)}</div>
          </div>`;
      });
      listContainer.innerHTML = html;
    });
  }

  // Escape HTML to prevent XSS when rendering user/page data into innerHTML
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Copy All as Markdown ──────────────────────────────────────────────────
  copyBtn.addEventListener('click', () => {
    chrome.storage.local.get({ annotations: [] }, (result) => {
      const data = result.annotations;
      if (data.length === 0) {
        alert('Nothing to copy yet!');
        return;
      }

      // Format as clean Markdown — ready to paste into Cursor, ChatGPT, Claude, etc.
      // FIX: Gemini used {item.tag} / {item.id} (broken template literals missing $)
      let markdown = '### Requested UI Changes\n\n';
      data.forEach((item, index) => {
        markdown += `#### Change ${index + 1}\n`;
        markdown += `**Page:** \`${item.url}\`\n`;
        markdown += `- **Target Element:** \`<${item.tag}>\` (ID: \`${item.id}\`)\n`;
        markdown += `- **Classes:** \`${item.classes}\`\n`;
        markdown += `- **XPath:** \`${item.xpath}\`\n`;
        markdown += `- **Improvement:** ${item.comment}\n\n`;
      });

      // FIX: Added .catch() error handler that was missing from Gemini's version
      navigator.clipboard.writeText(markdown).then(() => {
        const original = copyBtn.textContent;
        copyBtn.textContent = '✅ Copied!';
        setTimeout(() => (copyBtn.textContent = original), 1500);
      }).catch((err) => {
        console.error('[AI Dev Annotator] Clipboard write failed:', err);
        alert('Could not copy to clipboard. Try again.');
      });
    });
  });

  // ── Clear All ─────────────────────────────────────────────────────────────
  clearBtn.addEventListener('click', () => {
    if (confirm('Delete all annotations? This cannot be undone.')) {
      chrome.storage.local.set({ annotations: [] }, loadAnnotations);
    }
  });

  // Initial render
  loadAnnotations();
});
