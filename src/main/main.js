'use strict';
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, session, nativeImage, screen, powerMonitor } = require('electron');
const path = require('path');
const cfg = require('./config');
const bridge = require('./ps-bridge');
const tools = require('./tools');
const gemini = require('./gemini');
const prompts = require('./prompts');
const wake = require('./wake');
const runtime = require('./runtime');
const orb = require('./orb');
const startup = require('./startup');
const logger = require('./log');
const transcribe = require('./transcribe');
const wakeLocal = require('./wake-local');
app.on('will-quit', () => wakeLocal.stop());
process.on('uncaughtException', e => logger.log('main-exception', (e && e.stack) || e));
process.on('unhandledRejection', e => logger.log('main-rejection', (e && e.stack) || e));

// The app was renamed from Jarvis to Vision: keep using the old data folder so nothing saved is lost.
app.setPath('userData', path.join(app.getPath('appData'), 'Jarvis'));
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId('local.jarvis.agent');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion'); // keep the wake-word mic alive while the window is hidden/covered

let win = null, tray = null, quitting = false;
const startHidden = process.argv.includes('--hidden'); // set when Windows launches Vision at login: start quietly in the tray
const ICON = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const TRAY_ICON = path.join(__dirname, '..', '..', 'assets', 'tray.png'); // simpler artwork that stays crisp at 16 px

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const s = cfg.get();
  win = new BrowserWindow({
    width: 440, height: 740, x: wa.x + wa.width - 460, y: wa.y + wa.height - 760,
    minWidth: 380, minHeight: 560, frame: false, backgroundColor: '#0a0e13', show: false, icon: ICON,
    alwaysOnTop: s.alwaysOnTop, title: 'Vision',
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  runtime.state.win = win;
  win.setContentProtection(!!s.hideFromCapture);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.on('console-message', (...args) => { // anything the window's code reports as a warning/error goes to the log
    const e = args[0], d = e && e.message !== undefined ? e : { level: args[1], message: args[2], line: args[3], sourceId: args[4] };
    if (typeof d.level === 'string' ? ['warning', 'error'].includes(d.level) : d.level >= 2) logger.log('window', `${d.message} (${path.basename(String(d.sourceId || ''))}:${d.line || ''})`);
  });
  win.webContents.on('render-process-gone', (_e, details) => logger.log('window-crash', JSON.stringify(details)));
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
}

function showAndType() { runtime.state.approvalOpenedWindow = false; win.show(); win.focus(); runtime.emit('focus-input'); } // bring the window up with the cursor already in the message box
function toggleWindow() { win.isVisible() && win.isFocused() ? win.hide() : showAndType(); }

function createTray() {
  tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
  tray.setToolTip('Vision · made by Mostafa Mamdouh');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Vision · made by Mostafa Mamdouh', enabled: false },
    { type: 'separator' },
    { label: 'Show / hide', click: toggleWindow },
    { label: 'Type a request  Ctrl+Alt+V', click: showAndType },
    { label: 'Start / stop listening', click: () => runtime.emit('toggle-listening') },
    { label: 'Transcribe: start / stop (microphone)  Ctrl+Alt+T', click: () => safeToggle('mic') },
    { label: 'Transcribe: start / stop (audio playing on this PC)', click: () => safeToggle('system') },
    { label: 'Stop everything', click: () => runtime.stopAll() },
    { label: 'Run diagnostics (copies a report)', click: () => { win.showInactive(); require('./diagnostics').run(); } },
    { label: 'Open log folder', click: () => require('electron').shell.openPath(logger.dir()) },
    { type: 'separator' },
    { label: 'Quit Vision', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('click', toggleWindow);
}

function registerShortcuts() {
  const reg = (acc, fn) => { try { if (!globalShortcut.register(acc, fn)) console.warn('Shortcut unavailable:', acc); } catch (e) { console.warn(e.message); } };
  reg('Control+Alt+Space', () => runtime.emit('toggle-listening')); // voice only: do not pop the window up
  reg('Control+Alt+Escape', () => runtime.stopAll());
  reg('Control+Alt+V', showAndType); // type instead of talk: window up, cursor in the message box
  reg('Control+Alt+T', () => safeToggle('mic')); // start / stop dictation (microphone)
  reg('Control+Alt+Y', () => runtime.answerApproval(null, true, false));
  reg('Control+Alt+N', () => runtime.answerApproval(null, false, false));
}

function applySettings() {
  const s = cfg.get();
  if (win) { win.setAlwaysOnTop(!!s.alwaysOnTop); win.setContentProtection(!!s.hideFromCapture); }
  orb.applySettings();
  // Only register for the installed .exe; in `npm start` this would point Windows at the bare electron.exe.
  if (app.isPackaged && process.platform === 'win32') {
    try { app.setLoginItemSettings({ openAtLogin: false, path: process.execPath, args: ['--hidden'] }); } catch {} // drop any older Electron-made entry
    (s.startWithWindows
      ? startup.enable(process.execPath).then(async via => {
          logger.log('startup', `registered via ${via}`);
          if (via !== 'task' && await startup.flaggedRunAsAdmin(process.execPath)) runtime.emit('step', { kind: 'err', text: 'Start with Windows cannot work while Vision is set to “Run as administrator”. Start Vision as administrator once and it will set up a startup task that works.' });
        })
      : startup.disable()).catch(e => logger.log('startup', 'failed: ' + e.message));
  }
}

function wireIpc() {
  const publicConfig = () => ({ settings: cfg.get(), hasKey: cfg.hasKey(), models: cfg.getModels(), defaults: cfg.DEFAULTS, facts: cfg.facts(), shortcuts: cfg.shortcuts() });
  ipcMain.handle('cfg:get', () => publicConfig());
  const wakeHandlers = { onWake: p => runtime.emit('wake-detected', p), onStatus: t => { runtime.emit('wake-status', t); if (/^Wake word/.test(t)) runtime.emit('step', { kind: 'err', text: t }); } };
  let wakeTestTimer = null;
  ipcMain.handle('cfg:set', (_e, patch) => { cfg.set(patch); applySettings(); if (wakeLocal.running() && Object.keys(patch || {}).some(k => /^wake/.test(k))) wakeLocal.start(wakeLocal.paramsFrom(cfg.get()), wakeHandlers); return publicConfig(); });
  ipcMain.on('wake:local', (_e, on) => { if (on) wakeLocal.start(wakeLocal.paramsFrom(cfg.get()), wakeHandlers); else wakeLocal.stop(); });
  ipcMain.handle('wake:test', () => { // 25 seconds of listening that also shows what it hears
    clearTimeout(wakeTestTimer);
    wakeLocal.start(wakeLocal.paramsFrom(cfg.get()), { onWake: p => runtime.emit('wake-status', `WAKE WORD HEARD: “${p.phrase}” (${p.confidence.toFixed(2)}) ✔`), onStatus: t => runtime.emit('wake-status', t) }, { test: true });
    wakeTestTimer = setTimeout(() => { wakeLocal.stop(); runtime.emit('wake-status', 'Test finished.'); runtime.emit('wake-test-done'); }, 25000);
    return 'Starting the test… say your wake phrase, and some normal sentences too (25 seconds).';
  });
  ipcMain.handle('cfg:setKey', async (_e, key) => {
    cfg.setKey(key);
    if (!cfg.hasKey()) return { ok: true, config: publicConfig() };
    try { await gemini.refreshModels(); return { ok: true, config: publicConfig() }; }
    catch (e) { return { ok: false, error: e.message, config: publicConfig() }; }
  });
  ipcMain.handle('models:refresh', async () => { try { await gemini.refreshModels(); return { ok: true, config: publicConfig() }; } catch (e) { return { ok: false, error: e.message, config: publicConfig() }; } });
  ipcMain.handle('memory:clear', () => { cfg.removeFacts(''); cfg.removeShortcut(''); return publicConfig(); });
  ipcMain.handle('memory:forget', (_e, { kind, key } = {}) => { if (kind === 'shortcut') cfg.removeShortcutExact(key); else if (kind === 'fact') cfg.removeFactExact(key); return publicConfig(); }); // one item from the Settings list

  ipcMain.handle('live:setup', () => ({
    apiKey: cfg.getKey(), models: gemini.liveModels(), voice: cfg.get().voice,
    systemInstruction: prompts.liveSystem(), tools: tools.declarations('live'), settings: cfg.get()
  }));
  ipcMain.handle('tool:invoke', async (_e, { name, args }) => {
    const out = await tools.invoke(name, args, { scope: 'live' });
    return typeof out === 'string' ? out : out.text;
  });
  ipcMain.handle('wake:check', async (_e, b64) => { try { return await wake.check(b64); } catch (e) { return { wake: false, command: '', error: e.message }; } });
  ipcMain.on('approval:answer', (_e, { id, ok, taskWide, trust }) => runtime.answerApproval(id, ok, taskWide, trust));
  ipcMain.on('stop', () => runtime.stopAll());
  ipcMain.on('theme:set', (_e, t) => orb.setTheme(t)); // the floating orb follows the colours chosen in Settings
  ipcMain.on('rec:chunk', (_e, buf) => transcribe.chunk(buf));
  ipcMain.on('rec:done', () => transcribe.finish().catch(e => logger.log('transcribe', e.stack || e.message)));
  ipcMain.on('rec:error', (_e, m) => transcribe.fail(m)); // recording could not start in the window
  ipcMain.handle('diagnostics:run', () => { require('./diagnostics').run().catch(e => logger.log('diagnostics-crash', e.stack || e.message)); return true; });
  ipcMain.on('orb:level', (_e, p) => orb.update((p && p.mode) || null, Number(p && p.level) || 0));
  ipcMain.on('win:ctl', (_e, action) => {
    if (action === 'minimize') win.minimize();
    else if (action === 'hide') win.hide();
    else if (action === 'quit') { quitting = true; app.quit(); }
  });
}

app.on('second-instance', () => { if (win) showAndType(); });
function safeToggle(source) {
  try { transcribe.toggle(source); }
  catch (e) { runtime.emit('step', { kind: 'err', text: e.message }); try { new (require('electron').Notification)({ title: 'Vision', body: e.message, silent: true }).show(); } catch {} }
}
app.whenReady().then(() => {
  // "system audio" recording: answer the window's request with the speakers' loopback audio
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    require('electron').desktopCapturer.getSources({ types: ['screen'] }).then(src => cb({ video: src[0], audio: 'loopback' })).catch(() => cb({}));
  }, { useSystemPicker: false });
  transcribe.onState(on => { if (tray) tray.setToolTip(on ? 'Vision · recording…' : 'Vision · made by Mostafa Mamdouh'); });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  // First launch of the installed app: turn on "Start with Windows" once (can be switched off in Settings).
  if (!cfg.get().shellDefaultApplied) cfg.set({ allowShell: true, shellDefaultApplied: true });
  if (app.isPackaged && !cfg.get().startupInitialised) cfg.set({ startWithWindows: true, startupInitialised: true });
  wireIpc();
  // The wake listener opens the microphone once, when it starts. After sleep, a screen lock or a device change it can be left listening to nothing, so start it again.
  for (const ev of ['resume', 'unlock-screen']) powerMonitor.on(ev, () => setTimeout(() => { try { wakeLocal.restart(); } catch {} }, 3000));
  createWindow();
  createTray();
  registerShortcuts();
  orb.prewarm();
  applySettings();
  tools.scheduleAll();
  if (startHidden) setTimeout(() => { try { new (require('electron').Notification)({ title: 'Vision is running', body: 'Press Ctrl+Alt+Space to talk to me.', silent: true }).show(); } catch {} }, 4000); // so a quiet login start is not mistaken for "did not start"
  if (process.platform === 'win32') bridge.start().catch(e => { console.warn('PC helper:', e.message); logger.log('helper-start', e.message); runtime.emit('step', { kind: 'err', text: 'PC control helper failed to start (typing and clicking will not work): ' + e.message }); }); // warm up
  if (cfg.hasKey() && (!cfg.getModels().at || Date.now() - cfg.getModels().at > 12 * 3600e3)) gemini.refreshModels().catch(() => {});
});
app.on('before-quit', () => { quitting = true; bridge.stop(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', e => e.preventDefault());
