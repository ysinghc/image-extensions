import {
  SUPPORTED_FORMATS,
  mimeForFormat,
  extForFormat,
  isLossy,
  formatFileSize,
  parseTargetKB,
  scaleDimsToFit,
  sanitizeBaseName,
  baseNameFromUrl,
  buildFileName,
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
  btnEditor: $("btnEditor"), urlInput: $("urlInput"), btnGo: $("btnGo"),
  btnUpload: $("btnUpload"), fileInput: $("fileInput"), btnPaste: $("btnPaste"),
  loadedGroup: $("loadedGroup"), thumb: $("thumb"), srcInfo: $("srcInfo"),
  formatRow: $("formatRow"), qualityRow: $("qualityRow"),
  quality: $("quality"), qualityVal: $("qualityVal"),
  maxSide: $("maxSide"), targetKB: $("targetKB"),
  btnConvert: $("btnConvert"), btnSendEditor: $("btnSendEditor"),
  status: $("status"),
};

const S = {
  bitmap: null, srcBlob: null, thumbUrl: "",
  srcW: 0, srcH: 0, srcBytes: 0, baseName: "image", srcUrl: "",
  format: "png", quality: 85, support: {},
  busy: false,
};

function setStatus(msg, kind = "") {
  els.status.textContent = msg;
  els.status.className = `status ${kind}`;
}

function extApi() {
  return typeof browser !== "undefined" ? browser : (typeof chrome !== "undefined" ? chrome : null);
}

// ------------------------------------------------------------------- source

async function setSource(blob, { name, srcUrl = "" }) {
  const bitmap = await loadBitmap(blob);
  const { w, h } = bitmapSize(bitmap);
  if (!w || !h) throw new Error("Could not decode image file");
  if (S.bitmap?.close) S.bitmap.close();
  if (S.thumbUrl) URL.revokeObjectURL(S.thumbUrl);
  S.bitmap = bitmap;
  S.srcBlob = blob;
  S.srcW = w; S.srcH = h;
  S.srcBytes = blob.size || 0;
  S.baseName = sanitizeBaseName(name, "image");
  S.srcUrl = srcUrl;
  S.thumbUrl = URL.createObjectURL(blob);
  S.format = firstSupportedFormat(S.format);

  els.thumb.src = S.thumbUrl;
  els.srcInfo.textContent = `${w} × ${h}px` + (S.srcBytes ? ` · ${formatFileSize(S.srcBytes)}` : "") +
    (blob.type ? ` · ${blob.type.replace("image/", "").toUpperCase()}` : "");
  els.loadedGroup.classList.remove("hidden");
  els.btnConvert.disabled = false;
  els.btnSendEditor.disabled = false;
  syncFormatUI();
  setStatus("Ready — pick a format and convert.");
}

async function loadFromUrl(url) {
  url = (url || "").trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) image links are supported");
  setStatus("Loading…");
  const blob = await fetchImageBlob(url);
  await setSource(blob, { name: baseNameFromUrl(url), srcUrl: url });
}

async function loadFromBlob(blob, name) {
  if (!blob) return;
  if (blob.type && !blob.type.startsWith("image/")) throw new Error(`Not an image (got ${blob.type})`);
  await setSource(blob, { name: name || "pasted-image" });
}

// ------------------------------------------------------------------ convert

function syncFormatUI() {
  els.formatRow.innerHTML = "";
  for (const f of SUPPORTED_FORMATS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = f.label;
    b.disabled = S.support[f.id] === false;
    b.title = b.disabled ? `${f.label} is not supported by this browser` : `Convert to ${f.label}`;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-pressed", String(S.format === f.id));
    b.addEventListener("click", () => {
      if (b.disabled) return;
      S.format = f.id;
      syncFormatUI();
    });
    els.formatRow.appendChild(b);
  }
  els.qualityRow.style.display = isLossy(S.format) ? "" : "none";
}

function targetDims() {
  const max = parseInt(els.maxSide.value, 10);
  if (!max) return { w: S.srcW, h: S.srcH };
  return scaleDimsToFit(S.srcW, S.srcH, max, max);
}

async function doConvert() {
  if (!S.bitmap || S.busy) return;
  S.busy = true;
  els.btnConvert.disabled = true;
  try {
    const base = targetDims();
    const target = parseTargetKB(els.targetKB.value);
    const lossless = !isLossy(S.format);
    const mime = mimeForFormat(S.format);
    const bg = (S.format === "jpeg" || S.format === "bmp") ? "#ffffff" : null;
    let blob;
    let note = "";

    if (target) {
      setStatus("Compressing to fit…");
      const renderAt = async (q01, scale) => {
        const canvas = renderToCanvas(S.bitmap, {
          outW: Math.max(1, Math.round(base.w * scale)),
          outH: Math.max(1, Math.round(base.h * scale)),
          background: bg,
        });
        return canvasToBlobAsync(canvas, mime, lossless ? undefined : q01);
      };
      const res = await compressToTargetSize(renderAt, target, lossless ? { rounds: 1 } : {});
      blob = res.blob;
      const dw = Math.max(1, Math.round(base.w * res.scale));
      const dh = Math.max(1, Math.round(base.h * res.scale));
      note = res.fits
        ? ` (${dw}×${dh}, fits ${formatFileSize(target)})`
        : ` (smallest possible: ${formatFileSize(blob.size)})`;
      downloadBlob(blob, buildFileName(S.baseName, dw, dh, extForFormat(S.format)));
      setStatus(res.fits ? `Saved ${formatFileSize(blob.size)}${note}.` : `Saved, but over target${note}.`, res.fits ? "ok" : "bad");
    } else {
      const canvas = renderToCanvas(S.bitmap, { outW: base.w, outH: base.h, background: bg });
      blob = await canvasToBlobAsync(canvas, mime, lossless ? undefined : S.quality / 100);
      downloadBlob(blob, buildFileName(S.baseName, base.w, base.h, extForFormat(S.format)));
      setStatus(`Saved ${base.w}×${base.h} ${S.format.toUpperCase()} · ${formatFileSize(blob.size)}.`, "ok");
    }
  } catch (err) {
    console.error(err);
    setStatus(`Failed: ${err.message}`, "bad");
  } finally {
    S.busy = false;
    els.btnConvert.disabled = false;
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ------------------------------------------------------------------- editor

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("Could not read image data"));
    r.readAsDataURL(blob);
  });
}

async function openEditor(withCurrent) {
  const api = extApi();
  if (!api?.tabs?.create || !api?.runtime?.getURL) {
    setStatus("Cannot open the editor from here.", "bad");
    return;
  }
  if (withCurrent && S.srcUrl) {
    await api.tabs.create({ url: api.runtime.getURL(`editor.html?src=${encodeURIComponent(S.srcUrl)}`) });
    window.close();
    return;
  }
  if (withCurrent && S.srcBlob) {
    try {
      const store = api.storage?.session;
      if (!store) throw new Error("session storage unavailable");
      await store.set({
        "imageforge-import": { dataUrl: await blobToDataUrl(S.srcBlob), name: S.baseName },
      });
      await api.tabs.create({ url: api.runtime.getURL("editor.html") });
      window.close();
      return;
    } catch (err) {
      console.error(err);
      setStatus("Could not hand the image to the editor (too large?).", "bad");
      return;
    }
  }
  await api.tabs.create({ url: api.runtime.getURL("editor.html") });
  window.close();
}

// ------------------------------------------------------------------- events

function wireEvents() {
  els.btnGo.addEventListener("click", () =>
    loadFromUrl(els.urlInput.value).catch((e) => setStatus(`Could not load: ${e.message}`, "bad")));
  els.urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") els.btnGo.click();
  });
  els.btnUpload.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", () => {
    const f = els.fileInput.files[0];
    if (f) loadFromBlob(f, f.name).catch((e) => setStatus(e.message, "bad"));
    els.fileInput.value = "";
  });
  els.btnPaste.addEventListener("click", async () => {
    try {
      if (!navigator.clipboard?.read) throw new Error("clipboard API unavailable");
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (type) {
          await loadFromBlob(await item.getType(type), "pasted-image");
          return;
        }
      }
      setStatus("Clipboard has no image — copy one first.", "bad");
    } catch {
      setStatus("Clipboard blocked — press Ctrl+V instead.", "bad");
    }
  });
  document.addEventListener("paste", async (e) => {
    if (e.target === els.urlInput || e.target === els.targetKB) return;
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      loadFromBlob(files[0], "pasted-image").catch((err) => setStatus(err.message, "bad"));
      return;
    }
    const text = (e.clipboardData?.getData("text") || "").trim();
    if (/^https?:\/\//i.test(text)) {
      e.preventDefault();
      els.urlInput.value = text;
      loadFromUrl(text).catch((err) => setStatus(`Could not load: ${err.message}`, "bad"));
    }
  });

  els.quality.addEventListener("input", () => {
    S.quality = parseInt(els.quality.value, 10);
    els.qualityVal.textContent = S.quality;
  });

  els.btnConvert.addEventListener("click", doConvert);
  els.btnEditor.addEventListener("click", () => openEditor(false));
  els.btnSendEditor.addEventListener("click", () => openEditor(true));
}

S.support = detectEncodeSupport();
S.format = firstSupportedFormat("png");
syncFormatUI();
wireEvents();
