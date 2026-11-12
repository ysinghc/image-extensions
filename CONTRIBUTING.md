# Contributing to ImageForge

Thanks for helping out. This project is intentionally small and dependency-free —
please keep it that way.

## Setup

```sh
git clone https://github.com/ysinghc/image-extensions.git
cd image-extensions
node --test tests/core.test.mjs   # should be green before you start
./build.sh                          # produces dist-chrome/, dist-firefox/ + zips
```

Load `dist-chrome/` via `chrome://extensions` (Developer mode → Load unpacked)
or `dist-firefox/` via `about:debugging` (Load Temporary Add-on) to try changes.

## Ground rules

- **No dependencies.** No npm packages, no bundler, no frameworks. The whole
  extension is hand-written HTML/CSS/vanilla JS.
- **One shared core.** Image logic lives in `src/lib/image-core.js`, an ES module
  imported by the pages *and* the Node tests. Put pure, testable helpers there;
  keep `background.js` a plain script (no modules) so it runs as both a Chrome
  service worker and a Firefox background script.
- **Both browsers, always.** Every change must work in Chrome and Firefox.
  `manifest.chrome.json` and `manifest.firefox.json` must stay in sync (same
  version, same features); CI fails if the versions diverge.
- **Test what you touch.** Pure helpers get `node:test` cases in `tests/`.
  Browser-only code gets a manual pass in both browsers, or a headless check.

## Pull requests

1. Fork, branch from `main`, keep the change focused.
2. Run the full gate locally:
   ```sh
   node --test tests/core.test.mjs && ./build.sh
   ```
3. Smoke-test the built package in Chrome *and* Firefox (load, convert an
   image, download it).
4. Open the PR with a short description and the browsers you tested.

CI runs the tests, syntax checks, manifest validation, and a build on every PR.

## Releases

Maintainers cut releases by tagging; CI builds the store zips and attaches
them to the GitHub release:

```sh
# 1. Bump "version" in src/manifest.chrome.json AND src/manifest.firefox.json
# 2. Commit, then:
git tag v1.2.3 && git push origin v1.2.3
```

Upload the resulting `imageforge-<version>-chrome.zip` to the Chrome Web Store
and `imageforge-<version>-firefox.zip` to AMO (see README).

## Reporting bugs

Open an issue with: browser + version, steps to reproduce, what you expected,
and what happened. A sample image or link helps a lot.
