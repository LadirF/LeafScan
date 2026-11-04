// Visão computacional do LeafScan (OpenCV.js): detecção da folha, recorte em
// perspectiva, filtros e o "ímã" que encosta o canto na borda do papel.

const CV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';

let cvPromise = null;

export function loadCV() {
  if (cvPromise) return cvPromise;
  cvPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = CV_URL;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onerror = () => {
      cvPromise = null;
      s.remove();
      reject(new Error('Não foi possível carregar o motor de imagem. Verifique a internet.'));
    };
    s.onload = async () => {
      try {
        let c = window.cv;
        if (c instanceof Promise) c = await c;
        await new Promise((res) => {
          const ready = () => c.Mat && c.getBuildInformation;
          if (ready()) return res();
          const t = setInterval(() => { if (ready()) { clearInterval(t); res(); } }, 100);
          const prev = c.onRuntimeInitialized;
          c.onRuntimeInitialized = () => { if (prev) prev(); clearInterval(t); res(); };
        });
        // o módulo do Emscripten tem um .then que se devolve a si mesmo; se ficar,
        // resolve(c) entra em laço infinito (a página congela)
        if (typeof c.then === 'function') delete c.then;
        window.cv = c;
        resolve(c);
      } catch (e) {
        reject(e);
      }
    };
    document.head.appendChild(s);
  });
  return cvPromise;
}

export const cvReady = () => !!(window.cv && window.cv.Mat && window.cv.getBuildInformation);

// ---------------------------------------------------------------- geometria

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Ordena os 4 cantos como [sup-esq, sup-dir, inf-dir, inf-esq] (sentido horário na tela).
export function orderQuad(pts) {
  const cx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
  const cy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
  const s = pts.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let k = 0;
  for (let i = 1; i < 4; i++) if (s[i][0] + s[i][1] < s[k][0] + s[k][1]) k = i;
  return [0, 1, 2, 3].map((i) => s[(k + i) % 4]);
}

export function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i], n = q[(i + 1) % 4];
    a += p[0] * n[1] - n[0] * p[1];
  }
  return Math.abs(a) / 2;
}

export function isConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(z) < 1e-9) return false;
    const s = Math.sign(z);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

// Um recorte é válido se for convexo, não degenerado e com ângulos razoáveis.
export function quadIsValid(q, w, h) {
  if (!isConvex(q)) return false;
  if (quadArea(q) < w * h * 0.01) return false;
  for (let i = 0; i < 4; i++) if (dist(q[i], q[(i + 1) % 4]) < Math.min(w, h) * 0.04) return false;
  return true;
}

// Proporção real (largura/altura) de um retângulo visto em perspectiva, pelo
// método de Zhang & He (2007), supondo o centro óptico no centro da foto.
// Devolve null quando a estimativa não é confiável.
export function aspectRatio(q, W, H) {
  const u0 = W / 2, v0 = H / 2;
  const P = (p) => [p[0] - u0, p[1] - v0, 1];
  const m1 = P(q[0]), m2 = P(q[1]), m3 = P(q[3]), m4 = P(q[2]);
  const k2 = dot3(cross3(m1, m4), m3) / dot3(cross3(m2, m4), m3);
  const k3 = dot3(cross3(m1, m4), m2) / dot3(cross3(m3, m4), m2);
  if (!isFinite(k2) || !isFinite(k3)) return null;
  const n2 = m2.map((v, i) => k2 * v - m1[i]);
  const n3 = m3.map((v, i) => k3 * v - m1[i]);
  // distância focal estimada pela própria folha; quando a folha só está inclinada
  // num eixo (dois lados paralelos na foto) ela não sai da conta, então usa-se a
  // de uma câmera principal típica de celular (~0,75 do lado maior da foto)
  const L = Math.max(W, H);
  const den = n2[2] * n3[2];
  let f2 = Math.abs(den) > 1e-6 ? -(n2[0] * n3[0] + n2[1] * n3[1]) / den : NaN;
  if (!(f2 > (0.4 * L) ** 2 && f2 < (3 * L) ** 2)) f2 = (0.75 * L) ** 2;
  const r = Math.sqrt((n2[0] ** 2 + n2[1] ** 2) / f2 + n2[2] ** 2) /
            Math.sqrt((n3[0] ** 2 + n3[1] ** 2) / f2 + n3[2] ** 2);
  if (!isFinite(r) || r <= 0) return null;
  return r;
}

// Maior deslocamento entre cantos correspondentes (coordenadas normalizadas).
export function quadDist(a, b) {
  let m = 0;
  for (let i = 0; i < 4; i++) m = Math.max(m, dist(a[i], b[i]));
  return m;
}

// ---------------------------------------------------------------- detecção

// Fração dos pontos de cada lado que caem sobre uma borda do mapa (tolerância tol px).
function edgeSupport(data, W, H, a, b, from = 0, to = 1, tol = 2) {
  const L = dist(a, b);
  const n = Math.max(8, Math.min(60, Math.round(L * (to - from) / 3)));
  let hit = 0;
  for (let k = 0; k < n; k++) {
    const t = from + (to - from) * (k + 0.5) / n;
    const x = Math.round(a[0] + (b[0] - a[0]) * t);
    const y = Math.round(a[1] + (b[1] - a[1]) * t);
    let found = false;
    for (let dy = -tol; dy <= tol && !found; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      for (let dx = -tol; dx <= tol; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < W && data[yy * W + xx]) { found = true; break; }
      }
    }
    if (found) hit++;
  }
  return hit / n;
}

function quadSupport(data, W, H, q) {
  let s = 0;
  for (let i = 0; i < 4; i++) s += edgeSupport(data, W, H, q[i], q[(i + 1) % 4]);
  return s / 4;
}

// Contraste médio (-1 a 1) entre um ponto logo dentro e outro logo fora de cada
// lado. Folha clara sobre fundo escuro dá perto de 1; a moldura de uma prancheta
// escura sobre a mesa dá perto de 0. Pontos fora da imagem não contam.
function sideContrast(lum, W, H, q, off) {
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
  const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  const at = (x, y) => {
    x = Math.round(x); y = Math.round(y);
    return x < 0 || y < 0 || x >= W || y >= H ? -1 : lum[y * W + x];
  };
  let sum = 0, n = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    let nx = -(b[1] - a[1]), ny = b[0] - a[0];
    const L = Math.hypot(nx, ny) || 1;
    nx /= L; ny /= L;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    if (nx * (cx - mx) + ny * (cy - my) < 0) { nx = -nx; ny = -ny; } // normal para dentro
    for (let k = 1; k <= 8; k++) {
      const t = k / 9;
      const px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
      const inside = at(px + nx * off, py + ny * off), outside = at(px - nx * off, py - ny * off);
      if (inside < 0 || outside < 0) continue;
      sum += (inside - outside) / 255;
      n++;
    }
  }
  return n >= 8 ? sum / n : 0;
}

// Quantos cantos estão colados na borda da imagem (folha cortada ou contorno falso).
function cornersAtBorder(q, W, H) {
  const m = Math.min(W, H) * 0.015;
  return q.filter(([x, y]) => x < m || y < m || x > W - m || y > H - m).length;
}

function anglesOk(q) {
  for (let i = 0; i < 4; i++) {
    const p = q[(i + 3) % 4], c = q[i], n = q[(i + 1) % 4];
    const v1 = [p[0] - c[0], p[1] - c[1]], v2 = [n[0] - c[0], n[1] - c[1]];
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2));
    const ang = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
    if (ang < 40 || ang > 140) return false;
  }
  return true;
}

function quadsFromBinary(cv, bin, minArea, out) {
  const contours = new cv.MatVector();
  const hier = new cv.Mat();
  const hull = new cv.Mat();
  const approx = new cv.Mat();
  try {
    cv.findContours(bin, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      try {
        if (cv.contourArea(c) < minArea) continue;
        cv.convexHull(c, hull, false, true);
        const peri = cv.arcLength(hull, true);
        for (const f of [0.02, 0.03, 0.045, 0.065]) {
          cv.approxPolyDP(hull, approx, f * peri, true);
          if (approx.rows === 4) {
            const d = approx.data32S;
            out.push(orderQuad([[d[0], d[1]], [d[2], d[3]], [d[4], d[5]], [d[6], d[7]]]));
            break;
          }
          if (approx.rows < 4) break;
        }
      } finally {
        c.delete();
      }
    }
  } finally {
    contours.delete(); hier.delete(); hull.delete(); approx.delete();
  }
}

// Procura a folha numa imagem pequena (cv.Mat RGBA, ~400–700 px).
// Testa vários "modos" de borda (luminância forte, luminância fraca, saturação
// e máscara clara) e escolhe o quadrilátero com mais borda real nos 4 lados.
// Devolve { quad|null, support, sharp, sig }.
export function detectDocument(src) {
  const cv = window.cv;
  const W = src.cols, H = src.rows;
  const minArea = W * H * 0.1;
  const mats = [];
  const M = () => { const m = new cv.Mat(); mats.push(m); return m; };
  const gray = M(), blur = M(), tmp = M(), eA = M(), eB = M(), eS = M(), hsv = M(), sat = M(), ref = M(), dil = M(), mask = M(), lap = M(), mean = M(), std = M(), sig = M();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  const kClose = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
  mats.push(kernel, kClose);
  const chans = new cv.MatVector();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    // nitidez (variância do laplaciano) e assinatura 24x24 para notar troca de página
    cv.Laplacian(gray, lap, cv.CV_16S);
    cv.meanStdDev(lap, mean, std);
    const sharp = std.data64F[0] ** 2;
    cv.resize(blur, sig, new cv.Size(24, 24), 0, 0, cv.INTER_AREA);
    const signature = new Uint8Array(sig.data);

    const otsu = cv.threshold(blur, tmp, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
    const hi = Math.min(200, Math.max(40, otsu));
    cv.Canny(blur, eA, hi * 0.5, hi);                 // modo 1: contraste normal
    cv.Canny(blur, eB, 12, 36);                        // modo 2: papel claro em fundo claro
    cv.cvtColor(src, hsv, cv.COLOR_RGBA2RGB);
    cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);
    cv.split(hsv, chans);
    const s = chans.get(1);
    cv.GaussianBlur(s, sat, new cv.Size(5, 5), 0);
    s.delete();
    cv.Canny(sat, eS, 20, 60);                         // modo 3: fundo colorido
    cv.bitwise_or(eA, eB, ref);
    cv.bitwise_or(ref, eS, ref);

    const cands = [];
    for (const e of [eA, eB, eS]) {
      cv.dilate(e, dil, kernel);
      quadsFromBinary(cv, dil, minArea, cands);
    }
    // modo 4: região clara (folha branca sobre mesa escura)
    cv.morphologyEx(tmp, mask, cv.MORPH_CLOSE, kClose);
    quadsFromBinary(cv, mask, minArea, cands);

    // Nota de cada candidato. A área entra só pela raiz, para a moldura maior
    // (prancheta, tela, mesa) não ganhar da folha; pesam mais a borda real nos
    // 4 lados e o contraste papel × fundo logo dentro e fora de cada lado.
    const scored = [];
    const data = ref.data, lum = blur.data;
    const minDim = Math.min(W, H);
    for (const q of cands) {
      if (!isConvex(q) || !anglesOk(q)) continue;
      let minSide = Infinity;
      for (let i = 0; i < 4; i++) minSide = Math.min(minSide, dist(q[i], q[(i + 1) % 4]));
      if (minSide < minDim * 0.15) continue;
      const sup = quadSupport(data, W, H, q);
      if (sup < 0.45) continue;
      const con = sideContrast(lum, W, H, q, minDim * 0.03);
      const edge = cornersAtBorder(q, W, H);
      const score = Math.sqrt(quadArea(q) / (W * H)) * sup * sup *
        (0.12 + Math.max(con, -0.5 * con)) * (edge >= 2 ? 0.2 : edge === 1 ? 0.55 : 1);
      scored.push({ quad: q, support: sup, score });
    }
    scored.sort((a, b) => b.score - a.score);
    // tira quase-duplicatas (o mesmo contorno achado por modos diferentes)
    const tol = Math.max(W, H) * 0.03;
    const list = [];
    for (const c of scored) {
      if (list.every((o) => quadDist(o.quad, c.quad) > tol)) list.push(c);
      if (list.length === 6) break;
    }
    const best = list[0] || null;
    return { quad: best ? best.quad : null, support: best ? best.support : 0, cands: list, sharp, sig: signature };
  } finally {
    chans.delete();
    for (const m of mats) m.delete();
  }
}

// Acompanha a folha de um quadro para o outro na câmera ao vivo. Uma detecção
// solta não substitui a folha que já está sendo seguida: só troca quando outro
// contorno fica bem melhor por vários quadros seguidos, e um sumiço rápido
// (mão passando, reflexo) não apaga o contorno. Coordenadas normalizadas (0–1).
export class QuadTracker {
  constructor() { this.reset(); }

  reset() {
    this.quad = null;     // contorno mostrado (suavizado)
    this.raw = null;      // última detecção aceita
    this.steady = 0;      // quadros seguidos quase parados
    this.miss = 0;
    this.pending = null;  // candidato à troca
    this.pendingN = 0;
  }

  _vote(q) {
    if (this.pending && quadDist(q, this.pending) < 0.07) this.pendingN++;
    else { this.pending = q; this.pendingN = 1; }
    this.pending = q;
    return this.pendingN;
  }

  // cands: [{ quad, score }] em ordem decrescente de nota.
  // Notas medidas em vídeo real: folha bem visível 0,18–0,41; contornos falsos
  // (câmera em movimento, objetos da mesa) quase sempre abaixo de 0,1.
  update(cands) {
    const SHOW = 0.12, KEEP = 0.04;
    const best = cands[0] && cands[0].score >= SHOW ? cands[0] : null;
    let pick = null;
    if (this.quad) {
      const near = cands.find((c) => c.score >= KEEP && quadDist(c.quad, this.quad) < 0.07) || null;
      if (near && (!best || best === near || best.score < near.score * 2)) {
        pick = near;
        this.pending = null;
        this.pendingN = 0;
      } else if (best && this._vote(best.quad) >= (near ? 4 : 2)) {
        // outro contorno venceu: com a folha antiga ainda à vista, só depois de
        // 4 quadros; se ela sumiu (câmera mudou de lugar), depois de 2
        pick = best;
        this.quad = null;
        this.pending = null;
        this.pendingN = 0;
      } else {
        pick = near;
      }
    } else if (best && this._vote(best.quad) >= 2) {
      pick = best;            // aparece só depois de confirmado em 2 quadros
      this.pending = null;
      this.pendingN = 0;
    }

    if (pick) {
      this.miss = 0;
      const moved = this.raw ? quadDist(pick.quad, this.raw) : 1;
      this.raw = pick.quad;
      // só conta como "firme" com a folha bem vista (mão por cima não dispara a foto)
      this.steady = moved < 0.02 && pick.score >= SHOW ? this.steady + 1 : 0;
      this.quad = this.quad
        ? this.quad.map((p, i) => [p[0] * 0.55 + pick.quad[i][0] * 0.45, p[1] * 0.55 + pick.quad[i][1] * 0.45])
        : pick.quad.map((p) => p.slice());
    } else {
      this.steady = 0;
      if (this.quad && ++this.miss > 6) { this.quad = null; this.raw = null; }
    }
    return this.quad;
  }
}

// Mapa de bordas usado pelo "ímã" do editor de cantos.
export function edgeMap(canvas) {
  const cv = window.cv;
  const ctx = canvas.getContext('2d');
  const src = cv.matFromImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
  const gray = new cv.Mat(), blur = new cv.Mat(), a = new cv.Mat(), b = new cv.Mat(), tmp = new cv.Mat();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    const otsu = cv.threshold(blur, tmp, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
    const hi = Math.min(200, Math.max(40, otsu));
    cv.Canny(blur, a, hi * 0.5, hi);
    cv.Canny(blur, b, 15, 45);
    cv.bitwise_or(a, b, a);
    return { data: new Uint8Array(a.data), w: a.cols, h: a.rows };
  } finally {
    for (const m of [src, gray, blur, a, b, tmp]) m.delete();
  }
}

// Encosta o canto i na borda do papel mais próxima (raio R, no mapa de bordas).
// Só olha a metade de cada lado vizinha ao canto, para responder à posição dele.
export function snapCorner(E, q, i, R = 10) {
  const prev = q[(i + 3) % 4], next = q[(i + 1) % 4];
  const score = (p) =>
    edgeSupport(E.data, E.w, E.h, p, prev, 0, 0.5, 1) + edgeSupport(E.data, E.w, E.h, p, next, 0, 0.5, 1);
  const cur = q[i];
  const base = score(cur);
  let best = cur, bestScore = base;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy > R * R) continue;
      const p = [cur[0] + dx, cur[1] + dy];
      if (p[0] < 0 || p[1] < 0 || p[0] >= E.w || p[1] >= E.h) continue;
      const s = score(p) - 0.002 * Math.hypot(dx, dy); // empate: fica mais perto
      if (s > bestScore) { bestScore = s; best = p; }
    }
  }
  return bestScore >= base + 0.06 && bestScore >= 0.9 ? best : cur;
}

// ---------------------------------------------------------------- recorte e filtros

// Recorta e "desentorta" a folha. quad em pixels de src. Devolve cv.Mat RGBA.
export function warpDocument(src, q, maxSide) {
  const cv = window.cv;
  const [tl, tr, br, bl] = q;
  let w = Math.max(dist(tl, tr), dist(bl, br));
  let h = Math.max(dist(tl, bl), dist(tr, br));
  const r = aspectRatio(q, src.cols, src.rows);
  if (r && r / (w / h) > 0.45 && r / (w / h) < 2.2) {
    if (r > w / h) w = h * r; else h = w / r;
  }
  const sc = Math.min(1, maxSide / Math.max(w, h));
  w = Math.max(1, Math.round(w * sc));
  h = Math.max(1, Math.round(h * sc));
  // apara 0,6% de cada borda para não sobrar um fio da mesa em volta da folha
  const mx = w * 0.006, my = h * 0.006;
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, [tl[0], tl[1], tr[0], tr[1], br[0], br[1], bl[0], bl[1]]);
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [-mx, -my, w + mx, -my, w + mx, h + my, -mx, h + my]);
  let T = null;
  const dst = new cv.Mat();
  try {
    T = cv.getPerspectiveTransform(from, to);
    cv.warpPerspective(src, dst, T, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    return dst;
  } catch (e) {
    dst.delete();
    throw e;
  } finally {
    from.delete(); to.delete();
    if (T) T.delete();
  }
}

// Estima o fundo (papel + sombras) apagando a tinta com dilatação e mediana,
// em resolução reduzida, e devolve no tamanho original.
function background(cv, m) {
  const small = new cv.Mat(), d = new cv.Mat(), med = new cv.Mat(), bg = new cv.Mat();
  const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9));
  try {
    const sc = Math.min(1, 700 / Math.max(m.cols, m.rows));
    cv.resize(m, small, new cv.Size(0, 0), sc, sc, cv.INTER_AREA);
    cv.dilate(small, d, k);
    cv.medianBlur(d, med, 21);
    cv.resize(med, bg, new cv.Size(m.cols, m.rows), 0, 0, cv.INTER_LINEAR);
    return bg;
  } catch (e) {
    bg.delete();
    throw e;
  } finally {
    small.delete(); d.delete(); med.delete(); k.delete();
  }
}

export const FILTERS = [
  { id: 'magic', label: 'Cor mágica' },
  { id: 'original', label: 'Original' },
  { id: 'gray', label: 'Cinza' },
  { id: 'bw', label: 'P&B' },
];

// Aplica o filtro e devolve um novo cv.Mat RGBA.
export function applyFilter(src, filter) {
  const cv = window.cv;
  const out = new cv.Mat();
  const tmp = [];
  const M = () => { const m = new cv.Mat(); tmp.push(m); return m; };
  try {
    if (filter === 'original') { src.copyTo(out); return out; }
    const rgb = M();
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    if (filter === 'bw') {
      const g = M(), norm = M(), ad = M(), dark = M();
      cv.cvtColor(rgb, g, cv.COLOR_RGB2GRAY);
      const bg = background(cv, g);
      tmp.push(bg);
      cv.divide(g, bg, norm, 255);
      const block = Math.max(15, Math.round(Math.min(g.cols, g.rows) / 40)) | 1;
      cv.adaptiveThreshold(norm, ad, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY, block, 18);
      cv.threshold(norm, dark, 110, 255, cv.THRESH_BINARY);
      cv.bitwise_and(ad, dark, ad);  // áreas escuras grandes continuam pretas
      cv.cvtColor(ad, out, cv.COLOR_GRAY2RGBA);
      return out;
    }
    // "cor mágica": divide pela iluminação estimada (tira sombra e clareia o papel)
    const bg = background(cv, rgb);
    tmp.push(bg);
    const norm = M();
    cv.divide(rgb, bg, norm, 255);
    norm.convertTo(norm, -1, 1.15, -28);
    if (filter === 'gray') {
      const g = M();
      cv.cvtColor(norm, g, cv.COLOR_RGB2GRAY);
      cv.cvtColor(g, out, cv.COLOR_GRAY2RGBA);
    } else {
      cv.cvtColor(norm, out, cv.COLOR_RGB2RGBA);
    }
    return out;
  } catch (e) {
    out.delete();
    throw e;
  } finally {
    for (const m of tmp) m.delete();
  }
}
