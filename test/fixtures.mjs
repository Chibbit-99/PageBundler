// Fixture page used by the bundler tests. Mirrors what captureForContextMenu()
// hands to bundle(): an absolutized DOM snapshot plus resource hints.
import { assetsFrom } from './harness.mjs';

const png = label => {
  // Distinct, deterministic bytes per image.
  const bytes = new Uint8Array(64);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (label.charCodeAt(i % label.length) * 7 + i) & 0xff;
  return bytes;
};

const LOGO = png('logo');
const HERO = png('hero');

const CSS = `@import "theme.css";
@font-face { font-family: X; src: url(../fonts/x.woff2?v=1) format("woff2"); }
@font-face { font-family: Xcyr; unicode-range: U+0400-04FF; src: url(../fonts/x-cyrillic.woff2) format("woff2"); }
.hero { background-image: url(../img/hero-bg.png); }
.missing { background-image: url(../img/missing-bg.png); }
`;

const THEME = `@font-face { font-family: X; src: url(https://site.test/fonts/x.woff2?v=2) format("woff2"); }
`;

const APP_JS = `import "./chunk.js";
const sprite = new URL("../img/sprite-part.png", import.meta.url);
export const load = () => import("./lazy.js");
console.log(sprite);
`;

export const HTML = `<!doctype html>
<html lang="en"><head>
<link rel="stylesheet" href="https://site.test/css/site.css?v=1">
<link rel="stylesheet" href="https://site.test/css/site.css?v=2">
<link rel="icon" href="https://site.test/favicon.ico">
<link rel="preload" as="image" href="https://site.test/img/og-banner.png">
<script type="module" src="https://site.test/js/app.js"></script>
</head><body>
<img src="https://site.test/img/logo.png">
<img src="https://cdn.test/assets/logo-copy.png">
<img srcset="https://site.test/img/hero-1x.png 1x, https://site.test/img/hero-2x.png 2x">
<img src="https://site.test/img/sprite-sheet.png?v=1&amp;size=2">
<img src="https://site.test/img/missing.png">
<iframe src="https://video.test/embed/abc"></iframe>
<video src="https://site.test/media/clip.mp4" poster="https://site.test/img/poster.png"></video>
<style>.hero{background:url(https://site.test/img/hero-bg.png)}</style>
</body></html>`;

/** URLs the page itself (DOM + inline styles, including iframes) points at. */
export const REFERENCED = [
  'https://site.test/css/site.css?v=1',
  'https://site.test/css/site.css?v=2',
  'https://site.test/favicon.ico',
  'https://site.test/img/og-banner.png',
  'https://site.test/js/app.js',
  'https://site.test/img/logo.png',
  'https://cdn.test/assets/logo-copy.png',
  'https://site.test/img/hero-1x.png',
  'https://site.test/img/hero-2x.png',
  'https://site.test/img/sprite-sheet.png?v=1&size=2',
  'https://site.test/img/missing.png',
  'https://site.test/media/clip.mp4',
  'https://site.test/img/poster.png',
  'https://site.test/img/hero-bg.png',
];

/** Extra resources seen by the Resource Timing API (runtime loads, beacons, prefetches). */
export const HINTS = [
  'https://site.test/img/sprite-part.png',
  'https://analytics.test/pixel.gif',
  'https://beacon.test/collect.gif',
  'https://site.test/img/og-banner.png',
  'https://site.test/fonts/x.woff2?v=1',
];

export const DATA = {
  html: HTML,
  title: 'Fixture page',
  pageUrl: 'https://site.test/',
  resources: [...new Set([...REFERENCED, ...HINTS])],
  referenced: REFERENCED,
};

export const ASSETS = assetsFrom({
  'https://site.test/css/site.css?v=1': { body: CSS, type: 'text/css' },
  'https://site.test/css/site.css?v=2': { body: CSS, type: 'text/css' },
  'https://site.test/css/theme.css': { body: THEME, type: 'text/css' },
  'https://site.test/js/app.js': { body: APP_JS, type: 'text/javascript' },
  'https://site.test/js/chunk.js': { body: 'export const chunk = 1;\n', type: 'text/javascript' },
  'https://site.test/js/lazy.js': { body: 'export const lazy = 1;\n', type: 'text/javascript' },
  'https://site.test/favicon.ico': { body: png('favicon'), type: 'image/x-icon' },
  'https://site.test/img/logo.png': { body: LOGO, type: 'image/png' },
  'https://cdn.test/assets/logo-copy.png': { body: LOGO, type: 'image/png' },
  'https://site.test/img/hero-1x.png': { body: HERO, type: 'image/png' },
  'https://site.test/img/hero-2x.png': { body: png('hero2x'), type: 'image/png' },
  'https://site.test/img/hero-bg.png': { body: png('herobg'), type: 'image/png' },
  'https://site.test/img/poster.png': { body: png('poster'), type: 'image/png' },
  'https://site.test/img/sprite-sheet.png?v=1&size=2': { body: png('sprite'), type: 'image/png' },
  'https://site.test/img/sprite-part.png': { body: png('spritepart'), type: 'image/png' },
  'https://site.test/img/og-banner.png': { body: png('ogbanner'), type: 'image/png' },
  'https://site.test/fonts/x.woff2?v=1': { body: png('fontx'), type: 'font/woff2' },
  'https://site.test/fonts/x.woff2?v=2': { body: png('fontx'), type: 'font/woff2' },
  'https://site.test/fonts/x-cyrillic.woff2': { body: png('fontcyr'), type: 'font/woff2' },
  'https://site.test/media/clip.mp4': { body: png('clip'), type: 'video/mp4' },
  'https://analytics.test/pixel.gif': { body: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), type: 'image/gif' },
  'https://beacon.test/collect.gif': { body: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x62]), type: 'image/gif' },
  'https://site.test/img/empty.gif': { body: new Uint8Array(0), type: 'image/gif' },
  'https://site.test/js/vendor-empty.js': { body: '', type: 'text/javascript' },
});
