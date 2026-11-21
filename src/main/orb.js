'use strict';
// A small glowing orb that fades in over everything while you are talking, or Vision is speaking or thinking, and Vision' own window isn't on screen.
const { BrowserWindow, screen } = require('electron');
const path = require('path');
const cfg = require('./config');
const runtime = require('./runtime');

const SIZE = 200, HOLD_MS = 700, HOLD_TALK_MS = 1100; // you pause between words, so the orb stays a little longer while you talk
let w = null, shown = false, hideTimer = null, killTimer = null, lastMode = null;

function create() {
  if (w && !w.isDestroyed()) return w;
  w = new BrowserWindow({
    width: SIZE, height: SIZE, show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    resizable: false, movable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'orb-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  w.setIgnoreMouseEvents(true);
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setContentProtection(!!cfg.get().hideFromCapture); // keep it out of Vision' own screenshots
  w.loadFile(path.join(__dirname, '..', 'renderer', 'orb.html'));
  w.on('closed', () => { w = null; shown = false; });
  return w;
}

const userSeesVision = () => {
  const m = runtime.state.win;
  return !!m && !m.isDestroyed() && m.isVisible() && !m.isMinimized() && (m.isFocused() || m.isAlwaysOnTop());
};

function place() {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()), wa = d.workArea;
  w.setBounds({ x: Math.round(wa.x + wa.width / 2 - SIZE / 2), y: Math.round(wa.y + wa.height - SIZE - 8), width: SIZE, height: SIZE });
}

// Every screenshot hides the orb first (and keeps it hidden until the picture is taken), whatever the capture setting says:
// content protection is the first line of defence, this is the guarantee. It nests, so a long series of shots can hold it.
let suspended = 0;
async function hideForCapture() {
  suspended++;
  if (w && !w.isDestroyed() && w.isVisible()) { w.hide(); await new Promise(r => setTimeout(r, 70)); } // let the desktop compositor drop it from the picture
  let released = false;
  return () => {
    if (released) return; released = true;
    suspended = Math.max(0, suspended - 1);
    if (!suspended && shown && w && !w.isDestroyed()) w.showInactive(); // it comes back only if it is still supposed to be showing
  };
}
let theme = null;
function setTheme(t) { theme = t; if (w && !w.isDestroyed()) w.webContents.send('orb:theme', theme); }
function show() {
  clearTimeout(killTimer);
  const win = create();
  if (theme) win.webContents.send('orb:theme', theme);
  if (!shown) { place(); if (!suspended) win.showInactive(); win.setAlwaysOnTop(true, 'screen-saver'); shown = true; }
  win.webContents.send('orb:show');
}
function hide() {
  hideTimer = null;
  if (!w || w.isDestroyed() || !shown) return;
  shown = false;
  w.webContents.send('orb:hide');
  killTimer = setTimeout(() => { if (w && !w.isDestroyed() && !shown) w.hide(); }, 450);
}

// Called ~25x/second by the voice window: mode is "listening" (you are talking), "speaking", "thinking" or null (idle).
function update(mode, level) {
  if (mode && !userSeesVision()) {
    clearTimeout(hideTimer); hideTimer = null; lastMode = mode;
    show();
    if (w && !w.isDestroyed()) { w.webContents.send('orb:mode', mode); w.webContents.send('orb:level', level); }
  } else if (shown && !hideTimer) {
    hideTimer = setTimeout(hide, lastMode === 'listening' ? HOLD_TALK_MS : HOLD_MS); // short hold so gaps between spoken chunks don't flicker
  }
}
function applySettings() { if (w && !w.isDestroyed()) w.setContentProtection(!!cfg.get().hideFromCapture); }
function prewarm() { create(); }

module.exports = { update, applySettings, prewarm, setTheme, hideForCapture };
