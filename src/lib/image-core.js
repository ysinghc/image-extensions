// ImageForge shared core: pure helpers + canvas pipeline.
// ES module: imported by popup/editor pages and by Node tests.
// No dependencies. Browser-only functions throw cleanly outside a DOM.

export const SUPPORTED_FORMATS = [
  { id: "png", mime: "image/png", ext: "png", label: "PNG", lossy: false },
  { id: "jpeg", mime: "image/jpeg", ext: "jpg", label: "JPEG", lossy: true },
  { id: "webp", mime: "image/webp", ext: "webp", label: "WebP", lossy: true },
  { id: "avif", mime: "image/avif", ext: "avif", label: "AVIF", lossy: true },
  { id: "bmp", mime: "image/bmp", ext: "bmp", label: "BMP", lossy: false },
  { id: "gif", mime: "image/gif", ext: "gif", label: "GIF", lossy: false },
];

export function formatFor(id) {
  return SUPPORTED_FORMATS.find((f) => f.id === id) || null;
}

export function mimeForFormat(id) {
  return formatFor(id)?.mime || "image/png";
}

export function extForFormat(id) {
  return formatFor(id)?.ext || "png";
}

export function isLossy(id) {
  return !!formatFor(id)?.lossy;
}

export function clampInt(v, min, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Parse a "target size" field in KB. Returns bytes or null when empty/invalid. */
export function parseTargetKB(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 1024);
}

/**
 * Compute output pixel dimensions.
 * opts: { width?: number|null, height?: number|null, scale?: number|null,
 *         lockAspect?: boolean }
 * - scale multiplies both sides (e.g. 0.5, 2 for pixel-ratio 2x).
 * - with lockAspect and only one side given, the other follows the ratio.
 */
export function computeOutputDims(origW, origH, opts = {}) {
  const W = Math.max(1, Math.round(origW));
  const H = Math.max(1, Math.round(origH));
  const { width = null, height = null, scale = null, lockAspect = true } = opts;

  if (scale !== null && scale !== undefined && Number(scale) > 0) {
    return {
      w: Math.max(1, Math.round(W * Number(scale))),
      h: Math.max(1, Math.round(H * Number(scale))),
    };
  }
  const w = width === null || width === undefined || width === "" ? null : Math.round(Number(width));
  const h = height === null || height === undefined || height === "" ? null : Math.round(Number(height));
  const wOk = w !== null && Number.isFinite(w) && w > 0;
  const hOk = h !== null && Number.isFinite(h) && h > 0;
  if (wOk && hOk) return { w, h };
  if (wOk) return { w, h: lockAspect ? Math.max(1, Math.round((H * w) / W)) : H };
  if (hOk) return { w: lockAspect ? Math.max(1, Math.round((W * h) / H)) : W, h };
  return { w: W, h: H };
}

/** Scale (w,h) to fit inside maxW x maxH, preserving aspect. Never upscales. */
export function scaleDimsToFit(w, h, maxW, maxH) {
  const s = Math.min(1, maxW / w, maxH / h);
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)), scale: s };
}

/** Swap sides for 90/270 degree rotation. */
export function rotateDims(w, h, deg) {
  const d = ((Math.round(deg) % 360) + 360) % 360;
  return d === 90 || d === 270 ? { w: h, h: w } : { w, h };
}

export function sanitizeBaseName(name, fallback = "image") {
  const s = String(name || "")
    .split(/[?#]/)[0]
    .split("/").pop()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^\w\-() ]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .trim();
  return s || fallback;
}

export function baseNameFromUrl(url, fallback = "image") {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() || "";
    return sanitizeBaseName(decodeURIComponent(last), fallback);
  } catch {
    return sanitizeBaseName(String(url || "").split("/").pop() || "", fallback);
  }
}

export function buildFileName(base, w, h, ext, suffix = "") {
  const clean = sanitizeBaseName(base);
  const mid = suffix ? `-${suffix}` : "";
  return `${clean}-${w}x${h}${mid}.${ext}`;
}

// ---------------------------------------------------------------------------
// Browser-only: canvas pipeline
// ---------------------------------------------------------------------------

function requireDom() {
  if (typeof document === "undefined") {
    throw new Error("image-core canvas helpers need a DOM (browser) context");
  }
}

let encodeSupportCache = null;

/** Detect which mime types this browser can actually encode via canvas. */
export function detectEncodeSupport() {
  requireDom();
  if (encodeSupportCache) return encodeSupportCache;
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const out = {};
  for (const f of SUPPORTED_FORMATS) {
    try {
      const url = canvas.toDataURL(f.mime, 0.8);
      out[f.id] = url.startsWith(`data:${f.mime}`);
    } catch {
      out[f.id] = false;
    }
  }
  // PNG/JPEG are baseline; if detection failed assume they work.
  out.png = out.png || true;
  out.jpeg = out.jpeg || true;
  encodeSupportCache = out;
  return out;
}

export function firstSupportedFormat(preferred) {
  requireDom();
  const support = detectEncodeSupport();
  if (preferred && support[preferred]) return preferred;
  for (const id of ["png", "jpeg", "webp", "avif", "bmp", "gif"]) {
    if (support[id]) return id;
  }
  return "png";
}

/** Decode a Blob/File into an ImageBitmap (avoids canvas taint from fetches). */
export async function loadBitmap(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob);
    } catch {
      // fall through to <img> fallback
    }
  }
  requireDom();
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Could not decode image file"));
      el.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
    if (typeof createImageBitmap === "function") return await createImageBitmap(canvas);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function bitmapSize(src) {
  const w = src.naturalWidth ?? src.width ?? 0;
  const h = src.naturalHeight ?? src.height ?? 0;
  return { w, h };
}

function makeCanvas(w, h) {
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  throw new Error("No canvas implementation available");
}

/**
 * Render the full pipeline to a canvas:
 * rotate/flip -> resize -> optional grayscale.
 * opts: { rotate (0|90|180|270), flipH, flipV, grayscale, outW, outH,
 *         background (css color or null for transparency) }
 */
export function renderToCanvas(src, opts = {}) {
  const { w: srcW, h: srcH } = bitmapSize(src);
  if (!srcW || !srcH) throw new Error("Empty image source");
  const sx = 0;
  const sy = 0;
  const sw = srcW;
  const sh = srcH;

  const rotate = [0, 90, 180, 270].includes(opts.rotate) ? opts.rotate : 0;
  const { w: orientedW, h: orientedH } = rotateDims(sw, sh, rotate);
  const outW = Math.max(1, Math.round(opts.outW || orientedW));
  const outH = Math.max(1, Math.round(opts.outH || orientedH));

  const canvas = makeCanvas(outW, outH);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, outW, outH);
  }

  ctx.save();
  ctx.translate(outW / 2, outH / 2);
  if (opts.flipH) ctx.scale(-1, 1);
  if (opts.flipV) ctx.scale(1, -1);
  ctx.rotate((rotate * Math.PI) / 180);
  if (opts.grayscale) ctx.filter = "grayscale(1)";
  // After transforms, draw the source rect centered, scaled to output.
  const dw = rotate === 90 || rotate === 270 ? outH : outW;
  const dh = rotate === 90 || rotate === 270 ? outW : outH;
  ctx.imageSmoothingQuality = "high";
  try {
    ctx.drawImage(src, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
  } catch {
    // Some ImageBitmap sources throw on first draw; retry via a temp canvas.
    const tmp = makeCanvas(srcW, srcH);
    tmp.getContext("2d").drawImage(src, 0, 0);
    ctx.drawImage(tmp, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
  }
  ctx.restore();
  return canvas;
}

export function canvasToBlobAsync(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    if (canvas.convertToBlob) {
      canvas.convertToBlob({ type: mime, quality }).then(resolve, reject);
      return;
    }
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(`Encoder returned no data for ${mime}`))), mime, quality);
  });
}

/**
 * Encode the pipeline output. Lossless formats ignore quality.
 * Returns { blob, canvas, width, height }.
 */
export async function encodePipeline(src, opts = {}) {
  requireDomOrWorker();
  const formatId = opts.format || "png";
  const mime = mimeForFormat(formatId);
  const quality = isLossy(formatId) ? clampInt(opts.quality ?? 85, 1, 100) / 100 : undefined;
  const canvas = renderToCanvas(src, opts);
  const blob = await canvasToBlobAsync(canvas, mime, quality);
  return { blob, canvas, width: canvas.width, height: canvas.height };
}

function requireDomOrWorker() {
  if (typeof document === "undefined" && typeof OffscreenCanvas === "undefined") {
    throw new Error("image-core encode helpers need a browser context");
  }
}

/**
 * Compress to fit under targetBytes.
 * Strategy: binary-search quality at full size, then step down pixel scale
 * (0.9, 0.8, ...) re-searching quality each time, until it fits or minScale.
 * renderAt: async (quality01, scale) -> Blob
 * Returns { blob, quality, scale, fits }.
 */
export async function compressToTargetSize(renderAt, targetBytes, opts = {}) {
  const minQuality = opts.minQuality ?? 0.1;
  const maxQuality = opts.maxQuality ?? 0.95;
  const minScale = opts.minScale ?? 0.1;
  const rounds = opts.rounds ?? 7;

  async function bestAtScale(scale) {
    let lo = minQuality;
    let hi = maxQuality;
    let best = null;
    for (let i = 0; i < rounds; i++) {
      const q = (lo + hi) / 2;
      const blob = await renderAt(q, scale);
      if (blob.size <= targetBytes) {
        best = { blob, quality: q };
        lo = q;
      } else {
        hi = q;
      }
    }
    return best;
  }

  let scale = 1;
  for (;;) {
    const hit = await bestAtScale(scale);
    if (hit) return { ...hit, scale, fits: true };
    const next = scale > 0.5 ? scale - 0.1 : scale * 0.8;
    if (next < minScale) break;
    scale = next;
  }
  // Nothing fit: return the smallest we can make.
  const blob = await renderAt(minQuality, minScale);
  return { blob, quality: minQuality, scale: minScale, fits: blob.size <= targetBytes };
}

/** Fetch an image URL as a Blob (avoids CORS taint vs drawing remote <img>). */
export async function fetchImageBlob(url) {
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const blob = await res.blob();
  if (!blob.type.startsWith("image/")) {
    throw new Error(`URL did not return an image (got ${blob.type || "unknown type"})`);
  }
  return blob;
}
