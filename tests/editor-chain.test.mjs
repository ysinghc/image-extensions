import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The editor is a one-tool-at-a-time pipeline: tools append ordered steps to
// a visible chain (each feeding the next), and Export stays terminal. These
// static checks pin that structure so the UI can't regress into a wall of
// always-visible controls.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("editor has a step chain with origin and output endpoints", () => {
  const html = read("src/editor.html");
  assert.ok(/id="stepsList"/.test(html), "editor.html must have #stepsList");
  assert.ok(/id="noSteps"/.test(html), "editor.html must have an empty-chain hint");
  const js = read("src/editor.js");
  assert.ok(/function renderSteps/.test(js), "editor.js must render the chain");
  assert.ok(/Original/.test(js) && /Output/.test(js), "chain must label origin and output");
});

test("editor offers one tool at a time through a single panel", () => {
  const html = read("src/editor.html");
  for (const tool of ["crop", "resize", "rotate", "adjust"]) {
    assert.ok(new RegExp(`data-tool="${tool}"`).test(html), `tool grid must include ${tool}`);
    assert.ok(new RegExp(`id="panel-${tool}"`).test(html), `must have #panel-${tool}`);
  }
  assert.ok(/id="toolPanel"/.test(html), "must have a single shared #toolPanel");
  const panels = html.match(/id="panel-\w+"/g) || [];
  assert.equal(panels.length, 4);
  const js = read("src/editor.js");
  assert.ok(/function openTool/.test(js) && /function closeTool/.test(js), "must open/close one tool");
});

test("steps are ordered, editable, and removable", () => {
  const js = read("src/editor.js");
  assert.ok(/function setStep/.test(js), "must add/update/remove steps");
  assert.ok(/function moveStep/.test(js), "must reorder steps");
  assert.ok(/function renderPipeline/.test(js), "must render steps in order");
  assert.ok(/data-action="up"|"up"/.test(js), "step cards must offer move-earlier");
  assert.ok(/stepSummary/.test(js), "each step must summarize what it did");
});

test("export stays a single terminal section", () => {
  const html = read("src/editor.html");
  assert.ok(/id="exportCard"/.test(html), "must have #exportCard");
  assert.ok(/id="formatRow"/.test(html), "export must hold format pills");
  assert.ok(/id="btnFitSize"/.test(html), "export must hold fit-to-size");
  assert.ok(/id="btnDownload"/.test(html), "export must hold download");
  const js = read("src/editor.js");
  assert.ok(/function exportCanvas/.test(js), "must export from the pipeline output");
});
