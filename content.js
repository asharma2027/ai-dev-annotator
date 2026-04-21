// content.js
// Injected into every page. Listens for Alt + Right-Click to capture an annotation.

/**
 * Builds a precise XPath string for a given DOM element.
 * FIX: Gemini's version was missing `(ix + 1) + ']'` in the return statement,
 * producing incomplete/broken XPaths for all non-id elements.
 */
function getXPath(element) {
  if (!element || element.nodeType !== 1) return '';
  if (element.id !== '') return `id("${element.id}")`;
  if (element === document.body) return element.tagName.toLowerCase();

  let ix = 0;
  const siblings = element.parentNode ? element.parentNode.childNodes : [];
  for (let i = 0; i < siblings.length; i++) {
    const sibling = siblings[i];
    if (sibling === element) {
      // FIX: Was returning an incomplete string — `'['` with no closing `(ix+1)+']'`
      return getXPath(element.parentNode) + '/' + element.tagName.toLowerCase() + '[' + (ix + 1) + ']';
    }
    if (sibling.nodeType === 1 && sibling.tagName === element.tagName) ix++;
  }
  // Fallback (should never hit this)
  return element.tagName.toLowerCase();
}

// Listen for contextmenu (Right-Click) events
document.addEventListener('contextmenu', function (event) {
  // Only trigger when Alt (Option on Mac) is held
  if (!event.altKey) return;

  event.preventDefault(); // Suppress the browser's native context menu

  const target = event.target;

  // Prompt the user for their annotation
  const comment = prompt('AI Dev Annotator\n\nWhat should the AI change or improve here?');

  if (!comment || comment.trim() === '') return;

  // FIX: Use split(/\s+/) instead of split(' ') to handle multiple/irregular spaces in class names
  const classes =
    target.className && typeof target.className === 'string' && target.className.trim() !== ''
      ? '.' + target.className.trim().split(/\s+/).join('.')
      : 'N/A';

  const elementData = {
    url: window.location.href,
    tag: target.tagName.toLowerCase(),
    id: target.id ? `#${target.id}` : 'N/A',
    classes: classes,
    xpath: getXPath(target),
    comment: comment.trim(),
    timestamp: new Date().toLocaleString(),
  };

  // Append to saved annotations in chrome.storage.local
  chrome.storage.local.get({ annotations: [] }, function (result) {
    const updated = result.annotations;
    updated.push(elementData);
    chrome.storage.local.set({ annotations: updated }, function () {
      console.log('[AI Dev Annotator] Annotation saved:', elementData);
    });
  });
});
