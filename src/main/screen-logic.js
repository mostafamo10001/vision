'use strict';
// Pure helpers for reliable on-screen work (no Electron, so they load anywhere and are easy to test):
//  - screen "signatures": a tiny grayscale grid of the screen, to tell whether an action changed anything and whether the screen has settled
//  - crop geometry for the second, close-up look that double-checks where to click
//  - risk checks for click targets and files

const GW = 160, GH = 90;      // signature grid (cells are ~12 px on a 1080p screen)
const CELL_DELTA = 14;        // a cell counts as "different" when its brightness moved by more than this (0-255)
const CHANGED = 0.0003;       // >= ~5 of 14400 cells different (about a checkbox-sized change): the screen visibly changed
const STABLE = 0.00015;       // <= ~2 cells different between two looks: the screen is calm (a blinking caret flips one or two)

// BGRA bitmap (what Electron's nativeImage.toBitmap() gives) -> GW*GH grayscale cells, each the mean of a few samples.
function sigFromBGRA(buf, w, h, gw = GW, gh = GH) {
  const out = new Uint8Array(gw * gh);
  if (!buf || !w || !h || buf.length < w * h * 4) return out;
  for (let gy = 0; gy < gh; gy++) {
    const y0 = Math.floor(gy * h / gh), y1 = Math.max(y0 + 1, Math.floor((gy + 1) * h / gh));
    for (let gx = 0; gx < gw; gx++) {
      const x0 = Math.floor(gx * w / gw), x1 = Math.max(x0 + 1, Math.floor((gx + 1) * w / gw));
      let sum = 0, n = 0;
      for (const y of [y0, y1 - 1]) for (const x of [x0, x1 - 1]) {
        const o = (Math.min(y, h - 1) * w + Math.min(x, w - 1)) * 4;
        sum += buf[o] * 0.114 + buf[o + 1] * 0.587 + buf[o + 2] * 0.299; n++;
      }
      out[gy * gw + gx] = Math.round(sum / n);
    }
  }
  return out;
}
// Fraction of cells that differ between two signatures (1 = unknown / not comparable).
function sigDiff(a, b, delta = CELL_DELTA) {
  if (!a || !b || a.length !== b.length || !a.length) return 1;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > delta) d++;
  return d / a.length;
}

// ---- boxes and crops (all fractions of the picture, 0-1) ----
// Gemini box [ymin, xmin, ymax, xmax] on a 0-1000 grid -> {x1,y1,x2,y2} fractions, or null if it is not a sane box.
function boxFromGemini(b) {
  if (!Array.isArray(b) || b.length !== 4 || !b.every(v => Number.isFinite(Number(v)))) return null;
  const [ymin, xmin, ymax, xmax] = b.map(Number);
  const cl = v => Math.max(0, Math.min(1000, v)) / 1000;
  const box = { x1: cl(Math.min(xmin, xmax)), y1: cl(Math.min(ymin, ymax)), x2: cl(Math.max(xmin, xmax)), y2: cl(Math.max(ymin, ymax)) };
  return box.x2 > box.x1 && box.y2 > box.y1 ? box : null;
}
const boxArea = b => (b ? (b.x2 - b.x1) * (b.y2 - b.y1) : 0);
const boxCenter = b => ({ fx: (b.x1 + b.x2) / 2, fy: (b.y1 + b.y2) / 2 });
// A region around a candidate for the close-up: about 3x the box, never smaller than minW x minH, always inside the screen.
function cropRegion(cx, cy, box, minW = 0.30, minH = 0.34) {
  const bw = box ? box.x2 - box.x1 : 0, bh = box ? box.y2 - box.y1 : 0;
  const w = Math.min(1, Math.max(bw * 3, minW)), h = Math.min(1, Math.max(bh * 3, minH));
  const x1 = Math.max(0, Math.min(1 - w, cx - w / 2)), y1 = Math.max(0, Math.min(1 - h, cy - h / 2));
  return { x1, y1, x2: x1 + w, y2: y1 + h };
}
// A point given as fractions of the CROP -> fractions of the whole screen.
const mapFromCrop = (region, fx, fy) => ({ fx: region.x1 + fx * (region.x2 - region.x1), fy: region.y1 + fy * (region.y2 - region.y1) });
// Small things need the close-up to be placed exactly; large unique things do not.
const isSmallBox = b => !b || (b.x2 - b.x1) < 0.08 || (b.y2 - b.y1) < 0.06;

// ---- risk checks ----
// Words on a thing the agent is about to click that deserve an explicit OK: only installs, security prompts and "fix my PC" scams.
// (Payments, deletes and sends are already flagged by the agent itself; generic words like Yes / Accept / Send / Download are NOT here, they caused constant asking.)
const RISKY_CLICK = /\b(install(?:er|ation)?|run\s+anyway|allow|grant|unblock|trust|permit|uninstall|disable|turn\s+off|more\s+info|fix\s+(?:now|all|pc)|clean\s+(?:now|pc)|scan\s+now)\b/ig;
const riskyClickWords = text => [...new Set((String(text || '').match(RISKY_CLICK) || []).map(w => w.toLowerCase().replace(/\s+/g, ' ')))];
const riskyClickTarget = text => riskyClickWords(text).length > 0;

// Programs and scripts only (shortcuts, documents and disk images are not here: opening them is everyday use).
const EXEC_EXT = /\.(exe|msi|msix|appx|appxbundle|bat|cmd|scr|pif|ps1|psm1|vbs|vbe|js|jse|wsf|hta|jar|reg|cpl|dll)$/i;
const isExecutablePath = p => EXEC_EXT.test(String(p || '').trim().replace(/["']+$/, ''));

module.exports = { GW, GH, CHANGED, STABLE, sigFromBGRA, sigDiff, boxFromGemini, boxArea, boxCenter, cropRegion, mapFromCrop, isSmallBox, riskyClickWords, riskyClickTarget, isExecutablePath };
