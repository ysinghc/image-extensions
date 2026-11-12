# ImageForge — image converter & resizer (Chrome + Firefox)

[![CI](https://github.com/ysinghc/image-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/ysinghc/image-extensions/actions/workflows/ci.yml)

A Swiss-army-knife extension for everyday image chores: converting that WebP you
just found into a JPEG for a form, shrinking a photo under a KB limit,
or exporting an icon at 2x/3x pixel ratio.

Everything runs locally in your browser. No uploads, no accounts.

## Features

- **Convert** between PNG, JPEG, WebP, AVIF, BMP, GIF (whatever your
  browser can encode — unsupported formats are greyed out automatically)
- **Input from anywhere**: paste an image link, upload a file, drag & drop,
  paste from clipboard (Ctrl+V), or right-click any web image
- **Resize**: exact pixels, scale % / pixel ratio (25%–300%), or fit-inside
  presets (1920 → 256)
- **Quality slider** for lossy formats, JPEG/BMP matte colour for transparency
- **File-size limit**: enter “≤ 50 KB” and it lowers quality first, then
  shrinks pixels until it fits
- **Step chain** with reorder and per-step on/off switches to A/B each edit
- **Rotate / flip / grayscale**
- **Quick actions**: right-click → *Download as PNG/JPEG/WebP* without
  opening the editor; popup does one-click convert & download
- **Copy** the result back to the clipboard

## Install

### Chrome / Edge / Brave

1. Run `./build.sh` (needs `zip`), or skip it and use `src/` with the
   Chrome manifest (see below).
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select `dist-chrome/`.

### Firefox

1. Run `./build.sh`.
2. Open `about:debugging#/runtime/this-firefox`.
3. **Load Temporary Add-on** → select `dist-firefox/manifest.json`.

> Temporary add-ons unload on restart. For a permanent install, package
> `dist-firefox/` and sign it via [AMO](https://addons.mozilla.org).

## Usage

- **From a link**: copy an image address, click the toolbar icon (or open the
  Full editor), paste the link, pick a format/size, Download.
- **From the page**: right-click any image → *ImageForge* → open in the
  editor or download straight away as PNG/JPEG/WebP.
- **From a file**: upload, drag & drop, or screenshot → Ctrl+V.
- **Form uploads with a KB limit**: set the format (usually JPEG), type the
  max KB, hit **Fit to size**, Download.

## Project layout

```
src/
  manifest.chrome.json    Chrome MV3 manifest (service worker)
  manifest.firefox.json   Firefox MV3 manifest (background scripts)
  background.js           context menus + quick downloads (no modules, both browsers)
  popup.html/css/js       toolbar popup: quick convert & download
  editor.html/css/js      full editor tab: resize, rotate, adjust, compress-to-size…
  lib/image-core.js       shared conversion pipeline (ES module, zero deps)
  icons/                  SVG + PNG icon set
tests/core.test.mjs       unit tests for the pure core (node:test)
build.sh                  builds dist-chrome/, dist-firefox/ + zips
```

## Develop

```sh
node --test tests/core.test.mjs   # unit tests
./build.sh                          # build both browser packages
```

## Releases

Push a version tag and CI builds the store zips and attaches them to a
GitHub release automatically:

```sh
# bump "version" in src/manifest.chrome.json AND src/manifest.firefox.json first
git tag v1.0.0 && git push origin v1.0.0
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full process.

`src/lib/image-core.js` is a dependency-free ES module: pure helpers
(dimension math, file names, size fitting) plus a canvas pipeline
(`renderToCanvas`, `encodePipeline`, `compressToTargetSize`). The same file
is imported by the popup/editor pages and by the Node tests.

## Browser notes

- AVIF encoding needs a recent Chrome/Edge; Firefox enables it on recent
  versions. If a browser can’t encode a format, its button is disabled.
- `host_permissions: <all_urls>` is needed so pasted/right-clicked image
  URLs can be fetched and converted locally.
- GIF/BMP *export* support varies by browser; import (decoding) supports
  everything the browser can display.
