// Test harness: loads background.js (an MV3 service worker) into a VM context
// with stubbed chrome/fetch APIs so bundle() can be driven from Node and the
// produced ZIP inspected.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class FakeFileReader {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(buffer => {
      this.result = `data:application/octet-stream;base64,${Buffer.from(buffer).toString('base64')}`;
      this.onload?.();
    }, error => this.onerror?.(error));
  }
}

function makeChrome(store) {
  store.listeners = {};
  const listen = name => ({ addListener(fn) { store.listeners[name] = fn; } });
  return {
    runtime: {
      onMessage: listen('message'),
      onInstalled: listen('installed'),
      onConnect: listen('connect'),
      sendMessage: async () => {},
    },
    tabs: { sendMessage: async () => {}, query: async () => [], get: async () => null },
    action: { onClicked: listen('action') },
    contextMenus: { create() {}, onClicked: listen('contextMenu') },
    scripting: { executeScript: async () => [{ result: null }] },
    downloads: {
      async download(options) {
        store.download = options;
        return 1;
      },
    },
  };
}

/** Minimal ZIP reader for the stored (uncompressed) archives the bundler writes. */
export function readZip(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const entries = [];
  let offset = 0;
  while (offset + 4 <= buffer.length && view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = new globalThis.TextDecoder().decode(buffer.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + extraLength;
    entries.push({ name, data: buffer.subarray(start, start + size) });
    offset = start + size;
  }
  return entries;
}

/** Runs the extension's captureForContextMenu() against a supplied DOM. */
export function runCapture({ document, location, performance }) {
  const context = vm.createContext({
    chrome: makeChrome({}),
    Blob, URL, URLSearchParams, TextEncoder, TextDecoder, DataView, Uint8Array,
    crypto, console, btoa, atob, setTimeout, clearTimeout,
    document, location, performance,
  });
  const source = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8')
    + '\n;globalThis.__pageBundler = { captureForContextMenu };';
  vm.runInContext(source, context, { filename: 'background.js' });
  return context.__pageBundler.captureForContextMenu();
}

/**
 * Runs the injected capture function in a bare context, proving it does not
 * depend on anything from the service worker's scope.
 */
export function runIsolatedCapture({ document, location, performance }) {
  const host = vm.createContext({
    chrome: makeChrome({}), URL, URLSearchParams, TextEncoder, TextDecoder,
    DataView, Uint8Array, crypto, console, btoa, atob, setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8')
    + '\n;globalThis.__fn = captureForContextMenu;', host, { filename: 'background.js' });
  const source = vm.runInContext('globalThis.__fn.toString()', host);
  const bare = vm.createContext({ document, location, performance, URL, URLSearchParams, console });
  return vm.runInContext(`(${source})()`, bare);
}

/**
 * Runs the extension's bundle() with the given capture payload and asset server.
 * `assets` maps absolute URL -> { body, type, status }.
 */
export async function runBundle({ data, assets }) {
  const store = {};
  const requests = [];
  const globals = {
    chrome: makeChrome(store),
    Blob,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    DataView,
    Uint8Array,
    crypto,
    btoa,
    atob,
    console,
    setTimeout,
    clearTimeout,
    FileReader: FakeFileReader,
    fetch: async (url, options) => {
      requests.push(url);
      const asset = assets[url] || assets[url.replace(/#.*$/, '')];
      if (!asset) {
        return {
          ok: false,
          status: 404,
          headers: { get: () => null },
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      const body = typeof asset.body === 'string' ? new TextEncoder().encode(asset.body) : asset.body;
      return {
        ok: (asset.status || 200) < 400,
        status: asset.status || 200,
        headers: { get: name => (name.toLowerCase() === 'content-type' ? asset.type || 'application/octet-stream' : null) },
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        url,
      };
    },
  };

  const source = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8')
    + '\n;globalThis.__pageBundler = { bundle, captureForContextMenu, canonicalAssetUrl, zipStore };';
  const context = vm.createContext(globals);
  vm.runInContext(source, context, { filename: 'background.js' });

  const result = await context.__pageBundler.bundle(data, null);
  const downloadUrl = store.download?.url || '';
  const bytes = Buffer.from(downloadUrl.slice(downloadUrl.indexOf(',') + 1), 'base64');
  return {
    result,
    requests,
    filename: store.download?.filename,
    entries: readZip(bytes),
    html: readZip(bytes).find(entry => entry.name === 'index.html')?.data.toString('utf8') || '',
    names: readZip(bytes).map(entry => entry.name),
  };
}

export function assetsFrom(map) {
  const assets = {};
  for (const [url, value] of Object.entries(map)) {
    assets[url] = typeof value === 'string' ? { body: value } : value;
  }
  return assets;
}

/**
 * Boots background.js with stubbed chrome APIs; executeScript() returns the
 * supplied capture payload and fetch() serves `assets`.
 */
export function bootWorker({ capture, assets = {}, tabUrl = 'https://site.test/page' }) {
  const store = {};
  const chrome = makeChrome(store);
  chrome.tabs.get = async id => ({ id, url: tabUrl });
  chrome.scripting.executeScript = async () => [{ result: capture }];
  chrome.tabs.sendMessage = async (tabId, message) => { (store.tabMessages ||= []).push({ tabId, message }); };
  const context = vm.createContext({
    chrome, Blob, URL, URLSearchParams, TextEncoder, TextDecoder, DataView, Uint8Array,
    crypto, console, btoa, atob, setTimeout, clearTimeout,
    fetch: async url => {
      const asset = assets[url];
      if (!asset) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
      const body = typeof asset.body === 'string' ? new TextEncoder().encode(asset.body) : asset.body;
      return {
        ok: true,
        status: 200,
        headers: { get: name => (name.toLowerCase() === 'content-type' ? asset.type || 'application/octet-stream' : null) },
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  return { store, chrome };
}

/** Drives the service worker's message handler the way the popup does. */
export async function runMessage({ message, sender = {}, capture, assets = {}, tabUrl }) {
  const { store } = bootWorker({ capture, assets, tabUrl });
  const listener = store.listeners.message;
  const response = await new Promise(resolve => {
    const keepOpen = listener(message, sender, resolve);
    if (keepOpen !== true) resolve(undefined);
  });
  return { response, download: store.download, tabMessages: store.tabMessages || [] };
}

/** Drives the toolbar-icon path. */
export async function runAction({ capture, assets = {}, tab = { id: 5, url: 'https://site.test/page' } }) {
  const { store } = bootWorker({ capture, assets, tabUrl: tab.url });
  store.listeners.action(tab);
  // The handler is fire-and-forget; wait for the download or an error report.
  const deadline = Date.now() + 5000;
  while (!store.download && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
  return { download: store.download, tabMessages: store.tabMessages || [] };
}
