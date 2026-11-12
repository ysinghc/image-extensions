import test from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORTED_FORMATS,
  mimeForFormat,
  extForFormat,
  isLossy,
  clampInt,
  formatFileSize,
  parseTargetKB,
  computeOutputDims,
  scaleDimsToFit,
  rotateDims,
  sanitizeBaseName,
  baseNameFromUrl,
  buildFileName,
  normalizeCrop,
  compressToTargetSize,
} from "../src/lib/image-core.js";

test("format tables", () => {
  assert.ok(SUPPORTED_FORMATS.length >= 5);
  assert.equal(mimeForFormat("webp"), "image/webp");
  assert.equal(extForFormat("jpeg"), "jpg");
  assert.equal(isLossy("png"), false);
  assert.equal(isLossy("jpeg"), true);
  assert.equal(mimeForFormat("nope"), "image/png");
});

test("clampInt", () => {
  assert.equal(clampInt(5, 1, 10), 5);
  assert.equal(clampInt(-3, 0, 10), 0);
  assert.equal(clampInt(99, 0, 10), 10);
  assert.equal(clampInt("7.6", 0, 10), 8);
  assert.equal(clampInt("abc", 2, 9), 2);
});

test("formatFileSize", () => {
  assert.equal(formatFileSize(512), "512 B");
  assert.equal(formatFileSize(2048), "2.0 KB");
  assert.equal(formatFileSize(5 * 1024 * 1024), "5.00 MB");
  assert.equal(formatFileSize(-1), "—");
});

test("parseTargetKB", () => {
  assert.equal(parseTargetKB("50"), 50 * 1024);
  assert.equal(parseTargetKB(""), null);
  assert.equal(parseTargetKB("  "), null);
  assert.equal(parseTargetKB("0"), null);
  assert.equal(parseTargetKB("-5"), null);
  assert.equal(parseTargetKB("abc"), null);
});

test("computeOutputDims", () => {
  // scale mode (pixel-ratio adjustment)
  assert.deepEqual(computeOutputDims(100, 50, { scale: 2 }), { w: 200, h: 100 });
  assert.deepEqual(computeOutputDims(100, 50, { scale: 0.5 }), { w: 50, h: 25 });
  // explicit both sides
  assert.deepEqual(computeOutputDims(100, 50, { width: 30, height: 30 }), { w: 30, h: 30 });
  // one side + aspect lock
  assert.deepEqual(computeOutputDims(100, 50, { width: 50 }), { w: 50, h: 25 });
  assert.deepEqual(computeOutputDims(100, 50, { height: 100 }), { w: 200, h: 100 });
  // one side unlocked
  assert.deepEqual(computeOutputDims(100, 50, { width: 50, lockAspect: false }), { w: 50, h: 50 });
  // empty -> original
  assert.deepEqual(computeOutputDims(100, 50, {}), { w: 100, h: 50 });
  assert.deepEqual(computeOutputDims(100, 50, { width: "", height: "" }), { w: 100, h: 50 });
});

test("scaleDimsToFit never upscales", () => {
  assert.deepEqual(scaleDimsToFit(200, 100, 100, 100), { w: 100, h: 50, scale: 0.5 });
  const same = scaleDimsToFit(50, 50, 100, 100);
  assert.deepEqual([same.w, same.h], [50, 50]);
});

test("rotateDims", () => {
  assert.deepEqual(rotateDims(10, 20, 90), { w: 20, h: 10 });
  assert.deepEqual(rotateDims(10, 20, 270), { w: 20, h: 10 });
  assert.deepEqual(rotateDims(10, 20, 180), { w: 10, h: 20 });
  assert.deepEqual(rotateDims(10, 20, 0), { w: 10, h: 20 });
});

test("file names", () => {
  assert.equal(sanitizeBaseName("my photo(1).webp"), "my photo(1)");
  assert.equal(sanitizeBaseName(""), "image");
  assert.equal(baseNameFromUrl("https://x.com/a/pic.webp?size=1"), "pic");
  assert.equal(baseNameFromUrl("not a url"), "not a url");
  assert.equal(buildFileName("pic", 100, 50, "jpg"), "pic-100x50.jpg");
  assert.equal(buildFileName("pic", 100, 50, "jpg", "50kb"), "pic-100x50-50kb.jpg");
});

test("normalizeCrop", () => {
  assert.equal(normalizeCrop(null, 10, 10), null);
  assert.equal(normalizeCrop({ x: 0, y: 0, w: 10, h: 10 }, 10, 10), null);
  assert.deepEqual(normalizeCrop({ x: 2, y: 2, w: 5, h: 5 }, 10, 10), { x: 2, y: 2, w: 5, h: 5 });
  assert.deepEqual(normalizeCrop({ x: -5, y: -5, w: 99, h: 99 }, 10, 10), null); // clamps to full
  assert.deepEqual(normalizeCrop({ x: 8, y: 8, w: 5, h: 5 }, 10, 10), { x: 8, y: 8, w: 2, h: 2 });
});

test("compressToTargetSize binary-searches quality then scale", async () => {
  // Fake renderer: size grows with quality and scale.
  const renderAt = async (q, scale) => ({ size: Math.round(1000 * q * scale * scale) });
  const hit = await compressToTargetSize(renderAt, 500);
  assert.equal(hit.fits, true);
  assert.ok(hit.blob.size <= 500);
  assert.ok(hit.quality > 0.4 && hit.quality <= 0.95);
  assert.equal(hit.scale, 1);

  const small = await compressToTargetSize(renderAt, 10);
  assert.equal(small.fits, true);
  assert.ok(small.scale < 1); // had to shrink pixels, not just quality
  assert.ok(small.blob.size <= 10);

  const impossible = await compressToTargetSize(renderAt, 0);
  assert.equal(impossible.fits, false); // floor is 1 byte > 0
  assert.equal(impossible.blob.size, 1);
});
