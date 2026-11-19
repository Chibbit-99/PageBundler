const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

/* ------------------------------------------------------------------ ZIP ---- */

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

/* -------------------------------------------------------------- Filenames -- */

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

/* ------------------------------------------------------------- URL helpers - */

// Query parameters that never change which bytes a URL serves.
const CACHE_BUSTER_PARAM = /^(?:_+|cb|cache_?bust|cache_?breaker|timestamp|_?ts|utm_.+|fbclid|gclid)$/i;

// The exact URL we request and later rewrite in the captured page. Only the
// fragment is dropped, so signed/CDN URLs keep the query string they came with.
function canonicalAssetUrl(value, base) {
  const url = new URL(value, base);
  url.hash = '';
  return url.href;
}
// Identity used to notice that two references point at the same asset: query
// order and cache-buster values are ignored so repeated references are only
// downloaded and stored once.
function resourceKey(url) {
  const parsed = new URL(url);
  const params = [...parsed.searchParams.entries()]
    .filter(([name]) => !CACHE_BUSTER_PARAM.test(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const search = new URLSearchParams(params).toString();
  return parsed.origin + parsed.pathname + (search ? `?${search}` : '');
}
const withoutQuery = url => url.split(/[?#]/)[0];
const isInlineReference = value => !value || /^(?:data:|blob:|about:|javascript:|#)/i.test(value);

function assetKind(type, url) {
  if (/^text\/css/i.test(type) || /\.css(?:[?#]|$)/i.test(url)) return 'css';
  if (/image\/svg\+xml/i.test(type) || /\.svg(?:[?#]|$)/i.test(url)) return 'svg';
  if (/manifest\+json/i.test(type) || /(?:manifest|site)(?:\.webmanifest|\.json)(?:[?#]|$)/i.test(url)) return 'manifest';
  if (/javascript|ecmascript/i.test(type) || /\.m?js(?:[?#]|$)/i.test(url)) return 'js';
  if (/^font\//i.test(type) || /\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i.test(url)) return 'font';
  return 'asset';
}

/* -------------------------------------------------- Reference collection --- */

const CSS_REFERENCE = /url\(\s*(["']?)([^"')]+)\1\s*\)|@import\s+(?:url\(\s*)?(["'])([^"']+)\3/gi;

function collectCssReferences(css) {
  const references = [];
  for (const match of css.matchAll(CSS_REFERENCE)) {
    const raw = match[2] || match[4];
    if (!isInlineReference(raw)) references.push(raw);
  }
  return references;
}
function collectSvgReferences(svg) {
  const references = collectCssReferences(svg);
  for (const match of svg.matchAll(/(?:xlink:href|href)\s*=\s*["']([^"']+)["']/gi)) {
    if (!isInlineReference(match[1])) references.push(match[1]);
  }
  return references;
}
function collectJsReferences(js) {
  const patterns = [
    // import/export ... from "x", bare side-effect imports, dynamic import()
    /\b(?:import|export)\s*(?:[^'"();\n]*?\bfrom\s*)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bnew\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
    // Worker scripts are loaded at runtime and are part of the page's behaviour.
    /\bimportScripts\(\s*["']([^"']+)["']\s*\)/g,
    /\bnew\s+(?:Shared)?Worker\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const references = [];
  for (const pattern of patterns) {
    for (const match of js.matchAll(pattern)) {
      // Only local or absolute URLs; bare specifiers are resolved by a bundler.
      if (/^(?:\.{1,2}\/|\/|https?:\/\/)/i.test(match[1])) references.push(match[1]);
    }
  }
  return references;
}

/* ------------------------------------------------------------ Rewriting ---- */

function localAssetUrl(raw, baseUrl, localPaths, prefix) {
  let resolved;
  try { resolved = canonicalAssetUrl(raw, baseUrl); } catch (_) { return raw; }
  const local = localPaths.get(resolved);
  return local ? prefix + local.split('/').pop() : raw;
}
function rewriteCss(css, stylesheetUrl, localPaths) {
  return css.replace(CSS_REFERENCE, (whole, quote, raw, importQuote, importRaw) => {
    if (raw) return `url(${quote}${localAssetUrl(raw, stylesheetUrl, localPaths, './')}${quote})`;
    return whole.replace(importRaw, localAssetUrl(importRaw, stylesheetUrl, localPaths, './'));
  });
}
function rewriteSvg(svg, svgUrl, localPaths) {
  return rewriteCss(svg, svgUrl, localPaths).replace(/((?:xlink:)?href\s*=\s*["'])([^"']+)(["'])/gi,
    (whole, before, raw, after) => (raw.startsWith('#') ? whole : `${before}${localAssetUrl(raw, svgUrl, localPaths, './')}${after}`));
}
function rewriteJs(js, scriptUrl, localPaths) {
  return js.replace(/(["'])((?:\.{1,2}\/|\/)?[^"'\s]+\.(?:m?js|css|woff2?|ttf|otf|png|jpe?g|svg|webp|avif|gif|ico|json)(?:[?#][^"']*)?)\1/gi,
    (whole, quote, raw) => `${quote}${localAssetUrl(raw, scriptUrl, localPaths, './')}${quote}`);
}
function rewriteManifest(json, manifestUrl, localPaths) {
  let manifest;
  try { manifest = JSON.parse(json); } catch (_) { return json; }
  const icons = [...(manifest.icons || []), ...(manifest.shortcuts || []).flatMap(item => item.icons || [])];
  for (const icon of icons) if (icon && icon.src) icon.src = localAssetUrl(icon.src, manifestUrl, localPaths, './');
  return JSON.stringify(manifest, null, 2);
}

// Rewrites absolute URLs in the captured markup in a single scan: every URL-like
// token is looked up whole, so `a.css` is never rewritten inside `a.css?v=2`.
// Attribute values are escaped by the serializer (`&` -> `&amp;`), so both
// spellings are mapped; a fragment is carried over to the local path.
function rewriteHtml(html, localPaths) {
  if (!localPaths.size) return html;
  const replacements = new Map();
  for (const [url, path] of localPaths) {
    replacements.set(url, path);
    if (url.includes('&')) replacements.set(url.replace(/&/g, '&amp;'), path);
  }
  return html.replace(/https?:\/\/[^\s"'<>()]+/g, match => {
    const direct = replacements.get(match);
    if (direct) return direct;
    const fragment = match.indexOf('#');
    if (fragment > 0) {
      const base = replacements.get(match.slice(0, fragment));
      if (base) return base + match.slice(fragment);
    }
    return match;
  });
}

/* --------------------------------------------------------------- Hashing --- */

async function contentDigest(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Stores byte-identical assets once. Assets whose contents embed relative URLs
 * (CSS, JS, SVG, manifests) are only merged with an exact copy of the same URL,
 * because their references resolve against their own location.
 */
async function dedupeFiles(files, paths) {
  const keeperByDigest = new Map(), duplicates = new Map();
  for (const file of files) {
    const bytes = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
    if (!(bytes instanceof Uint8Array) || !bytes.length) continue;
    const scope = file.kind === 'asset' || file.kind === 'font' ? '*' : withoutQuery(file.url);
    const key = `${scope}|${bytes.length}|${await contentDigest(bytes)}`;
    const keeper = keeperByDigest.get(key);
    if (keeper) duplicates.set(file.name, keeper);
    else keeperByDigest.set(key, file.name);
  }
  for (const [url, path] of [...paths]) {
    const survivor = duplicates.get(path);
    if (survivor) paths.set(url, survivor);
  }
  for (let i = files.length - 1; i >= 0; i--) if (duplicates.has(files[i].name)) files.splice(i, 1);
  return duplicates.size;
}

/* -------------------------------------------------------------- Progress --- */

const progressPorts = new Set();
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'pagebundler-progress') return;
  progressPorts.add(port);
  port.onDisconnect.addListener(() => progressPorts.delete(port));
});
function reportProgress(percent, label, indeterminate = false, tabId = null, error = false) {
  const message = { type: 'bundle-progress', percent, label, indeterminate, error };
  if (tabId != null) { try { chrome.tabs.sendMessage(tabId, message).catch(() => {}); } catch (_) {} }
  for (const port of [...progressPorts]) {
    try { port.postMessage(message); } catch (_) { progressPorts.delete(port); }
  }
}

/* --------------------------------------------------------------- Bundling -- */

class SkippedAsset extends Error {}

async function bundle(data, tabId = null) {
  const used = new Set(['index.html']);
  const tasks = [];                 // planned downloads, in discovery order
  const taskByUrl = new Map();
  const taskByKey = new Map();      // resourceKey -> task, collapses repeated references
  const aliases = new Map();        // URL that duplicates another -> canonical URL
  const paths = new Map();          // URL -> local file name
  const files = [];
  const failed = new Set();         // could not be fetched
  const skipped = new Set();        // deliberately not stored (unused, empty, HTML document)
  const referenced = new Set();     // the page's own markup points here
  const fromContent = new Set();    // a stylesheet, script, SVG or manifest points here
  const workerCount = 8;

  const resolve = value => { try { return canonicalAssetUrl(value); } catch (_) { return null; } };

  function plan(value) {
    const url = resolve(value);
    if (!url) return null;
    const known = taskByUrl.get(url);
    if (known) return known.url;
    const key = resourceKey(url);
    const duplicate = taskByKey.get(key);
    if (duplicate) { aliases.set(url, duplicate.url); return duplicate.url; }
    const task = { url, pageReferenced: false, queued: false };
    taskByUrl.set(url, task);
    taskByKey.set(key, task);
    tasks.push(task);
    return url;
  }

  // Download order: everything the markup points at, then hinted code/fonts
  // (which can pull in more assets), and finally hinted images/media, which are
  // only downloaded if something still references them by then.
  const looksRuntimeLoadable = url => /\.(?:m?js|css|woff2?|ttf|otf|eot)(?:[?#]|$)/i.test(url);
  const queues = [[], [], []];
  const cursors = [0, 0, 0];
  let active = 0;
  let parsing = 0;   // markup/content tasks that may still discover more assets
  let waiters = [];
  const wake = () => { const pending = waiters; waiters = []; for (const waiter of pending) waiter(); };
  const waitForWork = () => new Promise(resolveWait => waiters.push(resolveWait));
  function enqueue(url, deferred) {
    const task = taskByUrl.get(url);
    if (!task || task.queued) return;
    task.queued = true;
    const queue = !deferred ? 0 : looksRuntimeLoadable(url) ? 1 : 2;
    if (queue < 2) parsing++;
    queues[queue].push(task);
    wake();
  }
  function nextTask() {
    for (let queue = 0; queue < queues.length; queue++) {
      // Speculative images are judged only once every stylesheet, script and
      // font has been parsed and stored.
      if (queue === 2 && parsing > 0) return null;
      if (cursors[queue] < queues[queue].length) return { task: queues[queue][cursors[queue]++], speculative: queue === 2 };
    }
    return null;
  }

  reportProgress(5, 'Discovering and bundling page assets…', true, tabId);

  const pageReferenced = Array.isArray(data.referenced) ? data.referenced : (data.resources || []);
  for (const value of pageReferenced) {
    const url = plan(value);
    if (!url) continue;
    referenced.add(url);
    taskByUrl.get(url).pageReferenced = true;
  }
  for (const value of data.resources || []) plan(value);
  for (const task of tasks) enqueue(task.url, !task.pageReferenced);

  function requireContent(value, base) {
    let url;
    try { url = base == null ? value : new URL(value, base).href; } catch (_) { return; }
    if (isInlineReference(url)) return;
    const planned = plan(url);
    if (!planned) return;
    fromContent.add(planned);
    enqueue(planned, false);
  }

  let completed = 0, lastReportAt = 0;

  async function processTask(task) {
    const url = task.url;
    const path = uniquePath(url, used);
    paths.set(url, path);
    try {
      const response = await fetch(url, { credentials: 'include', redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const type = response.headers.get('content-type') || '';
      // A sub-document cannot be reproduced offline, so never store one.
      if (/^text\/html/i.test(type)) throw new SkippedAsset('HTML sub-document');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length) throw new SkippedAsset('Empty asset');
      if (bytes.length > MAX_ASSET_BYTES) throw new Error('Asset exceeds 25 MB limit');
      const kind = assetKind(type, url);
      let text;
      if (kind === 'css') {
        text = decoder.decode(bytes);
        for (const raw of collectCssReferences(text)) requireContent(raw, url);
        files.push({ name: path, url, kind, data: text });
      } else if (kind === 'svg') {
        text = decoder.decode(bytes);
        for (const raw of collectSvgReferences(text)) requireContent(raw, url);
        files.push({ name: path, url, kind, data: text });
      } else if (kind === 'manifest') {
        text = decoder.decode(bytes);
        try {
          const manifest = JSON.parse(text);
          const icons = [...(manifest.icons || []), ...(manifest.shortcuts || []).flatMap(item => item.icons || [])];
          for (const icon of icons) if (icon && icon.src) requireContent(icon.src, url);
        } catch (_) {}
        files.push({ name: path, url, kind, data: text });
      } else if (kind === 'js') {
        text = decoder.decode(bytes);
        for (const raw of collectJsReferences(text)) requireContent(raw, url);
        files.push({ name: path, url, kind, data: text });
      } else files.push({ name: path, url, kind, data: bytes });
    } catch (error) {
      // Leave the original URL in place instead of pointing at a missing file.
      paths.delete(url);
      if (error instanceof SkippedAsset) skipped.add(url); else failed.add(url);
    }
    completed++;
  }

  async function worker() {
    for (;;) {
      const next = nextTask();
      if (!next) {
        if (active === 0) return;
        await waitForWork();
        continue;
      }
      const { task, speculative } = next;
      // Speculative hints are only fetched once every markup/content reference
      // has been parsed, so anything still unreferenced here is not needed by
      // the page (analytics pixels, prefetches, dead DOM nodes). Code and fonts
      // are kept because scripts can load them later.
      if (speculative && !referenced.has(task.url) && !fromContent.has(task.url) && !looksRuntimeLoadable(task.url)) {
        skipped.add(task.url);
        completed++;
        continue;
      }
      active++;
      try { await processTask(task); } finally {
        active--;
        if (!speculative) parsing--;
        wake();
        const now = Date.now();
        if (now - lastReportAt >= 250) {
          lastReportAt = now;
          reportProgress(5, `Processing assets… ${completed} processed · ${tasks.length} discovered`, true, tabId);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // Drop speculative loads: analytics beacons, prefetches, assets requested by
  // DOM nodes that no longer exist. Code, styles and fonts are kept even when
  // only the Resource Timing API saw them, because scripts can load them later.
  const runtimeLoadable = new Set(['js', 'css', 'svg', 'manifest', 'font']);
  for (let i = files.length - 1; i >= 0; i--) {
    const file = files[i];
    if (runtimeLoadable.has(file.kind)) continue;
    if (referenced.has(file.url) || fromContent.has(file.url)) continue;
    skipped.add(file.url);
    paths.delete(file.url);
    files.splice(i, 1);
  }

  const duplicates = await dedupeFiles(files, paths);

  const localPaths = new Map(paths);
  for (const [aliasUrl, url] of aliases) {
    const path = paths.get(url);
    if (path) localPaths.set(aliasUrl, path);
  }

  for (const file of files) {
    if (file.kind === 'css') file.data = rewriteCss(file.data, file.url, localPaths);
    else if (file.kind === 'js') file.data = rewriteJs(file.data, file.url, localPaths);
    else if (file.kind === 'svg') file.data = rewriteSvg(file.data, file.url, localPaths);
    else if (file.kind === 'manifest') file.data = rewriteManifest(file.data, file.url, localPaths);
  }

  let html = rewriteHtml(data.html || '', localPaths);
  html = html.replace(/<base\b[^>]*>/gi, '');
  files.unshift(
    { name: 'index.html', data: html },
    { name: 'README.txt', data: 'Offline viewing\n\nSome browsers block scripts, fonts, and other resources when an HTML file is opened directly with file://. The assets are included in this archive; serve this folder over localhost instead.\n\n1. Extract the ZIP.\n2. Open a terminal in the extracted folder (the folder containing index.html).\n3. Run: python3 -m http.server 8000\n4. Open http://localhost:8000 in your browser.\n\nOn Windows, use: py -m http.server 8000\nStop the server with Ctrl+C.\n' }
  );

  reportProgress(88, `Assets processed (${completed}) · creating ZIP with ${files.length} files…`, false, tabId);
  const blob = zipStore(files), base64 = await blobToBase64(blob);
  const filename = `${(data.title || 'page').replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 70) || 'page'}.zip`;
  const downloadUrl = `data:application/zip;base64,${base64}`;
  reportProgress(96, 'Starting ZIP download…', false, tabId);
  await chrome.downloads.download({ url: downloadUrl, filename, saveAs: true });
  reportProgress(100, 'ZIP ready', false, tabId);
  return { ok: true, fileCount: files.length, failed: failed.size, skipped: skipped.size, duplicates };
}

function blobToBase64(blob) {
  return blob.arrayBuffer().then(buffer => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  });
}

/* -------------------------------------------------------------- Capture ---- */

// Injected into the page: serializes the rendered DOM and reports which
// resources the markup points at (referenced) versus resources that were merely
// requested while the page ran (resources minus referenced).
function captureForContextMenu() {
  // This function is serialized into the page, so it must not use helpers from
  // this file's scope.
  const base = document.baseURI;
  const CSS_REFERENCE = /url\(\s*(["']?)([^"')]+)\1\s*\)|@import\s+(?:url\(\s*)?(["'])([^"']+)\3/gi;
  const isInlineReference = value => !value || /^(?:data:|blob:|about:|javascript:|#)/i.test(value);
  const referenced = new Set();
  const hints = new Set();
  const normalize = value => {
    try {
      const url = new URL(value, base);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      url.hash = '';
      return url.href;
    } catch (_) { return null; }
  };
  const add = (value, into = referenced) => {
    if (isInlineReference(value)) return null;
    const href = normalize(value);
    if (href) into.add(href);
    return href;
  };
  const addHint = value => {
    if (isInlineReference(value)) return;
    const href = normalize(value);
    if (href && !referenced.has(href)) hints.add(href);
  };
  const addSrcset = (value, into) => {
    for (const candidate of value.split(',')) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url) add(url, into);
    }
  };
  const addCss = (css, into) => {
    for (const match of css.matchAll(CSS_REFERENCE)) {
      const raw = match[2] || match[4];
      if (!isInlineReference(raw)) add(raw, into);
    }
  };

  const collected = '[src],[href],[poster],[srcset],[imagesrcset],[style],[data]';
  for (const el of document.querySelectorAll(collected)) {
    const name = el.localName;
    for (const attr of ['src', 'poster']) if (el.hasAttribute(attr)) add(el.getAttribute(attr));
    if (el.hasAttribute('data') && (name === 'object' || name === 'embed')) add(el.getAttribute('data'));
    // Only links that the page needs in order to render. Navigation hints
    // (prefetch, prerender, preconnect, alternate, canonical) are ignored.
    if (el.hasAttribute('href')) {
      const rel = (el.getAttribute('rel') || '').toLowerCase();
      const isStylesheetOrAsset = name === 'link'
        && /(?:^|\s)(?:stylesheet|icon|apple-touch-icon|manifest|preload|modulepreload)(?:\s|$)/.test(rel);
      if (isStylesheetOrAsset || el.namespaceURI === 'http://www.w3.org/2000/svg') add(el.getAttribute('href'));
    }
    for (const attr of ['srcset', 'imagesrcset']) if (el.hasAttribute(attr)) addSrcset(el.getAttribute(attr));
    if (el.hasAttribute('style')) addCss(el.getAttribute('style'));
  }
  for (const style of document.querySelectorAll('style')) addCss(style.textContent);

  // Resources the page requested while running: lazy-loaded chunks, fonts added
  // by scripts, and also beacons/tracking pixels that no markup points at. The
  // bundler keeps the former and drops the latter.
  for (const entry of performance.getEntriesByType('resource')) {
    if (/^(?:beacon|ping)$/i.test(entry.initiatorType || '')) continue;
    if (!/\.(?:m?js|css|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|avif|ico|mp4|webm|mp3|ogg|m4a|vtt)(?:$|[?#])/i.test(entry.name)) continue;
    addHint(entry.name);
  }

  const snapshot = document.documentElement.cloneNode(true);
  // The on-page progress widget lives in the DOM while bundling; it is not part
  // of the page being saved.
  for (const el of snapshot.querySelectorAll('[id^="pagebundler"]')) el.remove();
  const absolute = value => { try { return new URL(value, base).href; } catch (_) { return value; } };
  const absolutizeCss = value => value.replace(CSS_REFERENCE, (whole, quote, raw, importQuote, importRaw) => {
    if (raw) return `url(${quote}${absolute(raw)}${quote})`;
    return whole.replace(importRaw, absolute(importRaw));
  });
  const absolutize = (value, attr) => {
    if (attr === 'style') return absolutizeCss(value);
    if (attr === 'srcset' || attr === 'imagesrcset') {
      return value.split(',').map(candidate => {
        const parts = candidate.trim().split(/\s+/);
        parts[0] = absolute(parts[0]);
        return parts.join(' ');
      }).join(', ');
    }
    if (value.startsWith('#')) return value;
    return absolute(value);
  };
  for (const el of snapshot.querySelectorAll('[src],[href],[poster],[srcset],[imagesrcset],[style],[data]')) {
    for (const attr of ['src', 'href', 'poster', 'srcset', 'imagesrcset', 'style', 'data']) {
      if (el.hasAttribute(attr)) el.setAttribute(attr, absolutize(el.getAttribute(attr), attr));
    }
  }
  for (const style of snapshot.querySelectorAll('style')) style.textContent = absolutizeCss(style.textContent);

  const html = '<!doctype html>\n' + snapshot.outerHTML;
  return { html, title: document.title || 'page', pageUrl: location.href, referenced: [...referenced], resources: [...referenced, ...hints] };
}

/* --------------------------------------------------------- Chrome wiring ---- */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'pagebundler-save', title: 'Save page as ZIP with PageBundler', contexts: ['page'] });
});

async function captureAndBundle(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !/^https?:/.test(tab.url || '')) throw new Error('This page cannot be captured. Open a regular website and try again.');
  reportProgress(3, 'Capturing page…', true, tabId);
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: captureForContextMenu });
  if (!result?.result) throw new Error('Could not read this page. Try refreshing it and retrying.');
  return bundle(result.result, tabId);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'capture-and-bundle') return;
  const tabId = message.tabId ?? sender.tab?.id;
  captureAndBundle(tabId)
    .then(sendResponse)
    .catch(error => sendResponse({ ok: false, error: error.message || 'Could not save this page.' }));
  return true;
});

chrome.action.onClicked.addListener(tab => {
  if (!tab?.id) return;
  captureAndBundle(tab.id).catch(error => {
    console.error('PageBundler action failed:', error);
    reportProgress(0, error.message || 'Could not save this page.', false, tab.id, true);
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'pagebundler-save' || !tab?.id) return;
  captureAndBundle(tab.id).catch(error => {
    console.error('PageBundler context-menu capture failed:', error);
    reportProgress(0, error.message || 'Could not save this page.', false, tab.id, true);
  });
});
