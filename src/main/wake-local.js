'use strict';
// Local wake word. Runs wake-local.ps1 (Windows' own offline speech recognizer, listening only for a few phrases)
// and turns its output lines into callbacks. No audio leaves the PC and no quota is used.
const { spawn, execFile } = require('child_process');
const path = require('path');
const logger = require('./log');

const THRESHOLDS = { strict: 0.88, normal: 0.75, sensitive: 0.6 };
const DEFAULT_PHRASES = ['hey vision', 'okay vision', 'hey jarvis', 'okay jarvis'];
const scriptPath = () => path.join(__dirname, 'wake-local.ps1').replace('app.asar', 'app.asar.unpacked'); // PowerShell cannot read inside the asar archive

function cleanPhrases(text) {
  const list = String(text || '').split(/[,;\n]/).map(s => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(s => s.length >= 3 && s.length <= 40);
  return [...new Set(list)].slice(0, 8);
}
function paramsFrom(settings) {
  const phrases = cleanPhrases(settings.wakePhrases);
  return { phrases: phrases.length ? phrases : DEFAULT_PHRASES, threshold: THRESHOLDS[settings.wakeSensitivity] ?? THRESHOLDS.normal };
}

let proc = null, stopping = false, fatal = false, params = null, handlers = {}, lastWake = 0, failStreak = 0, retryTimer = null;
const running = () => !!proc;

function onLine(line) {
  const [kind, a, b, c] = line.split('|');
  if (kind === 'READY') { failStreak = 0; handlers.onStatus && handlers.onStatus(`Listening for: ${params.phrases.join(', ')}  (${a})`); }
  else if (kind === 'WAKE') {
    const now = Date.now(); if (now - lastWake < 3000) return; lastWake = now; // one wake per phrase, not one per echo
    handlers.onWake && handlers.onWake({ phrase: a, confidence: Number(b) });
  } else if (kind === 'HEARD') handlers.onStatus && handlers.onStatus(`Heard: “${a}” (${b}${c ? ', ' + c : ''})`);
  else if (kind === 'WARN') { logger.log('wake-local', line); handlers.onStatus && handlers.onStatus(line.slice(5)); }
  else if (kind === 'ERROR') {
    // Only a missing/wrong-language recognizer is permanent. "Could not open the microphone" and other errors are often
    // temporary (the audio service is not ready right after login, a headset is reconnecting), so they must be retried.
    if (/No Windows speech recognizer|only Windows speech recognizer/i.test(line)) fatal = true;
    logger.log('wake-local', line);
    if (fatal || failStreak === 0 || failStreak === 5) handlers.onStatus && handlers.onStatus('Wake word: ' + line.slice(6) + (fatal ? '' : ' (will keep retrying)'));
  }
}
function spawnNow() {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath(), '-Phrases', params.phrases.join(','), '-Threshold', String(params.threshold), '-ParentPid', String(process.pid), '-Test', params.test ? '1' : '0'];
  const p = spawn('powershell.exe', args, { windowsHide: true }); proc = p; let buf = '';
  p.stdout.setEncoding && p.stdout.setEncoding('utf8');
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (line) onLine(line); } });
  p.stderr.on('data', d => logger.log('wake-local', 'stderr: ' + String(d).slice(0, 200)));
  p.on('error', e => { if (proc === p) proc = null; if (e && e.code === 'ENOENT') fatal = true; logger.log('wake-local', 'spawn error: ' + e.message); handlers.onStatus && handlers.onStatus('Wake word: could not start PowerShell (' + e.message + ')'); if (!fatal) scheduleRetry(e.message); });
  p.on('exit', code => { if (proc === p) proc = null; if (stopping || fatal) return; scheduleRetry('code ' + code); });
}
// The listener died by itself: bring it back, waiting longer after each failure (2 s, 4 s, 8 s ... at most 30 s). It never gives up for good.
function scheduleRetry(why) {
  if (stopping || fatal || retryTimer) return;
  const delay = Math.min(30000, 2000 * 2 ** Math.min(failStreak, 4)); failStreak++;
  logger.log('wake-local', `listener closed (${why}); retry ${failStreak} in ${delay} ms`);
  retryTimer = setTimeout(() => { retryTimer = null; if (!stopping && !proc && !fatal) spawnNow(); }, delay);
}
function stop() {
  stopping = true; clearTimeout(retryTimer); retryTimer = null; const p = proc; proc = null;
  if (p) { if (process.platform === 'win32') execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }, () => {}); else { try { p.kill(); } catch {} } }
}
function start(p, h, { test = false } = {}) {
  stop(); stopping = false; fatal = false; lastWake = 0; failStreak = 0;
  params = { ...p, test }; handlers = h || {};
  spawnNow();
}
// True while the listener is supposed to be on (even if it is between retries).
const active = () => !stopping && !!params;
// Start a fresh listener now (after sleep/resume, or when the microphone changed): it binds to the default microphone only once, when it starts.
function restart() { if (!active()) return; start(params, handlers, { test: !!params.test }); }
// For Run diagnostics: which Windows speech recognizers are installed?
function probe() {
  return new Promise(res => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Speech; [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object { $_.Culture.Name }'], { windowsHide: true, timeout: 20000 },
    (err, out) => res(err ? { error: err.message, cultures: [] } : { cultures: String(out).split(/\r?\n/).map(s => s.trim()).filter(Boolean) })));
}
module.exports = { start, stop, running, active, restart, probe, cleanPhrases, paramsFrom, THRESHOLDS };
