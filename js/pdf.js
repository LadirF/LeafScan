// Gerador de PDF mínimo: cada página é uma imagem JPEG embutida sem recompressão.
// O PDF é montado como um Blob feito de pedaços, então as imagens não são
// copiadas para a memória do JavaScript — não há limite prático de páginas.

const A4 = [595.28, 841.89];

function pdfText(s) {
  let h = 'FEFF';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c > 0xffff) {
      const v = c - 0x10000;
      h += (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
    } else {
      h += c.toString(16).padStart(4, '0');
    }
  }
  return '<' + h.toUpperCase() + '>';
}

function pdfDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const tz = off === 0 ? 'Z' : `${off > 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}'${p(Math.abs(off) % 60)}'`;
  return `(D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${tz})`;
}

const num = (n) => (Math.round(n * 100) / 100).toString();

// pages: [{ blob, w, h, comps }]; opts.size: 'a4' (folha A4, orientação automática)
// ou 'fit' (página com a proporção da imagem, lado maior = altura do A4).
export function buildPdf(pages, opts = {}) {
  const parts = [];
  let offset = 0;
  const offsets = [];
  const text = (s) => { parts.push(s); offset += s.length; }; // só ASCII
  const raw = (bytes) => { parts.push(bytes); offset += bytes.length; };
  const obj = (id, body) => { offsets[id] = offset; text(`${id} 0 obj\n${body}\nendobj\n`); };

  raw(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // %PDF-1.4 + binário

  const n = pages.length;
  const infoId = 3 + 3 * n;
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pages.map((_, i) => `${3 + 3 * i} 0 R`).join(' ');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);

  pages.forEach((p, i) => {
    const pageId = 3 + 3 * i, contId = pageId + 1, imgId = pageId + 2;
    let PW, PH;
    if (opts.size === 'fit') {
      const k = A4[1] / Math.max(p.w, p.h);
      PW = p.w * k; PH = p.h * k;
    } else {
      [PW, PH] = p.w > p.h ? [A4[1], A4[0]] : A4;
    }
    const s = Math.min(PW / p.w, PH / p.h);
    const dw = p.w * s, dh = p.h * s;
    const dx = (PW - dw) / 2, dy = (PH - dh) / 2;
    obj(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(PW)} ${num(PH)}] ` +
      `/Resources << /XObject << /Im0 ${imgId} 0 R >> /ProcSet [/PDF /ImageC /ImageB] >> /Contents ${contId} 0 R >>`);
    const content = `q ${num(dw)} 0 0 ${num(dh)} ${num(dx)} ${num(dy)} cm /Im0 Do Q`;
    obj(contId, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    offsets[imgId] = offset;
    const cs = p.comps === 1 ? '/DeviceGray' : '/DeviceRGB';
    text(`${imgId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace ${cs} ` +
      `/BitsPerComponent 8 /Filter /DCTDecode /Length ${p.blob.size} >>\nstream\n`);
    parts.push(p.blob);
    offset += p.blob.size;
    text('\nendstream\nendobj\n');
  });

  obj(infoId, `<< /Title ${pdfText(opts.title || 'LeafScan')} /Producer (LeafScan) /CreationDate ${pdfDate(new Date())} >>`);

  const xref = offset;
  let x = `xref\n0 ${infoId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= infoId; id++) x += String(offsets[id]).padStart(10, '0') + ' 00000 n \n';
  text(x);
  text(`trailer\n<< /Size ${infoId + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

// Lê largura, altura e nº de componentes de cor do cabeçalho de um JPEG.
export function jpegInfo(buf) {
  const d = new DataView(buf);
  if (d.byteLength < 4 || d.getUint16(0) !== 0xffd8) return null;
  let o = 2;
  while (o + 9 < d.byteLength) {
    if (d.getUint8(o) !== 0xff) { o++; continue; }
    const m = d.getUint8(o + 1);
    if (m === 0xff) { o++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
    const len = d.getUint16(o + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: d.getUint16(o + 5), w: d.getUint16(o + 7), comps: d.getUint8(o + 9) };
    }
    o += 2 + len;
  }
  return null;
}
