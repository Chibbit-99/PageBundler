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
  return decodeURIComponent(value.split('/').pop().split('?')[0] || 'asset').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-90) || 'asset';
}
function uniquePath(url, used) {
  const base = 'assets/' + safeFilename(new URL(url).pathname);
  let path = base, i = 2;
  while (used.has(path)) { const dot = base.lastIndexOf('.'); path = dot > base.indexOf('/') ? `${base.slice(0, dot)}-${i++}${base.slice(dot)}` : `${base}-${i++}`; }
  used.add(path); return path;
}
async function bundle(data) {
  const used = new Set(['index.html']), paths = new Map(), files = [], failed = new Set();
  const queue = [...new Set(data.resources || [])];
  for (let cursor = 0; cursor < queue.length && cursor < 1000; cursor++) {
    const url = queue[cursor];
    if (paths.has(url)) continue;
    const path = uniquePath(url, used); paths.set(url, path);
    try {
      const response = await fetch(url, { credentials: 'include', redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 25 * 1024 * 1024) throw new Error('Asset exceeds 25 MB limit');
      const type = response.headers.get('content-type') || '';
      if (/text\/css|\.css(?:[?#]|$)/i.test(type + ' ' + url)) {
        let css = new TextDecoder().decode(bytes);
        const refs = [...css.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)|@import\s+(?:url\()?(["'])([^"']+)\3\)?/gi)];
        for (const m of refs) {
          const raw = m[2] || m[4]; if (!raw || /^(data:|#|blob:)/i.test(raw)) continue;
          try { const absolute = new URL(raw, url).href; if (!queue.includes(absolute)) queue.push(absolute); }
          catch (_) {}
        }
        files.push({ name: path, data: css, cssUrl: url });
      } else files.push({ name: path, data: bytes });
    } catch (_) { failed.add(url); }
  }
  for (const file of files) if (file.cssUrl) file.data = rewriteCss(file.data, file.cssUrl, paths);
  let html = data.html || '';
  for (const [url, path] of paths) {
    if (failed.has(url)) continue;
    const relative = path;
    html = html.split(url).join(relative);
    try { const u = new URL(url); html = html.split(u.origin + u.pathname + u.search + u.hash).join(relative); } catch (_) {}
  }
  html = html.replace(/<base\b[^>]*>/i, '');
  files.unshift({ name: 'index.html', data: html });
  const blob = zipStore(files), base64 = await blobToBase64(blob);
  const filename = `${(data.title || 'page').replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 70) || 'page'}.zip`;
  const downloadUrl = `data:application/zip;base64,${base64}`;
  await chrome.downloads.download({ url: downloadUrl, filename, saveAs: true });
  return { ok: true, fileCount: files.length, failed: failed.size };
}
function rewriteCss(css, stylesheetUrl, paths) {
  const replacements = [];
  for (const [url, path] of paths) {
    try { if (new URL(url).href) replacements.push([url, '../' + path]); } catch (_) {}
  }
  for (const [url, path] of replacements) css = css.split(url).join(path);
  return css;
}
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob);
  });
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'bundle-page') { bundle(message.data).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message })); return true; }
});

function captureForContextMenu() {
  const resources = new Set(), base = document.baseURI;
  const add = value => {
    if (!value || /^(data:|blob:|javascript:|#)/i.test(value)) return;
    try { const u = new URL(value, base); if (/^https?:$/.test(u.protocol)) resources.add(u.href); } catch (_) {}
  };
  for (const el of document.querySelectorAll('[src],[href],[poster],[srcset],[style]')) {
    for (const attr of ['src', 'href', 'poster']) if (el.hasAttribute(attr)) add(el.getAttribute(attr));
    if (el.hasAttribute('srcset')) for (const item of el.getAttribute('srcset').split(',')) add(item.trim().split(/\s+/)[0]);
    if (el.hasAttribute('style')) for (const m of el.getAttribute('style').matchAll(/url\(["']?([^"')]+)["']?\)/gi)) add(m[1]);
  }
  for (const style of document.querySelectorAll('style')) for (const m of style.textContent.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) add(m[1]);
  const snapshot = document.documentElement.cloneNode(true);
  for (const el of snapshot.querySelectorAll('[src],[href],[poster],[srcset]')) for (const attr of ['src', 'href', 'poster', 'srcset']) {
    if (!el.hasAttribute(attr)) continue;
    if (attr === 'srcset') el.setAttribute(attr, el.getAttribute(attr).split(',').map(item => { const p = item.trim().split(/\s+/); try { p[0] = new URL(p[0], base).href; } catch (_) {} return p.join(' '); }).join(', '));
    else try { el.setAttribute(attr, new URL(el.getAttribute(attr), base).href); } catch (_) {}
  }
  const html = '<!doctype html>\n' + snapshot.outerHTML;
  return { html, title: document.title || 'page', pageUrl: location.href, resources: [...resources] };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'pagebundler-save', title: 'Save page as ZIP with PageBundler', contexts: ['page'] });
});
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'pagebundler-save' || !tab?.id || !/^https?:/.test(tab.url || '')) return;
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: captureForContextMenu });
    if (result?.result) await bundle(result.result);
  } catch (error) {
    console.error('PageBundler context-menu capture failed:', error);
  }
});
