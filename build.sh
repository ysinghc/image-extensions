#!/usr/bin/env bash
# Build unpacked + zipped packages for Chrome and Firefox.
# Usage: ./build.sh   (outputs dist-chrome/, dist-firefox/, *.zip)
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(python3 -c "import json;print(json.load(open('src/manifest.chrome.json'))['version'])")

for TARGET in chrome firefox; do
  DIST="dist-$TARGET"
  rm -rf "$DIST"
  mkdir -p "$DIST"
  cp src/popup.html src/popup.css src/popup.js \
     src/editor.html src/editor.css src/editor.js \
     src/background.js "$DIST/"
  mkdir -p "$DIST/lib" "$DIST/icons"
  cp src/lib/*.js "$DIST/lib/"
  cp src/icons/* "$DIST/icons/"
  cp "src/manifest.$TARGET.json" "$DIST/manifest.json"
  rm -f "imageforge-$VERSION-$TARGET.zip"
  (cd "$DIST" && zip -qr "../imageforge-$VERSION-$TARGET.zip" .)
  echo "built $DIST/ + imageforge-$VERSION-$TARGET.zip"
done
