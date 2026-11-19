import test from 'node:test';
import assert from 'node:assert/strict';
import { runBundle } from './harness.mjs';
import { DATA, ASSETS } from './fixtures.mjs';

const bundleOnce = () => runBundle({ data: DATA, assets: ASSETS });

function indexOf(entries, name) {
  return entries.find((entry) => entry.name === name);
}

test('includes every asset the page references', async () => {
  const { names, html, entries } = await bundleOnce();
  // DOM references, CSS references (including @import chains), and JS references.
  const needed = [
    'site.css', 'theme.css', 'app.js', 'chunk.js', 'lazy.js', 'favicon.ico',
    'logo.png', 'hero-1x.png', 'hero-2x.png', 'sprite-sheet.png', 'hero-bg.png',
    'poster.png', 'x.woff2', 'x-cyrillic.woff2', 'clip.mp4', 'sprite-part.png',
  ];
  for (const file of needed) {
    assert.ok(names.some((name) => name.endsWith('/' + file) || name.endsWith(file)),
      `expected ${file} in ZIP, got ${names.join(', ')}`);
  }
  assert.ok(indexOf(entries, 'index.html'), 'index.html present');
  assert.ok(indexOf(entries, 'README.txt'), 'README.txt present');
  // Every surviving local reference must resolve to a file that exists.
  const localRefs = [...html.matchAll(/(?:src|href|poster)="(assets\/[^"]+)"/g)].map((m) => m[1]);
  for (const ref of localRefs) {
    assert.ok(names.includes(ref), `index.html points at missing file ${ref}`);
  }
});

test('does not store the same file twice', async () => {
  const { entries, names } = await bundleOnce();
  const seen = new Map();
  for (const entry of entries) {
    if (entry.name === 'index.html' || entry.name === 'README.txt') continue;
    const key = `${entry.data.length}:${Buffer.from(entry.data).toString('hex')}`;
    if (entry.data.length === 0) continue;
    if (seen.has(key)) {
      assert.fail(`duplicate content: ${seen.get(key)} and ${entry.name}`);
    }
    seen.set(key, entry.name);
  }
  // site.css?v=2 and the two x.woff2?v=* URLs collapse onto the surviving files.
  assert.equal(names.filter((name) => name.endsWith('site.css')).length, 1, `site.css copies: ${names}`);
  assert.equal(names.filter((name) => name.endsWith('x.woff2')).length, 1);
  assert.equal(names.filter((name) => name.includes('logo')).length, 1, `logo copies: ${names}`);
});

test('skips speculative, tracking and empty resources', async () => {
  const { names, requests } = await bundleOnce();
  assert.ok(!names.some((name) => name.includes('pixel')), `tracking pixel bundled: ${names}`);
  assert.ok(!names.some((name) => name.includes('collect')), `beacon bundled: ${names}`);
  assert.ok(!requests.some((url) => url.includes('analytics.test')), 'tracking pixel was downloaded');
  assert.ok(!requests.some((url) => url.includes('video.test')), 'iframe document was downloaded');
  assert.ok(!names.includes('assets/empty.gif'), 'empty asset written');
});

test('keeps runtime-loaded assets that JavaScript references', async () => {
  const { names } = await bundleOnce();
  assert.ok(names.some((name) => name.endsWith('sprite-part.png')), `JS-referenced asset dropped: ${names}`);
});

test('rewrites HTML references, including escaped query strings', async () => {
  const { html, names } = await bundleOnce();
  assert.ok(!html.includes('https://site.test/img/logo.png'), 'logo src not rewritten');
  assert.ok(!html.includes('&amp;size=2'), 'escaped query URL not rewritten');
  assert.ok(!html.includes('https://site.test/css/site.css'), 'stylesheet not rewritten');
  // Missing assets keep their remote URL instead of pointing at a non-existent file.
  assert.ok(html.includes('https://site.test/img/missing.png'), 'failed asset should stay remote');
  // Iframes cannot be bundled; leave the original URL alone.
  assert.ok(html.includes('https://video.test/embed/abc'));
  // srcset candidates remain intact.
  const srcset = html.match(/srcset="([^"]+)"/)?.[1] || '';
  assert.equal(srcset.split(',').length, 2, `srcset lost candidates: ${srcset}`);
  for (const candidate of srcset.split(',')) {
    const url = candidate.trim().split(/\s+/)[0];
    assert.ok(names.includes(url), `srcset candidate is not in the ZIP: ${url}`);
  }
});

test('rewrites CSS and JS dependency references to the surviving files', async () => {
  const { entries, names } = await bundleOnce();
  const css = entries.find((entry) => entry.name.endsWith('site.css')).data.toString('utf8');
  assert.ok(!/https?:\/\//.test(css.replace(/@font-face/g, '')), `CSS still references remote URLs: ${css}`);
  assert.ok(css.includes('url(./x.woff2'), 'font not rewritten');
  assert.ok(css.includes('@import "./theme.css"'), `@import not rewritten: ${css}`);
  const theme = entries.find((entry) => entry.name.endsWith('theme.css')).data.toString('utf8');
  assert.ok(theme.includes('url(./x.woff2'), 'theme font not rewritten');
  const app = entries.find((entry) => entry.name.endsWith('app.js')).data.toString('utf8');
  assert.ok(app.includes('"./chunk.js"'), `JS import not rewritten: ${app}`);
  assert.ok(app.includes('"./lazy.js"'), `dynamic import not rewritten: ${app}`);
  assert.ok(app.includes('"./sprite-part.png"'), `asset URL not rewritten: ${app}`);
});
