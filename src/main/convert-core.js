'use strict';
// Vision file converter: the pure part (no Electron, no dependencies), so it can be tested on its own.
// PNG decoder, JPEG reader, PDF writer, BMP / ICO writers, Markdown / text -> HTML, CSV <-> JSON.
const zlib = require('zlib');

// ---------------------------------------------------------------- PNG decoder ----------------
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// Returns { w, h, comps (1 = gray, 3 = RGB), data } with transparency flattened onto white.
function decodePng(buf, maxPixels = 120e6) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('This is not a valid PNG file.');
  let p = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0, plte = null, trns = null;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ctype = d[9]; interlace = d[12]; }
    else if (type === 'PLTE') plte = d;
    else if (type === 'tRNS') trns = d;
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!w || !h || !idat.length) throw new Error('The PNG file is damaged.');
  if (w * h > maxPixels) throw new Error('That image is too large (over ' + Math.round(maxPixels / 1e6) + ' megapixels).');
  if (interlace) { const e = new Error('interlaced PNG'); e.code = 'INTERLACED'; throw e; }
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!ch || ![1, 2, 4, 8, 16].includes(depth)) throw new Error('Unsupported PNG type.');
  if (ctype === 3 && !plte) throw new Error('The PNG file is damaged (no palette).');
  const bpp = ch * depth, rowBytes = Math.ceil(w * bpp / 8), bpx = Math.max(1, Math.ceil(bpp / 8));
  let inf;
  try { inf = zlib.inflateSync(Buffer.concat(idat)); } catch { throw new Error('The PNG file is damaged.'); }
  if (inf.length < h * (rowBytes + 1)) throw new Error('The PNG file is damaged (truncated).');

  const raw = Buffer.alloc(h * rowBytes);
  for (let y = 0; y < h; y++) {
    const ft = inf[y * (rowBytes + 1)], src = y * (rowBytes + 1) + 1, dst = y * rowBytes, prev = dst - rowBytes;
    if (ft === 0) inf.copy(raw, dst, src, src + rowBytes);
    else if (ft === 1) for (let x = 0; x < rowBytes; x++) raw[dst + x] = (inf[src + x] + (x >= bpx ? raw[dst + x - bpx] : 0)) & 255;
    else if (ft === 2) for (let x = 0; x < rowBytes; x++) raw[dst + x] = (inf[src + x] + (y > 0 ? raw[prev + x] : 0)) & 255;
    else if (ft === 3) for (let x = 0; x < rowBytes; x++) raw[dst + x] = (inf[src + x] + (((x >= bpx ? raw[dst + x - bpx] : 0) + (y > 0 ? raw[prev + x] : 0)) >> 1)) & 255;
    else if (ft === 4) {
      for (let x = 0; x < rowBytes; x++) {
        const a = x >= bpx ? raw[dst + x - bpx] : 0, b = y > 0 ? raw[prev + x] : 0, c = x >= bpx && y > 0 ? raw[prev + x - bpx] : 0;
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        raw[dst + x] = (inf[src + x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    } else throw new Error('The PNG file is damaged (bad filter).');
  }

  const gray = ctype === 0 || ctype === 4, comps = gray ? 1 : 3;
  // Fast paths: plain 8-bit gray / RGB with no transparency.
  if (depth === 8 && !trns && (ctype === 0 || ctype === 2)) return { w, h, comps, data: raw };

  const out = Buffer.alloc(w * h * comps), maxv = (1 << Math.min(depth, 8)) - 1;
  const sample = (rowOff, i) => {
    if (depth === 8) return raw[rowOff + i];
    if (depth === 16) return raw[rowOff + i * 2];
    const bit = i * depth;
    return (raw[rowOff + (bit >> 3)] >> (8 - depth - (bit & 7))) & maxv;
  };
  const sample16 = (rowOff, i) => (depth === 16 ? raw.readUInt16BE(rowOff + i * 2) : sample(rowOff, i));
  const keyG = ctype === 0 && trns && trns.length >= 2 ? trns.readUInt16BE(0) : -1;
  const keyRGB = ctype === 2 && trns && trns.length >= 6 ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)] : null;
  const over = (c, a) => (a === 255 ? c : Math.round(c * a / 255 + (255 - a)));
  let o = 0;
  for (let y = 0; y < h; y++) {
    const ro = y * rowBytes;
    for (let x = 0; x < w; x++) {
      if (ctype === 0) {
        let v = sample(ro, x); const isKey = keyG >= 0 && sample16(ro, x) === keyG;
        if (depth < 8) v = Math.round(v * 255 / maxv);
        out[o++] = isKey ? 255 : v;
      } else if (ctype === 4) {
        const v = sample(ro, x * 2), a = sample(ro, x * 2 + 1); out[o++] = over(v, a);
      } else if (ctype === 2) {
        const isKey = keyRGB && sample16(ro, x * 3) === keyRGB[0] && sample16(ro, x * 3 + 1) === keyRGB[1] && sample16(ro, x * 3 + 2) === keyRGB[2];
        for (let k = 0; k < 3; k++) out[o++] = isKey ? 255 : sample(ro, x * 3 + k);
      } else if (ctype === 3) {
        const idx = sample(ro, x), a = trns && idx < trns.length ? trns[idx] : 255;
        for (let k = 0; k < 3; k++) out[o++] = over(plte[idx * 3 + k] || 0, a);
      } else { // 6: RGBA
        const a = sample(ro, x * 4 + 3);
        for (let k = 0; k < 3; k++) out[o++] = over(sample(ro, x * 4 + k), a);
      }
    }
  }
  return { w, h, comps, data: out };
}

// ---------------------------------------------------------------- JPEG reader ----------------
function exifOrientation(t) {
  try {
    if (t.length < 14) return 1;
    const le = t.toString('latin1', 0, 2) === 'II';
    const u16 = o => (le ? t.readUInt16LE(o) : t.readUInt16BE(o)), u32 = o => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
    const ifd = u32(4), n = u16(ifd);
    for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (e + 12 > t.length) break; if (u16(e) === 0x0112) return u16(e + 8) || 1; }
  } catch { /* ignore */ }
  return 1;
}
// { w, h, comps, bits, orientation } or throws.
function jpegInfo(buf) {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) throw new Error('This is not a valid JPEG file.');
  let p = 2, orientation = 1, info = null;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xFF) { p++; continue; }
    const m = buf[p + 1];
    if (m === 0xFF) { p++; continue; }
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { p += 2; continue; }
    if (m === 0xD9 || m === 0xDA) break;
    const len = buf.readUInt16BE(p + 2);
    if (m === 0xE1 && buf.toString('latin1', p + 4, p + 10) === 'Exif\0\0') orientation = exifOrientation(buf.subarray(p + 10, p + 2 + len));
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) info = { h: buf.readUInt16BE(p + 5), w: buf.readUInt16BE(p + 7), comps: buf[p + 9], bits: buf[p + 4] };
    p += 2 + len;
  }
  if (!info || !info.w || !info.h) throw new Error('The JPEG file is damaged.');
  return { ...info, orientation };
}

// ---------------------------------------------------------------- PDF writer ----------------
// pages: [{ w, h, kind: 'jpeg' | 'raw' | 'flate', comps: 1 | 3, data: Buffer }]  (pixel size + image data; 'flate' = already zlib-compressed raw pixels)
// opts.page: 'a4' | 'letter' | 'fit'
function buildPdf(pages, { page = 'a4' } = {}) {
  if (!pages.length) throw new Error('Nothing to put in the PDF.');
  const chunks = [], offs = []; let len = 0;
  const push = b => { b = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1'); chunks.push(b); len += b.length; };
  const f = n => (Math.round(n * 100) / 100).toString();
  const obj = (n, dict, stream) => {
    offs[n] = len; push(`${n} 0 obj\n`);
    if (stream) { push(`<< ${dict} /Length ${stream.length} >>\nstream\n`); push(stream); push('\nendstream\nendobj\n'); }
    else push(`<< ${dict} >>\nendobj\n`);
  };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`);
  obj(1, '/Type /Catalog /Pages 2 0 R');
  obj(2, `/Type /Pages /Count ${pages.length} /Kids [${kids.join(' ')}]`);
  pages.forEach((pg, i) => {
    const po = 3 + i * 3, co = po + 1, io = po + 2;
    let pw, ph, x, y, dw, dh;
    if (page === 'fit') {
      pw = Math.min(14400, Math.max(36, pg.w * 0.75)); ph = Math.min(14400, Math.max(36, pg.h * 0.75)); x = 0; y = 0; dw = pw; dh = ph;
    } else {
      let [bw, bh] = page === 'letter' ? [612, 792] : [595.28, 841.89];
      if (pg.w > pg.h) [bw, bh] = [bh, bw]; // landscape picture -> landscape page
      const m = 18, s = Math.min((bw - 2 * m) / pg.w, (bh - 2 * m) / pg.h);
      pw = bw; ph = bh; dw = pg.w * s; dh = pg.h * s; x = (bw - dw) / 2; y = (bh - dh) / 2;
    }
    obj(po, `/Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(pw)} ${f(ph)}] /Resources << /XObject << /Im0 ${io} 0 R >> >> /Contents ${co} 0 R`);
    obj(co, '', Buffer.from(`q ${f(dw)} 0 0 ${f(dh)} ${f(x)} ${f(y)} cm /Im0 Do Q`, 'latin1'));
    const cs = pg.comps === 1 ? '/DeviceGray' : '/DeviceRGB';
    if (pg.kind === 'jpeg') obj(io, `/Type /XObject /Subtype /Image /Width ${pg.w} /Height ${pg.h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode`, pg.data);
    else obj(io, `/Type /XObject /Subtype /Image /Width ${pg.w} /Height ${pg.h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /FlateDecode`, pg.kind === 'flate' ? pg.data : zlib.deflateSync(pg.data, { level: 6 }));
  });
  const n = 2 + pages.length * 3, xref = len;
  let x = `xref\n0 ${n + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= n; i++) x += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  push(x + `trailer\n<< /Size ${n + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- BMP / ICO ----------------
function encodeBmp({ w, h, comps, data }) {
  const row = Math.ceil(w * 3 / 4) * 4, b = Buffer.alloc(54 + row * h);
  b.write('BM', 0, 'latin1'); b.writeUInt32LE(b.length, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18); b.writeInt32LE(h, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(row * h, 34); b.writeInt32LE(2835, 38); b.writeInt32LE(2835, 42);
  for (let y = 0; y < h; y++) {
    const dst = 54 + (h - 1 - y) * row;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * comps, d = dst + x * 3;
      if (comps === 1) { b[d] = b[d + 1] = b[d + 2] = data[s]; } else { b[d] = data[s + 2]; b[d + 1] = data[s + 1]; b[d + 2] = data[s]; }
    }
  }
  return b;
}
// images: [{ size, png: Buffer }]  (square PNGs up to 256 px)
function buildIco(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let off = head.length;
  images.forEach((im, i) => {
    const e = 6 + i * 16;
    head[e] = im.size >= 256 ? 0 : im.size; head[e + 1] = im.size >= 256 ? 0 : im.size; head[e + 4] = 1; head[e + 6] = 32;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6); head.writeUInt32LE(im.png.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += im.png.length;
  });
  return Buffer.concat([head, ...images.map(i => i.png)]);
}

// ---------------------------------------------------------------- text -> HTML ----------------
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const CSS = `@page{size:A4;margin:18mm}html{font-size:11pt}body{font-family:"Segoe UI",Tahoma,Arial,sans-serif;line-height:1.55;color:#111;margin:0}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.2em 0 .5em}h1{font-size:1.9em;border-bottom:1px solid #ddd;padding-bottom:.2em}h2{font-size:1.5em}h3{font-size:1.25em}
p{margin:.6em 0}pre{background:#f5f5f5;padding:.7em;border-radius:4px;white-space:pre-wrap;word-wrap:break-word}code{font-family:Consolas,"Courier New",monospace;font-size:.92em;background:#f3f3f3;padding:0 .2em;border-radius:3px}pre code{background:none;padding:0}
blockquote{margin:.8em 0;padding:.1em 1em;border-inline-start:4px solid #ccc;color:#444}table{border-collapse:collapse;margin:.8em 0}th,td{border:1px solid #bbb;padding:.3em .6em}th{background:#f0f0f0}img{max-width:100%}hr{border:0;border-top:1px solid #ccc}a{color:#0b57d0}
.t{font-family:Consolas,"Courier New","Segoe UI",monospace;font-size:10.5pt;white-space:pre-wrap;word-wrap:break-word;line-height:1.4}`;
function wrapHtml(body, { title = '', base = '' } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>${base ? `<base href="${esc(base)}">` : ''}<style>${CSS}</style></head><body>${body}</body></html>`;
}
// Each line is its own block with dir="auto", so Arabic / Hebrew lines are laid out right-to-left.
function textToHtml(text, opts) {
  const lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  return wrapHtml(lines.map(l => `<div class="t" dir="auto">${l.length ? esc(l) : '&nbsp;'}</div>`).join(''), opts);
}

function inline(s) {
  s = esc(s);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => '<strong>' + (a || b) + '</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?![_\w])/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + codes[+i] + '</code>');
}
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const isBlank = s => /^\s*$/.test(s);
const isHr = s => /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(s);
const isTableSep = s => s.includes('|') && s.includes('-') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(s);
const cells = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
const FENCE_RE = /^\s{0,3}(```+|~~~+)/;
const startsBlock = (L, i) => FENCE_RE.test(L[i]) || /^\s{0,3}#{1,6}\s/.test(L[i]) || isHr(L[i]) || /^\s{0,3}>/.test(L[i]) || LIST_RE.test(L[i]) || (L[i].includes('|') && i + 1 < L.length && isTableSep(L[i + 1]));

function renderList(buf) {
  const first = buf.find(l => LIST_RE.test(l)), m0 = first.match(LIST_RE);
  const base = m0[1].replace(/\t/g, '    ').length, ordered = /\d/.test(m0[2]), items = [];
  let cur = null;
  for (const l of buf) {
    const m = l.match(LIST_RE), ind = l.match(/^\s*/)[0].replace(/\t/g, '    ').length;
    if (m && ind <= base + 1) { cur = { text: [m[3]], kids: [] }; items.push(cur); }
    else if (cur) {
      if (l.trim() === '') cur.kids.push('');
      else {
        const dl = l.replace(/\t/g, '    ').replace(new RegExp('^ {0,' + (base + 2) + '}'), '');
        if (!cur.kids.length && !LIST_RE.test(dl)) cur.text.push(dl.trim()); // a wrapped line of the same item
        else cur.kids.push(dl);
      }
    }
  }
  const li = it => {
    let t = it.text.join(' ').replace(/^\[ \]\s*/, '\u2610 ').replace(/^\[[xX]\]\s*/, '\u2611 ');
    const kids = it.kids.some(k => k.trim()) ? blocks(it.kids) : '';
    return `<li dir="auto">${inline(t)}${kids}</li>`;
  };
  const start = ordered && +m0[2].match(/\d+/)[0] !== 1 ? ` start="${+m0[2].match(/\d+/)[0]}"` : '';
  return `<${ordered ? 'ol' + start : 'ul'}>${items.map(li).join('')}</${ordered ? 'ol' : 'ul'}>`;
}
function blocks(L) {
  const out = []; let i = 0, m;
  while (i < L.length) {
    const s = L[i];
    if (isBlank(s)) { i++; continue; }
    if ((m = s.match(FENCE_RE))) {
      const fence = m[1], buf = []; i++;
      while (i < L.length && !L[i].trim().startsWith(fence)) buf.push(L[i++]);
      i++; out.push(`<pre dir="auto"><code>${esc(buf.join('\n'))}</code></pre>`); continue;
    }
    if ((m = s.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) { out.push(`<h${m[1].length} dir="auto">${inline(m[2])}</h${m[1].length}>`); i++; continue; }
    if (isHr(s)) { out.push('<hr>'); i++; continue; }
    if (/^\s{0,3}>/.test(s)) { const buf = []; while (i < L.length && /^\s{0,3}>/.test(L[i])) buf.push(L[i++].replace(/^\s{0,3}>\s?/, '')); out.push(`<blockquote dir="auto">${blocks(buf)}</blockquote>`); continue; }
    if (s.includes('|') && i + 1 < L.length && isTableSep(L[i + 1])) {
      const head = cells(s), al = cells(L[i + 1]).map(c => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''));
      i += 2; const rows = [];
      while (i < L.length && !isBlank(L[i]) && L[i].includes('|')) rows.push(cells(L[i++]));
      const td = (t, c, k) => `<${t}${al[k] ? ` style="text-align:${al[k]}"` : ''} dir="auto">${inline(c || '')}</${t}>`;
      out.push(`<table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${head.map((_, k) => td('td', r[k], k)).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (LIST_RE.test(s)) {
      const buf = [], ord0 = /\d/.test(s.match(LIST_RE)[2]), ind0 = s.match(LIST_RE)[1].replace(/\t/g, '    ').length;
      while (i < L.length) {
        const lm = L[i].match(LIST_RE); // a different kind of list (bullets <-> numbers) at the same level starts a new list
        if (lm && lm[1].replace(/\t/g, '    ').length <= ind0 + 1 && /\d/.test(lm[2]) !== ord0) break;
        if (isBlank(L[i])) { let j = i; while (j < L.length && isBlank(L[j])) j++; const nm = L[j] && L[j].match(LIST_RE);
          if (j < L.length && ((nm && !(nm[1].replace(/\t/g, '    ').length <= ind0 + 1 && /\d/.test(nm[2]) !== ord0)) || (!nm && /^\s{2,}\S/.test(L[j])))) { buf.push(''); i = j; continue; } break; }
        if (!LIST_RE.test(L[i]) && !/^\s+\S/.test(L[i])) break;
        buf.push(L[i++]);
      }
      out.push(renderList(buf)); continue;
    }
    const buf = [];
    while (i < L.length && !isBlank(L[i]) && (buf.length === 0 || !startsBlock(L, i))) buf.push(L[i++]);
    out.push(`<p dir="auto">${inline(buf.join('\n')).replace(/ {2,}\n/g, '<br>\n')}</p>`);
  }
  return out.join('\n');
}
function mdToHtml(md, opts) { return wrapHtml(blocks(String(md).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')), opts); }

function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote|pre|section|article)>/gi, '\n').replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ---------------------------------------------------------------- CSV <-> JSON ----------------
function parseCsv(text) {
  text = String(text).replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const count = d => { let n = 0, q = false; for (const ch of first) { if (ch === '"') q = !q; else if (!q && ch === d) n++; } return n; };
  const best = [',', ';', '\t', '|'].map(d => [d, count(d)]).sort((a, b) => b[1] - a[1])[0], D = best[1] > 0 ? best[0] : ',';
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"' && f === '') q = true;
    else if (c === D) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; rows.push(row); row = []; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}
function csvToJson(text) {
  const rows = parseCsv(text);
  if (!rows.length) return '[]\n';
  const seen = new Map(), head = rows[0].map((h, i) => {
    let k = String(h).trim() || 'column' + (i + 1); const n = seen.get(k) || 0; seen.set(k, n + 1); return n ? `${k}_${n + 1}` : k;
  });
  const data = rows.slice(1).map(r => { const o = {}; head.forEach((k, i) => { o[k] = r[i] ?? ''; }); return o; });
  return JSON.stringify(data, null, 2) + '\n';
}
function jsonToCsv(text) {
  let data; try { data = JSON.parse(String(text).replace(/^\uFEFF/, '')); } catch { throw new Error('That file is not valid JSON.'); }
  if (!Array.isArray(data)) data = data && typeof data === 'object' ? [data] : null;
  if (!data) throw new Error('The JSON must be a list of records (or one record) to become a table.');
  const cell = v => { if (v == null) return ''; const s = typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  let lines;
  if (data.every(r => Array.isArray(r))) lines = data.map(r => r.map(cell).join(','));
  else {
    const keys = []; for (const r of data) if (r && typeof r === 'object') for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
    lines = [keys.map(cell).join(','), ...data.map(r => keys.map(k => cell(r && typeof r === 'object' ? r[k] : r)).join(','))];
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n'; // BOM so Excel shows Arabic and other scripts correctly
}

module.exports = { decodePng, jpegInfo, buildPdf, encodeBmp, buildIco, mdToHtml, textToHtml, wrapHtml, htmlToText, parseCsv, csvToJson, jsonToCsv };
