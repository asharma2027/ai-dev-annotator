// universal-import.js : cross-app prompt capture import/export layer
//
// This file intentionally does not execute prompts, click UI, type into apps,
// call AI APIs, or modify external applications. It only imports structured
// context captured elsewhere, stores it as local annotations, and exports
// model-agnostic Markdown that the user can paste into any AI tool.

(function () {
  'use strict';

  const STORAGE_KEY = 'annotations';
  const UNIVERSAL_SOURCE_TYPE = 'universal-prompt-capture';
  const MAX_VISIBLE_TEXT = 480;

  function escHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function slug(value, fallback) {
    return String(value || fallback || 'capture')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || fallback || 'capture';
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function stableHash(value) {
    const str = String(value || '');
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function sourceUrl(source, target) {
    const adapter = slug(source.adapter || source.type || 'app', 'app');
    const app = slug(source.appName || source.bundleId || source.packageName || 'unknown', 'unknown');
    const ref = target.stableRef || target.accessibilityPath || target.resourceId || target.nodeId || target.filePath || target.name || 'target';
    return `app://${adapter}/${app}#${encodeURIComponent(ref)}`;
  }

  function targetSelector(target) {
    return [
      target.kind || target.role || target.type || 'element',
      target.name || target.label || target.title || '',
      target.stableRef || target.accessibilityPath || target.resourceId || target.nodeId || target.filePath || '',
    ].filter(Boolean).join(' · ');
  }

  function normalizeCapture(payload) {
    const source = payload && payload.source && typeof payload.source === 'object' ? payload.source : {};
    const captures = Array.isArray(payload && payload.captures) ? payload.captures : [];
    if (!captures.length) throw new Error('Expected a JSON object with a non-empty captures[] array.');

    return captures.map((item, index) => {
      const target = item && item.target && typeof item.target === 'object' ? item.target : {};
      const prompt = String(item.prompt || item.note || item.comment || '').trim();
      if (!prompt) throw new Error(`Capture ${index + 1} is missing a prompt/note/comment.`);

      const selector = targetSelector(target);
      const visibleText = String(target.visibleText || item.visibleText || '').replace(/\s+/g, ' ').trim().slice(0, MAX_VISIBLE_TEXT);
      const ref = target.stableRef || target.accessibilityPath || target.resourceId || target.nodeId || target.filePath || selector;
      const idSeed = JSON.stringify({ source, target, prompt, index, importedAt: nowIso() });
      const importedAt = nowIso();

      return {
        id: `univ_${Date.now()}_${index}_${stableHash(idSeed)}`,
        url: source.url || source.deepLink || sourceUrl(source, target),
        tag: slug(target.kind || target.role || target.type || source.adapter || 'app-element', 'app-element'),
        elId: slug(ref, 'target'),
        classes: '',
        xpath: ref ? String(ref) : '',
        comment: prompt,
        text: visibleText,
        timestamp: item.timestamp || importedAt,
        sourceType: UNIVERSAL_SOURCE_TYPE,
        universalCapture: {
          version: payload.version || 1,
          importedAt,
          source,
          target,
          prompt,
          labels: Array.isArray(item.labels) ? item.labels : [],
          risk: item.risk || 'prompt-only',
          selector,
        },
      };
    });
  }

  function readAnnotations() {
    return new Promise(resolve => chrome.storage.local.get({ [STORAGE_KEY]: [] }, result => resolve(result[STORAGE_KEY] || [])));
  }

  function writeAnnotations(annotations) {
    return new Promise(resolve => chrome.storage.local.set({ [STORAGE_KEY]: annotations }, resolve));
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    return Promise.resolve();
  }

  function formatUniversalMarkdown(annotations) {
    const universal = annotations.filter(ann => ann && ann.sourceType === UNIVERSAL_SOURCE_TYPE);
    if (!universal.length) return '';

    const groups = new Map();
    universal.forEach(ann => {
      const cap = ann.universalCapture || {};
      const src = cap.source || {};
      const title = src.appName || src.documentName || src.windowTitle || src.adapter || ann.url || 'Cross-app capture';
      if (!groups.has(title)) groups.set(title, []);
      groups.get(title).push(ann);
    });

    const lines = [
      '# Cross-App Prompt Capture Export',
      '',
      '> Prompt-only context. Do not assume any action has been executed. Use these notes as instructions for an AI coding/writing/design agent.',
      '',
    ];

    for (const [title, anns] of groups.entries()) {
      lines.push(`## ${title}`, '');
      anns.forEach((ann, index) => {
        const cap = ann.universalCapture || {};
        const src = cap.source || {};
        const target = cap.target || {};
        const stableRef = target.stableRef || target.accessibilityPath || target.resourceId || target.nodeId || target.filePath || ann.xpath || ann.elId;
        lines.push(`${index + 1}. ${cap.selector || ann.tag || 'Target'}`);
        if (src.adapter) lines.push(`   - Source adapter: ${src.adapter}`);
        if (src.bundleId || src.packageName) lines.push(`   - App id: ${src.bundleId || src.packageName}`);
        if (src.windowTitle) lines.push(`   - Window/screen: ${src.windowTitle}`);
        if (src.documentName) lines.push(`   - Document: ${src.documentName}`);
        if (stableRef) lines.push(`   - Stable reference: \`${String(stableRef).replace(/`/g, '\\`')}\``);
        if (target.visibleText || ann.text) lines.push(`   - Visible text: _"${String(target.visibleText || ann.text).replace(/\s+/g, ' ').slice(0, MAX_VISIBLE_TEXT)}"_`);
        lines.push(`   - Prompt: ${String(cap.prompt || ann.comment || '').replace(/\n/g, '\n     ')}`);
        lines.push(`   - Captured at: ${ann.timestamp || cap.importedAt || ''}`);
        lines.push('');
      });
    }

    return lines.join('\n').trim() + '\n';
  }

  function showUniversalModal() {
    const existing = document.getElementById('universal-capture-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'universal-capture-modal';
    overlay.className = 'universal-capture-modal';
    overlay.innerHTML = `
      <div class="universal-capture-box" role="dialog" aria-label="Import cross-app prompt captures">
        <button class="universal-capture-close" title="Close">✕</button>
        <h3>Import App Captures</h3>
        <p>Paste prompt-only JSON from a native helper, simulator bridge, IDE plugin, Figma plugin, or another capture adapter. Nothing is executed.</p>
        <textarea class="universal-capture-input" spellcheck="false" placeholder='{\n  "version": 1,\n  "source": { "adapter": "macos-accessibility", "appName": "MyApp", "windowTitle": "Settings" },\n  "captures": [\n    {\n      "target": { "kind": "button", "name": "Export", "stableRef": "AXWindow/AXToolbar/AXButton[Export]", "visibleText": "Export" },\n      "prompt": "Rename this to Export CSV and disable it until invoices are loaded."\n    }\n  ]\n}'></textarea>
        <div class="universal-capture-actions">
          <button class="universal-capture-secondary">Cancel</button>
          <button class="universal-capture-primary">Import captures</button>
        </div>
        <div class="universal-capture-status" aria-live="polite"></div>
      </div>`;

    const close = () => overlay.remove();
    overlay.querySelector('.universal-capture-close').addEventListener('click', close);
    overlay.querySelector('.universal-capture-secondary').addEventListener('click', close);
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });

    overlay.querySelector('.universal-capture-primary').addEventListener('click', async () => {
      const input = overlay.querySelector('.universal-capture-input');
      const status = overlay.querySelector('.universal-capture-status');
      try {
        const payload = JSON.parse(input.value);
        const imported = normalizeCapture(payload);
        const existingAnns = await readAnnotations();
        await writeAnnotations([...existingAnns, ...imported]);
        status.textContent = `Imported ${imported.length} capture${imported.length === 1 ? '' : 's'}.`;
        setTimeout(() => window.location.reload(), 500);
      } catch (error) {
        status.textContent = error && error.message ? error.message : 'Import failed.';
      }
    });

    document.body.appendChild(overlay);
    setTimeout(() => overlay.querySelector('.universal-capture-input').focus(), 0);
  }

  async function copyUniversalCaptures() {
    const annotations = await readAnnotations();
    const markdown = formatUniversalMarkdown(annotations);
    if (!markdown) {
      alert('No app captures found yet. Use Import App Captures first.');
      return;
    }
    await copyText(markdown);
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .universal-capture-bar { display:flex; gap:6px; padding:8px 10px 0; }
      .universal-capture-bar button { flex:1; border:1px solid #d0d7de; border-radius:8px; background:#fff; padding:7px 8px; font-size:12px; cursor:pointer; }
      .universal-capture-bar button:hover { background:#f6f8fa; }
      .universal-capture-modal { position:fixed; inset:0; z-index:2147483647; background:rgba(15,23,42,.36); display:flex; align-items:center; justify-content:center; padding:14px; }
      .universal-capture-box { width:min(520px, 100%); background:#fff; color:#111827; border-radius:14px; box-shadow:0 20px 50px rgba(15,23,42,.35); padding:16px; position:relative; }
      .universal-capture-close { position:absolute; top:10px; right:10px; border:0; background:transparent; font-size:16px; cursor:pointer; }
      .universal-capture-box h3 { margin:0 28px 6px 0; font-size:16px; }
      .universal-capture-box p { margin:0 0 10px; color:#4b5563; font-size:12px; line-height:1.4; }
      .universal-capture-input { width:100%; min-height:230px; resize:vertical; box-sizing:border-box; border:1px solid #d0d7de; border-radius:10px; padding:10px; font:12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .universal-capture-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:10px; }
      .universal-capture-actions button { border-radius:8px; border:1px solid #d0d7de; padding:7px 10px; cursor:pointer; }
      .universal-capture-primary { background:#111827; color:#fff; border-color:#111827 !important; }
      .universal-capture-status { margin-top:8px; min-height:16px; font-size:12px; color:#374151; }
      [data-theme="dark"] .universal-capture-bar button { background:#111827; color:#e5e7eb; border-color:#374151; }
      [data-theme="dark"] .universal-capture-bar button:hover { background:#1f2937; }
      [data-theme="dark"] .universal-capture-box { background:#111827; color:#f9fafb; }
      [data-theme="dark"] .universal-capture-box p, [data-theme="dark"] .universal-capture-status { color:#d1d5db; }
      [data-theme="dark"] .universal-capture-input { background:#030712; color:#f9fafb; border-color:#374151; }
    `;
    document.head.appendChild(style);
  }

  function injectControls() {
    if (document.getElementById('universal-capture-bar')) return;
    const list = document.getElementById('annotations-list');
    if (!list || !list.parentElement) return;

    const bar = document.createElement('div');
    bar.id = 'universal-capture-bar';
    bar.className = 'universal-capture-bar';
    bar.innerHTML = `
      <button id="universal-import-btn" title="Import prompt-only captures from other apps">＋ Import App Captures</button>
      <button id="universal-copy-btn" title="Copy imported app captures as Markdown">Copy App Prompts</button>
    `;
    list.parentElement.insertBefore(bar, list);
    document.getElementById('universal-import-btn').addEventListener('click', showUniversalModal);
    document.getElementById('universal-copy-btn').addEventListener('click', copyUniversalCaptures);
  }

  document.addEventListener('DOMContentLoaded', () => {
    injectStyles();
    injectControls();
  });
})();
