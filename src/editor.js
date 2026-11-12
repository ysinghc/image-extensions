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
  btnNew: $("btnNew"), btnDownloadTop: $("btnDownloadTop"), topOut: $("topOut"),
  dropzone: $("dropzone"), emptyState: $("emptyState"),
  previewWrap: $("previewWrap"), previewCanvas: $("previewCanvas"),
  cropLayer: $("cropLayer"), cropBox: $("cropBox"),
  shades: { top: $("shadeTop"), right: $("shadeRight"), bottom: $("shadeBottom"), left: $("shadeLeft") },
  cropFloatApply: $("cropFloatApply"), srcInfo: $("srcInfo"),
  stepsList: $("stepsList"), noSteps: $("noSteps"),
  toolGrid: $("toolGrid"), toolPanel: $("toolPanel"),
  toolTitle: $("toolTitle"), toolClose: $("toolClose"),
  panels: {
    crop: $("panel-crop"), resize: $("panel-resize"),
    rotate: $("panel-rotate"), adjust: $("panel-adjust"),
  },
  cropAspect: $("cropAspect"), btnCropReset: $("btnCropReset"),
  btnCropApply: $("btnCropApply"), btnCropRemove: $("btnCropRemove"),
  resizeIO: $("resizeIO"), outW: $("outW"), outH: $("outH"),
  lockAspect: $("lockAspect"), scaleRow: $("scaleRow"), fitRow: $("fitRow"),
  btnResizeReset: $("btnResizeReset"),
  rotateState: $("rotateState"), btnRotL: $("btnRotL"), btnRotR: $("btnRotR"),
  btnRot180: $("btnRot180"), btnFlipH: $("btnFlipH"), btnFlipV: $("btnFlipV"),
  btnRotateReset: $("btnRotateReset"), grayscale: $("grayscale"),
  formatRow: $("formatRow"), qualityRow: $("qualityRow"),
  quality: $("quality"), qualityVal: $("qualityVal"),
  matteRow: $("matteRow"), matte: $("matte"),
  targetKB: $("targetKB"), btnFitSize: $("btnFitSize"), fitStatus: $("fitStatus"),
  fileName: $("fileName"), outLine: $("outLine"),
  btnDownload: $("btnDownload"), btnCopy: $("btnCopy"),
  toast: $("toast"),
};

// Steps: ordered pixel ops, each feeding the next.
//   crop   { rel: {x,y,w,h} }            relative coords, 0..1
//   resize { mode:'scale', scale } | { mode:'dims', w, h }
//   rotate { rotate: 0|90|180|270, flipH, flipV }
//   adjust { grayscale: bool }
// Export (format/quality/size limit) is always terminal, not a step.
const S = {
  bitmap: null, epoch: 0,
  srcW: 0, srcH: 0, srcBytes: 0, baseName: "image",
  steps: [],
  activeTool: null, cropDraft: null, cropAspect: "free",
  format: "png", quality: 85, matte: "#ffffff",
  fit: null, // { scale, quality, targetBytes }
  filenameDirty: false,
  encodeSupport: {},
  lastBlob: null, lastDims: { w: 0, h: 0 }, lastEncodeKey: "",
  pipeCache: { key: "", canvas: null, w: 0, h: 0, log: [] },
  fitting: false,
};

const TOOL_TITLES = { crop: "Crop", resize: "Resize", rotate: "Rotate & flip", adjust: "Adjust" };
const SCALE_PRESETS = [25, 50, 75, 100, 150, 200, 300];
const FIT_PRESETS = [
  { label: "1920", max: 1920 },
  { label: "1280", max: 1280 },
  { label: "800", max: 800 },
  { label: "512", max: 512 },
  { label: "256", max: 256 },
];
const PREVIEW_MAX_SIDE = 1400;

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

function dimsStr(d) {
  return `${d.w} \u00d7 ${d.h}`;
}

function extApi() {
  return typeof browser !== "undefined" ? browser : (typeof chrome !== "undefined" ? chrome : null);
}

// ------------------------------------------------------------ pipeline core

function stepIndex(tool) {
  return S.steps.findIndex((s) => s.tool === tool);
}

function getStep(tool) {
  return S.steps.find((s) => s.tool === tool) || null;
}

function setStep(tool, params) {
  const i = stepIndex(tool);
  if (!params) {
    if (i >= 0) S.steps.splice(i, 1);
  } else if (i >= 0) {
    S.steps[i].params = params;
  } else {
    S.steps.push({ tool, params });
  }
  S.pipeCache.key = "";
}

function moveStep(i, dir) {
  const j = i + dir;
  if (i < 0 || j < 0 || j >= S.steps.length) return;
  [S.steps[i], S.steps[j]] = [S.steps[j], S.steps[i]];
  S.pipeCache.key = "";
}

/** Render steps[0..upto) in order. Returns {canvas,w,h,log}. Cached for full runs. */
function renderPipeline(upto = Infinity) {
  if (!S.bitmap) return null;
  const key = `${S.epoch}|${JSON.stringify(S.steps.slice(0, upto))}`;
  if (upto === Infinity && S.pipeCache.key === key && S.pipeCache.canvas) return S.pipeCache;
  let src = S.bitmap;
  let w = S.srcW;
  let h = S.srcH;
  const log = [];
  for (const st of S.steps.slice(0, upto)) {
    if (st.tool === "crop") {
      const r = st.params.rel;
      const abs = normalizeCrop({ x: r.x * w, y: r.y * h, w: r.w * w, h: r.h * h }, w, h)
        || { x: 0, y: 0, w, h };
      src = renderToCanvas(src, { crop: abs, outW: abs.w, outH: abs.h });
    } else if (st.tool === "rotate") {
      const d = rotateDims(w, h, st.params.rotate);
      src = renderToCanvas(src, {
        rotate: st.params.rotate, flipH: st.params.flipH, flipV: st.params.flipV,
        outW: d.w, outH: d.h,
      });
    } else if (st.tool === "resize") {
      const t = st.params.mode === "dims"
        ? { w: clampInt(st.params.w, 1, 16000), h: clampInt(st.params.h, 1, 16000) }
        : computeOutputDims(w, h, { scale: st.params.scale });
      src = renderToCanvas(src, { outW: t.w, outH: t.h });
    } else if (st.tool === "adjust") {
      src = renderToCanvas(src, { grayscale: st.params.grayscale, outW: w, outH: h });
    }
    w = src.width;
    h = src.height;
    log.push({ w, h });
  }
  const out = { canvas: src, w, h, log };
  if (upto === Infinity) S.pipeCache = { ...out, key };
  return out;
}

/** Dims entering step i (original size for i=0). */
function inputDimsAt(i) {
  if (i <= 0) return { w: S.srcW, h: S.srcH };
  const full = renderPipeline();
  return full.log[i - 1] || { w: S.srcW, h: S.srcH };
}

/** Dims entering the named tool's step, or the pipeline output when absent. */
function toolInputDims(tool) {
  const i = stepIndex(tool);
  if (i < 0) {
    const full = renderPipeline();
    return { w: full.w, h: full.h };
  }
  return inputDimsAt(i);
}

function outputDims() {
  const pipe = renderPipeline();
  const s = S.fit ? S.fit.scale : 1;
  return { w: Math.max(1, Math.round(pipe.w * s)), h: Math.max(1, Math.round(pipe.h * s)) };
}

function isCanvas(src) {
  return !!src && (typeof src.toBlob === "function" || typeof src.convertToBlob === "function");
}

/** Final export canvas: pipeline output + fit scale + matte when needed. */
function exportCanvas() {
  const pipe = renderPipeline();
  const d = outputDims();
  const matte = (S.format === "jpeg" || S.format === "bmp") ? S.matte : null;
  if (!matte && d.w === pipe.w && d.h === pipe.h && isCanvas(pipe.canvas)) {
    return { canvas: pipe.canvas, ...d };
  }
  return { canvas: renderToCanvas(pipe.canvas, { outW: d.w, outH: d.h, background: matte }), ...d };
}

/** Central refresh after any step add/edit/remove/reorder. */
function afterStepsChanged() {
  renderSteps();
  syncActivePanel();
  refreshPreview();
  clearFit("Fit cleared — the pipeline changed, refit to reapply.");
  scheduleEncode();
}

// ------------------------------------------------------------------- pills

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
      clearFit("Fit cleared — the format changed, refit to reapply.");
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
      if (pct === 100) setStep("resize", null);
      else setStep("resize", { mode: "scale", scale: pct / 100 });
      afterStepsChanged();
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
      const base = toolInputDims("resize");
      const fit = scaleDimsToFit(base.w, base.h, p.max, p.max);
      setStep("resize", { mode: "dims", w: fit.w, h: fit.h });
      afterStepsChanged();
    });
    els.fitRow.appendChild(b);
  }
}

// ---------------------------------------------------------------- step list

function stepSummary(st, input) {
  if (st.tool === "crop") {
    const r = st.params.rel;
    const abs = normalizeCrop({ x: r.x * input.w, y: r.y * input.h, w: r.w * input.w, h: r.h * input.h }, input.w, input.h)
      || { w: input.w, h: input.h };
    return `to ${dimsStr(abs)}`;
  }
  if (st.tool === "resize") {
    const p = st.params;
    if (p.mode === "scale") {
      const out = computeOutputDims(input.w, input.h, { scale: p.scale });
      return `${Math.round(p.scale * 100)}% · ${dimsStr(out)}`;
    }
    return `to ${dimsStr({ w: p.w, h: p.h })}`;
  }
  if (st.tool === "rotate") {
    const parts = [];
    if (st.params.rotate) parts.push(`${st.params.rotate}°`);
    if (st.params.flipH) parts.push("flip H");
    if (st.params.flipV) parts.push("flip V");
    return parts.join(" · ") || "original";
  }
  if (st.tool === "adjust") {
    return st.params.grayscale ? "grayscale" : "original";
  }
  return "";
}

function renderSteps() {
  els.stepsList.innerHTML = "";
  els.noSteps.classList.toggle("hidden", S.steps.length > 0 || !S.bitmap);
  if (!S.bitmap) {
    syncToolGrid();
    return;
  }
  const full = renderPipeline();
  const origin = document.createElement("li");
  origin.className = "origin";
  origin.innerHTML = `<span class="node" aria-hidden="true"></span>
    <div class="endpoint"><b>Original</b> · ${dimsStr({ w: S.srcW, h: S.srcH })}</div>`;
  els.stepsList.appendChild(origin);

  S.steps.forEach((st, i) => {
    const li = document.createElement("li");
    li.className = "step";
    const input = i === 0 ? { w: S.srcW, h: S.srcH } : full.log[i - 1];
    const out = full.log[i];
    li.innerHTML = `<span class="node" aria-hidden="true">${i + 1}</span>`;
    const card = document.createElement("button");
    card.type = "button";
    card.className = "step-card" + (S.activeTool === st.tool ? " active" : "");
    card.dataset.edit = String(i);
    card.title = `Edit ${TOOL_TITLES[st.tool]}`;
    const label = document.createElement("span");
    label.className = "step-text";
    const b = document.createElement("b");
    b.textContent = TOOL_TITLES[st.tool];
    const sub = document.createElement("i");
    sub.textContent = stepSummary(st, input);
    label.append(b, sub);
    const dims = document.createElement("span");
    dims.className = "step-dims";
    dims.textContent = dimsStr(out);
    card.append(label, dims);
    li.appendChild(card);

    const btns = document.createElement("span");
    btns.className = "step-btns";
    const mk = (action, text, title, disabled) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = text;
      btn.title = title;
      btn.disabled = !!disabled;
      btn.dataset.action = action;
      btn.dataset.i = String(i);
      if (action === "remove") btn.classList.add("remove");
      return btn;
    };
    btns.append(
      mk("up", "↑", "Move earlier", i === 0),
      mk("down", "↓", "Move later", i === S.steps.length - 1),
      mk("remove", "×", `Remove ${TOOL_TITLES[st.tool]}`),
    );
    li.appendChild(btns);
    els.stepsList.appendChild(li);
  });

  const d = outputDims();
  const end = document.createElement("li");
  end.className = "output";
  end.innerHTML = `<span class="node" aria-hidden="true"></span>
    <div class="endpoint"><b>Output</b> · ${dimsStr(d)}${S.fit && S.fit.scale < 0.999 ? ` · scaled ${Math.round(S.fit.scale * 100)}%` : ""}</div>`;
  els.stepsList.appendChild(end);
  syncToolGrid();
}

function syncToolGrid() {
  for (const b of els.toolGrid.querySelectorAll("button")) {
    const tool = b.dataset.tool;
    b.setAttribute("aria-expanded", String(S.activeTool === tool));
    let dot = b.querySelector(".dot");
    if (stepIndex(tool) >= 0) {
      if (!dot) {
        dot = document.createElement("span");
        dot.className = "dot";
        dot.setAttribute("aria-hidden", "true");
        b.appendChild(dot);
      }
    } else if (dot) {
      dot.remove();
    }
  }
}

// ------------------------------------------------------------- tool panels

function openTool(tool) {
  if (!S.bitmap) return;
  S.activeTool = tool;
  els.toolPanel.classList.remove("hidden");
  els.toolTitle.textContent = TOOL_TITLES[tool];
  for (const [name, panel] of Object.entries(els.panels)) {
    panel.classList.toggle("hidden", name !== tool);
  }
  if (tool === "crop") {
    const committed = getStep("crop");
    S.cropDraft = committed ? { ...committed.params.rel } : defaultCropRel(cropInputDims());
  }
  syncActivePanel();
  refreshPreview();
  renderSteps();
}

function closeTool() {
  S.activeTool = null;
  S.cropDraft = null;
  els.toolPanel.classList.add("hidden");
  refreshPreview();
  renderSteps();
}

function syncActivePanel() {
  if (!S.bitmap || !S.activeTool) return;
  if (S.activeTool === "resize") syncResizePanel();
  else if (S.activeTool === "rotate") syncRotatePanel();
  else if (S.activeTool === "adjust") syncAdjustPanel();
  else if (S.activeTool === "crop") layoutCropBox();
}

function syncResizePanel() {
  const input = toolInputDims("resize");
  const st = getStep("resize");
  const out = st
    ? (st.params.mode === "dims"
      ? { w: clampInt(st.params.w, 1, 16000), h: clampInt(st.params.h, 1, 16000) }
      : computeOutputDims(input.w, input.h, { scale: st.params.scale }))
    : { ...input };
  els.resizeIO.textContent = `${dimsStr(input)} → ${dimsStr(out)}` +
    (!st ? " · original size" : "");
  if (document.activeElement !== els.outW) els.outW.value = out.w;
  if (document.activeElement !== els.outH) els.outH.value = out.h;
  for (const b of els.scaleRow.querySelectorAll("button")) {
    const pressed = !!st && st.params.mode === "scale" &&
      b.textContent === `${Math.round(st.params.scale * 100)}%`;
    b.setAttribute("aria-pressed", String(pressed));
  }
}

function onDimsInput(which) {
  if (!S.bitmap) return;
  const base = toolInputDims("resize");
  const w = parseInt(els.outW.value, 10);
  const h = parseInt(els.outH.value, 10);
  let params;
  if (els.lockAspect.checked) {
    if (which === "w" && Number.isFinite(w) && w > 0) {
      params = { mode: "dims", w, h: Math.max(1, Math.round((base.h * w) / base.w)) };
    } else if (which === "h" && Number.isFinite(h) && h > 0) {
      params = { mode: "dims", w: Math.max(1, Math.round((base.w * h) / base.h)), h };
    } else {
      return;
    }
  } else {
    const cur = toolInputDims("resize");
    params = {
      mode: "dims",
      w: Number.isFinite(w) && w > 0 ? w : cur.w,
      h: Number.isFinite(h) && h > 0 ? h : cur.h,
    };
  }
  if (params.w === base.w && params.h === base.h) setStep("resize", null);
  else setStep("resize", params);
  afterStepsChanged();
}

function describeRotation(p) {
  const parts = [];
  if (p.rotate) parts.push(`${p.rotate}°`);
  if (p.flipH) parts.push("flip horizontal");
  if (p.flipV) parts.push("flip vertical");
  return parts.length ? parts.join(" · ") : "Original orientation";
}

function syncRotatePanel() {
  const st = getStep("rotate");
  els.rotateState.textContent = describeRotation(st ? st.params : { rotate: 0, flipH: false, flipV: false });
}

function commitRotate(p) {
  if (!p.rotate && !p.flipH && !p.flipV) setStep("rotate", null);
  else setStep("rotate", { ...p });
}

function nudgeRotate(delta) {
  if (!S.bitmap) return;
  const st = getStep("rotate");
  const p = st ? { ...st.params } : { rotate: 0, flipH: false, flipV: false };
  p.rotate = (p.rotate + delta) % 360;
  commitRotate(p);
  afterStepsChanged();
}

function toggleFlip(which) {
  if (!S.bitmap) return;
  const st = getStep("rotate");
  const p = st ? { ...st.params } : { rotate: 0, flipH: false, flipV: false };
  p[which] = !p[which];
  commitRotate(p);
  afterStepsChanged();
}

function syncAdjustPanel() {
  const st = getStep("adjust");
  els.grayscale.checked = !!st?.params.grayscale;
}

// ------------------------------------------------------------------ preview

function refreshPreview() {
  if (!S.bitmap) return;
  const cropMode = S.activeTool === "crop";
  const base = cropMode ? renderPipeline(cropStepUpTo()) : renderPipeline();
  const s = Math.min(1, PREVIEW_MAX_SIDE / Math.max(base.w, base.h));
  const pw = Math.max(1, Math.round(base.w * s));
  const ph = Math.max(1, Math.round(base.h * s));
  if (els.previewCanvas.width !== pw || els.previewCanvas.height !== ph) {
    els.previewCanvas.width = pw;
    els.previewCanvas.height = ph;
  }
  const ctx = els.previewCanvas.getContext("2d");
  ctx.clearRect(0, 0, pw, ph);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(base.canvas, 0, 0, pw, ph);

  els.emptyState.classList.add("hidden");
  els.previewWrap.classList.remove("hidden");
  layoutCropBox();
  els.srcInfo.textContent =
    `Original: ${dimsStr({ w: S.srcW, h: S.srcH })}` +
    (S.srcBytes ? ` · ${formatFileSize(S.srcBytes)}` : "") +
    (cropMode
      ? ` · cropping on ${dimsStr({ w: base.w, h: base.h })} input`
      : ` · preview ${dimsStr({ w: base.w, h: base.h })}`);
}

// --------------------------------------------------------------------- crop

/** Steps before the crop step (or all steps when appending). */
function cropStepUpTo() {
  const i = stepIndex("crop");
  return i < 0 ? Infinity : i;
}

function cropInputDims() {
  const i = stepIndex("crop");
  if (i < 0) {
    const full = renderPipeline();
    return { w: full.w, h: full.h };
  }
  return inputDimsAt(i);
}

function aspectRatio() {
  if (S.cropAspect === "free") return null;
  const [a, b] = S.cropAspect.split(":").map(Number);
  return a / b;
}

/** Default centered box (relative coords) honoring the aspect lock. */
function defaultCropRel(input) {
  const ratio = aspectRatio();
  let w = 0.8;
  let h = 0.8;
  if (ratio) {
    if ((w * input.w) / (h * input.h) > ratio) w = (h * input.h * ratio) / input.w;
    else h = (w * input.w / ratio) / input.h;
    w = Math.min(w, 1);
    h = Math.min(h, 1);
  }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

function draftAbsDims() {
  const input = cropInputDims();
  const d = S.cropDraft || defaultCropRel(input);
  return {
    w: Math.max(1, Math.round(d.w * input.w)),
    h: Math.max(1, Math.round(d.h * input.h)),
  };
}

function layoutCropBox() {
  const show = S.activeTool === "crop" && !!S.bitmap;
  els.cropLayer.classList.toggle("hidden", !show);
  if (!show) return;
  if (!S.cropDraft) S.cropDraft = defaultCropRel(cropInputDims());
  const input = cropInputDims();
  const rect = els.previewCanvas.getBoundingClientRect();
  const wrapRect = els.previewWrap.getBoundingClientRect();
  const ox = rect.left - wrapRect.left;
  const oy = rect.top - wrapRect.top;
  const kx = rect.width / input.w;
  const ky = rect.height / input.h;
  const d = S.cropDraft;
  const bx = ox + d.x * input.w * kx;
  const by = oy + d.y * input.h * ky;
  const bw = Math.max(2, d.w * input.w * kx);
  const bh = Math.max(2, d.h * input.h * ky);
  els.cropBox.style.left = `${bx}px`;
  els.cropBox.style.top = `${by}px`;
  els.cropBox.style.width = `${bw}px`;
  els.cropBox.style.height = `${bh}px`;
  // Dim everything outside the box, confined to the image area.
  const setShade = (el, x, y, w, h) => {
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = `${Math.max(0, w)}px`;
    el.style.height = `${Math.max(0, h)}px`;
  };
  setShade(els.shades.top, ox, oy, rect.width, by - oy);
  setShade(els.shades.bottom, ox, by + bh, rect.width, oy + rect.height - by - bh);
  setShade(els.shades.left, ox, by, bx - ox, bh);
  setShade(els.shades.right, bx + bw, by, ox + rect.width - bx - bw, bh);
  // Park the apply button just below the box (above it when space is tight).
  const btn = els.cropFloatApply;
  const btnW = btn.offsetWidth || 90;
  const btnH = btn.offsetHeight || 30;
  const layerW = wrapRect.width;
  btn.style.left = `${Math.min(Math.max(4, bx + bw - btnW), Math.max(4, layerW - btnW - 4))}px`;
  let btnY = by + bh + 6;
  if (btnY + btnH > oy + rect.height - 4) btnY = by - btnH - 6;
  if (btnY < oy + 4) btnY = by + 6;
  btn.style.top = `${btnY}px`;
  const abs = draftAbsDims();
  els.btnCropApply.textContent = `Apply crop ${abs.w} × ${abs.h}`;
  els.btnCropRemove.disabled = !getStep("crop");
}

function applyCrop() {
  if (!S.bitmap || S.activeTool !== "crop" || !S.cropDraft) return;
  setStep("crop", { rel: { ...S.cropDraft } });
  afterStepsChanged();
  closeTool(); // reveal the cropped result; reopen the step to refine
}

function removeCrop() {
  if (!S.bitmap) return;
  setStep("crop", null);
  S.cropDraft = defaultCropRel(cropInputDims());
  afterStepsChanged();
  closeTool();
}

/** Write a CSS-px box (relative to canvas top-left) back to the draft. */
function commitCropCss(x, y, w, h) {
  const input = cropInputDims();
  const rect = els.previewCanvas.getBoundingClientRect();
  const kx = rect.width / input.w;
  const ky = rect.height / input.h;
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  S.cropDraft = {
    x: clamp01(x / kx / input.w),
    y: clamp01(y / ky / input.h),
    w: Math.min(1, Math.max(0.01, w / kx / input.w)),
    h: Math.min(1, Math.max(0.01, h / ky / input.h)),
  };
  S.cropDraft.w = Math.min(S.cropDraft.w, 1 - S.cropDraft.x);
  S.cropDraft.h = Math.min(S.cropDraft.h, 1 - S.cropDraft.y);
  layoutCropBox();
}

function setupCropDrag() {
  let drag = null;
  const MIN = 12;

  els.cropBox.addEventListener("pointerdown", (e) => {
    if (!S.bitmap || S.activeTool !== "crop") return;
    e.preventDefault();
    els.cropBox.setPointerCapture(e.pointerId);
    const boxRect = els.cropBox.getBoundingClientRect();
    const canvasRect = els.previewCanvas.getBoundingClientRect();
    drag = {
      handle: e.target.dataset?.h || null,
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

// ------------------------------------------------------------------ encode

const scheduleEncode = debounce(refreshEncode, 220);

async function refreshEncode() {
  if (!S.bitmap) return;
  const d = outputDims();
  const key = [
    S.epoch, JSON.stringify(S.steps), S.format, S.quality, S.matte,
    S.fit ? S.fit.scale : 1, d.w, d.h,
  ].join("|");
  if (key === S.lastEncodeKey && S.lastBlob) return;
  try {
    const { canvas } = exportCanvas();
    const mime = mimeForFormat(S.format);
    const q = isLossy(S.format) ? S.quality / 100 : undefined;
    const blob = await canvasToBlobAsync(canvas, mime, q);
    S.lastBlob = blob;
    S.lastDims = { ...d };
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
  const q = isLossy(S.format) ? ` · q${S.quality}` : "";
  const fit = S.fit && S.fit.scale < 0.999 ? ` · fit ${Math.round(S.fit.scale * 100)}%` : "";
  els.outLine.innerHTML =
    `Output: <strong>${dimsStr({ w, h })} · ${f.label} · ${size}</strong>${q}${fit}`;
  els.topOut.textContent = `${dimsStr({ w, h })} · ${f.label} · ${size}`;
  if (!S.filenameDirty) {
    els.fileName.value = buildFileName(S.baseName, w, h, extForFormat(S.format));
  }
}

// ---------------------------------------------------------- fit to file size

function setFitStatus(msg, kind = "") {
  els.fitStatus.textContent = msg;
  els.fitStatus.className = `hint ${kind}`;
}

function clearFit(note) {
  if (!S.fit) return;
  S.fit = null;
  S.lastEncodeKey = "";
  if (note) setFitStatus(note);
  renderSteps();
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
    const pipe = renderPipeline();
    const lossless = !isLossy(S.format);
    const bg = (S.format === "jpeg" || S.format === "bmp") ? S.matte : null;
    const renderAt = async (q01, scale) => {
      const w = Math.max(1, Math.round(pipe.w * scale));
      const h = Math.max(1, Math.round(pipe.h * scale));
      const canvas = renderToCanvas(pipe.canvas, { outW: w, outH: h, background: bg });
      return canvasToBlobAsync(canvas, mimeForFormat(S.format), lossless ? undefined : q01);
    };
    const res = await compressToTargetSize(renderAt, target, lossless ? { rounds: 1 } : {});
    if (!lossless) {
      S.quality = clampInt(Math.round(res.quality * 100), 1, 100);
      els.quality.value = S.quality;
      els.qualityVal.textContent = S.quality;
    }
    S.fit = { scale: res.scale, quality: res.quality, targetBytes: target };
    S.lastBlob = null;
    S.lastEncodeKey = "";
    renderSteps();
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
    let blob = S.lastBlob;
    if (mime !== "image/png") {
      const { canvas } = exportCanvas();
      blob = await canvasToBlobAsync(
        renderToCanvas(canvas, { outW: S.lastDims.w, outH: S.lastDims.h }), "image/png",
      );
    }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("Copied to clipboard as PNG.");
  } catch (err) {
    console.error(err);
    toast("Copy failed — the browser blocked clipboard access.", "error");
  }
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
  S.steps = [];
  S.activeTool = null;
  S.cropDraft = null;
  S.fit = null;
  S.filenameDirty = false;
  S.lastBlob = null;
  S.lastEncodeKey = "";
  S.pipeCache = { key: "", canvas: null, w: 0, h: 0, log: [] };
  els.toolPanel.classList.add("hidden");
  els.grayscale.checked = false;
  setFitStatus("Lowers quality first, then shrinks pixels if needed.");

  S.format = firstSupportedFormat(S.format);
  syncFormatUI();
  document.body.classList.remove("no-image");
  renderSteps();
  refreshPreview();
  await refreshEncode();
}

function resetAll() {
  if (S.bitmap && S.bitmap.close) S.bitmap.close();
  Object.assign(S, {
    bitmap: null, srcW: 0, srcH: 0, srcBytes: 0, baseName: "image",
    steps: [], activeTool: null, cropDraft: null, fit: null,
    filenameDirty: false, lastBlob: null, lastEncodeKey: "",
    pipeCache: { key: "", canvas: null, w: 0, h: 0, log: [] },
  });
  els.toolPanel.classList.add("hidden");
  els.grayscale.checked = false;
  els.previewWrap.classList.add("hidden");
  els.emptyState.classList.remove("hidden");
  els.srcInfo.textContent = "No image loaded.";
  els.outLine.textContent = "—";
  els.topOut.textContent = "";
  els.fileName.value = "";
  renderSteps();
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

// ------------------------------------------------------------------- events

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

  // Tool grid + step list.
  els.toolGrid.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tool]");
    if (!b || !S.bitmap) return;
    const tool = b.dataset.tool;
    if (S.activeTool === tool) closeTool();
    else openTool(tool);
  });
  els.toolClose.addEventListener("click", closeTool);

  els.stepsList.addEventListener("click", (e) => {
    const actionBtn = e.target.closest("button[data-action]");
    if (actionBtn) {
      e.stopPropagation();
      const i = parseInt(actionBtn.dataset.i, 10);
      const action = actionBtn.dataset.action;
      if (action === "remove") {
        const [removed] = S.steps.splice(i, 1);
        S.pipeCache.key = "";
        if (S.activeTool === removed.tool && removed.tool === "crop") {
          S.cropDraft = defaultCropRel(cropInputDims());
        }
        afterStepsChanged();
      } else if (action === "up") {
        moveStep(i, -1);
        afterStepsChanged();
      } else if (action === "down") {
        moveStep(i, 1);
        afterStepsChanged();
      }
      return;
    }
    const card = e.target.closest("button[data-edit]");
    if (card) openTool(S.steps[parseInt(card.dataset.edit, 10)].tool);
  });

  // Crop panel.
  els.cropAspect.addEventListener("change", () => {
    S.cropAspect = els.cropAspect.value;
    S.cropDraft = defaultCropRel(cropInputDims());
    layoutCropBox();
  });
  els.btnCropReset.addEventListener("click", () => {
    if (!S.bitmap) return;
    S.cropDraft = defaultCropRel(cropInputDims());
    layoutCropBox();
  });
  els.btnCropApply.addEventListener("click", applyCrop);
  els.btnCropRemove.addEventListener("click", removeCrop);
  els.cropFloatApply.addEventListener("click", (e) => {
    e.stopPropagation();
    applyCrop();
  });
  els.cropBox.addEventListener("dblclick", (e) => {
    e.preventDefault();
    applyCrop();
  });
  document.addEventListener("keydown", (e) => {
    if (!S.activeTool) return;
    const tag = e.target.tagName || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === "Escape") closeTool();
    // Enter applies, unless a button is focused (it handles Enter itself).
    else if (e.key === "Enter" && tag !== "BUTTON" && S.activeTool === "crop") applyCrop();
  });

  // Resize panel.
  els.outW.addEventListener("change", () => onDimsInput("w"));
  els.outH.addEventListener("change", () => onDimsInput("h"));
  els.btnResizeReset.addEventListener("click", () => {
    if (!S.bitmap) return;
    setStep("resize", null);
    afterStepsChanged();
  });

  // Rotate panel.
  els.btnRotL.addEventListener("click", () => nudgeRotate(270));
  els.btnRotR.addEventListener("click", () => nudgeRotate(90));
  els.btnRot180.addEventListener("click", () => nudgeRotate(180));
  els.btnFlipH.addEventListener("click", () => toggleFlip("flipH"));
  els.btnFlipV.addEventListener("click", () => toggleFlip("flipV"));
  els.btnRotateReset.addEventListener("click", () => {
    if (!S.bitmap) return;
    setStep("rotate", null);
    afterStepsChanged();
  });

  // Adjust panel.
  els.grayscale.addEventListener("change", () => {
    if (!S.bitmap) return;
    setStep("adjust", els.grayscale.checked ? { grayscale: true } : null);
    afterStepsChanged();
  });

  // Export.
  els.quality.addEventListener("input", () => {
    S.quality = parseInt(els.quality.value, 10);
    els.qualityVal.textContent = S.quality;
    clearFit("Fit cleared — the quality changed, refit to reapply.");
    scheduleEncode();
  });
  els.matte.addEventListener("input", () => {
    S.matte = els.matte.value;
    clearFit("Fit cleared — the matte changed, refit to reapply.");
    scheduleEncode();
  });
  els.btnFitSize.addEventListener("click", fitToSize);
  els.targetKB.addEventListener("keydown", (e) => { if (e.key === "Enter") fitToSize(); });

  els.fileName.addEventListener("input", () => { S.filenameDirty = true; });
  const download = () => doDownload().catch((e) => toast(e.message, "error"));
  els.btnDownload.addEventListener("click", download);
  els.btnDownloadTop.addEventListener("click", download);
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
  renderSteps();
  if (!(await consumeSessionImport())) await consumeQueryImport();
  const params = new URLSearchParams(location.search);
  if (params.get("pick") && !S.bitmap) {
    toast("Choose a file to get started — or drop one here, or paste a link.");
    els.dropzone.classList.add("pick-attention");
    els.btnUpload.focus({ preventScroll: true });
    setTimeout(() => els.dropzone.classList.remove("pick-attention"), 4000);
    history.replaceState(null, "", location.pathname);
  }
}

init().catch((e) => {
  console.error(e);
  toast(`Startup failed: ${e.message}`, "error");
});
