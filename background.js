const encoder = new TextEncoder();

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) { crc ^= byte; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ -1) >>> 0;
}
function dosDateTime(date = new Date()) {
  return { time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1), date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate() };
}
function zipStore(files) {
  const locals = [], central = []; let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name), bytes = file.data instanceof Uint8Array ? file.data : encoder.encode(file.data);
    const crc = crc32(bytes), { time, date } = dosDateTime();
    const local = new Uint8Array(30 + name.length + bytes.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true); lv.setUint16(12, date, true); lv.setUint32(14, crc, true); lv.setUint32(18, bytes.length, true); lv.setUint32(22, bytes.length, true); lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
    local.set(name, 30); local.set(bytes, 30 + name.length); locals.push(local);
    const c = new Uint8Array(46 + name.length), cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true); cv.setUint16(14, date, true); cv.setUint32(16, crc, true); cv.setUint32(20, bytes.length, true); cv.setUint32(24, bytes.length, true); cv.setUint16(28, name.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true); cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true); cv.setUint32(42, offset, true); c.set(name, 46); central.push(c);
    offset += local.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0), end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  return new Blob([...locals, ...central, end], { type: 'application/zip' });
}
function safeFilename(value) {
  const segment = value.split('/').pop().split('?')[0] || 'asset';
  let decoded = segment;
  try { decoded = decodeURIComponent(segment); } catch (_) { decoded = segment; }
  return decoded.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-90) || 'asset';
}
function uniquePath(url, used) {
  const base = 'assets/' + safeFilename(new URL(url).pathname);
  let path = base, i = 2;
  while (used.has(path)) { const dot = base.lastIndexOf('.'); path = dot > base.indexOf('/') ? `${base.slice(0, dot)}-${i++}${base.slice(dot)}` : `${base}-${i++}`; }
  used.add(path); return path;
}
function canonicalAssetUrl(value, base) {
  const url = new URL(value, base);
  url.hash = '';
  // Normalize query ordering and remove common tracking/cache-buster parameters so
  // repeated references to the same static asset are enqueued only once.
  url.searchParams.sort();
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:_+|cb|cache_?bust|cache_?breaker|timestamp|_?ts|utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  }
  return url.href;
}
function reportProgress(percent, label, indeterminate = false, tabId = null, error = false) {
  const message = { type: 'bundle-progress', percent, label, indeterminate, error };
  const delivery = tabId == null ? chrome.runtime.sendMessage(message) : chrome.tabs.sendMessage(tabId, message);
  delivery.catch(() => {});
}
async function bundle(data, tabId = null) {
  const used = new Set(['index.html']), paths = new Map(), files = [], failed = new Set();
  const workerCount = 8;
  const initialResources = [...new Set((data.resources || []).map(value => {
    try { return canonicalAssetUrl(value); } catch (_) { return null; }
  }).filter(Boolean))];
  const queue = initialResources;
  const scheduled = new Set(queue);
  reportProgress(5, 'Discovering and bundling page assets…', true, tabId);
  let cursor = 0, completed = 0, lastProgressAt = 0;
  const enqueue = url => {
    try { url = canonicalAssetUrl(url); } catch (_) { return; }
    if (scheduled.has(url)) return;
    scheduled.add(url); queue.push(url);
  };
  async function processNext() {
    while (cursor < queue.length) {
      const index = cursor++, url = queue[index];
      if (paths.has(url)) { completed++; continue; }
      const path = uniquePath(url, used); paths.set(url, path);
      try {
        const response = await fetch(url, { credentials: 'include', redirect: 'follow' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 25 * 1024 * 1024) throw new Error('Asset exceeds 25 MB limit');
        const type = response.headers.get('content-type') || '';
        if (/text\/css|\.css(?:[?#]|$)/i.test(type + ' ' + url)) {
          const css = new TextDecoder().decode(bytes);
          for (const match of css.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)|@import\s+(?:url\()?(["'])([^"']+)\3\)?/gi)) {
            const raw = match[2] || match[4]; if (!raw || /^(data:|#|blob:)/i.test(raw)) continue;
            try { enqueue(new URL(raw, url).href); } catch (_) {}
          }
          files.push({ name: path, data: css, cssUrl: url });
        } else if (/image\/svg\+xml/i.test(type) || /\.svg(?:[?#]|$)/i.test(url)) {
          const svg = new TextDecoder().decode(bytes);
          const refs = [...svg.matchAll(/(?:href|xlink:href)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^"')]+)["']?\s*\)/gi)];
          for (const match of refs) {
            const raw = match[1] || match[2]; if (!raw || /^(data:|#|blob:)/i.test(raw)) continue;
            try { enqueue(new URL(raw, url).href); } catch (_) {}
          }
          files.push({ name: path, data: svg, svgUrl: url });
        } else if (/manifest\+json/i.test(type) || /(?:manifest|site)(?:\.webmanifest|\.json)(?:[?#]|$)/i.test(url)) {
          const manifest = JSON.parse(new TextDecoder().decode(bytes));
          const icons = [...(manifest.icons || []), ...(manifest.shortcuts || []).flatMap(item => item.icons || [])];
          for (const icon of icons) if (icon.src) try { enqueue(new URL(icon.src, url).href); } catch (_) {}
          files.push({ name: path, data: JSON.stringify(manifest, null, 2), manifestUrl: url });
        } else if (/javascript|ecmascript/i.test(type) || /\\.m?js(?:[?#]|$)/i.test(url)) {
          const js = new TextDecoder().decode(bytes);
          const staticImportPattern = /\b(?:import|export)\s*(?:[^'"();\n]*?\bfrom\s*)?["']([^"']+)["']/g;
          const dynamicImportPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
          const assetUrlPattern = /\bnew\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;
          const addJsDependency = raw => {
            if (!raw || !/^(?:\.{1,2}\/|\/|https?:\/\/)/i.test(raw)) return;
            try { enqueue(new URL(raw, url).href); } catch (_) {}
          };
          for (const match of js.matchAll(staticImportPattern)) addJsDependency(match[1]);
          for (const match of js.matchAll(dynamicImportPattern)) addJsDependency(match[1]);
          for (const match of js.matchAll(assetUrlPattern)) addJsDependency(match[1]);
          files.push({ name: path, data: js, jsUrl: url });
        } else files.push({ name: path, data: bytes });
      } catch (_) { failed.add(url); }
      completed++;
      const now = Date.now();
      if (now - lastProgressAt >= 250) {
        lastProgressAt = now;
        reportProgress(5, `Processing assets… ${completed} processed · ${queue.length} discovered`, true, tabId);
      }
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => processNext()));
  reportProgress(5, `Asset pass complete: ${completed} processed of ${queue.length} discovered${failed.size ? ` · ${failed.size} unavailable` : ''}`, true, tabId);
  reportProgress(88, `Assets processed (${completed}) · creating ZIP with ${files.length + 2} files…`, false, tabId);
  for (const file of files) {
    if (file.cssUrl) file.data = rewriteCss(file.data, file.cssUrl, paths);
    if (file.jsUrl) file.data = rewriteJs(file.data, file.jsUrl, paths);
    if (file.svgUrl) file.data = rewriteSvg(file.data, file.svgUrl, paths);
    if (file.manifestUrl) {
      const manifest = JSON.parse(file.data);
      const icons = [...(manifest.icons || []), ...(manifest.shortcuts || []).flatMap(item => item.icons || [])];
      for (const icon of icons) if (icon.src) icon.src = localAssetUrl(icon.src, file.manifestUrl, paths, './');
      file.data = JSON.stringify(manifest, null, 2);
    }
  }
  let html = data.html || '';
  for (const [url, path] of paths) {
    if (failed.has(url)) continue;
    const relative = path;
    html = html.split(url).join(relative);
    try { const u = new URL(url); html = html.split(u.origin + u.pathname + u.search + u.hash).join(relative); } catch (_) {}
  }
  html = html.replace(/<base\b[^>]*>/i, '');
  files.unshift(
    { name: 'index.html', data: html },
    { name: 'README.txt', data: 'Offline viewing\n\nSome browsers block scripts, fonts, and other resources when an HTML file is opened directly with file://. The assets are included in this archive; serve this folder over localhost instead.\n\n1. Extract the ZIP.\n2. Open a terminal in the extracted folder (the folder containing index.html).\n3. Run: python3 -m http.server 8000\n4. Open http://localhost:8000 in your browser.\n\nOn Windows, use: py -m http.server 8000\nStop the server with Ctrl+C.\n' }
  );
  const blob = zipStore(files), base64 = await blobToBase64(blob);
  const filename = `${(data.title || 'page').replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 70) || 'page'}.zip`;
  const downloadUrl = `data:application/zip;base64,${base64}`;
  reportProgress(96, 'Starting ZIP download…', false, tabId);
  await chrome.downloads.download({ url: downloadUrl, filename, saveAs: true });
  reportProgress(100, 'ZIP ready', false, tabId);
  return { ok: true, fileCount: files.length, failed: failed.size };
}
function localAssetUrl(raw, baseUrl, paths, prefix) {
  try {
    const resolved = new URL(raw, baseUrl), local = paths.get(canonicalAssetUrl(raw, baseUrl));
    return local ? prefix + local.split('/').pop() + resolved.hash : raw;
  } catch (_) { return raw; }
}
function rewriteCss(css, stylesheetUrl, paths) {
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)|(@import\s+(?:url\()?)(["'])([^"']+)\4(\)?)/gi,
    (whole, quote, raw, importStart, importQuote, importRaw, close) => {
      if (raw) return `url(${quote}${localAssetUrl(raw, stylesheetUrl, paths, './')}${quote})`;
      return `${importStart}${importQuote}${localAssetUrl(importRaw, stylesheetUrl, paths, './')}${importQuote}${close || ''}`;
    });
}
function rewriteSvg(svg, svgUrl, paths) {
  const withCss = rewriteCss(svg, svgUrl, paths);
  return withCss.replace(/((?:xlink:)?href\s*=\s*["'])([^"']+)(["'])/gi, (whole, before, raw, after) => {
    if (raw.startsWith('#')) return whole;
    return `${before}${localAssetUrl(raw, svgUrl, paths, './')}${after}`;
  });
}
function rewriteJs(js, scriptUrl, paths) {
  return js.replace(/(["'])((?:\.{1,2}\/|\/)?[^"'\s]+\.(?:m?js|css|woff2?|ttf|otf|png|jpe?g|svg|webp)(?:[?#][^"']*)?)\1/gi,
    (whole, quote, raw) => `${quote}${localAssetUrl(raw, scriptUrl, paths, './')}${quote}`);
}
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob);
  });
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'bundle-page') { bundle(message.data, _sender.tab?.id).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message })); return true; }
});

function captureForContextMenu() {
  const resources = new Set(), base = document.baseURI;
  const add = value => {
    if (!value || /^(data:|blob:|javascript:|#)/i.test(value)) return;
    try { const u = new URL(value, base); if (/^https?:$/.test(u.protocol)) resources.add(u.href); } catch (_) {}
  };
  for (const el of document.querySelectorAll('[src],[href],[poster],[srcset],[style]')) {
    for (const attr of ['src', 'poster']) if (el.hasAttribute(attr)) add(el.getAttribute(attr));
    if (el.hasAttribute('href') && ((el.localName === 'link' && /stylesheet|icon|manifest|preload|modulepreload/i.test(el.rel)) || el.namespaceURI === 'http://www.w3.org/2000/svg')) add(el.getAttribute('href'));
    if (el.hasAttribute('srcset')) for (const item of el.getAttribute('srcset').split(',')) add(item.trim().split(/\s+/)[0]);
    if (el.hasAttribute('style')) for (const m of el.getAttribute('style').matchAll(/url\(["']?([^"')]+)["']?\)/gi)) add(m[1]);
  }
  for (const style of document.querySelectorAll('style')) for (const m of style.textContent.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) add(m[1]);
  // Include static resources already requested by the page, including lazy-loaded chunks.
  for (const entry of performance.getEntriesByType('resource')) {
    try {
      const resource = new URL(entry.name);
      if (/\.(?:m?js|css|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|avif|ico|mp4|webm|mp3|ogg)(?:$|[?#])/i.test(resource.href)) add(resource.href);
    } catch (_) {}
  }
  const snapshot = document.documentElement.cloneNode(true);
  for (const el of snapshot.querySelectorAll('[src],[href],[poster],[srcset]')) for (const attr of ['src', 'href', 'poster', 'srcset']) {
    if (!el.hasAttribute(attr)) continue;
    if (attr === 'srcset') el.setAttribute(attr, el.getAttribute(attr).split(',').map(item => { const p = item.trim().split(/\s+/); try { p[0] = new URL(p[0], base).href; } catch (_) {} return p.join(' '); }).join(', '));
    else {
      const raw = el.getAttribute(attr);
      if (raw.startsWith('#')) continue;
      try { el.setAttribute(attr, new URL(raw, base).href); } catch (_) {}
    }
  }
  const absolutizeCssUrls = value => value.replace(/url\((["']?)([^"')]+)\1\)/gi, (all, quote, raw) => {
    try { return `url(${quote}${new URL(raw, base).href}${quote})`; } catch (_) { return all; }
  });
  for (const el of snapshot.querySelectorAll('[style]')) el.setAttribute('style', absolutizeCssUrls(el.getAttribute('style')));
  for (const style of snapshot.querySelectorAll('style')) style.textContent = absolutizeCssUrls(style.textContent);
  const html = '<!doctype html>\n' + snapshot.outerHTML;
  return { html, title: document.title || 'page', pageUrl: location.href, resources: [...resources] };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'pagebundler-save', title: 'Save page as ZIP with PageBundler', contexts: ['page'] });
});
chrome.action.onClicked.addListener(async tab => {
  if (!tab?.id || !/^https?:/.test(tab.url || '')) return;
  reportProgress(3, 'Capturing page…', true, tab.id);
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: captureForContextMenu });
    if (!result?.result) throw new Error('Could not capture this page.');
    await bundle(result.result, tab.id);
  } catch (error) {
    console.error('PageBundler action failed:', error);
    reportProgress(0, error.message || 'Could not save this page.', false, tab.id, true);
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'pagebundler-save' || !tab?.id || !/^https?:/.test(tab.url || '')) return;
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: captureForContextMenu });
    if (result?.result) await bundle(result.result, tab.id);
  } catch (error) {
    console.error('PageBundler context-menu capture failed:', error);
    reportProgress(0, error.message || 'Could not save this page.', false, tab.id, true);
  }
});
