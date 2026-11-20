'use strict';
// Screen capture + coordinate mapping. The model works in a 0-1000 grid over the screenshot;
// this module converts that grid to physical screen pixels for the Windows helper.
const { desktopCapturer, screen } = require('electron');
const orb = require('./orb');
const L = require('./screen-logic');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let target = null; // { display, origin:{x,y}, size:{w,h} } in physical pixels

function pickDisplay() {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const origin = screen.dipToScreenPoint({ x: d.bounds.x, y: d.bounds.y });
  target = { display: d, origin, size: { w: Math.round(d.size.width * d.scaleFactor), h: Math.round(d.size.height * d.scaleFactor) } };
  return target;
}
const current = () => target || pickDisplay();

async function grabRaw(t, size) { // no orb handling: the caller holds it hidden
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size || { width: t.size.w, height: t.size.h } });
  const src = sources.find(s => String(s.display_id) === String(t.display.id)) || sources[0];
  if (!src || src.thumbnail.isEmpty()) throw new Error('Screen capture returned nothing.');
  return src.thumbnail;
}
async function grab(t) {
  const restore = await orb.hideForCapture(); // the floating orb must never appear in a screenshot
  try { return await grabRaw(t); } finally { restore(); }
}

// ---------- did the screen change / has it settled? ----------
// A tiny grayscale grid of the screen (cheap: a 640px grab). Comparing two of them tells whether an action did anything.
async function sigOf(t) {
  const w = 640, h = Math.max(90, Math.round(w * t.size.h / t.size.w));
  const img = await grabRaw(t, { width: w, height: h }), s = img.getSize();
  return L.sigFromBGRA(img.toBitmap(), s.width, s.height);
}
async function signature() {
  const restore = await orb.hideForCapture();
  try { return await sigOf(current()); } finally { restore(); }
}
// After an action: wait for the screen to START changing (up to changeMs; it may never, if the action missed), then wait until it
// stops changing (one calm look, up to stableMs). Much faster than a fixed sleep when the app is quick, and patient when it is slow.
// Returns { changed: true|false|null (null = no "before" given), stable, ms }.
async function waitStable({ before = null, changeMs = 800, stableMs = 2000, interval = 100, calmNeeded = 1 } = {}) {
  const t0 = Date.now(), restore = await orb.hideForCapture(); // held hidden: the orb's animation would look like a change
  try {
    const t = current();
    let prev = await sigOf(t), changed = !!before && L.sigDiff(before, prev) >= L.CHANGED;
    while (before && !changed && Date.now() - t0 < changeMs) { await sleep(interval); prev = await sigOf(t); changed = L.sigDiff(before, prev) >= L.CHANGED; }
    let calm = 0; const end = Date.now() + stableMs;
    while (calm < calmNeeded && Date.now() < end) {
      await sleep(interval);
      const cur = await sigOf(t);
      if (L.sigDiff(prev, cur) <= L.STABLE) calm++; else calm = 0;
      prev = cur;
    }
    if (before && !changed) changed = L.sigDiff(before, prev) >= L.CHANGED;
    return { changed: before ? changed : null, stable: calm >= calmNeeded, ms: Date.now() - t0 };
  } finally { restore(); }
}
function fit(img, maxEdge) {
  const { width, height } = img.getSize();
  const k = Math.min(1, maxEdge / Math.max(width, height));
  return k < 1 ? img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'good' }) : img;
}

// Full screenshot for the model.
async function capture({ fresh = true, maxEdge = 1280 } = {}) {
  const t = fresh ? pickDisplay() : current();
  const img = await grab(t);
  const out = fit(img, maxEdge);
  return { mime: 'image/jpeg', data: out.toJPEG(75).toString('base64'), size: out.getSize() };
}
// Zoomed crop; region given on the 0-1000 grid.
async function zoom(x1, y1, x2, y2, maxEdge = 1400) {
  const t = current();
  const img = await grab(t);
  const { width, height } = img.getSize();
  const cl = v => Math.max(0, Math.min(1000, Number(v)));
  const [a, b, c, d] = [cl(x1), cl(y1), cl(x2), cl(y2)];
  const x = Math.round(Math.min(a, c) / 1000 * width), y = Math.round(Math.min(b, d) / 1000 * height);
  const w = Math.max(16, Math.round(Math.abs(c - a) / 1000 * width)), h = Math.max(16, Math.round(Math.abs(d - b) / 1000 * height));
  const crop = img.crop({ x, y, width: Math.min(w, width - x), height: Math.min(h, height - y) });
  const out = fit(crop, maxEdge);
  return { mime: 'image/jpeg', data: out.toJPEG(85).toString('base64'), size: out.getSize() };
}
async function fullResPng() { return (await grab(pickDisplay())).toPNG(); }
// The same full-resolution picture without the PNG encode/decode round trip (slow on big screens): for callers that only resize or crop it.
async function fullImage() { return grab(pickDisplay()); }

function toPhysical(nx, ny) {
  const t = current();
  const cl = v => Math.max(0, Math.min(1000, Number(v)));
  return { x: Math.round(t.origin.x + cl(nx) / 1000 * t.size.w), y: Math.round(t.origin.y + cl(ny) / 1000 * t.size.h) };
}
module.exports = { capture, zoom, fullResPng, fullImage, toPhysical, current, pickDisplay, signature, waitStable };
