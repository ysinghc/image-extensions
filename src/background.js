/* ImageForge background worker (plain script — no modules).
 * Runs as a Chrome MV3 service worker and as a Firefox MV3 background script.
 * Uses callback-style chrome.* APIs, which both browsers support here.
 */

const QUICK_FORMATS = [
  { id: "dl-png", format: "png", mime: "image/png", ext: "png", label: "PNG", quality: undefined },
  { id: "dl-jpg", format: "jpeg", mime: "image/jpeg", ext: "jpg", label: "JPEG", quality: 0.9 },
  { id: "dl-webp", format: "webp", mime: "image/webp", ext: "webp", label: "WebP", quality: 0.9 },
];

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "imageforge-root",
      title: "ImageForge",
      contexts: ["image"],
    });
    chrome.contextMenus.create({
      id: "imageforge-open",
      parentId: "imageforge-root",
      title: "Open in ImageForge editor",
      contexts: ["image"],
    });
    chrome.contextMenus.create({
      id: "imageforge-sep",
      parentId: "imageforge-root",
      type: "separator",
      contexts: ["image"],
    });
    for (const q of QUICK_FORMATS) {
      chrome.contextMenus.create({
        id: q.id,
        parentId: "imageforge-root",
        title: `Download as ${q.label}`,
        contexts: ["image"],
      });
    }
  });
}

chrome.runtime.onInstalled.addListener(setupMenus);
// MV3 service workers can restart without onInstalled; menus persist, but
// re-creating on startup is harmless and covers edge cases.
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(setupMenus);

chrome.contextMenus.onClicked.addListener((info) => {
  if (!info.srcUrl) return;
  if (info.menuItemId === "imageforge-open") {
    chrome.tabs.create({
      url: chrome.runtime.getURL(`editor.html?src=${encodeURIComponent(info.srcUrl)}`),
    });
    return;
  }
  const q = QUICK_FORMATS.find((f) => f.id === info.menuItemId);
  if (q) quickDownload(info.srcUrl, q).catch((err) => console.error("ImageForge:", err));
});

function baseNameFromUrl(url) {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
    const clean = decodeURIComponent(last)
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[^\w\-() ]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .trim();
    return clean || "image";
  } catch {
    return "image";
  }
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }
  throw new Error("No canvas available in background context");
}

function canvasToBlob(canvas, mime, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: mime, quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error(`Encoder returned no data for ${mime}`))),
      mime,
      quality,
    );
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("Could not read converted image"));
    r.readAsDataURL(blob);
  });
}

async function quickDownload(srcUrl, q) {
  const res = await fetch(srcUrl, { credentials: "omit" });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const blob = await res.blob();
  if (!blob.type.startsWith("image/")) throw new Error(`Not an image (got ${blob.type || "unknown"})`);

  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = makeCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    if (q.format === "jpeg") {
      ctx.fillStyle = "#ffffff"; // matte for transparency
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(bitmap, 0, 0);
    const out = await canvasToBlob(canvas, q.mime, q.quality);
    const url = await blobToDataUrl(out);
    await new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url,
          filename: `${baseNameFromUrl(srcUrl)}-${bitmap.width}x${bitmap.height}.${q.ext}`,
          saveAs: false,
        },
        (id) => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(id)),
      );
    });
  } finally {
    if (bitmap.close) bitmap.close();
  }
}
