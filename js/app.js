// pdftool — client-side PDF page organiser.
//
// pdf.js renders thumbnails, pdf-lib assembles the output, SortableJS handles
// drag & drop (its MultiDrag plugin also owns the selection state: a page is
// selected iff its card carries the `selected` class).

import { PDFDocument, degrees } from '../vendor/pdf-lib/pdf-lib.esm.min.js';
import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
import Sortable from '../vendor/sortable/sortable.complete.esm.js';

const vendorUrl = (p) => new URL(`../vendor/pdfjs/${p}`, import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = vendorUrl('pdf.worker.min.mjs');
const PDFJS_ASSETS = {
  cMapUrl: vendorUrl('cmaps/'),
  cMapPacked: true,
  standardFontDataUrl: vendorUrl('standard_fonts/'),
  wasmUrl: vendorUrl('wasm/'),
  iccUrl: vendorUrl('iccs/'),
};

const THUMB_PX = 400;          // longest edge of a rendered thumbnail
const RENDER_CONCURRENCY = 2;
const HISTORY_LIMIT = 100;
const FILE_COLORS = ['#d9482b', '#2f7fd1', '#3d9a50', '#b05cc6', '#d99a1c', '#17a2a2', '#d1487f', '#7a7f8c'];

const $ = (id) => document.getElementById(id);
const grid = $('grid');

// ---------------------------------------------------------------- state

/** @type {Map<string, {id: string, name: string, color: string, lib: any, doc: any}>} */
const files = new Map();
/** Output order. `rot` is the extra rotation in degrees (may be negative or > 360). */
let pages = [];      // {id, fileId, index, rot}
let undoStack = [];
let redoStack = [];
const cards = new Map();   // page id -> card element
let nextId = 1;
let nameEdited = false;
let busy = false;

const norm = (deg) => ((deg % 360) + 360) % 360;
const pageById = (id) => pages.find((p) => p.id === id);
const selectedIds = () => new Set([...grid.querySelectorAll('.card.selected')].map((el) => el.dataset.id));

// ---------------------------------------------------------------- history

const snapshot = () => pages.map((p) => ({ ...p }));

/** Record the current state for undo, then apply `fn`, which returns the new page list. */
function commit(fn) {
  undoStack.push(snapshot());
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
  pages = fn(pages);
  render();
}

function timeTravel(from, to) {
  if (!from.length) return;
  to.push(snapshot());
  pages = from.pop();
  setSelection(new Set());
  render();
}
const undo = () => timeTravel(undoStack, redoStack);
const redo = () => timeTravel(redoStack, undoStack);

// ---------------------------------------------------------------- toasts

function toast(msg, { error = false, sticky = false } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '');
  el.textContent = msg;
  $('toasts').append(el);
  const close = () => el.remove();
  el.addEventListener('click', close);
  if (!sticky) setTimeout(close, error ? 9000 : 3500);
  return close;
}

// ---------------------------------------------------------------- import

async function imageToPdf(file, bytes) {
  const out = await PDFDocument.create();
  let img;
  if (file.type === 'image/jpeg') {
    img = await out.embedJpg(bytes);
  } else if (file.type === 'image/png') {
    img = await out.embedPng(bytes);
  } else {
    // Anything else the browser can decode (WebP, GIF, SVG, ...) goes through a canvas.
    const bmp = await createImageBitmap(file);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    const png = await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer();
    img = await out.embedPng(png);
  }
  // Treat image pixels as 96 dpi.
  const w = img.width * 0.75, h = img.height * 0.75;
  out.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  return out.save();
}

async function loadFile(file) {
  let bytes = new Uint8Array(await file.arrayBuffer());
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!isPdf) {
    if (!file.type.startsWith('image/')) throw new Error('not a PDF or an image');
    bytes = await imageToPdf(file, bytes);
  }
  let lib;
  try {
    lib = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (/encrypt/i.test(e?.message ?? '')) throw new Error('the file is encrypted / password-protected, which is not supported');
    throw new Error('the file could not be parsed as a PDF');
  }
  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  const doc = await pdfjs.getDocument({ data: bytes.slice(), ...PDFJS_ASSETS }).promise;
  const id = 'f' + nextId++;
  const entry = { id, name: file.name, color: FILE_COLORS[files.size % FILE_COLORS.length], lib, doc };
  files.set(id, entry);
  const n = Math.min(lib.getPageCount(), doc.numPages);
  return Array.from({ length: n }, (_, index) => ({ id: 'p' + nextId++, fileId: id, index, rot: 0 }));
}

async function addFiles(fileList) {
  const list = [...fileList];
  if (!list.length) return;
  const done = toast(list.length === 1 ? `Reading ${list[0].name}…` : `Reading ${list.length} files…`, { sticky: true });
  const added = [];
  for (const file of list) {
    try {
      added.push(...await loadFile(file));
    } catch (e) {
      console.error(e);
      toast(`${file.name}: ${e.message}`, { error: true });
    }
  }
  done();
  if (added.length) commit((cur) => [...cur, ...added]);
}

// ---------------------------------------------------------------- thumbnails

const renderQueue = [];
let rendering = 0;

function pumpRenderQueue() {
  while (rendering < RENDER_CONCURRENCY && renderQueue.length) {
    const card = renderQueue.shift();
    const page = cards.get(card.dataset.id) === card ? card._page : null;
    if (!page) continue;
    rendering++;
    renderThumb(card, page)
      .catch((e) => console.error('thumbnail failed', e))
      .finally(() => { rendering--; pumpRenderQueue(); });
  }
}

async function renderThumb(card, { fileId, index }) {
  const canvas = card.querySelector('canvas');
  const pdfPage = await files.get(fileId).doc.getPage(index + 1);
  const base = pdfPage.getViewport({ scale: 1 });
  const viewport = pdfPage.getViewport({ scale: THUMB_PX / Math.max(base.width, base.height) });
  // Render off-DOM first so the placeholder is swapped in one go.
  const tmp = document.createElement('canvas');
  tmp.width = Math.ceil(viewport.width);
  tmp.height = Math.ceil(viewport.height);
  await pdfPage.render({ canvas: tmp, viewport }).promise;
  canvas.width = tmp.width;
  canvas.height = tmp.height;
  canvas.getContext('2d').drawImage(tmp, 0, 0);
  canvas.classList.remove('pending');
  pdfPage.cleanup();
}

const thumbObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    thumbObserver.unobserve(e.target);
    renderQueue.push(e.target);
  }
  pumpRenderQueue();
}, { rootMargin: '600px 0px' });

// ---------------------------------------------------------------- cards

const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}"/></svg>`;

function cardFor(page) {
  let card = cards.get(page.id);
  if (card) return card;
  const file = files.get(page.fileId);
  card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = page.id;
  card.style.setProperty('--file', file.color);
  card._page = { fileId: page.fileId, index: page.index };
  card.innerHTML = `
    <div class="thumb">
      <canvas class="pending" width="283" height="400"></canvas>
      <span class="check"></span>
      <div class="card-actions">
        <button class="card-btn" type="button" data-act="rotate" title="Rotate right" aria-label="Rotate right">${icon('rot-r')}</button>
        <button class="card-btn" type="button" data-act="preview" title="Preview" aria-label="Preview">${icon('zoom')}</button>
        <button class="card-btn" type="button" data-act="delete" title="Delete page" aria-label="Delete page">${icon('trash')}</button>
      </div>
    </div>
    <div class="meta"><span class="num"></span><span class="src"></span></div>`;
  const src = card.querySelector('.src');
  src.textContent = `${file.name} · p${page.index + 1}`;
  src.title = `${file.name}, page ${page.index + 1}`;
  cards.set(page.id, card);
  thumbObserver.observe(card);
  return card;
}

function setSelection(ids) {
  for (const el of grid.children) {
    (ids.has(el.dataset.id) ? Sortable.utils.select : Sortable.utils.deselect)(el);
  }
  updateChrome();
}

// ---------------------------------------------------------------- render

function render() {
  // Sortable tracks selected elements internally, so release the ones leaving the grid.
  const keep = new Set(pages.map((p) => p.id));
  for (const el of [...grid.children]) if (!keep.has(el.dataset.id)) Sortable.utils.deselect(el);

  grid.replaceChildren(...pages.map(cardFor));
  pages.forEach((p, i) => {
    const card = cards.get(p.id);
    card.querySelector('.num').textContent = i + 1;
    card.querySelector('canvas').style.transform = p.rot ? `rotate(${p.rot}deg)` : '';
  });

  renderChips();
  if (!nameEdited) {
    const used = new Set(pages.map((p) => p.fileId));
    $('outname').value = used.size === 1
      ? files.get([...used][0]).name.replace(/\.[^.]+$/, '') + '-edited.pdf'
      : 'combined.pdf';
  }
  updateChrome();
}

function renderChips() {
  const counts = new Map();
  for (const p of pages) counts.set(p.fileId, (counts.get(p.fileId) ?? 0) + 1);
  $('files').replaceChildren(...[...counts].map(([fileId, n]) => {
    const file = files.get(fileId);
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.setProperty('--file', file.color);
    chip.innerHTML = `
      <button type="button" data-act="select" title="Select all pages from this file"><span class="dot"></span><span class="name"></span><span class="n"></span></button>
      <button type="button" class="rm" data-act="remove" title="Remove all pages from this file" aria-label="Remove file">${icon('x')}</button>`;
    chip.dataset.file = fileId;
    chip.querySelector('.name').textContent = file.name;
    chip.querySelector('.n').textContent = n === 1 ? '1 page' : `${n} pages`;
    return chip;
  }));
}

function updateChrome() {
  const nSel = grid.querySelectorAll('.card.selected').length;
  const has = pages.length > 0;
  document.body.classList.toggle('has-pages', has);
  document.body.classList.toggle('has-sel', nSel > 0);
  $('empty').hidden = has;
  grid.hidden = !has;
  $('hint').hidden = !has;
  $('count').textContent = nSel
    ? `${nSel} of ${pages.length} selected`
    : `${pages.length} page${pages.length === 1 ? '' : 's'}`;
  $('undo').disabled = !undoStack.length || busy;
  $('redo').disabled = !redoStack.length || busy;
  $('download').disabled = busy;
  $('download-sel').disabled = busy;
}

// ---------------------------------------------------------------- operations

function rotate(ids, delta) {
  if (!ids.size) return;
  commit((cur) => cur.map((p) => (ids.has(p.id) ? { ...p, rot: p.rot + delta } : p)));
}

function remove(ids) {
  if (!ids.size) return;
  commit((cur) => cur.filter((p) => !ids.has(p.id)));
}

function duplicate(ids) {
  if (!ids.size) return;
  commit((cur) => cur.flatMap((p) => (ids.has(p.id) ? [p, { ...p, id: 'p' + nextId++ }] : [p])));
}

function reset() {
  if (pages.length && !confirm('Remove all pages and start over?')) return;
  setSelection(new Set());
  grid.replaceChildren();
  for (const f of files.values()) f.doc.destroy();
  files.clear();
  cards.clear();
  renderQueue.length = 0;
  pages = [];
  undoStack = [];
  redoStack = [];
  nameEdited = false;
  render();
}

// ---------------------------------------------------------------- export

async function buildPdf(list) {
  const out = await PDFDocument.create();
  // Copy each source's pages in one batch so shared resources (fonts, images) are embedded once.
  const copies = new Map();
  for (const fileId of new Set(list.map((p) => p.fileId))) {
    const mine = list.filter((p) => p.fileId === fileId);
    const copied = await out.copyPages(files.get(fileId).lib, mine.map((p) => p.index));
    mine.forEach((p, i) => copies.set(p, copied[i]));
  }
  for (const p of list) {
    const page = copies.get(p);
    if (norm(p.rot)) page.setRotation(degrees(norm(page.getRotation().angle + p.rot)));
    out.addPage(page);
  }
  return out.save();
}

async function download(list, name) {
  if (!list.length || busy) return;
  busy = true;
  updateChrome();
  const done = toast('Building PDF…', { sticky: true });
  try {
    // Let the toast paint before the (synchronous-ish) heavy lifting starts.
    await new Promise((r) => setTimeout(r, 30));
    const bytes = await buildPdf(list);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    done();
    toast(`Saved ${name} (${list.length} page${list.length === 1 ? '' : 's'})`);
  } catch (e) {
    console.error(e);
    done();
    toast(`Could not build the PDF: ${e.message}`, { error: true });
  } finally {
    busy = false;
    updateChrome();
  }
}

function outName(suffix = '') {
  let name = $('outname').value.trim().replace(/[\\/:*?"<>|]/g, '_') || 'combined.pdf';
  name = name.replace(/\.pdf$/i, '');
  return `${name}${suffix}.pdf`;
}

const downloadAll = () => download(pages, outName());
function downloadSelection() {
  const ids = selectedIds();
  return download(pages.filter((p) => ids.has(p.id)), outName('-selection'));
}

// ---------------------------------------------------------------- preview

const preview = $('preview');
let previewId = null;
let previewTask = null;

async function showPreview(id) {
  const i = pages.findIndex((p) => p.id === id);
  if (i < 0) return preview.close();
  previewId = id;
  const p = pages[i];
  const file = files.get(p.fileId);
  $('pv-title').textContent = `Page ${i + 1} of ${pages.length} — ${file.name}, p${p.index + 1}`;
  $('pv-prev').disabled = i === 0;
  $('pv-next').disabled = i === pages.length - 1;
  if (!preview.open) preview.showModal();

  previewTask?.cancel();
  const stage = $('pv-stage');
  const pdfPage = await file.doc.getPage(p.index + 1);
  if (previewId !== id) return;
  const rotation = norm(pdfPage.rotate + p.rot);
  const base = pdfPage.getViewport({ scale: 1, rotation });
  const fit = Math.min(stage.clientWidth / base.width, stage.clientHeight / base.height);
  const viewport = pdfPage.getViewport({ scale: fit * Math.min(devicePixelRatio || 1, 2), rotation });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const task = previewTask = pdfPage.render({ canvas, viewport });
  try {
    await task.promise;
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') console.error(e);
    return;
  }
  if (previewId === id) stage.replaceChildren(canvas);
}

function previewStep(d) {
  const i = pages.findIndex((p) => p.id === previewId);
  const next = pages[i + d];
  if (next) showPreview(next.id);
}

// ---------------------------------------------------------------- wiring

new Sortable(grid, {
  animation: 150,
  multiDrag: true,
  selectedClass: 'selected',
  avoidImplicitDeselect: true,
  ghostClass: 'ghost',
  filter: '.card-btn',
  preventOnFilter: false,
  delay: 180,
  delayOnTouchOnly: true,
  onSelect: updateChrome,
  onDeselect: updateChrome,
  onEnd() {
    const order = [...grid.children].map((el) => el.dataset.id);
    if (order.every((id, i) => pages[i]?.id === id)) return;
    const byId = new Map(pages.map((p) => [p.id, p]));
    commit(() => order.map((id) => byId.get(id)));
  },
});

grid.addEventListener('click', (e) => {
  const btn = e.target.closest('.card-btn');
  if (!btn) return;
  const id = btn.closest('.card').dataset.id;
  const ids = new Set([id]);
  if (btn.dataset.act === 'rotate') rotate(ids, 90);
  else if (btn.dataset.act === 'delete') remove(ids);
  else if (btn.dataset.act === 'preview') showPreview(id);
});
grid.addEventListener('dblclick', (e) => {
  const card = e.target.closest('.card');
  if (card && !e.target.closest('.card-btn')) showPreview(card.dataset.id);
});
// Clicking the empty area around the pages clears the selection.
$('main').addEventListener('click', (e) => {
  if (e.target === grid || e.target === $('main')) setSelection(new Set());
});

$('files').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const fileId = btn.closest('.chip').dataset.file;
  const ids = new Set(pages.filter((p) => p.fileId === fileId).map((p) => p.id));
  if (btn.dataset.act === 'remove') remove(ids);
  else setSelection(ids);
});

const picker = $('picker');
const pick = () => picker.click();
$('add').addEventListener('click', pick);
$('dropzone').addEventListener('click', pick);
picker.addEventListener('change', () => { addFiles(picker.files); picker.value = ''; });

$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('reset').addEventListener('click', reset);
$('download').addEventListener('click', downloadAll);
$('download-sel').addEventListener('click', downloadSelection);
$('outname').addEventListener('input', () => { nameEdited = true; });

$('sel-all').addEventListener('click', () => setSelection(new Set(pages.map((p) => p.id))));
$('sel-none').addEventListener('click', () => setSelection(new Set()));
$('sel-invert').addEventListener('click', () => {
  const cur = selectedIds();
  setSelection(new Set(pages.filter((p) => !cur.has(p.id)).map((p) => p.id)));
});
$('rot-l').addEventListener('click', () => rotate(selectedIds(), -90));
$('rot-r').addEventListener('click', () => rotate(selectedIds(), 90));
$('dup').addEventListener('click', () => duplicate(selectedIds()));
$('del').addEventListener('click', () => remove(selectedIds()));

$('size').addEventListener('input', (e) => {
  document.documentElement.style.setProperty('--card', e.target.value + 'px');
});

$('pv-close').addEventListener('click', () => preview.close());
$('pv-prev').addEventListener('click', () => previewStep(-1));
$('pv-next').addEventListener('click', () => previewStep(1));
$('pv-rot-l').addEventListener('click', () => { rotate(new Set([previewId]), -90); showPreview(previewId); });
$('pv-rot-r').addEventListener('click', () => { rotate(new Set([previewId]), 90); showPreview(previewId); });
preview.addEventListener('click', (e) => { if (e.target === preview) preview.close(); });
preview.addEventListener('close', () => {
  previewTask?.cancel();
  previewId = null;
  $('pv-stage').replaceChildren();
});

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (preview.open) {
    if (e.key === 'ArrowLeft') previewStep(-1);
    else if (e.key === 'ArrowRight') previewStep(1);
    return;
  }
  if (e.target.closest('input, textarea, select') && !(mod && e.key.toLowerCase() === 's')) return;
  if (!pages.length && !undoStack.length && !redoStack.length) return;
  const key = e.key.toLowerCase();
  let handled = true;
  if (mod && key === 'z') (e.shiftKey ? redo : undo)();
  else if (mod && key === 'y') redo();
  else if (mod && key === 'a') setSelection(new Set(pages.map((p) => p.id)));
  else if (mod && key === 's') downloadAll();
  else if (mod || e.altKey) handled = false;
  else if (key === 'delete' || key === 'backspace') remove(selectedIds());
  else if (key === 'r') rotate(selectedIds(), e.shiftKey ? -90 : 90);
  else if (key === 'd') duplicate(selectedIds());
  else if (key === 'escape') setSelection(new Set());
  else handled = false;
  if (handled) e.preventDefault();
});

// Dropping files anywhere on the page adds them. (Page reordering also uses
// native drag & drop, so only react to drags that actually carry files.)
const veil = $('dropveil');
const carriesFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!carriesFiles(e)) return;
  dragDepth++;
  veil.hidden = false;
});
window.addEventListener('dragleave', (e) => {
  if (!carriesFiles(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; veil.hidden = true; }
});
window.addEventListener('dragover', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('drop', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  veil.hidden = true;
  addFiles(e.dataTransfer.files);
});

render();

// Small hook for automated tests and console tinkering.
window.pdftool = { addFiles, buildPdf, get pages() { return snapshot(); } };
