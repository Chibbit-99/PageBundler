import test from 'node:test';
import assert from 'node:assert/strict';
import { runBundle } from './harness.mjs';

const page = (html, referenced, resources = referenced) => ({
  html, title: 'Edge cases', pageUrl: 'https://site.test/', referenced, resources,
});
const entry = (result, name) => result.entries.find(item => item.name === name);

test('cache-buster variants are fetched and stored once', async () => {
  const result = await runBundle({
    data: page(
      '<img src="https://site.test/img/logo.png?_=1"><img src="https://site.test/img/logo.png?_=2">',
      ['https://site.test/img/logo.png?_=1', 'https://site.test/img/logo.png?_=2'],
    ),
    assets: {
      'https://site.test/img/logo.png?_=1': { body: new Uint8Array([1, 2, 3]), type: 'image/png' },
      'https://site.test/img/logo.png?_=2': { body: new Uint8Array([1, 2, 3]), type: 'image/png' },
    },
  });
  assert.deepEqual(result.requests, ['https://site.test/img/logo.png?_=1']);
  assert.equal(result.names.filter(name => name.endsWith('logo.png')).length, 1);
  assert.equal(result.html.match(/assets\/logo\.png/g).length, 2, result.html);
});

test('a shorter bundled URL never rewrites the prefix of a longer one', async () => {
  const result = await runBundle({
    data: page(
      '<script src="https://site.test/js/app.js"></script>'
      + '<script>window.asset = "https://site.test/js/app.js?v=9";</script>',
      ['https://site.test/js/app.js'],
    ),
    assets: { 'https://site.test/js/app.js': { body: 'export const app = 1;', type: 'text/javascript' } },
  });
  assert.ok(result.html.includes('src="assets/app.js"'), result.html);
  assert.ok(result.html.includes('"https://site.test/js/app.js?v=9"'), `inline URL corrupted: ${result.html}`);
});

test('two real variants of one URL keep separate files', async () => {
  const result = await runBundle({
    data: page(
      '<img src="https://site.test/img/logo.png"><img src="https://site.test/img/logo.png?v=2">',
      ['https://site.test/img/logo.png', 'https://site.test/img/logo.png?v=2'],
    ),
    assets: {
      'https://site.test/img/logo.png': { body: new Uint8Array([1]), type: 'image/png' },
      'https://site.test/img/logo.png?v=2': { body: new Uint8Array([2]), type: 'image/png' },
    },
  });
  assert.equal(result.names.filter(name => name.endsWith('.png')).length, 2);
  const sources = [...result.html.matchAll(/src="(assets\/[^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(sources, ['assets/logo.png', 'assets/logo-2.png']);
});

test('empty assets are left as remote URLs instead of becoming empty files', async () => {
  const result = await runBundle({
    data: page('<img src="https://site.test/img/empty.gif">', ['https://site.test/img/empty.gif']),
    assets: { 'https://site.test/img/empty.gif': { body: new Uint8Array(0), type: 'image/gif' } },
  });
  assert.ok(!result.names.includes('assets/empty.gif'));
  assert.ok(result.html.includes('https://site.test/img/empty.gif'), 'src should stay remote');
  assert.equal(result.result.skipped, 1);
});

test('manifest icons are bundled and rewritten', async () => {
  const manifest = JSON.stringify({
    name: 'App', icons: [{ src: '/icons/192.png', sizes: '192x192' }],
    shortcuts: [{ name: 'New', icons: [{ src: '/icons/shortcut.png' }] }],
  });
  const result = await runBundle({
    data: page('<link rel="manifest" href="https://site.test/manifest.webmanifest">', ['https://site.test/manifest.webmanifest']),
    assets: {
      'https://site.test/manifest.webmanifest': { body: manifest, type: 'application/manifest+json' },
      'https://site.test/icons/192.png': { body: new Uint8Array([9, 9]), type: 'image/png' },
      'https://site.test/icons/shortcut.png': { body: new Uint8Array([8, 8]), type: 'image/png' },
    },
  });
  const stored = JSON.parse(entry(result, 'assets/manifest.webmanifest').data.toString('utf8'));
  assert.equal(stored.icons[0].src, './192.png');
  assert.equal(stored.shortcuts[0].icons[0].src, './shortcut.png');
  assert.ok(result.names.includes('assets/192.png'));
  assert.ok(result.names.includes('assets/shortcut.png'));
});

test('SVG references are rewritten and fragment references left alone', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs>'
    + '<image href="/img/embedded.png"/><use href="#g"/></svg>';
  const result = await runBundle({
    data: page('<img src="https://site.test/icons/picture.svg">', ['https://site.test/icons/picture.svg']),
    assets: {
      'https://site.test/icons/picture.svg': { body: svg, type: 'image/svg+xml' },
      'https://site.test/img/embedded.png': { body: new Uint8Array([5]), type: 'image/png' },
    },
  });
  const stored = entry(result, 'assets/picture.svg').data.toString('utf8');
  assert.ok(stored.includes('href="./embedded.png"'), stored);
  assert.ok(stored.includes('href="#g"'), stored);
  assert.ok(result.names.includes('assets/embedded.png'));
});

test('chained @import stylesheets are followed to the last level', async () => {
  const result = await runBundle({
    data: page('<link rel="stylesheet" href="https://site.test/css/one.css">', ['https://site.test/css/one.css']),
    assets: {
      'https://site.test/css/one.css': { body: '@import "two.css";', type: 'text/css' },
      'https://site.test/css/two.css': { body: '@import "three.css";', type: 'text/css' },
      'https://site.test/css/three.css': { body: '.x{color:red}', type: 'text/css' },
    },
  });
  for (const name of ['assets/one.css', 'assets/two.css', 'assets/three.css']) {
    assert.ok(result.names.includes(name), `${name} missing from ${result.names}`);
  }
  assert.equal(entry(result, 'assets/one.css').data.toString('utf8').trim(), '@import "./two.css";');
});

test('payloads without a referenced list keep every hinted asset', async () => {
  const html = '<img src="https://site.test/img/logo.png">';
  const result = await runBundle({
    data: { html, title: 'Legacy', pageUrl: 'https://site.test/', resources: ['https://site.test/img/logo.png', 'https://site.test/img/late.png'] },
    assets: {
      'https://site.test/img/logo.png': { body: new Uint8Array([1]), type: 'image/png' },
      'https://site.test/img/late.png': { body: new Uint8Array([2]), type: 'image/png' },
    },
  });
  assert.ok(result.names.includes('assets/logo.png'));
  assert.ok(result.names.includes('assets/late.png'), 'without a referenced list nothing is pruned');
});

test('every local reference in the saved page exists in the archive', async () => {
  const result = await runBundle({
    data: page(
      '<link rel="stylesheet" href="https://site.test/css/a.css">'
      + '<img src="https://site.test/img/one.png">'
      + '<img src="https://site.test/img/broken.png">'
      + '<video poster="https://site.test/img/poster.png"></video>',
      ['https://site.test/css/a.css', 'https://site.test/img/one.png', 'https://site.test/img/broken.png', 'https://site.test/img/poster.png'],
    ),
    assets: {
      'https://site.test/css/a.css': { body: '.a{background:url(../img/one.png)}.b{background:url(../img/gone.png)}', type: 'text/css' },
      'https://site.test/img/one.png': { body: new Uint8Array([1]), type: 'image/png' },
      'https://site.test/img/poster.png': { body: new Uint8Array([3]), type: 'image/png' },
    },
  });
  const localRefs = [...result.html.matchAll(/(?:src|href|poster)="(assets\/[^"]+)"/g)].map(match => match[1]);
  for (const ref of localRefs) assert.ok(result.names.includes(ref), `${ref} referenced but not stored`);
  const css = entry(result, 'assets/a.css').data.toString('utf8');
  // Unavailable assets keep their original reference rather than a dead local path.
  assert.ok(css.includes('url(../img/gone.png)'), css);
  assert.ok(result.html.includes('https://site.test/img/broken.png'), result.html);
});

test('a stylesheet that only the page runtime loaded still brings its images', async () => {
  const result = await runBundle({
    data: page(
      '<img src="https://site.test/img/logo.png">',
      ['https://site.test/img/logo.png'],
      [
        'https://site.test/img/logo.png',
        'https://site.test/css/lazy.css',
        'https://site.test/img/from-lazy-css.png',
        'https://analytics.test/pixel.gif',
      ],
    ),
    assets: {
      'https://site.test/img/logo.png': { body: new Uint8Array([1]), type: 'image/png' },
      'https://site.test/css/lazy.css': { body: '.lazy{background:url(../img/from-lazy-css.png)}', type: 'text/css' },
      'https://site.test/img/from-lazy-css.png': { body: new Uint8Array([7]), type: 'image/png' },
      'https://analytics.test/pixel.gif': { body: new Uint8Array([0, 1]), type: 'image/gif' },
    },
  });
  assert.ok(result.names.includes('assets/lazy.css'), `runtime stylesheet dropped: ${result.names}`);
  assert.ok(result.names.includes('assets/from-lazy-css.png'), `image used by runtime CSS dropped: ${result.names}`);
  assert.ok(!result.names.some(name => name.includes('pixel')), `tracking pixel kept: ${result.names}`);
});

test('a few hundred assets are bundled without stalling', async () => {
  const referenced = [];
  const resources = [];
  const assets = {};
  const images = [];
  for (let i = 0; i < 300; i++) {
    const url = `https://site.test/img/asset-${i}.png`;
    images.push(`<img src="${url}">`);
    referenced.push(url);
    resources.push(url);
    assets[url] = { body: new Uint8Array([i & 0xff, (i >> 8) & 0xff]), type: 'image/png' };
  }
  for (let i = 0; i < 50; i++) resources.push(`https://analytics.test/pixel-${i}.gif`);
  const started = Date.now();
  const result = await runBundle({ data: page(images.join(''), referenced, resources), assets });
  assert.equal(result.names.filter(name => name.startsWith('assets/asset-')).length, 300);
  assert.ok(!result.names.some(name => name.includes('pixel')), 'hints were not pruned');
  assert.ok(Date.now() - started < 10000, 'bundling too slow');
});

test('the popup message path captures and bundles through the service worker', async () => {
  const { runMessage } = await import('./harness.mjs');
  const capture = {
    html: '<img src="https://site.test/img/logo.png"><img src="https://site.test/img/logo.png?_=2">',
    title: 'Wired up',
    pageUrl: 'https://site.test/page',
    referenced: ['https://site.test/img/logo.png', 'https://site.test/img/logo.png?_=2'],
    resources: ['https://site.test/img/logo.png', 'https://site.test/img/logo.png?_=2', 'https://analytics.test/p.gif'],
  };
  const assets = {
    'https://site.test/img/logo.png': { body: new Uint8Array([1, 2]), type: 'image/png' },
    'https://analytics.test/p.gif': { body: new Uint8Array([9]), type: 'image/gif' },
  };
  const { response, download } = await runMessage({ message: { type: 'capture-and-bundle', tabId: 7 }, capture, assets });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.fileCount, 3, 'index.html, README.txt and one asset');
  assert.equal(response.duplicates, 0);
  assert.equal(response.skipped, 1, 'analytics pixel skipped');
  assert.equal(download.filename, 'Wired up.zip');
  assert.ok(download.url.startsWith('data:application/zip;base64,'));
});

test('the message path refuses pages that cannot be captured', async () => {
  const { runMessage } = await import('./harness.mjs');
  const { response, download } = await runMessage({
    message: { type: 'capture-and-bundle', tabId: 3 },
    capture: { html: '', title: 'x', referenced: [], resources: [] },
    tabUrl: 'chrome://settings',
  });
  assert.equal(response.ok, false);
  assert.match(response.error, /cannot be captured/i);
  assert.equal(download, undefined);
});

test('unknown messages are ignored', async () => {
  const { runMessage } = await import('./harness.mjs');
  const { response, download } = await runMessage({ message: { type: 'something-else' }, capture: {} });
  assert.equal(response, undefined);
  assert.equal(download, undefined);
});

test('fragment references to a bundled asset are rewritten', async () => {
  const result = await runBundle({
    data: page(
      '<img src="https://site.test/icons/sprite.svg#logo">'
      + '<svg><use href="https://site.test/icons/sprite.svg#star"></use></svg>',
      ['https://site.test/icons/sprite.svg'],
    ),
    assets: { 'https://site.test/icons/sprite.svg': { body: '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="star"/></svg>', type: 'image/svg+xml' } },
  });
  assert.equal(result.names.filter(name => name.endsWith('sprite.svg')).length, 1);
  assert.ok(result.html.includes('src="assets/sprite.svg#logo"'), result.html);
  assert.ok(result.html.includes('href="assets/sprite.svg#star"'), result.html);
});

test('rewriting a large page with many assets stays fast', async () => {
  const referenced = [];
  const assets = {};
  const parts = ['<article>'];
  for (let i = 0; i < 1500; i++) {
    const url = `https://site.test/gallery/photo-${i}.png`;
    referenced.push(url);
    assets[url] = { body: new Uint8Array([i & 0xff, (i >> 8) & 0xff, 1, 2, 3]), type: 'image/png' };
    parts.push(`<figure><img src="${url}" srcset="${url} 1x, ${url}?dpr=2 2x"><figcaption>Photo ${i} see ${url}</figcaption></figure>`);
  }
  parts.push('</article>');
  const started = Date.now();
  const result = await runBundle({ data: page(parts.join(''), referenced), assets });
  const elapsed = Date.now() - started;
  assert.equal(result.names.filter(name => name.startsWith('assets/photo-')).length, 1500);
  assert.ok(!result.html.includes('src="https://site.test/gallery/'), 'markup was not rewritten');
  assert.ok(elapsed < 15000, `bundling took ${elapsed}ms`);
});

test('the toolbar icon bundles and reports progress to the page', async () => {
  const { runAction } = await import('./harness.mjs');
  const capture = {
    html: '<img src="https://site.test/img/logo.png">',
    title: 'Toolbar',
    pageUrl: 'https://site.test/page',
    referenced: ['https://site.test/img/logo.png'],
    resources: ['https://site.test/img/logo.png'],
  };
  const { download, tabMessages } = await runAction({
    capture,
    assets: { 'https://site.test/img/logo.png': { body: new Uint8Array([1, 2]), type: 'image/png' } },
  });
  assert.equal(download.filename, 'Toolbar.zip');
  assert.ok(tabMessages.length >= 2, 'progress should be shown on the page');
  assert.equal(tabMessages[0].tabId, 5);
  assert.ok(tabMessages.some(entry => entry.message.label === 'Capturing page…'), JSON.stringify(tabMessages));
  assert.ok(tabMessages.some(entry => entry.message.percent === 100));
});
