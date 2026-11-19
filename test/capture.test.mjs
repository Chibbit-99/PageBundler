import test from 'node:test';
import assert from 'node:assert/strict';
import { runCapture, runIsolatedCapture } from './harness.mjs';
import { element, document } from './fake-dom.mjs';

const PAGE = 'https://site.test/articles/page?utm_source=newsletter';

function buildPage() {
  const page = element('html', { lang: 'en' }, [
    element('head', {}, [
      element('link', { rel: 'stylesheet', href: '/css/site.css?v=1' }),
      element('link', { rel: 'prefetch', href: '/js/next-page.js' }),
      element('link', { rel: 'preconnect', href: 'https://fonts.test' }),
      element('link', { rel: 'canonical', href: 'https://site.test/articles/page' }),
      element('link', { rel: 'icon', href: '/favicon.ico' }),
      element('link', { rel: 'preload', as: 'image', imagesrcset: '/img/a.png 1x, /img/b.png 2x' }),
      element('script', { type: 'module', src: '/js/app.js' }),
      element('style', {}, [], { text: '@import "/css/extra.css";\nbody{background:url(/img/bg2.png)}' }),
    ]),
    element('body', {}, [
      element('a', { href: '/about' }, [], { text: 'About' }),
      element('img', { src: '/img/logo.png', srcset: '/img/logo.png 1x, /img/logo@2x.png 2x' }),
      element('img', { src: 'data:image/png;base64,AAAA' }),
      element('img', { src: '/img/tracked.png?w=10&h=10' }),
      element('iframe', { src: 'https://video.test/embed/abc' }),
      element('object', { data: '/docs/manual.pdf' }),
      element('video', { src: '/media/clip.mp4', poster: '/img/poster.png' }),
      element('div', { style: "background:url('/img/bg.png')" }),
      element('svg', {}, [element('use', { href: '/icons/sprite.svg#star' }, [], { namespace: 'http://www.w3.org/2000/svg' })], { namespace: 'http://www.w3.org/2000/svg' }),
      // The extension's own progress widget is present while bundling.
      element('div', { id: 'pagebundler-progress-host', style: 'all:initial;position:fixed' }),
    ]),
  ]);
  return document({ title: 'Article', url: PAGE, root: page });
}

const RESOURCE_TIMING = [
  { name: 'https://site.test/js/lazy.js', initiatorType: 'script' },
  { name: 'https://site.test/fonts/x.woff2', initiatorType: 'css' },
  { name: 'https://analytics.test/pixel.gif', initiatorType: 'img' },
  { name: 'https://tracker.test/beacon.gif', initiatorType: 'beacon' },
  { name: 'https://site.test/api/data.json', initiatorType: 'fetch' },
];

const capture = () => runCapture({
  document: buildPage(),
  location: { href: PAGE },
  performance: { getEntriesByType: type => (type === 'resource' ? RESOURCE_TIMING : []) },
});

test('capture reports only the references the page renders from', () => {
  const { referenced } = capture();
  const expected = [
    'https://site.test/css/site.css?v=1',
    'https://site.test/favicon.ico',
    'https://site.test/img/a.png',
    'https://site.test/img/b.png',
    'https://site.test/js/app.js',
    'https://site.test/css/extra.css',
    'https://site.test/img/bg2.png',
    'https://site.test/img/logo.png',
    'https://site.test/img/logo@2x.png',
    'https://site.test/img/tracked.png?w=10&h=10',
    'https://video.test/embed/abc',
    'https://site.test/docs/manual.pdf',
    'https://site.test/media/clip.mp4',
    'https://site.test/img/poster.png',
    'https://site.test/img/bg.png',
    'https://site.test/icons/sprite.svg',
  ];
  for (const url of expected) assert.ok(referenced.includes(url), `missing ${url} in ${referenced.join(', ')}`);
  assert.ok(!referenced.includes('https://site.test/about'), 'navigation links must not be bundled');
  assert.ok(!referenced.includes('https://site.test/js/next-page.js'), 'prefetched pages must not be bundled');
  assert.ok(!referenced.some(url => url.startsWith('data:')), 'inline data must not be bundled');
  assert.ok(!referenced.some(url => url.includes('fonts.test')), 'preconnect hints have no file');
});

test('capture separates runtime hints from page references', () => {
  const { resources, referenced } = capture();
  for (const url of referenced) assert.ok(resources.includes(url), `${url} should also be a resource`);
  assert.ok(resources.includes('https://site.test/js/lazy.js'), 'runtime script chunk should be a hint');
  assert.ok(resources.includes('https://site.test/fonts/x.woff2'), 'font loaded by CSS should be a hint');
  assert.ok(resources.includes('https://analytics.test/pixel.gif'), 'pixel is reported as a hint for the bundler to drop');
  assert.ok(!resources.includes('https://tracker.test/beacon.gif'), 'beacons must not be collected');
  assert.ok(!resources.includes('https://site.test/api/data.json'), 'non-asset requests must not be collected');
});

test('captured markup is self-contained and absolutized', () => {
  const { html, title, pageUrl } = capture();
  assert.equal(title, 'Article');
  assert.equal(pageUrl, PAGE);
  assert.ok(html.startsWith('<!doctype html>\n<html'), 'doctype preserved');
  assert.ok(html.includes('href="https://site.test/css/site.css?v=1"'), 'stylesheet absolutized');
  assert.ok(html.includes('srcset="https://site.test/img/logo.png 1x, https://site.test/img/logo@2x.png 2x"'), `srcset absolutized: ${html}`);
  assert.ok(html.includes("url('https://site.test/img/bg.png')"), 'inline style absolutized');
  assert.ok(html.includes('@import "https://site.test/css/extra.css"'), 'inline @import absolutized');
  assert.ok(html.includes('url(https://site.test/img/bg2.png)'), 'inline <style> url absolutized');
  assert.ok(html.includes('imagesrcset="https://site.test/img/a.png 1x, https://site.test/img/b.png 2x"'));
  // Query strings stay escaped in markup, which the bundler accounts for.
  assert.ok(html.includes('src="https://site.test/img/tracked.png?w=10&amp;h=10"'), `escaped query: ${html}`);
  assert.ok(html.includes('href="https://site.test/icons/sprite.svg#star"'), 'fragment kept in markup');
});

test('the capture function can be injected on its own', () => {
  // executeScript() serializes the function, so it must not close over helpers
  // that only exist in the service worker.
  const captured = runIsolatedCapture({
    document: buildPage(),
    location: { href: PAGE },
    performance: { getEntriesByType: type => (type === 'resource' ? RESOURCE_TIMING : []) },
  });
  assert.equal(captured.title, 'Article');
  assert.ok(captured.referenced.length > 0);
  assert.ok(captured.html.includes('https://site.test/img/logo.png'));
});

test('the extension UI is not saved into the page', () => {
  const { html } = capture();
  assert.ok(!html.includes('pagebundler-progress-host'), html);
  assert.ok(!html.includes('all:initial'), html);
});
