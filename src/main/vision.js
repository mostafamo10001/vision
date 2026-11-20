'use strict';
// Screen vision, online (Gemini): finds things on the screen for click_on / find_on_screen, and answers questions about it.
// The screenshot is prepared once and sent once.
const { nativeImage, screen } = require('electron');
const gemini = require('./gemini');
const capture = require('./capture');
const cfg = require('./config');
const L = require('./screen-logic');
const logger = require('./log');

// Quick vision calls: thinking switched down (unless visionFast=false) and a backup model started if the first is slow (see gemini.generateFast).
const fastCall = (body, opts) => gemini.generateFast(body, { ...opts, thinking: cfg.get().visionFast !== false });

// Keeps the picture to about one megapixel: plenty for reading UI text, fast to upload, and cheap on tokens. The close-up pass covers fine detail when it is needed.
function prepare(src, maxPixels = 1280 * 784) {
  const img = Buffer.isBuffer(src) ? nativeImage.createFromBuffer(src) : src, { width, height } = img.getSize();
  const k = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  const w = Math.max(28, Math.round(width * k / 28) * 28), h = Math.max(28, Math.round(height * k / 28) * 28);
  const out = (w === width && h === height) ? img : img.resize({ width: w, height: h, quality: 'best' });
  return { b64: out.toJPEG(80).toString('base64'), mime: 'image/jpeg', w, h };
}

// ---------- reading coordinates out of an answer ----------
function parseJsonLoose(text) {
  const clean = String(text || '').replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(clean); } catch {}
  const m = clean.match(/(\[[\s\S]*\]|\{[\s\S]*\})/); if (m) { try { return JSON.parse(m[1]); } catch {} }
  return null;
}
function extractTargets(text) {
  const out = [], j = parseJsonLoose(text), nums = (a, n) => Array.isArray(a) && a.length === n && a.every(v => Number.isFinite(Number(v)));
  const visit = o => {
    if (Array.isArray(o)) return o.forEach(visit);
    if (o && typeof o === 'object') {
      for (const k of ['box_2d', 'bbox_2d', 'bbox', 'box']) if (nums(o[k], 4)) return out.push({ nums: o[k].map(Number), kind: 'box', label: o.label || o.name || '' });
      for (const k of ['point_2d', 'point']) if (nums(o[k], 2)) return out.push({ nums: o[k].map(Number), kind: 'point', label: o.label || o.name || '' });
      Object.values(o).forEach(visit);
    }
  };
  if (j) visit(j);
  return out;
}
// Gemini answers boxes as [ymin, xmin, ymax, xmax] on a 0-1000 grid. -> fractions of the picture, or null if outside it
function toFractions(t) {
  let x, y;
  if (t.kind === 'box') { const [ymin, xmin, ymax, xmax] = t.nums; x = (xmin + xmax) / 2000; y = (ymin + ymax) / 2000; } else { x = t.nums[0] / 1000; y = t.nums[1] / 1000; }
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { fx: x, fy: y } : null;
}

// Pass 1: look at the whole (shrunk) screen and list every match, most likely first.
async function groundCandidates(target, shot, signal) {
  const ask1 = () => fastCall({ contents: [{ role: 'user', parts: [{ text: `Find "${target}" in this screenshot. If several things match, list every match, the most likely one first; prefer the clickable control itself (button, link, field, icon) over a nearby label. The box must tightly surround just that one element. Return JSON only: [{"label": string, "box_2d": [ymin, xmin, ymax, xmax]}] with every coordinate normalized to 0-1000. If it is not visible return [].` }, { inlineData: { mimeType: shot.mime, data: shot.b64 } }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } }, { signal, timeoutMs: 25000 });
  let res;
  try { res = await ask1(); } catch (e) { if (signal?.aborted) throw e; await new Promise(r => setTimeout(r, 400)); res = await ask1(); } // one quiet retry: a single slow or failed call should not fail a click
  const out = [];
  for (const t of extractTargets(gemini.textOf(res))) {
    const f = toFractions(t); if (!f) continue;
    const box = t.kind === 'box' ? L.boxFromGemini(t.nums) : null;
    out.push({ ...f, box, label: t.label || target });
  }
  // a "box" that covers most of the screen is a window or a page, not the thing asked for: keep it only as a last resort
  return [...out.filter(c => L.boxArea(c.box) <= 0.6), ...out.filter(c => L.boxArea(c.box) > 0.6)];
}
async function groundOnline(target, shot, signal) {
  const c = await groundCandidates(target, shot, signal);
  if (!c.length) { const e = new Error('not visible'); e.notFound = true; throw e; }
  return { fx: c[0].fx, fy: c[0].fy, label: c[0].label, count: c.length };
}

// Pass 2: a close-up crop (full resolution) around the candidate. The model confirms it really is the thing asked for and gives the exact spot.
// -> { ok:false } when the close-up says it is something else, { ok:true, fx, fy } with the refined point otherwise.
async function verifyCandidate(target, cand, full, signal) {
  const { width: W, height: H } = full.getSize();
  const reg = L.cropRegion(cand.fx, cand.fy, cand.box);
  const x = Math.round(reg.x1 * W), y = Math.round(reg.y1 * H), w = Math.max(32, Math.round((reg.x2 - reg.x1) * W)), h = Math.max(32, Math.round((reg.y2 - reg.y1) * H));
  const crop = full.crop({ x, y, width: Math.min(w, W - x), height: Math.min(h, H - y) });
  const { width: cw, height: ch } = crop.getSize(), k = Math.min(1, 1400 / Math.max(cw, ch));
  const img = k < 1 ? crop.resize({ width: Math.round(cw * k), height: Math.round(ch * k), quality: 'best' }) : crop;
  const res = await fastCall({ contents: [{ role: 'user', parts: [{ text: `This is a zoomed-in crop of a screenshot. Is "${target}" in it? The thing I am looking for should be near the middle. Return JSON only: {"found": boolean, "box_2d": [ymin, xmin, ymax, xmax]} with coordinates normalized to 0-1000 inside THIS crop, tightly around that one element. If it is not here, or only something merely similar is, answer {"found": false}.` }, { inlineData: { mimeType: 'image/jpeg', data: img.toJPEG(88).toString('base64') } }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } }, { signal, timeoutMs: 20000 });
  const j = parseJsonLoose(gemini.textOf(res)), o = Array.isArray(j) ? j[0] : j;
  if (!o || typeof o !== 'object') throw new Error('unreadable close-up answer');
  if (o.found === false) return { ok: false };
  const box = L.boxFromGemini(o.box_2d || o.bbox_2d || o.box);
  if (!box) return { ok: true, fx: cand.fx, fy: cand.fy }; // confirmed, but no better spot given: keep the first one
  const c = L.boxCenter(box), p = L.mapFromCrop(reg, c.fx, c.fy);
  // the refined spot must stay near the candidate (which sits near the middle of the crop); a big jump means the close-up found something else
  if (Math.abs(p.fx - cand.fx) > 0.4 * (reg.x2 - reg.x1) || Math.abs(p.fy - cand.fy) > 0.4 * (reg.y2 - reg.y1)) return { ok: false };
  return { ok: true, fx: p.fx, fy: p.fy };
}

// ---------- find something on screen ----------
// FAST PATH: one look at the whole screen, one click. A close-up (full-resolution crop) is only used up front when SEVERAL things matched
// (to pick the right one); otherwise it is saved for when the click did nothing (see relocate). Settings: verifyClicks=false turns it off.
async function locate(target, { signal } = {}) {
  const t0 = Date.now(), full = await capture.fullImage(), shot = prepare(full);
  const ms = () => Date.now() - t0;
  const cands = await groundCandidates(String(target), shot, signal);
  if (!cands.length) return { found: false, note: 'it is not visible on the screen', via: 'online', ms: ms() };
  const verifyOn = cfg.get().verifyClicks !== false;
  for (const c of cands.slice(0, 3)) {
    const needs = verifyOn && cands.length > 1;
    if (!needs) return { found: true, ...capture.toPhysical(c.fx * 1000, c.fy * 1000), fx: c.fx, fy: c.fy, cands: cands.slice(0, 3), label: c.label, count: cands.length, verified: false, via: 'online', ms: ms() };
    try {
      const v = await verifyCandidate(String(target), c, full, signal);
      if (!v.ok) continue; // the close-up says this is not it: try the next candidate
      return { found: true, ...capture.toPhysical(v.fx * 1000, v.fy * 1000), fx: v.fx, fy: v.fy, cands: cands.slice(0, 3), label: c.label, count: cands.length, verified: true, via: 'online', ms: ms() };
    } catch (e) {
      if (signal?.aborted) throw e;
      // the second look failed (timeout, odd answer): use the first look rather than failing the click
      return { found: true, ...capture.toPhysical(c.fx * 1000, c.fy * 1000), fx: c.fx, fy: c.fy, cands: cands.slice(0, 3), label: c.label, count: cands.length, verified: false, via: 'online', ms: ms() };
    }
  }
  return { found: false, note: 'what I saw did not hold up on a closer look, so I did not click it', via: 'online', ms: ms() };
}

// The click did nothing: take a fresh full-resolution look at the places pass 1 pointed to and find the exact spot.
// -> { found:false } (nothing better), { found:true, same:true } (the close-up agrees with where we clicked: do not click again), or a new point.
async function relocate(target, prev, { signal } = {}) {
  if (cfg.get().verifyClicks === false || !prev || !Array.isArray(prev.cands)) return { found: false };
  const t0 = Date.now(), full = await capture.fullImage();
  for (const c of prev.cands.slice(0, 2)) {
    let v; try { v = await verifyCandidate(String(target), c, full, signal); } catch (e) { if (signal?.aborted) throw e; continue; }
    if (!v.ok) continue;
    return { found: true, same: Math.hypot(v.fx - prev.fx, v.fy - prev.fy) < 0.006, ...capture.toPhysical(v.fx * 1000, v.fy * 1000), fx: v.fx, fy: v.fy, ms: Date.now() - t0 };
  }
  return { found: false, ms: Date.now() - t0 };
}

// ---------- ask about the screen ----------
// opts: { json, system, validate, signal }
// Screenshots do not contain the mouse pointer, so "what is this?" has no anchor. Tell the model where it is (only when it is on the captured screen).
function pointerHint() {
  try {
    const b = capture.current().display.bounds, p = screen.getCursorScreenPoint(), fx = (p.x - b.x) / b.width, fy = (p.y - b.y) / b.height;
    if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) return '';
    return `\n(The mouse pointer is ${Math.round(fx * 100)}% from the left and ${Math.round(fy * 100)}% from the top of the screenshot. If the request says "this" or "here", it most likely means what is at or right next to the pointer.)`;
  } catch { return ''; }
}
const ASK_SYSTEM = 'You answer questions about a screenshot of the user\'s screen. Answer directly in plain text and keep it short (the answer is read aloud), but include everything the question asks for. If the user asks about "this" element and it is not obvious which one, use the most prominent or most likely one instead of asking.';
async function ask(prompt, opts = {}) {
  const t0 = Date.now(), full = await capture.fullImage(), tCap = Date.now() - t0, shot = prepare(full), tPrep = Date.now() - t0 - tCap;
  const system = opts.system || (opts.json ? '' : ASK_SYSTEM);
  const res = await fastCall({ ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents: [{ role: 'user', parts: [{ text: prompt + pointerHint() }, { inlineData: { mimeType: shot.mime, data: shot.b64 } }] }], ...(opts.json ? { generationConfig: { responseMimeType: 'application/json' } } : {}) }, { signal: opts.signal });
  const text = String(gemini.textOf(res) || '').trim();
  if (!text) throw new Error('empty answer');
  const ms = Date.now() - t0;
  logger.log('timing', `screen question: capture ${tCap} ms, resize ${tPrep} ms, model ${ms - tCap - tPrep} ms (${res._model || '?'}), total ${ms} ms`);
  return { text, value: opts.validate ? opts.validate(text) : undefined, via: 'online', ms };
}
const describe = (question, opts = {}) => ask(question || 'Describe what is on the screen in 3-4 sentences, naming the open apps and any important text.', opts);

// ---------- self-test (used by Run diagnostics) ----------
// Draws a picture with a red square at a known spot and asks the model to find it: proves the whole chain on this key.
function testPicture() {
  const W = 1344, H = 784, buf = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { buf[i * 4] = 238; buf[i * 4 + 1] = 236; buf[i * 4 + 2] = 235; buf[i * 4 + 3] = 255; }
  const rect = (x0, y0, x1, y1, b, g, r) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const o = (y * W + x) * 4; buf[o] = b; buf[o + 1] = g; buf[o + 2] = r; } };
  rect(0, 0, W, 70, 90, 60, 40); rect(200, 300, 330, 420, 200, 120, 40); rect(900, 520, 1020, 640, 40, 40, 215); // header, blue decoy, RED square centred at (960, 580)
  const img = nativeImage.createFromBitmap(buf, { width: W, height: H });
  return { b64: img.toJPEG(90).toString('base64'), mime: 'image/jpeg', w: W, h: H, expected: { x: 960 / W, y: 580 / H } };
}
async function selfTest() {
  const pic = testPicture(), t0 = Date.now(), f = await groundOnline('the red square', pic);
  const err = Math.hypot((f.fx - pic.expected.x) * pic.w, (f.fy - pic.expected.y) * pic.h);
  if (err > pic.w * 0.05) throw new Error(`pointed ${Math.round(err)} px away from a test square: clicking by description may be unreliable`);
  return `found a test square within ${Math.round(err)} px (${((Date.now() - t0) / 1000).toFixed(1)} s)`;
}

module.exports = { locate, relocate, ask, describe, selfTest, parseJsonLoose, extractTargets };
