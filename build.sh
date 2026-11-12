#!/usr/bin/env bash
# Build unpacked + zipped packages for Chrome and Firefox.
# Usage: ./build.sh   (outputs dist-chrome/, dist-firefox/, *.zip)
set -euo pipefail
cd "$(dirname "$0")"

command -v zip >/dev/null || { echo "error: 'zip' is required to build" >&2; exit 1; }

VERSION=$(python3 -c "import json;print(json.load(open('src/manifest.chrome.json'))['version'])")
FIREFOX_VERSION=$(python3 -c "import json;print(json.load(open('src/manifest.firefox.json'))['version'])")
test "$VERSION" = "$FIREFOX_VERSION" || {
  echo "error: manifest versions diverged (chrome=$VERSION firefox=$FIREFOX_VERSION)" >&2
  exit 1
}

for TARGET in chrome firefox; do
  DIST="dist-$TARGET"
  rm -rf "$DIST"
  mkdir -p "$DIST"
  # Copy the whole tree (minus the per-target manifests) so new source files
  # can never silently miss the package.
  (cd src && tar cf - --exclude='manifest.*.json' .) | (cd "$DIST" && tar xf -)
  cp "src/manifest.$TARGET.json" "$DIST/manifest.json"
  rm -f "imageforge-$VERSION-$TARGET.zip"
  (cd "$DIST" && zip -qr "../imageforge-$VERSION-$TARGET.zip" .)
  echo "built $DIST/ + imageforge-$VERSION-$TARGET.zip"
done
