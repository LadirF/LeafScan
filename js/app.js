// LeafScan — telas, câmera, captura automática, editor de cantos e exportação.
import * as db from './db.js';
import {
  loadCV, cvReady, detectDocument, warpDocument, applyFilter, edgeMap, snapCorner,
  quadIsValid, quadDist, QuadTracker, FILTERS,
} from './scanner.js';
import { buildPdf, jpegInfo } from './pdf.js';

const $ = (s) => document.querySelector(s);

const MAX_ORIG = 4000;   // lado maior da foto guardada (limite seguro de canvas no iPhone)
const MAX_OUT = 3000;    // lado maior da página final
const LIVE_SIZE = 420;   // lado maior do quadro analisado ao vivo
const STILL_SIZE = 720;  // lado maior usado para detectar numa foto parada
const STABLE_FRAMES = 9; // quadros firmes seguidos antes da captura automática

const pref = {
  get(k, d) { try { const v = localStorage.getItem('leafscan.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('leafscan.' + k, JSON.stringify(v)); } catch { /* sem armazenamento */ } },
};

let pages = [];
const thumbUrls = new Map();
const busy = new Set();

// ================================================================ utilidades

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

function canvasBlob(c, type = 'image/jpeg', q = 0.9) {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('falha ao gerar a imagem'))), type, q));
}

// Solta a memória do canvas na hora (o Safari do iPhone demora a liberar).
function freeCanvas(c) { if (c) { c.width = 0; c.height = 0; } }

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function scaledCanvas(src, maxSide) {
  const w = src.width || src.videoWidth, h = src.height || src.videoHeight;
  const sc = Math.min(1, maxSide / Math.max(w, h));
  const c = makeCanvas(w * sc, h * sc);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}

async function blobToCanvas(blob, maxSide = Infinity) {
  let img = null, w, h;
  if (window.createImageBitmap) {
    try { img = await createImageBitmap(blob); w = img.width; h = img.height; } catch { img = null; }
  }
  if (!img) {
    img = await new Promise((res, rej) => {
      const u = URL.createObjectURL(blob);
      const im = new Image();
      im.onload = () => { URL.revokeObjectURL(u); res(im); };
      im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('imagem inválida')); };
      im.src = u;
    });
    w = img.naturalWidth; h = img.naturalHeight;
  }
  const sc = Math.min(1, maxSide / Math.max(w, h));
  const c = makeCanvas(w * sc, h * sc);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  if (img.close) img.close();
  return c;
}

function matFromCanvas(c) {
  return window.cv.matFromImageData(c.getContext('2d').getImageData(0, 0, c.width, c.height));
}

const fullQuad = () => [[0, 0], [1, 0], [1, 1], [0, 1]];
const insetQuad = () => { const m = 0.04; return [[m, m], [1 - m, m], [1 - m, 1 - m], [m, 1 - m]]; };

function defaultName() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `Documento ${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}h${p(d.getMinutes())}`;
}

function fmtSize(bytes) {
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
}

// ================================================================ navegação entre telas

const stack = ['home'];
const SCREENS = ['home', 'camera', 'editor', 'viewer'];

function showTop() {
  const top = stack[stack.length - 1];
  const base = top === 'sheet' ? stack[stack.length - 2] : top;
  for (const s of SCREENS) $('#' + s).classList.toggle('active', s === base);
  $('#sheet').hidden = top !== 'sheet';
}

function pushScreen(name) {
  stack.push(name);
  history.pushState({ leafscan: stack.length }, '');
  showTop();
}

function popScreen() {
  if (stack.length > 1) history.back();
}

// Voltar fecha telas; "avançar" no navegador é desfeito, porque uma tela fechada
// (câmera, editor) não tem como ser reaberta só pelo histórico.
window.addEventListener('popstate', (e) => {
  const depth = (e.state && e.state.leafscan) || 1;
  if (depth > stack.length) { history.go(stack.length - depth); return; }
  if (depth === stack.length) return;
  while (stack.length > depth) onLeave(stack.pop());
  showTop();
  onEnter(stack[stack.length - 1]);
});

function onLeave(name) {
  if (name === 'camera') stopCamera();
  if (name === 'editor') closeEditor();
  if (name === 'sheet') exportFiles = null;
  if (name === 'viewer' && viewUrl) { URL.revokeObjectURL(viewUrl); viewUrl = ''; $('#pvImg').removeAttribute('src'); }
}

function onEnter(name) {
  if (name === 'viewer') updateViewer();
  if (name === 'home') renderPages();
}

// ================================================================ páginas

function nextPos() { return pages.length ? pages[pages.length - 1].pos + 1 : 1; }

function thumbUrl(p) {
  if (!p.thumb) return '';
  let u = thumbUrls.get(p.id);
  if (!u || u.blob !== p.thumb) {
    if (u) URL.revokeObjectURL(u.url);
    u = { blob: p.thumb, url: URL.createObjectURL(p.thumb) };
    thumbUrls.set(p.id, u);
  }
  return u.url;
}

function dropThumb(id) {
  const u = thumbUrls.get(id);
  if (u) { URL.revokeObjectURL(u.url); thumbUrls.delete(id); }
}

function renderPages() {
  const grid = $('#pages');
  grid.textContent = '';
  pages.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'page-card';
    b.setAttribute('aria-label', `Página ${i + 1}`);
    const tape = document.createElement('span');
    tape.className = 'tape';
    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = '';
    const u = thumbUrl(p);
    if (u) img.src = u;
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = i + 1;
    b.append(tape, img, num);
    if (busy.has(p.id) || !p.out) {
      const s = document.createElement('div');
      s.className = 'busy';
      s.innerHTML = '<span class="spinner"></span>';
      b.append(s);
    }
    b.addEventListener('click', () => openViewer(i));
    grid.append(b);
  });
  $('#pageCount').textContent = pages.length;
  $('#empty').hidden = pages.length > 0;
  $('#btnClear').hidden = pages.length === 0;
  $('#camCount').textContent = pages.length;
}

async function detectOnCanvas(c) {
  await loadCV();
  const small = scaledCanvas(c, STILL_SIZE);
  const m = matFromCanvas(small);
  try {
    const r = detectDocument(m);
    return r.quad ? r.quad.map(([x, y]) => [x / m.cols, y / m.rows]) : null;
  } finally {
    m.delete();
    freeCanvas(small);
  }
}

// Fila: uma página processada por vez, para não estourar a memória do celular.
let queue = Promise.resolve();

function enqueue(p) {
  busy.add(p.id);
  p.ver = (p.ver || 0) + 1;
  const ver = p.ver;
  queue = queue.then(() => (p.ver === ver ? processPage(p) : null)).catch((e) => console.error(e));
  return queue;
}

async function processPage(p) {
  if (!pages.includes(p)) { busy.delete(p.id); return; }
  const mats = [];
  const canvases = [];
  const keep = (m) => { mats.push(m); return m; };
  const canvas = (c) => { canvases.push(c); return c; };
  try {
    const cv = await loadCV();
    const c = canvas(await blobToCanvas(p.orig));
    if (!p.quad) p.quad = (await detectOnCanvas(c)) || insetQuad();
    const src = keep(matFromCanvas(c));
    freeCanvas(c);
    const q = p.quad.map(([x, y]) => [x * src.cols, y * src.rows]);
    const warped = keep(warpDocument(src, q, MAX_OUT));
    src.delete();
    let f = keep(applyFilter(warped, p.filter));
    warped.delete();
    if (p.rot) {
      const r = keep(new cv.Mat());
      cv.rotate(f, r, [cv.ROTATE_90_CLOCKWISE, cv.ROTATE_180, cv.ROTATE_90_COUNTERCLOCKWISE][p.rot - 1]);
      f = r;
    }
    const out = canvas(makeCanvas(f.cols, f.rows));
    out.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(f.data), f.cols, f.rows), 0, 0);
    for (const m of mats.splice(0)) if (!m.isDeleted()) m.delete();
    const blob = await canvasBlob(out, 'image/jpeg', 0.88);
    const th = canvas(scaledCanvas(out, 360));
    const thumb = await canvasBlob(th, 'image/jpeg', 0.75);
    const size = { w: out.width, h: out.height, comps: 3 };
    const info = jpegInfo(await blob.slice(0, 65536).arrayBuffer()) || size;
    Object.assign(p, { out: blob, thumb, w: info.w, h: info.h, comps: info.comps });
    if (pages.includes(p)) await db.put(p);
  } catch (e) {
    console.error(e);
    toast('Não consegui processar uma página: ' + (e.message || e));
  } finally {
    for (const m of mats) if (!m.isDeleted()) m.delete();
    canvases.forEach(freeCanvas);
    busy.delete(p.id);
    renderPages();
    if (stack[stack.length - 1] === 'viewer' && pages[viewIndex] === p) updateViewer();
  }
}

async function addPage(blob, w, h, quad) {
  const p = {
    id: uid(), pos: nextPos(), orig: blob, ow: w, oh: h, quad,
    filter: pref.get('filter', 'magic'), rot: 0, out: null, thumb: null, created: Date.now(),
  };
  pages.push(p);
  busy.add(p.id);
  renderPages();
  try { await db.put(p); } catch (e) { console.warn('não salvou no aparelho', e); }
  enqueue(p);
  if (navigator.storage && navigator.storage.persist && !addPage.asked) {
    addPage.asked = true;
    navigator.storage.persist().catch(() => {});
  }
  return p;
}

async function removePage(p) {
  pages = pages.filter((x) => x !== p);
  busy.delete(p.id);
  dropThumb(p.id);
  await db.del(p.id).catch(() => {});
}

async function swapPages(i, j) {
  const a = pages[i], b = pages[j];
  [a.pos, b.pos] = [b.pos, a.pos];
  pages[i] = b;
  pages[j] = a;
  await Promise.all([db.put(a), db.put(b)]).catch(() => {});
}

// ================================================================ importar fotos

async function importFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
  if (!list.length) return;
  toast(list.length === 1 ? 'Importando a foto…' : `Importando ${list.length} fotos…`);
  for (const f of list) {
    try {
      const c = await blobToCanvas(f, MAX_ORIG);
      const blob = await canvasBlob(c, 'image/jpeg', 0.92);
      let quad = null;
      try { quad = await detectOnCanvas(c); } catch { /* sem motor ainda: processPage tenta de novo */ }
      const w = c.width, h = c.height;
      freeCanvas(c);
      await addPage(blob, w, h, quad || (cvReady() ? insetQuad() : null));
    } catch (e) {
      console.error(e);
      toast(`Não consegui abrir “${f.name}”.`);
    }
  }
}

// ================================================================ câmera

const cam = {
  stream: null, track: null, running: false, timer: 0, smooth: null, tracker: new QuadTracker(),
  stable: 0, sharpMax: 0, armed: true, lastCapture: 0, ref: null, lastSig: null, lost: 0,
  capturing: false, auto: pref.get('auto', true), torch: false, wake: null, thumbUrl: '', token: 0,
};
const live = document.createElement('canvas');
const liveCtx = live.getContext('2d', { willReadFrequently: true });

function setHint(t) { const h = $('#camHint'); if (h.textContent !== t) h.textContent = t; }

function setRing(f) {
  $('#camRing').style.strokeDashoffset = String(276.5 * (1 - Math.max(0, Math.min(1, f))));
}

async function getStream() {
  const base = { facingMode: { ideal: 'environment' } };
  const tries = [
    { ...base, width: { ideal: 3840 }, height: { ideal: 2160 } },
    { ...base, width: { ideal: 1920 }, height: { ideal: 1080 } },
    base,
  ];
  let err;
  for (const video of tries) {
    try { return await navigator.mediaDevices.getUserMedia({ video, audio: false }); } catch (e) {
      err = e;
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') break;
    }
  }
  throw err;
}

async function openCamera() {
  pushScreen('camera');
  $('#camFallback').hidden = true;
  $('#camAuto').setAttribute('aria-pressed', String(cam.auto));
  $('#camAuto').textContent = cam.auto ? 'Auto' : 'Manual';
  setRing(0);
  setHint('Abrindo a câmera…');
  loadCV().catch((e) => toast(e.message));
  await startCamera();
}

async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return cameraFallback('Este navegador não libera a câmera para sites. Use a câmera do aparelho.');
  }
  const token = ++cam.token;
  try {
    const stream = await getStream();
    // a tela mudou, o app foi para o fundo ou outra abertura começou enquanto esperava a permissão
    if (token !== cam.token || stack[stack.length - 1] !== 'camera' || document.hidden) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
    cam.stream = stream;
    cam.track = stream.getVideoTracks()[0];
    const v = $('#video');
    v.srcObject = stream;
    await v.play().catch(() => {});
    const caps = cam.track.getCapabilities ? cam.track.getCapabilities() : {};
    $('#camTorch').hidden = !caps.torch;
    $('#camTorch').setAttribute('aria-pressed', 'false');
    cam.torch = false;
    if (caps.focusMode && caps.focusMode.includes('continuous')) {
      cam.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }
    try { cam.wake = await navigator.wakeLock?.request('screen'); } catch { cam.wake = null; }
    cam.tracker.reset();
    Object.assign(cam, { running: true, smooth: null, stable: 0, sharpMax: 0, armed: true });
    tick();
  } catch (e) {
    console.warn(e);
    const msg = e && e.name === 'NotAllowedError'
      ? 'A câmera foi bloqueada. Libere o acesso nas configurações do navegador ou use a câmera do aparelho.'
      : 'Não foi possível abrir a câmera aqui.';
    cameraFallback(msg);
  }
}

function cameraFallback(msg) {
  $('#camFallbackMsg').textContent = msg;
  $('#camFallback').hidden = false;
  setHint('Câmera indisponível');
}

function stopCamera() {
  cam.token++;
  cam.running = false;
  clearTimeout(cam.timer);
  if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
  cam.stream = null;
  cam.track = null;
  $('#video').srcObject = null;
  if (cam.wake) { cam.wake.release().catch(() => {}); cam.wake = null; }
  const o = $('#camOverlay');
  o.getContext('2d').clearRect(0, 0, o.width, o.height);
}

document.addEventListener('visibilitychange', () => {
  if (stack[stack.length - 1] !== 'camera') return;
  if (document.hidden) stopCamera();
  else startCamera();
});

function sigDiff(a, b) {
  if (!a || !b) return 255;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

function tick() {
  if (!cam.running) return;
  const v = $('#video');
  if (v.readyState >= 2 && v.videoWidth && cvReady() && !cam.capturing) {
    const sc = LIVE_SIZE / Math.max(v.videoWidth, v.videoHeight);
    const w = Math.round(v.videoWidth * sc), h = Math.round(v.videoHeight * sc);
    if (live.width !== w || live.height !== h) { live.width = w; live.height = h; }
    liveCtx.drawImage(v, 0, 0, w, h);
    let r = null;
    const m = window.cv.matFromImageData(liveCtx.getImageData(0, 0, w, h));
    try { r = detectDocument(m); } catch (e) { console.warn(e); } finally { m.delete(); }
    if (r) handleDetection(r, w, h);
  } else if (!cvReady()) {
    setHint('Carregando o motor de imagem…');
  }
  drawCamOverlay();
  cam.timer = setTimeout(tick, 70);
}

function handleDetection(r, w, h) {
  const now = performance.now();
  cam.lastSig = r.sig;
  const cands = r.cands.map((c) => ({ score: c.score, quad: c.quad.map(([x, y]) => [x / w, y / h]) }));
  const q = cam.tracker.update(cands);
  cam.smooth = q;
  cam.stable = cam.tracker.steady;
  cam.sharpMax = cam.stable ? Math.max(cam.sharpMax, r.sharp) : r.sharp;

  // depois de uma captura, só volta a disparar quando a página mudar ou sair do quadro
  if (!cam.armed) {
    cam.lost = q ? 0 : cam.lost + 1;
    if (now - cam.lastCapture > 1000 && (cam.lost >= 4 || sigDiff(r.sig, cam.ref) > 16)) cam.armed = true;
  }

  const progress = cam.auto && cam.armed && q ? cam.stable / STABLE_FRAMES : 0;
  setRing(progress);

  if (!q) setHint(cam.armed ? 'Procurando a folha…' : 'Pronto! Próxima página');
  else if (!cam.armed) setHint('Capturada ✓ Vire a página');
  else if (!cam.auto) setHint('Folha encontrada. Toque para fotografar');
  else if (cam.stable < STABLE_FRAMES) setHint('Segure firme…');

  // dispara com a imagem firme e no quadro mais nítido da sequência
  if (cam.auto && cam.armed && q && cam.stable >= STABLE_FRAMES && r.sharp >= cam.sharpMax * 0.8 &&
      now - cam.lastCapture > 1200) {
    capture();
  }
}

// Área em que o vídeo aparece na tela (object-fit: contain).
function videoRect(stage, vw, vh) {
  const s = Math.min(stage.clientWidth / vw, stage.clientHeight / vh);
  return { s, ox: (stage.clientWidth - vw * s) / 2, oy: (stage.clientHeight - vh * s) / 2 };
}

function drawCamOverlay() {
  const o = $('#camOverlay'), stage = $('#camStage'), v = $('#video');
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(stage.clientWidth * dpr), H = Math.round(stage.clientHeight * dpr);
  if (o.width !== W || o.height !== H) { o.width = W; o.height = H; }
  const ctx = o.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!cam.smooth || !v.videoWidth) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const r = videoRect(stage, v.videoWidth, v.videoHeight);
  const pts = cam.smooth.map(([x, y]) => [r.ox + x * v.videoWidth * r.s, r.oy + y * v.videoHeight * r.s]);
  const done = !cam.armed;
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.closePath();
  ctx.fillStyle = done ? 'rgba(125,154,120,.28)' : 'rgba(224,122,95,.2)';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = done ? '#7d9a78' : '#e07a5f';
  ctx.setLineDash(cam.stable >= 2 || done ? [] : [10, 7]);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], 7, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.stroke();
  }
}

function flash() {
  const f = $('#camFlash');
  f.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on')));
  if (navigator.vibrate) navigator.vibrate(30);
}

async function capture() {
  const v = $('#video');
  if (cam.capturing || v.readyState < 2 || !v.videoWidth) return;
  cam.capturing = true;
  flash();
  const liveQ = cam.smooth && cam.stable >= 2 ? cam.smooth.map((p) => p.slice()) : null;
  Object.assign(cam, { ref: cam.lastSig, armed: false, lost: 0, lastCapture: performance.now(), stable: 0 });
  cam.tracker.steady = 0;
  setRing(0);
  try {
    const c = scaledCanvas(v, MAX_ORIG);
    const blob = await canvasBlob(c, 'image/jpeg', 0.92);
    let quad = null;
    if (cvReady()) {
      try {
        const still = await detectOnCanvas(c);
        if (still && (!liveQ || quadDist(still, liveQ) < 0.06)) quad = still;
      } catch (e) { console.warn(e); }
    }
    quad = quad || liveQ || (cvReady() ? insetQuad() : null);
    const w = c.width, h = c.height;
    freeCanvas(c);
    if (cam.thumbUrl) URL.revokeObjectURL(cam.thumbUrl);
    cam.thumbUrl = URL.createObjectURL(blob);
    $('#camThumbImg').src = cam.thumbUrl;
    await addPage(blob, w, h, quad);
    setHint(`Página ${pages.length} capturada ✓`);
  } catch (e) {
    console.error(e);
    toast('Falha ao fotografar: ' + (e.message || e));
  } finally {
    cam.capturing = false;
  }
}

// ================================================================ visualizar página

let viewIndex = 0;
let viewUrl = '';

function openViewer(i) {
  viewIndex = i;
  pushScreen('viewer');
  updateViewer();
}

function updateViewer() {
  if (!pages.length) { if (stack[stack.length - 1] === 'viewer') popScreen(); return; }
  viewIndex = Math.max(0, Math.min(viewIndex, pages.length - 1));
  const p = pages[viewIndex];
  $('#pvTitle').textContent = `Página ${viewIndex + 1} de ${pages.length}`;
  if (viewUrl) URL.revokeObjectURL(viewUrl);
  viewUrl = p.out ? URL.createObjectURL(p.out) : '';
  const img = $('#pvImg');
  if (viewUrl) img.src = viewUrl; else img.removeAttribute('src');
  $('#pvBusy').hidden = !(busy.has(p.id) || !p.out);
  $('#pvPrev').disabled = viewIndex === 0;
  $('#pvNext').disabled = viewIndex === pages.length - 1;
  $('#pvMoveL').disabled = viewIndex === 0;
  $('#pvMoveR').disabled = viewIndex === pages.length - 1;
  for (const b of $('#pvFilters').children) b.setAttribute('aria-checked', String(b.dataset.f === p.filter));
}

function buildFilterChips() {
  const box = $('#pvFilters');
  for (const f of FILTERS) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.f = f.id;
    b.setAttribute('role', 'radio');
    b.textContent = f.label;
    b.addEventListener('click', () => {
      const p = pages[viewIndex];
      if (!p || p.filter === f.id) return;
      p.filter = f.id;
      pref.set('filter', f.id);
      enqueue(p);
      updateViewer();
    });
    box.append(b);
  }
}

// ================================================================ editor de cantos com lupa

const ed = {
  page: null, src: null, quad: null, rect: null, active: null, edges: null, edgeScale: 1,
  magnet: pref.get('magnet', true), pointer: null,
};

async function openEditor(p) {
  pushScreen('editor');
  ed.page = p;
  ed.edges = null;
  $('#edMagnet').setAttribute('aria-pressed', String(ed.magnet));
  setEdMsg('Abrindo a foto…');
  try {
    ed.src = await blobToCanvas(p.orig);
  } catch (e) {
    toast('Não consegui abrir a foto original.');
    popScreen();
    return;
  }
  if (stack[stack.length - 1] !== 'editor') { freeCanvas(ed.src); ed.src = null; return; }
  const q = p.quad || insetQuad();
  ed.quad = q.map(([x, y]) => [x * ed.src.width, y * ed.src.height]);
  layoutEditor();
  setEdMsg('Arraste os cantos ou os lados. A lupa mostra o ponto exato.');
  loadCV().then(() => {
    if (!ed.src) return;
    const small = scaledCanvas(ed.src, 1000);
    ed.edgeScale = small.width / ed.src.width;
    ed.edges = edgeMap(small);
    freeCanvas(small);
  }).catch(() => {});
}

function closeEditor() {
  freeCanvas(ed.src);
  ed.src = null;
  ed.page = null;
  ed.edges = null;
  ed.active = null;
  $('#loupe').classList.remove('on');
}

function setEdMsg(t, warn = false) {
  const m = $('#edMsg');
  m.textContent = t;
  m.classList.toggle('warn', warn);
}

function layoutEditor() {
  if (!ed.src) return;
  const stage = $('#edStage');
  const dpr = window.devicePixelRatio || 1;
  const cw = stage.clientWidth, ch = stage.clientHeight - 34; // espaço do aviso embaixo
  const pad = 18;
  const s = Math.min((cw - pad * 2) / ed.src.width, (ch - pad * 2) / ed.src.height);
  ed.rect = { s, ox: (cw - ed.src.width * s) / 2, oy: (ch - ed.src.height * s) / 2 };
  for (const id of ['#edCanvas', '#edOverlay']) {
    const c = $(id);
    c.width = Math.round(cw * dpr);
    c.height = Math.round(stage.clientHeight * dpr);
  }
  const ctx = $('#edCanvas').getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, stage.clientHeight);
  ctx.imageSmoothingQuality = 'high';
  ctx.shadowColor = 'rgba(0,0,0,.45)';
  ctx.shadowBlur = 14;
  ctx.drawImage(ed.src, ed.rect.ox, ed.rect.oy, ed.src.width * s, ed.src.height * s);
  drawEdOverlay();
}

const toScreen = ([x, y]) => [ed.rect.ox + x * ed.rect.s, ed.rect.oy + y * ed.rect.s];
const edValid = () => quadIsValid(ed.quad, ed.src.width, ed.src.height);

function drawEdOverlay() {
  const o = $('#edOverlay');
  const dpr = window.devicePixelRatio || 1;
  const ctx = o.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, o.width, o.height);
  if (!ed.src) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const pts = ed.quad.map(toScreen);
  const ok = edValid();
  const { ox, oy, s } = ed.rect;
  // escurece o que fica fora do recorte
  ctx.beginPath();
  ctx.rect(ox, oy, ed.src.width * s, ed.src.height * s);
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.closePath();
  ctx.fillStyle = 'rgba(20,18,16,.5)';
  ctx.fill('evenodd');
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.closePath();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = ok ? '#e07a5f' : '#d33';
  ctx.stroke();
  // alças dos lados
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4];
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(ang);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = ok ? '#e07a5f' : '#d33';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(-13, -4.5, 26, 9, 4.5) : ctx.rect(-13, -4.5, 26, 9);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  // cantos
  pts.forEach((p, i) => {
    const on = ed.active && ed.active.type === 'corner' && ed.active.i === i;
    ctx.beginPath();
    ctx.arc(p[0], p[1], on ? 6 : 11, 0, Math.PI * 2);
    ctx.fillStyle = on ? 'rgba(255,255,255,.4)' : '#fff';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = ok ? '#e07a5f' : '#d33';
    ctx.stroke();
  });
  $('#edApply').disabled = !ok;
}

// Lupa: amplia a região do ponto arrastado e fica do lado oposto ao dedo,
// para o dedo nunca cobrir o que se está ajustando.
function drawLoupe(focus, clientX, clientY) {
  const L = $('#loupe');
  const stage = $('#edStage');
  const box = stage.getBoundingClientRect();
  const size = 150, margin = 10;
  const fx = clientX - box.left, fy = clientY - box.top;
  let left = fx < box.width / 2 ? box.width - size - margin : margin;
  let top = margin;
  if (fy < size + 60 && Math.abs(fx - (left + size / 2)) < size) top = box.height - size - 44;
  L.style.left = left + 'px';
  L.style.top = top + 'px';
  const dpr = window.devicePixelRatio || 1;
  const px = Math.round(size * dpr);
  if (L.width !== px) { L.width = px; L.height = px; }
  const ctx = L.getContext('2d');
  const zoom = 3; // em relação ao que aparece na tela
  const k = ed.rect.s * zoom * dpr;  // pixels da lupa por pixel da foto
  const half = px / 2 / k;
  const sx = focus[0] - half, sy = focus[1] - half;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#1b1917';
  ctx.fillRect(0, 0, px, px);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(ed.src, sx, sy, half * 2, half * 2, 0, 0, px, px);
  const T = ([x, y]) => [(x - sx) * k, (y - sy) * k];
  const pts = ed.quad.map(T);
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.closePath();
  ctx.lineWidth = 2 * dpr;
  ctx.strokeStyle = edValid() ? 'rgba(224,122,95,.95)' : 'rgba(221,51,51,.95)';
  ctx.stroke();
  const c = px / 2, arm = 14 * dpr, gap = 4 * dpr;
  ctx.lineWidth = 2 * dpr;
  ctx.strokeStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(c - arm, c); ctx.lineTo(c - gap, c);
  ctx.moveTo(c + gap, c); ctx.lineTo(c + arm, c);
  ctx.moveTo(c, c - arm); ctx.lineTo(c, c - gap);
  ctx.moveTo(c, c + gap); ctx.lineTo(c, c + arm);
  ctx.stroke();
  ctx.lineWidth = 1 * dpr;
  ctx.strokeStyle = 'rgba(0,0,0,.6)';
  ctx.beginPath();
  ctx.arc(c, c, gap, 0, Math.PI * 2);
  ctx.stroke();
  L.classList.add('on');
}

function edPick(x, y) {
  const pts = ed.quad.map(toScreen);
  let best = null, bd = Infinity;
  pts.forEach((p, i) => {
    const d = Math.hypot(p[0] - x, p[1] - y);
    if (d < bd) { bd = d; best = { type: 'corner', i }; }
  });
  if (bd <= 44) return best;
  let eb = null, ebd = Infinity;
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4];
    const d = Math.hypot((a[0] + b[0]) / 2 - x, (a[1] + b[1]) / 2 - y);
    if (d < ebd) { ebd = d; eb = { type: 'edge', i }; }
  }
  if (ebd <= 40) return eb;
  return bd <= 70 ? best : null;
}

function edFocus() {
  const a = ed.active;
  if (a.type === 'corner') return ed.quad[a.i];
  const p = ed.quad[a.i], n = ed.quad[(a.i + 1) % 4];
  return [(p[0] + n[0]) / 2, (p[1] + n[1]) / 2];
}

function bindEditor() {
  const o = $('#edOverlay');
  o.addEventListener('pointerdown', (e) => {
    if (!ed.src || ed.active) return;
    const box = o.getBoundingClientRect();
    const hit = edPick(e.clientX - box.left, e.clientY - box.top);
    if (!hit) return;
    e.preventDefault();
    o.setPointerCapture(e.pointerId);
    ed.active = hit;
    ed.pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, start: ed.quad.map((p) => p.slice()) };
    drawEdOverlay();
    drawLoupe(edFocus(), e.clientX, e.clientY);
  });
  o.addEventListener('pointermove', (e) => {
    if (!ed.active || e.pointerId !== ed.pointer.id) return;
    e.preventDefault();
    const dx = (e.clientX - ed.pointer.x) / ed.rect.s, dy = (e.clientY - ed.pointer.y) / ed.rect.s;
    const W = ed.src.width, H = ed.src.height;
    const move = (i) => {
      const s = ed.pointer.start[i];
      ed.quad[i] = [Math.max(0, Math.min(W, s[0] + dx)), Math.max(0, Math.min(H, s[1] + dy))];
    };
    move(ed.active.i);
    if (ed.active.type === 'edge') move((ed.active.i + 1) % 4);
    drawEdOverlay();
    drawLoupe(edFocus(), e.clientX, e.clientY);
  });
  const end = (e) => {
    if (!ed.active || e.pointerId !== ed.pointer.id) return;
    const moved = ed.active.type === 'corner' ? [ed.active.i] : [ed.active.i, (ed.active.i + 1) % 4];
    if (ed.magnet && ed.edges) {
      const k = ed.edgeScale;
      for (const i of moved) {
        const q = ed.quad.map(([x, y]) => [x * k, y * k]);
        const sn = snapCorner(ed.edges, q, i, 10);
        ed.quad[i] = [sn[0] / k, sn[1] / k];
      }
    }
    ed.active = null;
    ed.pointer = null;
    $('#loupe').classList.remove('on');
    drawEdOverlay();
    if (!edValid()) setEdMsg('Recorte inválido: os cantos se cruzaram ou ficaram próximos demais.', true);
    else setEdMsg('Arraste os cantos ou os lados. A lupa mostra o ponto exato.');
  };
  o.addEventListener('pointerup', end);
  o.addEventListener('pointercancel', end);

  $('#edCancel').addEventListener('click', () => popScreen());
  $('#edApply').addEventListener('click', () => {
    if (!ed.src || !edValid()) return;
    const p = ed.page;
    p.quad = ed.quad.map(([x, y]) => [x / ed.src.width, y / ed.src.height]);
    enqueue(p);
    db.put(p).catch(() => {});
    popScreen();
  });
  $('#edAuto').addEventListener('click', async () => {
    if (!ed.src) return;
    setEdMsg('Procurando a folha…');
    try {
      const q = await detectOnCanvas(ed.src);
      if (!ed.src) return;
      if (q) {
        ed.quad = q.map(([x, y]) => [x * ed.src.width, y * ed.src.height]);
        setEdMsg('Folha encontrada. Ajuste se precisar.');
      } else {
        setEdMsg('Não achei a folha. Ajuste os cantos à mão.', true);
      }
      drawEdOverlay();
    } catch (e) {
      setEdMsg('Motor de imagem indisponível.', true);
    }
  });
  $('#edFull').addEventListener('click', () => {
    if (!ed.src) return;
    ed.quad = fullQuad().map(([x, y]) => [x * ed.src.width, y * ed.src.height]);
    drawEdOverlay();
  });
  $('#edMagnet').addEventListener('click', () => {
    ed.magnet = !ed.magnet;
    pref.set('magnet', ed.magnet);
    $('#edMagnet').setAttribute('aria-pressed', String(ed.magnet));
    toast(ed.magnet ? 'Ímã ligado: o canto encosta na borda do papel.' : 'Ímã desligado.');
  });
  window.addEventListener('resize', () => { if (stack[stack.length - 1] === 'editor') layoutEditor(); });
}

// ================================================================ exportar

let exportFiles = null;
const exportOpts = { fmt: pref.get('fmt', 'pdf'), size: pref.get('size', 'a4') };

function docName() {
  const v = $('#docName').value.trim() || defaultName();
  return v.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120);
}

function syncSeg() {
  for (const seg of document.querySelectorAll('.seg')) {
    const name = seg.dataset.name;
    for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.v === exportOpts[name]));
  }
  $('#sizeField').hidden = exportOpts.fmt !== 'pdf';
  // Em alguns Android (visto num Xiaomi com Android 10) o sistema abre o app de
  // destino mas não lhe entrega o arquivo, e nada avisa; fica o caminho manual.
  const hint = $('#sheetHint');
  hint.hidden = !isAndroid;
  hint.innerHTML = exportOpts.fmt === 'pdf'
    ? 'Se o arquivo não chegar ao WhatsApp, toque em <b>Salvar arquivo</b> e depois, no WhatsApp, use o clipe → <b>Documento</b> e escolha o PDF em Downloads.'
    : 'Se as imagens não chegarem ao WhatsApp, toque em <b>Salvar arquivo</b> e depois, no WhatsApp, use o clipe → <b>Galeria</b>.';
}

async function openExport() {
  if (!pages.length) { toast('Ainda não há páginas para exportar.'); return; }
  pushScreen('sheet');
  syncSeg();
  $('#exShare').disabled = true;
  $('#exSave').disabled = true;
  $('#sheetInfo').textContent = 'Terminando de processar as páginas…';
  while (busy.size) { await queue; await sleep(30); }
  if (stack[stack.length - 1] !== 'sheet') return;
  const missing = pages.filter((p) => !p.out).length;
  if (missing) {
    $('#sheetInfo').textContent = `${missing} página(s) não puderam ser processadas. Abra-as e ajuste os cantos.`;
    return;
  }
  prepareFiles();
}

const isAndroid = /Android/i.test(navigator.userAgent);
let prepToken = 0;

async function prepareFiles() {
  const token = ++prepToken;
  const name = docName();
  let files;
  if (exportOpts.fmt === 'pdf') {
    const blob = buildPdf(pages.map((p) => ({ blob: p.out, w: p.w, h: p.h, comps: p.comps })), { size: exportOpts.size, title: name });
    files = [new File([blob], name + '.pdf', { type: 'application/pdf' })];
  } else {
    files = pages.map((p, i) => new File([p.out], `${name} - ${String(i + 1).padStart(3, '0')}.jpg`, { type: 'image/jpeg' }));
  }
  // No Android, o arquivo montado com pedaços guardados no IndexedDB chega ilegível
  // ao WhatsApp (ele fecha sem enviar). Lá o arquivo é copiado para a memória num
  // bloco só antes do toque em "Compartilhar"; o toque continua imediato.
  if (isAndroid) {
    exportFiles = null;
    $('#exShare').disabled = true;
    $('#exSave').disabled = true;
    $('#sheetInfo').textContent = 'Preparando o arquivo…';
    try {
      files = await Promise.all(files.map(async (f) => new File([await f.arrayBuffer()], f.name, { type: f.type })));
    } catch (e) {
      console.error(e);
      if (token === prepToken) $('#sheetInfo').textContent = 'Não consegui preparar o arquivo: ' + (e.message || e);
      return;
    }
    if (token !== prepToken || stack[stack.length - 1] !== 'sheet') return;
  }
  exportFiles = files;
  const total = exportFiles.reduce((s, f) => s + f.size, 0);
  const n = pages.length;
  $('#sheetInfo').textContent = exportOpts.fmt === 'pdf'
    ? `${n} página${n > 1 ? 's' : ''} · PDF de ${fmtSize(total)}`
    : `${n} imagem${n > 1 ? 'ns' : ''} · ${fmtSize(total)} no total`;
  const canShare = !!(navigator.canShare && navigator.canShare({ files: exportFiles }));
  $('#exShare').disabled = !canShare;
  $('#exShare').title = canShare ? '' : 'Este navegador não compartilha arquivos; use “Salvar arquivo”.';
  $('#exSave').disabled = false;
}

async function shareFiles() {
  if (!exportFiles) return;
  // No Android, mandar título junto com o arquivo faz o WhatsApp (e outros apps)
  // receber só o texto e descartar o PDF; lá vai só o arquivo, que já leva o nome.
  try {
    await navigator.share(isAndroid ? { files: exportFiles } : { files: exportFiles, title: docName() });
  } catch (e) {
    if (e.name !== 'AbortError') {
      toast('Não deu para compartilhar (' + (e.message || e.name) + '). Use “Salvar arquivo” e envie pelo app.', 6000);
    }
  }
}

async function saveFiles() {
  if (!exportFiles) return;
  if (exportFiles.length > 1) {
    toast('Salvando uma imagem por vez. Se o navegador perguntar, permita vários downloads. No iPhone, prefira “Compartilhar”.', 5000);
  } else if (isAndroid) {
    toast('PDF salvo em Downloads. No WhatsApp, toque no clipe → Documento e escolha o arquivo.', 6000);
  }
  for (const f of exportFiles) {
    const a = document.createElement('a');
    const u = URL.createObjectURL(f);
    a.href = u;
    a.download = f.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 60000);
    if (exportFiles.length > 1) await sleep(400);
  }
}

// ================================================================ ligações

function bind() {
  $('#docName').value = pref.get('docName', '') || defaultName();
  $('#docName').addEventListener('change', () => pref.set('docName', $('#docName').value.trim()));

  $('#btnScan').addEventListener('click', openCamera);
  $('#btnImport').addEventListener('click', () => $('#fileImport').click());
  $('#btnExport').addEventListener('click', openExport);
  $('#fileImport').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });
  $('#fileCapture').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });
  $('#btnClear').addEventListener('click', async () => {
    if (!confirm(`Apagar as ${pages.length} páginas deste aparelho?`)) return;
    for (const p of pages) dropThumb(p.id);
    pages = [];
    busy.clear();
    await db.clear().catch(() => {});
    $('#docName').value = defaultName();
    pref.set('docName', '');
    renderPages();
  });

  // câmera
  $('#camClose').addEventListener('click', () => popScreen());
  $('#camShutter').addEventListener('click', () => capture());
  $('#camThumb').addEventListener('click', () => popScreen());
  $('#camSystem').addEventListener('click', () => $('#fileCapture').click());
  $('#camAuto').addEventListener('click', () => {
    cam.auto = !cam.auto;
    pref.set('auto', cam.auto);
    $('#camAuto').setAttribute('aria-pressed', String(cam.auto));
    $('#camAuto').textContent = cam.auto ? 'Auto' : 'Manual';
    cam.stable = 0;
    setRing(0);
  });
  $('#camTorch').addEventListener('click', () => {
    if (!cam.track) return;
    cam.torch = !cam.torch;
    cam.track.applyConstraints({ advanced: [{ torch: cam.torch }] }).catch(() => { cam.torch = false; });
    $('#camTorch').setAttribute('aria-pressed', String(cam.torch));
  });

  // página
  buildFilterChips();
  $('#pvBack').addEventListener('click', () => popScreen());
  $('#pvPrev').addEventListener('click', () => { viewIndex--; updateViewer(); });
  $('#pvNext').addEventListener('click', () => { viewIndex++; updateViewer(); });
  $('#pvCrop').addEventListener('click', () => { const p = pages[viewIndex]; if (p) openEditor(p); });
  $('#pvRotate').addEventListener('click', () => {
    const p = pages[viewIndex];
    if (!p) return;
    p.rot = ((p.rot || 0) + 1) % 4;
    enqueue(p);
    updateViewer();
  });
  $('#pvDelete').addEventListener('click', async () => {
    const p = pages[viewIndex];
    if (!p || !confirm(`Excluir a página ${viewIndex + 1}?`)) return;
    await removePage(p);
    renderPages();
    updateViewer();
  });
  $('#pvMoveL').addEventListener('click', async () => {
    if (viewIndex <= 0) return;
    await swapPages(viewIndex, viewIndex - 1);
    viewIndex--;
    renderPages();
    updateViewer();
  });
  $('#pvMoveR').addEventListener('click', async () => {
    if (viewIndex >= pages.length - 1) return;
    await swapPages(viewIndex, viewIndex + 1);
    viewIndex++;
    renderPages();
    updateViewer();
  });
  $('#pvAll').addEventListener('click', () => {
    const p = pages[viewIndex];
    if (!p) return;
    const label = FILTERS.find((f) => f.id === p.filter).label;
    const others = pages.filter((x) => x.filter !== p.filter);
    if (!others.length) { toast(`Todas as páginas já estão em “${label}”.`); return; }
    if (!confirm(`Aplicar “${label}” às outras ${others.length} página(s)?`)) return;
    for (const x of others) { x.filter = p.filter; enqueue(x); }
    renderPages();
    updateViewer();
  });

  // exportar
  for (const seg of document.querySelectorAll('.seg')) {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      exportOpts[seg.dataset.name] = b.dataset.v;
      pref.set(seg.dataset.name, b.dataset.v);
      syncSeg();
      if (exportFiles) prepareFiles();
    });
  }
  $('#exShare').addEventListener('click', shareFiles);
  $('#exSave').addEventListener('click', saveFiles);
  $('#exClose').addEventListener('click', () => popScreen());
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') popScreen(); });

  bindEditor();
}

async function init() {
  history.replaceState(null, '');
  bind();
  try {
    pages = await db.all();
  } catch (e) {
    console.warn(e);
    pages = [];
  }
  renderPages();
  for (const p of pages) if (!p.out) enqueue(p);

  // o carregamento do motor é silencioso; só avisa se falhar
  loadCV().catch((e) => {
    const st = $('#engineStatus');
    st.textContent = e.message;
    st.hidden = false;
  });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  }
}

init();
