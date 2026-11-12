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
  detectEncodeSupport,
  firstSupportedFormat,
  loadBitmap,
  bitmapSize,
  renderToCanvas,
  canvasToBlobAsync,
  compressToTargetSize,
  fetchImageBlob,
} from "./lib/image-core.js";

const $ = (id) => document.getElementById(id);
const els = {
  urlInput: $("urlInput"), btnLoadUrl: $("btnLoadUrl"),
  btnUpload: $("btnUpload"), fileInput: $("fileInput"), btnPaste: $("btnPaste"),
  btnNew: $("btnNew"), dropzone: $("dropzone"), emptyState: $("emptyState"),
  previewWrap: $("previewWrap"), previewCanvas: $("previewCanvas"),
  cropLayer: $("cropLayer"), cropBox: $("cropBox"), srcInfo: $("srcInfo"),
  formatRow: $("formatRow"), qualityRow: $("qualityRow"),
  quality: $("quality"), qualityVal: $("qualityVal"),
  matteRow: $("matteRow"), matte: $("matte"),
  outW: $("outW"), outH: $("outH"), lockAspect: $("lockAspect"),
  scaleRow: $("scaleRow"), fitRow: $("fitRow"), cropBaseHint: $("cropBaseHint"),
  cropEnabled: $("cropEnabled"), cropAspect: $("cropAspect"), btnCropReset: $("btnCropReset"),
  btnRotL: $("btnRotL"), btnRotR: $("btnRotR"), btnRot180: $("btnRot180"),
  btnFlipH: $("btnFlipH"), btnFlipV: $("btnFlipV"), grayscale: $("grayscale"),
  targetKB: $("targetKB"), btnFitSize: $("btnFitSize"), fitStatus: $("fitStatus"),
  fileName: $("fileName"), outLine: $("outLine"),
  btnDownload: $("btnDownload"), btnCopy: $("btnCopy"),
  toast: $("toast"),
};

const S = {
  bitmap: null, epoch: 0,
  srcW: 0, srcH: 0, srcBytes: 0, baseName: "image",
  format: "png", quality: 85, matte: "#ffffff",
  rotate: 0, flipH: false, flipV: false, grayscale: false,
  cropEnabled: false, crop: null, aspect: "free",
  resize: { mode: "scale", scale: 1, w: 0, h: 0 },
  filenameDirty: false,
  encodeSupport: {},
  lastBlob: null, lastDims: { w: 0, h: 0 }, lastEncodeKey: "",
  orientedCache: { key: "", canvas: null },
  fitting: false,
};

const SCALE_PRESETS = [25, 50, 75, 100, 150, 200, 300];
const FIT_PRESETS = [
  { label: "1920", max: 1920 },
  { label: "1280", max: 1280 },
  { label: "800", max: 800 },
  { label: "512", max: 512 },
  { label: "256", max: 256 },
];

// ---------------------------------------------------------------- helpers

let toastTimer = null;
function toast(msg, kind = "") {
  els.toast.textContent = msg;
  els.toast.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 4200);
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function extApi() {
  return typeof browser !== "undefined" ? browser : (typeof chrome !== "undefined" ? chrome : null);
}

// ------------------------------------------------------------ format pills

function buildFormatPills() {
  els.formatRow.innerHTML = "";
  for (const f of SUPPORTED_FORMATS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = f.label;
    b.dataset.format = f.id;
    b.setAttribute("role", "radio");
    const ok = S.encodeSupport[f.id] !== false;
    b.disabled = !ok;
    b.title = ok ? `Convert to ${f.label}` : `${f.label} encoding is not supported by this browser`;
    b.setAttribute("aria-pressed", String(S.format === f.id));
    b.addEventListener("click", () => {
      if (!S.bitmap || !ok) return;
      S.format = f.id;
      syncFormatUI();
      scheduleEncode();
    });
    els.formatRow.appendChild(b);
  }
}

function syncFormatUI() {
  for (const b of els.formatRow.querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(b.dataset.format === S.format));
  }
  els.qualityRow.classList.toggle("hidden", !isLossy(S.format));
  const needsMatte = S.format === "jpeg" || S.format === "bmp";
  els.matteRow.classList.toggle("hidden", !needsMatte);
}

function buildScalePills() {
  els.scaleRow.innerHTML = "";
  for (const pct of SCALE_PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `${pct}%`;
    b.title = pct >= 100 ? `Scale to ${pct}% (${pct / 100}x pixel ratio)` : `Scale to ${pct}%`;
    b.addEventListener("click", () => {
      if (!S.bitmap) return;
      S.resize = { mode: "scale", scale: pct / 100, w: 0, h: 0 };
      syncDimsUI();
      scheduleEncode();
    });
    els.scaleRow.appendChild(b);
  }
  els.fitRow.innerHTML = "";
  for (const p of FIT_PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = p.label;
    b.title = `Fit longest side inside ${p.max}px`;
    b.addEventListener("click", () => {
      if (!S.bitmap) return;
      const base = croppedBaseDims();
      const fit = scaleDimsToFit(base.w, base.h, p.max, p.max);
      S.resize = { mode: "dims", scale: 1, w: fit.w, h: fit.h };
      syncDimsUI();
      scheduleEncode();
    });
    els.fitRow.appendChild(b);
  }
}

// ------------------------------------------------------------ geometry core

function orientedSize() {
  return rotateDims(S.srcW, S.srcH, S.rotate);
}

/** Oriented (rotate/flip/grayscale applied), full-resolution canvas. Cached. */
function orientedCanvas() {
  const key = `${S.epoch}|${S.rotate}|${S.flipH}|${S.flipV}|${S.grayscale}`;
  if (S.orientedCache.key === key && S.orientedCache.canvas) return S.orientedCache.canvas;
  const { w, h } = orientedSize();
  const canvas = renderToCanvas(S.bitmap, {
    rotate: S.rotate, flipH: S.flipH, flipV: S.flipV,
    grayscale: S.grayscale, outW: w, outH: h,
  });
  S.orientedCache = { key, canvas };
  return canvas;
}

function croppedBaseDims() {
  const o = orientedSize();
  if (S.cropEnabled && S.crop) {
    const c = normalizeCrop(S.crop, o.w, o.h);
    if (c) return { w: c.w, h: c.h };
  }
  return { w: o.w, h: o.h };
}

function outputDims() {
  const base = croppedBaseDims();
  if (S.resize.mode === "dims") {
    return {
      w: clampInt(S.resize.w, 1, 16000),
      h: clampInt(S.resize.h, 1, 16000),
    };
  }
  return computeOutputDims(base.w, base.h, { scale: S.resize.scale });
}

function syncDimsUI() {
  const d = outputDims();
  const base = croppedBaseDims();
  els.outW.value = d.w;
  els.outH.value = d.h;
  els.cropBaseHint.textContent = `Source area: ${base.w} × ${base.h}px. ` +
    (S.resize.mode === "scale"
      ? `Scale ${Math.round(S.resize.scale * 100)}% → ${d.w} × ${d.h}px.`
      : `Custom size (source ${base.w} × ${base.h}px).`);
  for (const b of els.scaleRow.querySelectorAll("button")) {
    const pct = Math.round(S.resize.scale * 100);
    b.setAttribute("aria-pressed", String(S.resize.mode === "scale" && b.textContent === `${pct}%`));
  }
}

// ------------------------------------------------------------------ preview

const PREVIEW_MAX_SIDE = 1400;

function refreshPreview() {
  if (!S.bitmap) return;
  const oriented = orientedCanvas();
  const { w: ow, h: oh } = orientedSize();
  const s = Math.min(1, PREVIEW_MAX_SIDE / Math.max(ow, oh));
  const pw = Math.max(1, Math.round(ow * s));
  const ph = Math.max(1, Math.round(oh * s));
  if (els.previewCanvas.width !== pw || els.previewCanvas.height !== ph) {
    els.previewCanvas.width = pw;
    els.previewCanvas.height = ph;
  }
  const ctx = els.previewCanvas.getContext("2d");
  ctx.clearRect(0, 0, pw, ph);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(oriented, 0, 0, pw, ph);

  els.emptyState.classList.add("hidden");
  els.previewWrap.classList.remove("hidden");
  layoutCropBox();
  els.srcInfo.textContent =
    `Original: ${S.srcW} × ${S.srcH}px` +
    (S.srcBytes ? ` · ${formatFileSize(S.srcBytes)}` : "") +
    (S.rotate || S.flipH || S.flipV ? ` · oriented ${ow} × ${oh}px` : "");
}

// ------------------------------------------------------------------ encode

const scheduleEncode = debounce(refreshEncode, 220);

async function refreshEncode() {
  if (!S.bitmap) return;
  const d = outputDims();
  const key = [
    S.epoch, S.format, S.quality, S.matte, S.rotate, S.flipH, S.flipV,
    S.grayscale, JSON.stringify(S.cropEnabled ? S.crop : null), d.w, d.h,
  ].join("|");
  if (key === S.lastEncodeKey && S.lastBlob) return;
  try {
    const oriented = orientedCanvas();
    const canvas = renderToCanvas(oriented, {
      crop: S.cropEnabled ? S.crop : null,
      outW: d.w, outH: d.h,
      background: (S.format === "jpeg" || S.format === "bmp") ? S.matte : null,
    });
    const mime = mimeForFormat(S.format);
    const q = isLossy(S.format) ? S.quality / 100 : undefined;
    const blob = await canvasToBlobAsync(canvas, mime, q);
    S.lastBlob = blob;
    S.lastDims = { w: d.w, h: d.h };
    S.lastEncodeKey = key;
    updateOutputLine();
  } catch (err) {
    console.error(err);
    els.outLine.textContent = `Encode failed: ${err.message}`;
  }
}

function updateOutputLine() {
  const { w, h } = S.lastDims;
  const f = SUPPORTED_FORMATS.find((x) => x.id === S.format);
  const size = S.lastBlob ? formatFileSize(S.lastBlob.size) : "—";
  els.outLine.innerHTML =
    `Output: <strong>${w} × ${h}px · ${f.label} · ${size}</strong>` +
    (isLossy(S.format) ? ` · q${S.quality}` : "");
  if (!S.filenameDirty) {
    els.fileName.value = buildFileName(S.baseName, w, h, extForFormat(S.format));
  }
}

// --------------------------------------------------------------------- crop

function aspectRatio() {
  if (S.aspect === "free") return null;
  const [a, b] = S.aspect.split(":").map(Number);
  return a / b;
}

/** Map oriented-pixel crop -> CSS px box inside the preview wrap. */
function layoutCropBox() {
  const show = S.cropEnabled && !!S.bitmap;
  els.cropLayer.classList.toggle("hidden", !show);
  if (!show) return;
  const { w: ow, h: oh } = orientedSize();
  const rect = els.previewCanvas.getBoundingClientRect();
  const wrapRect = els.previewWrap.getBoundingClientRect();
  const ox = rect.left - wrapRect.left;
  const oy = rect.top - wrapRect.top;
  const kx = rect.width / ow;
  const ky = rect.height / oh;
  if (!S.crop) defaultCrop();
  const c = S.crop;
  els.cropBox.style.left = `${ox + c.x * kx}px`;
  els.cropBox.style.top = `${oy + c.y * ky}px`;
  els.cropBox.style.width = `${Math.max(2, c.w * kx)}px`;
  els.cropBox.style.height = `${Math.max(2, c.h * ky)}px`;
}

function defaultCrop() {
  const { w: ow, h: oh } = orientedSize();
  const ratio = aspectRatio();
  let w = ow * 0.8;
  let h = oh * 0.8;
  if (ratio) {
    if (w / h > ratio) w = h * ratio;
    else h = w / ratio;
  }
  w = Math.min(w, ow);
  h = Math.min(h, oh);
  S.crop = {
    x: Math.round((ow - w) / 2),
    y: Math.round((oh - h) / 2),
    w: Math.round(w),
    h: Math.round(h),
  };
}

/** Write a CSS-px box (relative to canvas top-left) back to oriented pixels. */
function commitCropCss(x, y, w, h) {
  const { w: ow, h: oh } = orientedSize();
  const rect = els.previewCanvas.getBoundingClientRect();
  const kx = rect.width / ow;
  const ky = rect.height / oh;
  S.crop = normalizeCrop({
    x: x / kx,
    y: y / ky,
    w: w / kx,
    h: h / ky,
  }, ow, oh) || { x: 0, y: 0, w: ow, h: oh };
  if (S.resize.mode !== "dims") syncDimsUI();
  else {
    // keep custom dims, just refresh the hint line
    syncDimsUI();
    els.outW.value = S.resize.w;
    els.outH.value = S.resize.h;
  }
  layoutCropBox();
  scheduleEncode();
}

function setupCropDrag() {
  let drag = null;
  const MIN = 12; // min box size in CSS px

  els.cropBox.addEventListener("pointerdown", (e) => {
    if (!S.bitmap) return;
    e.preventDefault();
    els.cropBox.setPointerCapture(e.pointerId);
    const boxRect = els.cropBox.getBoundingClientRect();
    const canvasRect = els.previewCanvas.getBoundingClientRect();
    const h = e.target.dataset?.h || null;
    drag = {
      handle: h,
      startX: e.clientX, startY: e.clientY,
      orig: {
        x: boxRect.left - canvasRect.left,
        y: boxRect.top - canvasRect.top,
        w: boxRect.width, h: boxRect.height,
      },
      bounds: { w: canvasRect.width, h: canvasRect.height },
    };
  });

  els.cropBox.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const ratio = aspectRatio();
    let { x, y, w, h } = drag.orig;

    if (!drag.handle) {
      x = Math.min(Math.max(0, x + dx), drag.bounds.w - w);
      y = Math.min(Math.max(0, y + dy), drag.bounds.h - h);
    } else {
      if (drag.handle.includes("e")) w = drag.orig.w + dx;
      if (drag.handle.includes("s")) h = drag.orig.h + dy;
      if (drag.handle.includes("w")) { x = drag.orig.x + dx; w = drag.orig.w - dx; }
      if (drag.handle.includes("n")) { y = drag.orig.y + dy; h = drag.orig.h - dy; }
      if (ratio) {
        // Drive the locked side from the dominant drag axis.
        if (Math.abs(dx) >= Math.abs(dy)) h = w / ratio;
        else w = h * ratio;
        if (drag.handle.includes("w")) x = drag.orig.x + drag.orig.w - w;
        if (drag.handle.includes("n")) y = drag.orig.y + drag.orig.h - h;
      }
      w = Math.max(MIN, w);
      h = Math.max(MIN, h);
      x = Math.min(Math.max(0, x), drag.bounds.w - MIN);
      y = Math.min(Math.max(0, y), drag.bounds.h - MIN);
      w = Math.min(w, drag.bounds.w - x);
      h = Math.min(h, drag.bounds.h - y);
      if (ratio) {
        // Re-lock after clamping.
        if (w / h > ratio) w = h * ratio;
        else h = w / ratio;
      }
    }
    commitCropCss(x, y, w, h);
  });

  const end = () => { drag = null; };
  els.cropBox.addEventListener("pointerup", end);
  els.cropBox.addEventListener("pointercancel", end);
}

// ------------------------------------------------------------ source input

async function setSource(blob, baseName) {
  const bitmap = await loadBitmap(blob);
  const { w, h } = bitmapSize(bitmap);
  if (!w || !h) throw new Error("Could not decode image file");
  if (S.bitmap && S.bitmap.close) S.bitmap.close();
  S.bitmap = bitmap;
  S.epoch += 1;
  S.srcW = w;
  S.srcH = h;
  S.srcBytes = blob.size || 0;
  S.baseName = sanitizeBaseName(baseName, "image");
  // Reset transforms for the new image, keep format/quality prefs.
  S.rotate = 0; S.flipH = false; S.flipV = false; S.grayscale = false;
  S.cropEnabled = false; S.crop = null;
  S.resize = { mode: "scale", scale: 1, w: 0, h: 0 };
  S.filenameDirty = false;
  S.lastBlob = null; S.lastEncodeKey = "";
  S.orientedCache = { key: "", canvas: null };
  els.cropEnabled.checked = false;
  els.grayscale.checked = false;

  S.format = firstSupportedFormat(S.format);
  syncFormatUI();
  document.body.classList.remove("no-image");
  refreshPreview();
  syncDimsUI();
  await refreshEncode();
}

function resetAll() {
  if (S.bitmap && S.bitmap.close) S.bitmap.close();
  Object.assign(S, {
    bitmap: null, srcW: 0, srcH: 0, srcBytes: 0, baseName: "image",
    rotate: 0, flipH: false, flipV: false, grayscale: false,
    cropEnabled: false, crop: null,
    resize: { mode: "scale", scale: 1, w: 0, h: 0 },
    filenameDirty: false, lastBlob: null, lastEncodeKey: "",
    orientedCache: { key: "", canvas: null },
  });
  els.previewWrap.classList.add("hidden");
  els.emptyState.classList.remove("hidden");
  els.srcInfo.textContent = "No image loaded.";
  els.outLine.textContent = "—";
  els.fileName.value = "";
  els.cropEnabled.checked = false;
  els.grayscale.checked = false;
  document.body.classList.add("no-image");
}

async function loadFromUrl(url) {
  url = (url || "").trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) image links are supported");
  els.btnLoadUrl.disabled = true;
  try {
    const blob = await fetchImageBlob(url);
    await setSource(blob, baseNameFromUrl(url));
  } finally {
    els.btnLoadUrl.disabled = false;
  }
}

async function loadFromBlob(blob, name) {
  if (!blob) return;
  if (blob.type && !blob.type.startsWith("image/")) {
    throw new Error(`Not an image (got ${blob.type})`);
  }
  await setSource(blob, name || "pasted-image");
}

async function pasteFromClipboard() {
  // Preferred: async clipboard read (needs focus + permission).
  try {
    if (navigator.clipboard && navigator.clipboard.read) {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (type) {
          const blob = await item.getType(type);
          await loadFromBlob(blob, "pasted-image");
          return true;
        }
        if (item.types.includes("text/plain")) {
          const text = (await (await item.getType("text/plain")).text()).trim();
          if (/^https?:\/\//i.test(text)) {
            els.urlInput.value = text;
            await loadFromUrl(text);
            return true;
          }
        }
      }
    }
  } catch (err) {
    if (err?.name === "NotAllowedError") {
      toast("Clipboard blocked by the browser — press Ctrl+V instead.", "error");
      return true;
    }
    // fall through to hint
  }
  toast("Press Ctrl+V to paste an image or link.");
  return false;
}

async function consumeSessionImport() {
  try {
    const api = extApi();
    const store = api?.storage?.session;
    if (!store) return false;
    const got = await store.get("imageforge-import");
    const imp = got && got["imageforge-import"];
    if (!imp || !imp.dataUrl) return false;
    await store.remove("imageforge-import");
    const blob = await (await fetch(imp.dataUrl)).blob();
    await loadFromBlob(blob, imp.name || "image");
    return true;
  } catch (err) {
    console.warn("session import failed", err);
    return false;
  }
}

async function consumeQueryImport() {
  const src = new URLSearchParams(location.search).get("src");
  if (!src) return false;
  els.urlInput.value = src;
  try {
    await loadFromUrl(src);
  } catch (err) {
    toast(`Could not load image: ${err.message}`, "error");
  }
  history.replaceState(null, "", location.pathname);
  return true;
}

// ---------------------------------------------------------- fit to file size

function setFitStatus(msg, kind = "") {
  els.fitStatus.textContent = msg;
  els.fitStatus.className = `hint ${kind}`;
}

async function fitToSize() {
  if (!S.bitmap || S.fitting) return;
  const target = parseTargetKB(els.targetKB.value);
  if (!target) {
    setFitStatus("Enter a target size in KB first.", "bad");
    return;
  }
  S.fitting = true;
  els.btnFitSize.disabled = true;
  setFitStatus("Compressing…");
  try {
    await refreshEncode();
    if (S.lastBlob && S.lastBlob.size <= target) {
      setFitStatus(`Already ${formatFileSize(S.lastBlob.size)} — under the limit.`, "ok");
      return;
    }
    const oriented = orientedCanvas();
    const base = outputDims();
    const lossless = !isLossy(S.format);
    const bg = (S.format === "jpeg" || S.format === "bmp") ? S.matte : null;
    const renderAt = async (q01, scale) => {
      const w = Math.max(1, Math.round(base.w * scale));
      const h = Math.max(1, Math.round(base.h * scale));
      const canvas = renderToCanvas(oriented, {
        crop: S.cropEnabled ? S.crop : null, outW: w, outH: h, background: bg,
      });
      return canvasToBlobAsync(canvas, mimeForFormat(S.format), lossless ? undefined : q01);
    };
    const res = await compressToTargetSize(renderAt, target, lossless ? { rounds: 1 } : {});
    // Adopt the winning settings so Download reproduces them.
    if (!lossless) {
      S.quality = clampInt(Math.round(res.quality * 100), 1, 100);
      els.quality.value = S.quality;
      els.qualityVal.textContent = S.quality;
    }
    const base0 = croppedBaseDims();
    if (S.resize.mode === "scale") {
      S.resize.scale = Math.max(0.01, (base.w * res.scale) / base0.w);
    } else {
      S.resize.w = Math.max(1, Math.round(base.w * res.scale));
      S.resize.h = Math.max(1, Math.round(base.h * res.scale));
    }
    S.lastBlob = null;
    S.lastEncodeKey = "";
    syncDimsUI();
    await refreshEncode();
    if (res.fits) {
      setFitStatus(
        `Fits: ${formatFileSize(res.blob.size)}` +
        (lossless ? "" : ` at q${Math.round(res.quality * 100)}`) +
        (res.scale < 0.999 ? `, scaled to ${Math.round(res.scale * 100)}%.` : "."),
        "ok",
      );
    } else {
      setFitStatus(
        `Smallest possible is ${formatFileSize(res.blob.size)} — try ${S.format === "png" ? "JPEG/WebP" : "a smaller size"}.`,
        "bad",
      );
    }
  } catch (err) {
    setFitStatus(`Failed: ${err.message}`, "bad");
  } finally {
    S.fitting = false;
    els.btnFitSize.disabled = false;
  }
}

// --------------------------------------------------------------- output I/O

function downloadName() {
  let name = els.fileName.value.trim() || buildFileName(S.baseName, S.lastDims.w, S.lastDims.h, extForFormat(S.format));
  const want = `.${extForFormat(S.format)}`;
  if (!name.toLowerCase().endsWith(want)) name += want;
  return name;
}

async function doDownload() {
  if (!S.bitmap) return;
  await refreshEncode();
  if (!S.lastBlob) {
    toast("Nothing to download yet.", "error");
    return;
  }
  const url = URL.createObjectURL(S.lastBlob);
  const a = document.createElement("a");
  a.href = url;
  a.download = downloadName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`Saved ${downloadName()} (${formatFileSize(S.lastBlob.size)})`);
}

async function doCopy() {
  if (!S.bitmap) return;
  await refreshEncode();
  if (!S.lastBlob) return;
  try {
    const mime = S.lastBlob.type || mimeForFormat(S.format);
    // Clipboard API prefers PNG; re-encode when needed.
    let blob = S.lastBlob;
    if (mime !== "image/png") {
      const d = S.lastDims;
      const canvas = renderToCanvas(orientedCanvas(), {
        crop: S.cropEnabled ? S.crop : null, outW: d.w, outH: d.h,
      });
      blob = await canvasToBlobAsync(canvas, "image/png");
    }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("Copied to clipboard as PNG.");
  } catch (err) {
    console.error(err);
    toast("Copy failed — the browser blocked clipboard access.", "error");
  }
}

// ------------------------------------------------------------------- events

function onDimsInput(which) {
  if (!S.bitmap) return;
  const w = parseInt(els.outW.value, 10);
  const h = parseInt(els.outH.value, 10);
  if (els.lockAspect.checked) {
    const base = croppedBaseDims();
    if (which === "w" && Number.isFinite(w) && w > 0) {
      S.resize = { mode: "dims", scale: 1, w, h: Math.max(1, Math.round((base.h * w) / base.w)) };
    } else if (which === "h" && Number.isFinite(h) && h > 0) {
      S.resize = { mode: "dims", scale: 1, w: Math.max(1, Math.round((base.w * h) / base.h)), h };
    } else {
      return;
    }
    els.outW.value = S.resize.w;
    els.outH.value = S.resize.h;
  } else {
    S.resize = {
      mode: "dims", scale: 1,
      w: Number.isFinite(w) && w > 0 ? w : outputDims().w,
      h: Number.isFinite(h) && h > 0 ? h : outputDims().h,
    };
  }
  syncDimsUI();
  els.outW.value = S.resize.w;
  els.outH.value = S.resize.h;
  scheduleEncode();
}

function wireEvents() {
  els.btnLoadUrl.addEventListener("click", () =>
    loadFromUrl(els.urlInput.value).catch((e) => toast(`Could not load: ${e.message}`, "error")));
  els.urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") els.btnLoadUrl.click();
  });

  els.btnUpload.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", () => {
    const f = els.fileInput.files[0];
    if (f) loadFromBlob(f, f.name).catch((e) => toast(e.message, "error"));
    els.fileInput.value = "";
  });

  els.btnPaste.addEventListener("click", () =>
    pasteFromClipboard().catch((e) => toast(e.message, "error")));
  els.btnNew.addEventListener("click", resetAll);

  document.addEventListener("paste", async (e) => {
    if (e.target === els.urlInput || e.target === els.fileName || e.target === els.targetKB) return;
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      try {
        await loadFromBlob(files[0], "pasted-image");
      } catch (err) {
        toast(err.message, "error");
      }
      return;
    }
    const text = (e.clipboardData?.getData("text") || "").trim();
    if (/^https?:\/\//i.test(text)) {
      e.preventDefault();
      els.urlInput.value = text;
      try {
        await loadFromUrl(text);
      } catch (err) {
        toast(`Could not load: ${err.message}`, "error");
      }
    }
  });

  for (const ev of ["dragenter", "dragover"]) {
    els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.add("over"); });
  }
  for (const ev of ["dragleave", "drop"]) {
    els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.remove("over"); });
  }
  els.dropzone.addEventListener("drop", (e) => {
    const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith("image/"));
    if (f) loadFromBlob(f, f.name).catch((err) => toast(err.message, "error"));
  });

  els.quality.addEventListener("input", () => {
    S.quality = parseInt(els.quality.value, 10);
    els.qualityVal.textContent = S.quality;
    scheduleEncode();
  });
  els.matte.addEventListener("input", () => { S.matte = els.matte.value; scheduleEncode(); });

  els.outW.addEventListener("change", () => onDimsInput("w"));
  els.outH.addEventListener("change", () => onDimsInput("h"));

  els.cropEnabled.addEventListener("change", () => {
    S.cropEnabled = els.cropEnabled.checked;
    if (S.cropEnabled && !S.crop) defaultCrop();
    if (S.resize.mode !== "dims") syncDimsUI();
    refreshPreview();
    scheduleEncode();
  });
  els.cropAspect.addEventListener("change", () => {
    S.aspect = els.cropAspect.value;
    if (S.cropEnabled) {
      defaultCrop(); // re-center under the new ratio
      if (S.resize.mode !== "dims") syncDimsUI();
      refreshPreview();
      scheduleEncode();
    }
  });
  els.btnCropReset.addEventListener("click", () => {
    if (!S.bitmap) return;
    defaultCrop();
    if (S.resize.mode !== "dims") syncDimsUI();
    refreshPreview();
    scheduleEncode();
  });

  const reorient = () => { refreshPreview(); syncDimsUI(); scheduleEncode(); };
  els.btnRotL.addEventListener("click", () => { S.rotate = (S.rotate + 270) % 360; S.crop = null; reorient(); });
  els.btnRotR.addEventListener("click", () => { S.rotate = (S.rotate + 90) % 360; S.crop = null; reorient(); });
  els.btnRot180.addEventListener("click", () => { S.rotate = (S.rotate + 180) % 360; S.crop = null; reorient(); });
  els.btnFlipH.addEventListener("click", () => { S.flipH = !S.flipH; reorient(); });
  els.btnFlipV.addEventListener("click", () => { S.flipV = !S.flipV; reorient(); });
  els.grayscale.addEventListener("change", () => { S.grayscale = els.grayscale.checked; reorient(); });

  els.btnFitSize.addEventListener("click", fitToSize);
  els.targetKB.addEventListener("keydown", (e) => { if (e.key === "Enter") fitToSize(); });

  els.fileName.addEventListener("input", () => { S.filenameDirty = true; });
  els.btnDownload.addEventListener("click", () => doDownload().catch((e) => toast(e.message, "error")));
  els.btnCopy.addEventListener("click", doCopy);

  window.addEventListener("resize", debounce(() => layoutCropBox(), 100));
}

// --------------------------------------------------------------------- init

async function init() {
  S.encodeSupport = detectEncodeSupport();
  S.format = firstSupportedFormat("png");
  buildFormatPills();
  syncFormatUI();
  buildScalePills();
  setupCropDrag();
  wireEvents();
  if (!(await consumeSessionImport())) await consumeQueryImport();
}

init().catch((e) => {
  console.error(e);
  toast(`Startup failed: ${e.message}`, "error");
});

