const button = document.getElementById('save');
const statusBox = document.getElementById('status');
const details = document.getElementById('details');
const progressWrap = document.getElementById('progress-wrap');
const progressBar = document.getElementById('progress-bar');
const progressLabel = document.getElementById('progress-label');

chrome.runtime.onMessage.addListener(message => {
  if (message?.type !== 'bundle-progress') return;
  progressWrap.hidden = false;
  progressBar.style.width = `${Math.max(0, Math.min(100, message.percent || 0))}%`;
  progressLabel.textContent = message.label || 'Working…';
});

function capturePage() {
  const base = document.baseURI;
  const resources = new Set();
  const add = value => {
    if (!value || value.startsWith('data:') || value.startsWith('blob:') || value.startsWith('javascript:') || value.startsWith('#')) return;
    try { const url = new URL(value, base); if (url.protocol === 'http:' || url.protocol === 'https:') resources.add(url.href); } catch (_) {}
  };
  for (const el of document.querySelectorAll('[src], [href], [poster], [srcset], [style]')) {
    for (const attr of ['src', 'href', 'poster']) if (el.hasAttribute(attr)) add(el.getAttribute(attr));
    if (el.hasAttribute('srcset')) for (const entry of el.getAttribute('srcset').split(',')) add(entry.trim().split(/\s+/)[0]);
    if (el.hasAttribute('style')) for (const match of el.getAttribute('style').matchAll(/url\(["']?([^"')]+)["']?\)/gi)) add(match[1]);
  }
  for (const style of document.querySelectorAll('style')) for (const match of style.textContent.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) add(match[1]);
  const snapshot = document.documentElement.cloneNode(true);
  for (const el of snapshot.querySelectorAll('[src], [href], [poster], [srcset], [style]')) {
    for (const attr of ['src', 'href', 'poster']) if (el.hasAttribute(attr)) {
      try { el.setAttribute(attr, new URL(el.getAttribute(attr), base).href); } catch (_) {}
    }
    for (const attr of ['srcset', 'style']) if (el.hasAttribute(attr)) {
      const value = el.getAttribute(attr).replace(/url\\((["']?)([^"')]+)\\1\\)/gi, (all, quote, raw) => {
        try { return `url(${quote}${new URL(raw, base).href}${quote})`; } catch (_) { return all; }
      });
      if (attr === 'srcset') el.setAttribute(attr, value.split(',').map(item => { const parts = item.trim().split(/\\s+/); try { parts[0] = new URL(parts[0], base).href; } catch (_) {} return parts.join(' '); }).join(', '));
      else el.setAttribute(attr, value);
    }
  }
  for (const style of snapshot.querySelectorAll('style')) style.textContent = style.textContent.replace(/url\\((["']?)([^"')]+)\\1\\)/gi, (all, quote, raw) => { try { return `url(${quote}${new URL(raw, base).href}${quote})`; } catch (_) { return all; } });
  const html = '<!doctype html>\n' + snapshot.outerHTML;
  return { html, title: document.title || 'page', pageUrl: location.href, resources: [...resources] };
}

button.addEventListener('click', async () => {
  button.disabled = true; statusBox.className = ''; statusBox.textContent = 'Capturing page and bundling files…'; details.hidden = true;
  progressWrap.hidden = false; progressBar.style.width = '2%'; progressLabel.textContent = 'Capturing page…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('This page cannot be captured. Open a regular website and try again.');
    const [capture] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: capturePage });
    if (!capture?.result) throw new Error('Could not read this page. Try refreshing it and retrying.');
    const result = await chrome.runtime.sendMessage({ type: 'bundle-page', data: capture.result });
    if (!result?.ok) throw new Error(result?.error || 'The ZIP could not be created.');
    statusBox.className = 'success'; statusBox.textContent = 'Your page ZIP is ready.';
    details.hidden = false; details.textContent = `${result.fileCount} files included${result.failed ? ` · ${result.failed} unavailable` : ''}.`;
  } catch (error) {
    statusBox.className = 'error'; statusBox.textContent = error.message || 'Something went wrong.';
  } finally { button.disabled = false; }
});
