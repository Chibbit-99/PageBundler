# PageBundler

A Chrome Manifest V3 extension that saves the current page as a ZIP containing `index.html` and locally bundled page assets.

## Load in Chrome
1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository directory.
3. Navigate to a page and click the PageBundler toolbar icon to save it directly; an on-page progress indicator shows the bundling status. You can also right-click anywhere on the page and choose **Save page as ZIP with PageBundler**.

The extension captures the rendered DOM, downloads referenced scripts, stylesheets, images, fonts and media where the site permits it, rewrites references to local files, and downloads a ZIP. Some pages use protected resources, authentication, or runtime-generated content that cannot be reproduced offline; failed assets are reported in the popup. Browser-internal pages and the Chrome Web Store cannot be captured.

## What goes into the archive
Only files the saved page needs:

- Everything the captured markup points at: scripts, stylesheets, icons, the web app manifest, images (`src` and every `srcset` candidate), `poster` frames, media, `<object>` documents, SVG `href` targets and CSS `url()`/`@import` targets.
- Code, styles and fonts that scripts load later (lazy chunks, dynamic `import()`, workers, `@font-face` files), discovered from stylesheet/script contents and from resources the page requested while it ran.
- Stylesheets are followed to any depth, so the images and fonts they pull in are included.
- Each asset is stored once: repeated references (cache-busters, reordered query strings) are fetched once, and byte-identical files are merged so every reference points at the same local copy.

Deliberately left out:

- Speculative-only loads — analytics beacons, tracking pixels, prefetch/prerender/preconnect hints, and assets that were requested by DOM nodes no longer on the page.
- Sub-documents (`<iframe>` pages) keep their original URL, because a remote page cannot be reproduced offline; an iframe pointing at a PDF or image is still bundled.
- Empty responses are not written as zero-byte files. Anything that could not be downloaded keeps its original remote URL, so the saved page never points at a local file that does not exist.

## Tests
`npm test` runs the bundler and page-capture tests (`node --test test/*.test.mjs`). The tests load `background.js` in a VM with stubbed `chrome`/`fetch` APIs, bundle fixture pages, and inspect the produced ZIP.

## Publish a release
In GitHub, open **Actions → Publish extension release → Run workflow**, enter a version such as `1.2.0`, and run it. The workflow creates a `v1.2.0` release with `PageBundler-1.2.0.zip` attached. Download and extract that ZIP, then use **Load unpacked** in Chrome. Releases are manually triggered; the entered version labels the release and archive.

## Permissions
The extension requests access to the active tab, downloads, and pages/resources across websites so it can package cross-origin assets. No data is sent to a server; packaging happens locally in the browser.
