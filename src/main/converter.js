'use strict';
// Vision file converter (v1.9). tools.js loads this inside try/catch, so if anything here fails to load every original tool keeps working.
// Built in (no installs): images <-> png/jpg/webp/bmp/ico, images -> PDF (one or many, merged), txt/md/html -> PDF, md -> html, txt -> html, html -> txt, csv <-> json.
// Optional free open-source engines (found automatically, installable by voice): FFmpeg, LibreOffice, pandoc, ImageMagick, Poppler.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { BrowserWindow, Notification, shell } = require('electron');
const core = require('./convert-core');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const deflate = buf => new Promise((res, rej) => zlib.deflate(buf, { level: 6 }, (e, o) => (e ? rej(e) : res(o))));
const withTimeout = (p, ms, msg) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t)); };

// ---------------------------------------------------------------- formats ----------------
const ALIAS = { jpeg: 'jpg', jpe: 'jpg', jfif: 'jpg', tiff: 'tif', htm: 'html', markdown: 'md', heif: 'heic', oga: 'ogg', text: 'txt', word: 'docx', excel: 'xlsx', powerpoint: 'pptx' };
const normExt = e => { e = String(e || '').toLowerCase().trim().replace(/^[.*]+/, ''); return ALIAS[e] || e; };
const extOf = f => normExt(path.extname(f).slice(1));
const IMG_BUILTIN = new Set(['png', 'jpg', 'webp', 'gif', 'bmp', 'ico', 'svg', 'avif']);
const IMG_ALL = new Set([...IMG_BUILTIN, 'tif', 'heic']);
const BUILTIN_IMG_OUT = new Set(['png', 'jpg', 'webp', 'bmp', 'ico', 'pdf']);
const AUDIO = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wma', 'aiff', 'aif', 'amr', 'mka']);
const VIDEO = new Set(['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp', 'ts']);
const LO_IN = new Set(['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp', 'txt', 'html', 'pdf']);
const LO_OUT = new Set(['pdf', 'docx', 'doc', 'odt', 'rtf', 'txt', 'html', 'xlsx', 'xls', 'ods', 'csv', 'pptx', 'ppt', 'odp', 'png', 'jpg', 'epub']);
const PANDOC_IN = new Set(['md', 'html', 'docx', 'odt', 'epub', 'rtf', 'txt', 'tex', 'rst']);
const PANDOC_OUT = new Set(['md', 'html', 'docx', 'odt', 'epub', 'rtf', 'txt', 'pdf']);
const TEXT_PDF = new Set(['txt', 'md', 'html', 'log']);
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif' };

// ---------------------------------------------------------------- engines ----------------
const ENGINES = {
  ffmpeg: { exe: 'ffmpeg.exe', winget: 'Gyan.FFmpeg', name: 'FFmpeg', gives: 'audio and video (mp3, wav, m4a, ogg, flac, mp4, mkv, avi, mov, webm, gif; pull the audio out of a video)', url: 'https://www.gyan.dev/ffmpeg/builds/' },
  libreoffice: { exe: 'soffice.exe', winget: 'TheDocumentFoundation.LibreOffice', name: 'LibreOffice', gives: 'Word, Excel, PowerPoint and OpenDocument files to and from PDF, docx, xlsx, pptx, txt, html', url: 'https://www.libreoffice.org/download/' },
  pandoc: { exe: 'pandoc.exe', winget: 'JohnMacFarlane.Pandoc', name: 'pandoc', gives: 'documents between markdown, html, docx, odt, epub, rtf, txt', url: 'https://pandoc.org/installing.html' },
  imagemagick: { exe: 'magick.exe', winget: 'ImageMagick.ImageMagick', name: 'ImageMagick', gives: 'more image formats (tiff, heic, gif and others)', url: 'https://imagemagick.org/script/download.php' },
  poppler: { exe: 'pdftoppm.exe', winget: 'oschwartz10612.Poppler', name: 'Poppler', gives: 'PDF pages to png / jpg images', url: 'https://github.com/oschwartz10612/poppler-windows/releases' }
};
const foundExe = new Map();
function whereExe(exe) {
  return new Promise(res => execFile(process.platform === 'win32' ? 'where.exe' : 'which', [exe], { windowsHide: true, timeout: 8000 }, (err, out) => {
    const l = !err && String(out).split(/\r?\n/).map(x => x.trim()).find(x => x && fs.existsSync(x)); res(l || null);
  }));
}
function findInTree(root, exe, depth) {
  let items; try { items = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const it of items) if (it.isFile() && it.name.toLowerCase() === exe) return path.join(root, it.name);
  if (depth > 0) for (const it of items) if (it.isDirectory()) { const r = findInTree(path.join(root, it.name), exe, depth - 1); if (r) return r; }
  return null;
}
function searchKnown(id) { // just-installed programs are not on this process's PATH yet, so look in their usual places
  const e = ENGINES[id], exe = e.exe.toLowerCase(), pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432].filter(Boolean), lad = process.env.LOCALAPPDATA;
  const direct = [];
  if (id === 'libreoffice') pf.forEach(d => direct.push(path.join(d, 'LibreOffice', 'program')));
  if (id === 'pandoc') { if (lad) direct.push(path.join(lad, 'Pandoc')); pf.forEach(d => direct.push(path.join(d, 'Pandoc'))); }
  if (id === 'imagemagick') pf.forEach(d => { try { fs.readdirSync(d).filter(n => /^ImageMagick/i.test(n)).forEach(n => direct.push(path.join(d, n))); } catch {} });
  if (lad) direct.push(path.join(lad, 'Microsoft', 'WinGet', 'Links'));
  for (const d of direct) { const p = path.join(d, e.exe); if (fs.existsSync(p)) return p; }
  if (lad) {
    const pk = path.join(lad, 'Microsoft', 'WinGet', 'Packages');
    try { for (const n of fs.readdirSync(pk)) if (n.toLowerCase().startsWith(e.winget.toLowerCase())) { const r = findInTree(path.join(pk, n), exe, 5); if (r) return r; } } catch {}
  }
  for (const d of pf) { const r = findInTree(path.join(d, e.name), exe, 3); if (r) return r; }
  return null;
}
async function findEngine(id) {
  const c = foundExe.get(id); if (c && fs.existsSync(c)) return c;
  const p = (await whereExe(ENGINES[id].exe)) || searchKnown(id);
  if (p) foundExe.set(id, p); else foundExe.delete(id);
  return p || null;
}
function runExe(exe, args, { cwd, timeoutMs = 600000, signal } = {}) {
  return new Promise((resolve, reject) => execFile(exe, args, { cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, signal, encoding: 'utf8' }, (err, stdout, stderr) => {
    if (err) {
      if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return reject(new Error('stopped by the user.'));
      const t = String(stderr || stdout || err.message).trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' ').slice(0, 400);
      return reject(new Error(t || 'the converter program failed.'));
    }
    resolve({ stdout, stderr });
  }));
}

// ---------------------------------------------------------------- Chromium helpers (hidden windows) ----------------
let canvasWin = null, canvasIdle = null;
async function getCanvasWin() {
  clearTimeout(canvasIdle);
  if (!canvasWin || canvasWin.isDestroyed()) {
    canvasWin = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
    canvasWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    canvasWin.webContents.on('will-navigate', e => e.preventDefault());
    await canvasWin.loadURL('about:blank');
  }
  return canvasWin;
}
const releaseCanvasWin = () => { clearTimeout(canvasIdle); canvasIdle = setTimeout(() => { try { if (canvasWin && !canvasWin.isDestroyed()) canvasWin.destroy(); } catch {} canvasWin = null; }, 30000); };
// outputs: [{ mime, quality, maxWidth, flatten, box }] -> array of Buffers (Chromium decodes the picture and encodes each output)
async function canvasRender(buf, ext, outputs) {
  if (buf.length > 250 * 1024 * 1024) throw new Error('That image file is too large.');
  const src = `data:${MIME[ext] || 'application/octet-stream'};base64,${buf.toString('base64')}`;
  const code = `(async()=>{const A=${JSON.stringify({ src, outputs })};
    const img=new Image();img.src=A.src;try{await img.decode();}catch(e){throw new Error('UNREADABLE');}
    let W=img.naturalWidth||0,H=img.naturalHeight||0;if(!W||!H){W=1024;H=768;}
    const res=[];
    for(const o of A.outputs){let w=W,h=H,cw,ch;
      if(o.box){const s=Math.min(o.box/W,o.box/H);w=Math.max(1,Math.round(W*s));h=Math.max(1,Math.round(H*s));cw=ch=o.box;}
      else if(o.maxWidth&&W>o.maxWidth){w=o.maxWidth;h=Math.max(1,Math.round(H*o.maxWidth/W));}
      const c=document.createElement('canvas');c.width=cw||w;c.height=ch||h;const x=c.getContext('2d');
      if(o.flatten){x.fillStyle='#ffffff';x.fillRect(0,0,c.width,c.height);}
      x.imageSmoothingQuality='high';x.drawImage(img,(c.width-w)/2,(c.height-h)/2,w,h);
      res.push(c.toDataURL(o.mime,o.quality).split(',')[1]);}
    return res;})()`;
  try {
    const w = await getCanvasWin();
    const res = await withTimeout(w.webContents.executeJavaScript(code, true), 180000, 'Reading the image took too long.');
    return res.map(b => Buffer.from(b, 'base64'));
  } catch (e) {
    if (/UNREADABLE/.test(e.message)) { const err = new Error(`I cannot read this .${ext} picture (it may be damaged, or an unsupported kind of ${ext}).`); err.code = 'UNREADABLE'; throw err; }
    throw e;
  } finally { releaseCanvasWin(); }
}
async function htmlFileToPdf(file, page) {
  const w = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, webSecurity: true } });
  try {
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await withTimeout(w.loadFile(file), 60000, 'The page took too long to load.');
    await sleep(250);
    const base = { pageSize: page === 'letter' ? 'Letter' : 'A4', printBackground: true };
    try { return await withTimeout(w.webContents.printToPDF({ ...base, margins: { marginType: 'custom', top: 0.7, bottom: 0.7, left: 0.7, right: 0.7 } }), 120000, 'Making the PDF took too long.'); }
    catch (e) { if (/too long/.test(e.message)) throw e; return await withTimeout(w.webContents.printToPDF(base), 120000, 'Making the PDF took too long.'); } // some Electron versions reject the margin options
  } finally { try { if (!w.isDestroyed()) w.destroy(); } catch {} }
}

// ---------------------------------------------------------------- register ----------------
function register(h) {
  const { def, str, num, bool, oneOf, obj, app, cfg, runtime, logger, safety, resolveLoose, resolveForCreate, guardWrite, clip, fmtSize } = h;
  const say = (kind, text) => runtime.emit('step', { kind, text });
  const notify = (title, body) => { try { new Notification({ title, body, silent: true }).show(); } catch {} };
  const sig = () => runtime.signal();
  let jobSeq = runtime.stopSeq(); // set at the start of each conversion job; stopAll() swaps the abort controller, so re-reading sig().aborted would never notice a stop
  const checkAbort = () => { if (runtime.stopSeq() !== jobSeq) throw new Error('stopped by the user.'); };
  const guardRead = p => { if (safety.isPrivatePath(p)) throw new Error('Not allowed.'); return p; };

  async function uniquePath(p) {
    if (!fs.existsSync(p)) return p;
    const { dir, name, ext } = path.parse(p);
    for (let i = 1; i < 1000; i++) { const c = path.join(dir, `${name} (${i})${ext}`); if (!fs.existsSync(c)) return c; }
    throw new Error('Too many files with that name already exist.');
  }
  // Where the converted file goes: next to the original (or "to"), never over an existing file.
  async function outPath(src, tgt, to, name) {
    const base = name || path.basename(src, path.extname(src));
    let dir = path.dirname(src), full = null;
    if (to && String(to).trim()) {
      const t = resolveForCreate(to);
      let isDir = /[\\/]\s*$/.test(String(to));
      try { if (fs.statSync(t).isDirectory()) isDir = true; } catch {}
      if (!isDir && path.extname(t)) full = path.join(path.dirname(t), path.basename(t, path.extname(t)) + '.' + tgt);
      else dir = t;
    }
    full = full || path.join(dir, `${base}.${tgt}`);
    try { guardWrite(full); } catch (e) {
      if (to) throw e;
      full = path.join(app.getPath('documents'), 'Vision Converted', `${base}.${tgt}`); guardWrite(full); // the original sits somewhere protected
    }
    await fsp.mkdir(path.dirname(full), { recursive: true });
    return uniquePath(full);
  }
  async function moveFile(from, to) { try { await fsp.rename(from, to); } catch { await fsp.copyFile(from, to); await fsp.unlink(from).catch(() => {}); } }
  const decodeText = buf => {
    if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.toString('utf16le').replace(/^\uFEFF/, '');
    if (buf[0] === 0xFE && buf[1] === 0xFF) return Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1))).swap16().toString('utf16le');
    const t = buf.toString('utf8');
    if (t.includes('\uFFFD')) { try { return new TextDecoder('windows-1256').decode(buf); } catch {} } // old "ANSI" Arabic text files
    return t;
  };
  const readSmall = async (f, max = 40e6) => { const st = await fsp.stat(f); if (st.size > max) throw new Error('That file is too large to convert here.'); return fsp.readFile(f); };

  // ---------- images ----------
  async function pngFromAny(file, ext, buf) { // -> decoded flat pixels, via Chromium for anything that is not a plain PNG
    if (ext === 'png') { try { return core.decodePng(buf); } catch (e) { if (e.code !== 'INTERLACED') throw e; } }
    const [png] = await canvasRender(buf, ext, [{ mime: 'image/png', flatten: true }]);
    return core.decodePng(png);
  }
  async function pageForPdf(file) {
    const ext = extOf(file); let buf = await readSmall(file, 250e6);
    if (ext === 'jpg') {
      try { const j = core.jpegInfo(buf); if ((j.comps === 1 || j.comps === 3) && j.bits === 8 && j.orientation === 1) return { w: j.w, h: j.h, kind: 'jpeg', comps: j.comps, data: buf }; } catch {}
    }
    if (!IMG_BUILTIN.has(ext)) { // tif / heic: ImageMagick (or FFmpeg) makes a PNG first
      const tmp = path.join(os.tmpdir(), `vision-img-${process.pid}-${Date.now()}.png`);
      try { await viaEngines(file, ext, 'png', { to: tmp, quality: 90 }, true); buf = await fsp.readFile(tmp); } finally { fsp.unlink(tmp).catch(() => {}); }
      const d = core.decodePng(buf); return { w: d.w, h: d.h, kind: 'flate', comps: d.comps, data: await deflate(d.data) };
    }
    const d = await pngFromAny(file, ext, buf);
    return { w: d.w, h: d.h, kind: 'flate', comps: d.comps, data: await deflate(d.data) };
  }
  async function imagesToPdf(files, out, o) {
    const pages = [];
    for (let i = 0; i < files.length; i++) {
      checkAbort();
      if (files.length > 4 && i % 5 === 0) say('info', `Reading picture ${i + 1} of ${files.length}…`);
      try { pages.push(await pageForPdf(files[i])); } catch (e) { throw new Error(`${path.basename(files[i])}: ${e.message}`); }
      await sleep(0);
    }
    await fsp.writeFile(out, core.buildPdf(pages, { page: o.page }));
  }
  async function imageBuiltin(file, ext, tgt, o) {
    if (tgt === 'pdf') { const out = await outPath(file, 'pdf', o.to); await imagesToPdf([file], out, o); return out; }
    const buf = await readSmall(file, 250e6), q = Math.max(1, Math.min(100, o.quality)) / 100;
    let data;
    if (tgt === 'png') data = (await canvasRender(buf, ext, [{ mime: 'image/png', maxWidth: o.maxWidth }]))[0];
    else if (tgt === 'jpg') data = (await canvasRender(buf, ext, [{ mime: 'image/jpeg', quality: q, flatten: true, maxWidth: o.maxWidth }]))[0];
    else if (tgt === 'webp') data = (await canvasRender(buf, ext, [{ mime: 'image/webp', quality: q, maxWidth: o.maxWidth }]))[0];
    else if (tgt === 'bmp') data = core.encodeBmp(core.decodePng((await canvasRender(buf, ext, [{ mime: 'image/png', flatten: true, maxWidth: o.maxWidth }]))[0]));
    else if (tgt === 'ico') {
      const sizes = [16, 32, 48, 64, 128, 256];
      const pngs = await canvasRender(buf, ext, sizes.map(box => ({ mime: 'image/png', box })));
      data = core.buildIco(sizes.map((size, i) => ({ size, png: pngs[i] })));
    } else throw new Error('Unsupported picture format.');
    const out = await outPath(file, tgt, o.to); await fsp.writeFile(out, data); return out;
  }

  // ---------- text & data ----------
  async function textToPdfFile(file, ext, o) {
    let pdf;
    if (ext === 'html') pdf = await htmlFileToPdf(file, o.page);
    else {
      const text = decodeText(await readSmall(file, 30e6)), title = path.basename(file, path.extname(file));
      const html = ext === 'md' ? core.mdToHtml(text, { title, base: pathToFileURL(path.dirname(file) + path.sep).href }) : core.textToHtml(text, { title });
      const tmp = path.join(os.tmpdir(), `vision-conv-${process.pid}-${Date.now()}.html`);
      await fsp.writeFile(tmp, html, 'utf8');
      try { pdf = await htmlFileToPdf(tmp, o.page); } finally { fsp.unlink(tmp).catch(() => {}); }
    }
    const out = await outPath(file, 'pdf', o.to); await fsp.writeFile(out, pdf); return out;
  }
  async function textTransform(file, tgt, o, fn, bom) {
    const text = fn(decodeText(await readSmall(file, 60e6)), file);
    const out = await outPath(file, tgt, o.to); await fsp.writeFile(out, (bom && !text.startsWith('\uFEFF') ? '\uFEFF' : '') + text, 'utf8'); return out;
  }

  // ---------- engines ----------
  const mediaArgs = tgt => {
    if (tgt === 'mp3') return ['-vn', '-c:a', 'libmp3lame', '-q:a', '2'];
    if (tgt === 'm4a' || tgt === 'aac') return ['-vn', '-c:a', 'aac', '-b:a', '192k'];
    if (tgt === 'ogg') return ['-vn', '-c:a', 'libvorbis', '-q:a', '5'];
    if (tgt === 'opus') return ['-vn', '-c:a', 'libopus', '-b:a', '128k'];
    if (AUDIO.has(tgt)) return ['-vn'];
    if (tgt === 'mp4') return ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:a', 'aac', '-movflags', '+faststart'];
    if (tgt === 'webm') return ['-c:v', 'libvpx-vp9', '-c:a', 'libopus'];
    if (tgt === 'gif') return ['-vf', 'fps=12,scale=480:-1:flags=lanczos'];
    if (IMG_ALL.has(tgt)) return ['-frames:v', '1'];
    return [];
  };
  const RUN = {
    async ffmpeg(exe, file, ext, tgt, o, out) {
      await runExe(exe, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', file, ...mediaArgs(tgt), out], { timeoutMs: 4 * 3600e3, signal: sig() });
      return [out];
    },
    async imagemagick(exe, file, ext, tgt, o, out) {
      const a = [ext === 'gif' ? file + '[0]' : file];
      if (['jpg', 'bmp', 'pdf'].includes(tgt)) a.push('-background', 'white', '-alpha', 'remove', '-alpha', 'off');
      if (o.maxWidth) a.push('-resize', `${o.maxWidth}x>`);
      if (tgt === 'jpg' || tgt === 'webp') a.push('-quality', String(o.quality));
      a.push(out); await runExe(exe, a, { timeoutMs: 600000, signal: sig() }); return [out];
    },
    async libreoffice(exe, file, ext, tgt, o, out) {
      const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vision-lo-'));
      try {
        const filter = tgt === 'txt' ? 'txt:Text' : tgt;
        const a = ['--headless', '--norestore', '--nolockcheck', '--nologo', `-env:UserInstallation=${pathToFileURL(path.join(os.tmpdir(), 'vision-lo-profile')).href}`];
        if (ext === 'pdf' && ['docx', 'doc', 'odt', 'rtf', 'txt', 'html'].includes(tgt)) a.push('--infilter=writer_pdf_import');
        a.push('--convert-to', filter, '--outdir', tmp, file);
        await runExe(exe, a, { timeoutMs: 15 * 60e3, signal: sig() });
        const made = (await fsp.readdir(tmp))[0];
        if (!made) throw new Error('LibreOffice could not convert that file (it may be damaged, protected or unsupported).');
        await moveFile(path.join(tmp, made), out); return [out];
      } finally { fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
    },
    async pandoc(exe, file, ext, tgt, o, out) {
      if (tgt === 'pdf') { // no LaTeX needed: pandoc -> html -> Chromium prints it
        const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vision-pd-'));
        try {
          await runExe(exe, [file, '-s', '--extract-media=.', '-o', path.join(tmp, 'out.html')], { cwd: tmp, timeoutMs: 300000, signal: sig() });
          await fsp.writeFile(out, await htmlFileToPdf(path.join(tmp, 'out.html'), o.page)); return [out];
        } finally { fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
      }
      const a = [file, '-o', out];
      if (tgt === 'txt') a.push('-t', 'plain'); else if (tgt === 'html' || tgt === 'rtf') a.push('-s');
      await runExe(exe, a, { cwd: path.dirname(file), timeoutMs: 300000, signal: sig() }); return [out];
    },
    async poppler(exe, file, ext, tgt, o) {
      const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vision-pp-'));
      try {
        await runExe(exe, ['-r', '150', tgt === 'jpg' ? '-jpeg' : '-png', file, path.join(tmp, 'page')], { timeoutMs: 15 * 60e3, signal: sig() });
        const names = (await fsp.readdir(tmp)).sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
        if (!names.length) throw new Error('No pages came out of that PDF.');
        if (names.length === 1) { const out = await outPath(file, tgt, o.to); await moveFile(path.join(tmp, names[0]), out); return [out]; }
        const first = await outPath(file, tgt, o.to, path.basename(file, path.extname(file)) + ' pages'), dir = path.join(path.dirname(first), path.basename(first, '.' + tgt));
        const folder = await uniquePath(dir); await fsp.mkdir(folder, { recursive: true });
        const outs = [];
        for (let i = 0; i < names.length; i++) { const p = path.join(folder, `page ${i + 1}.${tgt}`); await moveFile(path.join(tmp, names[i]), p); outs.push(p); }
        return [folder + path.sep + ` (${outs.length} pages)`];
      } finally { fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
    }
  };
  function engineOrder(ext, tgt) {
    const o = [], media = x => AUDIO.has(x) || VIDEO.has(x) || x === 'gif';
    if ((AUDIO.has(ext) || VIDEO.has(ext) || ext === 'gif') && media(tgt)) o.push('ffmpeg');
    if (IMG_ALL.has(ext) && (IMG_ALL.has(tgt) || tgt === 'pdf')) { o.push('imagemagick'); if (IMG_ALL.has(tgt)) o.push('ffmpeg'); }
    if (ext === 'pdf' && (tgt === 'png' || tgt === 'jpg')) o.push('poppler', 'imagemagick');
    const lo = LO_IN.has(ext) && LO_OUT.has(tgt), pd = PANDOC_IN.has(ext) && PANDOC_OUT.has(tgt);
    if (tgt === 'pdf') { if (lo) o.push('libreoffice'); if (pd) o.push('pandoc'); } else { if (pd) o.push('pandoc'); if (lo) o.push('libreoffice'); }
    return [...new Set(o)];
  }
  async function viaEngines(file, ext, tgt, o, quiet) {
    const order = engineOrder(ext, tgt);
    if (!order.length) { const e = new Error(`I cannot convert .${ext} to .${tgt}. ${ext === 'pdf' ? 'To get the text out of a PDF use read_document; PDF to picture needs the Poppler engine.' : 'Tell the user which conversions I can do (pictures, PDF, text, csv/json, Office files, audio, video).'}`); e.code = 'NOENGINE'; throw e; }
    let lastErr = null; const missing = [];
    for (const id of order) {
      const exe = await findEngine(id);
      if (!exe) { missing.push(id); continue; }
      checkAbort();
      const out = id === 'poppler' ? null : (o.to && quiet ? o.to : await outPath(file, tgt, o.to));
      try { if (!quiet) say('info', `Converting with ${ENGINES[id].name}…`); return await RUN[id](exe, file, ext, tgt, o, out); }
      catch (e) { lastErr = e; if (out && !quiet) fsp.unlink(out).catch(() => {}); logger.log('convert', `${id} failed: ${e.message}`); if (/stopped by the user/.test(e.message)) throw e; }
    }
    if (lastErr) throw new Error(`${ENGINES[order.find(id => !missing.includes(id))].name} could not convert it: ${lastErr.message}`);
    const e = new Error(`To convert .${ext} to .${tgt} I need ${missing.map(m => ENGINES[m].name).join(' or ')} (free and open source: ${ENGINES[missing[0]].gives}). Offer to install it with converter_engines (action install, engine ${missing[0]}); the user is asked to approve first.`);
    e.code = 'NOENGINE'; throw e;
  }

  // ---------- router ----------
  async function convertOne(file, tgt, o) {
    const ext = extOf(file);
    if (!ext) throw new Error('that file has no extension, so I cannot tell what kind of file it is.');
    if (ext === tgt && !(IMG_ALL.has(ext) && o.maxWidth)) throw new Error(`it is already a .${tgt} file.`);
    if (IMG_BUILTIN.has(ext) && BUILTIN_IMG_OUT.has(tgt)) {
      try { return [await imageBuiltin(file, ext, tgt, o)]; }
      catch (e) { try { return await viaEngines(file, ext, tgt, o); } catch (e2) { throw e2.code === 'NOENGINE' ? e : e2; } }
    }
    if (TEXT_PDF.has(ext) && tgt === 'pdf') return [await textToPdfFile(file, ext, o)];
    if (ext === 'md' && tgt === 'html') return [await textTransform(file, 'html', o, (t, f) => core.mdToHtml(t, { title: path.basename(f, path.extname(f)), base: pathToFileURL(path.dirname(f) + path.sep).href }))];
    if ((ext === 'txt' || ext === 'log') && tgt === 'html') return [await textTransform(file, 'html', o, (t, f) => core.textToHtml(t, { title: path.basename(f, path.extname(f)) }))];
    if (ext === 'html' && tgt === 'txt') return [await textTransform(file, 'txt', o, t => core.htmlToText(t), true)];
    if (ext === 'csv' && tgt === 'json') return [await textTransform(file, 'json', o, t => core.csvToJson(t))];
    if (ext === 'json' && tgt === 'csv') return [await textTransform(file, 'csv', o, t => core.jsonToCsv(t))];
    return viaEngines(file, ext, tgt, o);
  }
  function splitPaths(s) { return String(s || '').split(/\s*(?:;|\||\r?\n)\s*/).map(x => x.trim()).filter(Boolean); }
  async function gather(a, tgt) {
    const parts = splitPaths(a.path); if (!parts.length) throw new Error('No file given.');
    const only = a.only ? new Set(String(a.only).toLowerCase().split(/[\s,;|]+/).map(x => normExt(x)).filter(Boolean)) : null, imgJob = IMG_ALL.has(tgt) || tgt === 'pdf', files = [];
    for (const part of parts) {
      const p = guardRead(resolveLoose(part)), st = await fsp.stat(p);
      if (!st.isDirectory()) { files.push(p); continue; }
      if (!only && !imgJob) throw new Error('That is a folder: tell me which file type inside it to convert (for example only docx).');
      const names = (await fsp.readdir(p, { withFileTypes: true })).filter(d => d.isFile()).map(d => d.name).sort((x, y) => x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' }));
      for (const n of names) { const e = normExt(path.extname(n).slice(1)); if ((only ? only.has(e) : IMG_ALL.has(e)) && e !== tgt) files.push(path.join(p, n)); }
    }
    if (!files.length) throw new Error('I found no files to convert there.');
    if (files.length > 300) throw new Error('That is more than 300 files; use a smaller batch.');
    return files;
  }
  async function convertMany(files, tgt, o, combine) {
    jobSeq = runtime.stopSeq();
    const outs = [], fails = [];
    const allImg = files.every(f => IMG_ALL.has(extOf(f)));
    if (tgt === 'pdf' && files.length > 1 && combine !== false && allImg) {
      const out = await outPath(files[0], 'pdf', o.to, path.basename(files[0], path.extname(files[0])) + ` + ${files.length - 1} more`);
      await imagesToPdf(files, out, o); outs.push(out);
    } else {
      if (files.length > 1 && o.to && path.extname(String(o.to))) o = { ...o, to: path.dirname(resolveForCreate(o.to)) };
      for (const f of files) {
        checkAbort();
        if (files.length > 1) say('info', `Converting ${path.basename(f)} (${outs.length + fails.length + 1} of ${files.length})…`);
        try { outs.push(...await convertOne(f, tgt, o)); } catch (e) { if (files.length === 1) throw e; fails.push(`${path.basename(f)}: ${String(e.message).replace(/\.$/, '')}`); }
      }
    }
    if (!outs.length) throw new Error(fails.slice(0, 3).join('; ') || 'nothing was converted.');
    const size = async p => { try { return fmtSize((await fsp.stat(p)).size); } catch { return ''; } };
    let msg;
    if (outs.length === 1) msg = `Created ${outs[0]}${/\)$/.test(outs[0]) ? '' : ` (${await size(outs[0])})`}.`;
    else msg = `Converted ${outs.length} of ${files.length} file(s) to ${tgt}. Saved next to the originals${o.to ? ' / in the folder you chose' : ''}; first: ${outs[0]}.`;
    if (fails.length) msg += ` ${fails.length} failed: ${fails.slice(0, 3).join('; ')}.`;
    if (o.open && outs[0]) shell.openPath(outs[0].replace(/[\\/] \(\d+ pages\)$/, '')).catch(() => {});
    return msg;
  }
  // Quick jobs answer straight away; long ones (video, big batches) carry on in the background and notify when done.
  async function withBackground(label, job) {
    let finished = false;
    const p = job(); p.then(() => { finished = true; }, () => { finished = true; });
    const winner = await Promise.race([p.then(() => 'done', () => 'done'), sleep(25000).then(() => 'slow')]);
    if (winner === 'done') return p;
    say('info', `${label} is taking a while; it keeps going in the background.`);
    p.then(r => { notify('Conversion finished', String(r).slice(0, 200)); say('sys', r); }, e => { notify('Conversion failed', String(e.message).slice(0, 200)); say('err', `Conversion failed: ${e.message}`); });
    return `Still converting (${label}). It keeps running in the background and a notification appears when it is done; tell the user that and do not wait.`;
  }

  def({
    name: 'convert_file',
    description: 'Convert files to another format and save a NEW file (the original is never changed or overwritten; it lands next to the original unless "to" is given). Works offline with no extra software: pictures between png / jpg / webp / bmp / ico, pictures to PDF (several pictures, or a whole folder of them, are merged into ONE pdf unless combine is false), txt / md / html to PDF, md to html, txt to html, html to txt, csv to json and json to csv. With free open-source engines it also does Word / Excel / PowerPoint to and from PDF, docx, xlsx, pptx, txt, html (LibreOffice, pandoc), audio and video such as mp4 to mp3 (FFmpeg), tiff / heic pictures (ImageMagick) and PDF pages to png / jpg (Poppler). If an engine is missing the error says which one: offer to install it with converter_engines. To only READ a PDF or document use read_document instead.',
    parameters: obj({
      path: str('The file, a folder of files, or several files separated by ";". Names as the user said them (typos are fine); shortcuts like downloads/photo.png work.'),
      format: str('Target format as a file extension: pdf, png, jpg, webp, bmp, ico, txt, html, md, csv, json, docx, xlsx, pptx, odt, mp3, wav, mp4...'),
      to: str('Optional: output folder, or full output file path. Default: next to the original.'),
      combine: bool('Several pictures to PDF: true (default) = one PDF with a page per picture, false = a separate PDF per picture.'),
      page: oneOf('PDF page size for pictures: a4 (default), letter, or fit (page = picture size).', ['a4', 'letter', 'fit']),
      quality: num('JPEG / WebP quality 1-100 (default 90).'),
      max_width: num('Optional: shrink pictures wider than this many pixels (keeps proportions).'),
      only: str('When "path" is a folder: only convert files with this extension, e.g. "png" or "docx". Pictures-to-picture/PDF jobs default to all pictures.'),
      open: bool('Open the result when finished.')
    }, ['path', 'format']),
    level: () => 1,
    describe: a => `Convert ${clip(String(a.path || ''), 120)} to ${String(a.format || '').replace(/^\./, '')}`,
    run: async a => {
      const tgt = normExt(a.format); if (!tgt) throw new Error('Tell me which format to convert to.');
      const files = await gather(a, tgt);
      const q = Number(a.quality), mw = Number(a.max_width);
      const o = { to: a.to, page: ['a4', 'letter', 'fit'].includes(a.page) ? a.page : 'a4', quality: q >= 1 && q <= 100 ? Math.round(q) : 90, maxWidth: mw > 0 ? Math.min(30000, Math.round(mw)) : 0, open: a.open === true };
      const label = files.length === 1 ? `${path.basename(files[0])} to ${tgt}` : `${files.length} files to ${tgt}`;
      return withBackground(label, () => convertMany(files, tgt, o, a.combine));
    }
  });

  def({
    name: 'converter_engines',
    description: 'Show which free open-source converter engines are installed (FFmpeg for audio/video, LibreOffice for Word/Excel/PowerPoint, pandoc, ImageMagick, Poppler for PDF to picture) and what each one unlocks, or install one with winget. Installing always asks the user first and runs in the background (Windows may show an administrator prompt).',
    parameters: obj({ action: oneOf('list (default) or install.', ['list', 'install']), engine: oneOf('Which engine to install.', Object.keys(ENGINES)) }),
    level: a => (a.action === 'install' ? 2 : 0), alwaysAsk: a => a.action === 'install',
    describe: a => (a.action === 'install' ? `INSTALL ${(ENGINES[a.engine] || {}).name || a.engine} (free, open source, via winget)` : 'List converter engines'),
    run: async a => {
      if (a.action !== 'install') {
        const lines = ['Built in, always available: pictures <-> png/jpg/webp/bmp/ico, pictures -> PDF, txt/md/html -> PDF, md -> html, csv <-> json.'];
        for (const [id, e] of Object.entries(ENGINES)) lines.push(`${e.name}: ${(await findEngine(id)) ? 'installed' : 'not installed'} - ${e.gives}`);
        return lines.join('\n');
      }
      const id = a.engine, e = ENGINES[id]; if (!e) throw new Error('Say which engine: ' + Object.keys(ENGINES).join(', ') + '.');
      const have = await findEngine(id); if (have) return `${e.name} is already installed.`;
      const winget = await whereExe('winget.exe');
      if (!winget) throw new Error(`winget is not available on this PC. ${e.name} can be downloaded from ${e.url}`);
      notify('Vision', `Installing ${e.name}…`); say('info', `Installing ${e.name} with winget (this can take a few minutes)…`);
      execFile(winget, ['install', '--id', e.winget, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'], { windowsHide: true, timeout: 30 * 60e3, maxBuffer: 8e6 }, async (err, so, se) => {
        foundExe.delete(id);
        if (await findEngine(id)) { notify('Vision', `${e.name} is installed.`); say('sys', `${e.name} is installed: ${e.gives}.`); }
        else { const why = String((se || so || (err && err.message)) || '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(0, 200); logger.log('convert', `install ${id} failed: ${why}`); notify('Vision', `Could not install ${e.name}.`); say('err', `Could not install ${e.name}: ${why || 'unknown error'}. You can download it from ${e.url}`); }
      });
      return `Installing ${e.name} in the background with winget; a notification appears when it is done (Windows may ask for administrator approval). Tell the user, and do not wait.`;
    }
  });
}

module.exports = register;
