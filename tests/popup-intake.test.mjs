import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Regression coverage for local-file intake.
//
// A native file picker opened from the toolbar popup steals focus, which
// closes the popup and destroys its page — the picked file is lost and the
// user hits a dead end. So the popup must never contain a file input:
// local files enter the popup via drag-and-drop (or paste), and the Upload
// button hands off to the full editor tab, which can host a picker safely.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("popup contains no native file picker (it would close the popup)", () => {
  const html = read("src/popup.html");
  assert.ok(!/type\s*=\s*["']file["']/i.test(html), "popup.html must not contain <input type=file>");
  const js = read("src/popup.js");
  assert.ok(!/fileInput/i.test(js), "popup.js must not reference a file input");
});

test("popup takes local files via drag-and-drop", () => {
  const html = read("src/popup.html");
  assert.ok(/drop/i.test(html), "popup.html should advertise file drops");
  const js = read("src/popup.js");
  assert.ok(/addEventListener\(["']drop["']/.test(js), "popup.js must handle drop events");
  assert.ok(/dataTransfer/.test(js), "popup.js must read dropped files from dataTransfer");
});

test("popup Upload hands off to the editor pick flow", () => {
  const html = read("src/popup.html");
  assert.ok(/btnUpload/.test(html), "popup.html must keep an Upload button");
  const js = read("src/popup.js");
  assert.ok(/editor\.html\?pick=1/.test(js), "popup.js must open the editor with ?pick=1");
});

test("editor honors ?pick=1 with a guided file-pick state", () => {
  const js = read("src/editor.js");
  assert.ok(/["']pick["']/.test(js), "editor.js must read the pick query param");
  const html = read("src/editor.html");
  assert.ok(/fileInput/.test(html), "editor.html must host the file input");
  assert.ok(/dropzone/.test(html), "editor.html must keep its dropzone");
});
