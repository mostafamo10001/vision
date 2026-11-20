'use strict';
// Self-test: checks each capability Vision relies on and reports plain results in the log.
const { execFile } = require('child_process');
const os = require('os');
const { app, clipboard } = require('electron');
const logger = require('./log');
const capture = require('./capture');
const bridge = require('./ps-bridge');
const gemini = require('./gemini');
const cfg = require('./config');
const runtime = require('./runtime');
const startup = require('./startup');
const vision = require('./vision');
const fs = require('fs');
const path = require('path');

const say = (ok, text) => runtime.emit('step', { kind: ok ? 'sys' : 'err', text: (ok ? 'OK: ' : 'FAIL: ') + text });
const isAdmin = () => new Promise(res => execFile('net.exe', ['session'], { windowsHide: true }, err => res(!err)));

async function run() {
  const lines = [];
  const check = async (label, fn) => {
    const t0 = Date.now();
    try { const info = await fn(); const m = `${label}${info ? ': ' + info : ''} (${Date.now() - t0} ms)`; say(true, m); lines.push('OK ' + m); }
    catch (e) { const m = `${label}: ${e.message}`; say(false, m); lines.push('FAIL ' + m); }
  };
  runtime.emit('step', { kind: 'info', text: 'Running diagnostics…' });

  await check('API key', async () => { if (!cfg.hasKey()) throw new Error('no key saved'); return 'saved'; });
  await check('Model list', async () => { const m = await gemini.refreshModels(); return `vision=${m.fast || '?'}, planner=${m.worker || '?'}, voice=${m.live || '?'}`; });
  await check('Saved memory', async () => `${cfg.facts().length} facts, ${Object.keys(cfg.shortcuts()).length} shortcuts, ${cfg.reminders().length} reminders (file: ${cfg.configPath()})`);
  if (process.platform === 'win32') await check('Start with Windows', () => startup.report(process.execPath));
  await check('Screen capture', async () => { const s = await capture.capture(); if (!s.data || s.data.length < 2000) throw new Error('capture was empty/black'); return `${s.size.width}x${s.size.height}`; });
  await check('Gemini vision model', async () => {
    const shot = await capture.capture({ maxEdge: 512 });
    const res = await gemini.generate('fast', { contents: [{ role: 'user', parts: [{ text: 'Reply with one short sentence describing this screenshot.' }, { inlineData: { mimeType: shot.mime, data: shot.data } }] }] }, { onSwitch: (m, e) => { const t = `Skipped model ${m}: ${e.message.slice(0, 110)}`; runtime.emit('step', { kind: 'info', text: t }); lines.push('NOTE ' + t); } });
    return `answered by ${res._model}`;  // what it saw is deliberately not included
  });
  await check('Local wake word', async () => {
    const s = cfg.get(); if (!s.wakeWord) return 'off (optional)';
    if (s.wakeEngine === 'cloud') return 'using the cloud engine (Gemini)';
    const r = await require('./wake-local').probe();
    if (!r.cultures.length) throw new Error(r.error || 'no Windows speech recognizer installed (Settings > Time & language > Speech)');
    if (!r.cultures.some(c => /^en-/i.test(c))) throw new Error('only ' + r.cultures.join(', ') + ' installed; the wake phrases need English (United States) speech');
    return 'Windows speech recognition ready: ' + r.cultures.join(', ');
  });
  await check('Screen targeting (finding things to click)', () => vision.selfTest());
  if (process.platform === 'win32') {
    await check('PC helper (typing, clicks, windows)', async () => { await bridge.call('ping', {}, 35000); const w = await bridge.call('active_window'); return w && w.title ? 'running' : 'running (no active window)'; });
    await check('Volume control (change, read back, restore)', async () => {
      const c = await bridge.call('volume', { action: 'get' });
      if (!(c.level >= 0)) throw new Error('could not read the volume');
      const t = c.level >= 50 ? c.level - 6 : c.level + 6;
      const s = await bridge.call('volume', { action: 'set', level: t });
      const back = await bridge.call('volume', { action: 'get' });
      await bridge.call('volume', { action: 'set', level: c.level });
      if (Math.abs(back.level - t) > 2) throw new Error(`asked for ${t}% but Windows reports ${back.level}% (via ${s.via || '?'}${s.why ? ': ' + s.why : ''})`);
      return `works (via ${s.via || 'com'})`;
    });
    await check('Keyboard input', async () => { await bridge.call('keys', { combo: 'shift' }); return 'key events accepted'; });
    await check('Administrator rights', async () => ((await isAdmin()) ? 'Vision runs as administrator' : 'standard user (cannot control admin-level windows)'));
  }

  // ---- every tool that is safe to run on its own (read-only), run exactly as the voice model would ----
  const tools = require('./tools'); // loaded lazily: tools.js also requires this file
  const TOOL_TESTS = [
    ['system_status', {}], ['list_windows', {}], ['set_volume', { action: 'get' }], ['clipboard', { action: 'get' }],
    ['list_directory', { path: 'desktop' }], ['search_files', { query: 'a', folder: 'downloads' }], ['list_processes', {}],
    ['list_reminders', {}], ['current_time', {}], ['todo', { action: 'list' }], ['calculate', { expression: '12*(3+4)' }], ['network_status', {}], ['list_bookmarks', {}], ['ui_list', {}], ['fetch_webpage', { url: 'https://example.com' }],
    ['web_lookup', { query: 'what is the date today' }], ['set_brightness', {}, 'only works on laptop / built-in displays']
  ];
  const SHOW_RESULT = new Set(['system_status', 'set_volume', 'list_reminders', 'current_time', 'calculate']); // everything else may contain personal names, so only OK/FAIL is shown
  for (const [name, args, soft] of TOOL_TESTS) {
    const t0 = Date.now();
    try {
      const out = await Promise.race([tools.invoke(name, args, { scope: 'live', quiet: true }), new Promise(r => setTimeout(() => r('ERROR: no answer after 25 s'), 25000))]);
      const text = String(typeof out === 'string' ? out : (out && out.text) || '');
      const ms = Date.now() - t0;
      if (/^ERROR/.test(text)) {
        if (soft) { say(true, `${name}: not available (${soft})`); lines.push(`NOTE ${name}: not available (${soft}) - ${text.slice(0, 100)}`); }
        else { say(false, `${name}: ${text.slice(6).trim().slice(0, 200)}`); lines.push(`FAIL tool ${name}: ${text.slice(0, 300)}`); }
      } else { say(true, `${name} (${ms} ms)`); lines.push(`OK tool ${name} (${ms} ms)${SHOW_RESULT.has(name) ? ': ' + text.replace(/\s+/g, ' ').slice(0, 70) : ''}`); }
    } catch (e) { say(false, `${name}: ${e.message}`); lines.push(`FAIL tool ${name}: ${e.message}`); }
  }

  const failed = lines.filter(l => l.startsWith('FAIL')).length;
  const report = [
    `Vision diagnostics report - ${new Date().toISOString()}`,
    `App ${app.getVersion()} | Electron ${process.versions.electron} | Windows ${os.release()} (${os.arch()}) | ${failed} failure(s)`,
    '', ...lines, '', 'Recent errors from the log:', logger.tail(25)
  ].join('\n');
  try { fs.writeFileSync(path.join(logger.dir(), 'diagnostics.txt'), report); } catch {}
  try { Promise.resolve(clipboard.writeText(report)).catch(() => {}); } catch {} // async since Electron 44, sync before
  logger.log('diagnostics', `${failed} failure(s)`);
  runtime.emit('step', { kind: failed ? 'err' : 'sys', text: failed ? `${failed} check(s) failed. The full report is copied to your clipboard: paste it into the chat.` : 'Everything passed. The report is copied to your clipboard.' });

  runtime.emit('step', { kind: 'info', text: 'Diagnostics finished.' });
  return report;
}
module.exports = { run };
