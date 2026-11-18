# PageBundler

A Chrome Manifest V3 extension that saves the current page as a ZIP containing `index.html` and locally bundled page assets.

## Load in Chrome
1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository directory.
3. Navigate to a page and click the PageBundler toolbar button, then **Save page as ZIP**. You can also right-click anywhere on the page and choose **Save page as ZIP with PageBundler**.

The extension captures the rendered DOM, downloads referenced scripts, stylesheets, images, fonts and media where the site permits it, rewrites references to local files, and downloads a ZIP. Some pages use protected resources, authentication, or runtime-generated content that cannot be reproduced offline; failed assets are reported in the popup. Browser-internal pages and the Chrome Web Store cannot be captured.

## Publish a release
In GitHub, open **Actions → Publish extension release → Run workflow**, enter a version such as `1.2.0`, and run it. The workflow creates a `v1.2.0` release with `PageBundler-1.2.0.zip` attached. Download and extract that ZIP, then use **Load unpacked** in Chrome. Releases are manually triggered; the entered version labels the release and archive.

## Permissions
The extension requests access to the active tab, downloads, and pages/resources across websites so it can package cross-origin assets. No data is sent to a server; packaging happens locally in the browser.
