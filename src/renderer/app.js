import { LiveClient } from './live.js';
import { WakeListener } from './wake.js';
import { Recorder } from './recorder.js';
import { isMultiStepCall, shouldContinue, continueText } from './steps.js';
import { drawOrb } from './orbdraw.js';
import { voiceCommand, approvalCommand, denyCommand, transcribeCommand } from './commands.js';

const $ = id => document.getElementById(id);
const J = window.jarvis;
const recorder = new Recorder(buf => J.recChunk(buf)); // dictation / system-audio recording (no voice session involved)
const VOICES = ['Charon', 'Puck', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr', 'Algenib', 'Sulafat', 'Gacrux', 'Achird'];

let cfg = null, live = null, connecting = false, reconnecting = false;
let manualHold = false, holdRetries = 0; // manualHold: started with the mic button/hotkey, so it stays open until you stop it
let activity = { state: 'idle' }, errorUntil = 0;
let curUser = null, curAsst = null, lastActivity = Date.now();
const approvals = [];
let lastWakeError = 0;
const wake = new WakeListener({
  check: async b64 => { const r = await J.wakeCheck(b64); if (r && r.error) throw new Error(r.error); if (r && !r.wake) addStep('sys', 'Heard: “' + (r.heard || '…') + '” (no wake word)'); return r; }, // surface API errors instead of failing silently
  onWake: ({ command }) => {
    addStep('sys', 'Wake word heard.');
    if (command) addMsg('user', command);
    if (command) { reqBuf = command; lastUserTextAt = Date.now(); }
    startListening(command || null, { fromWake: true });
  },
  onError: e => { if (Date.now() - lastWakeError > 30000) { lastWakeError = Date.now(); addStep('err', 'Wake word check failed: ' + e.message); } }
});
function tones(notes) { // [[frequencyHz, startSec, durationSec], ...]
  try {
    const c = new AudioContext(), now = c.currentTime;
    for (const [f, at, dur] of notes) {
      const o = c.createOscillator(), gn = c.createGain();
      o.type = 'sine'; o.frequency.value = f;
      gn.gain.setValueAtTime(0.0001, now + at); gn.gain.exponentialRampToValueAtTime(0.16, now + at + 0.02); gn.gain.exponentialRampToValueAtTime(0.0001, now + at + dur);
      o.connect(gn); gn.connect(c.destination); o.start(now + at); o.stop(now + at + dur + 0.05);
    }
    setTimeout(() => c.close(), (Math.max(...notes.map(n => n[1] + n[2])) + 0.3) * 1000);
  } catch {}
}
const startChime = () => tones([[659, 0, 0.14], [988, 0.11, 0.22]]);   // rising: voice session started
let lastEndChime = 0;
const endChime = () => { if (Date.now() - lastEndChime < 800) return; lastEndChime = Date.now(); tones([[880, 0, 0.14], [587, 0.11, 0.26]]); }; // falling: session ended
function chime() {
  try {
    const c = new AudioContext(), o = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(660, c.currentTime); o.frequency.exponentialRampToValueAtTime(990, c.currentTime + 0.12);
    g.gain.setValueAtTime(0.0001, c.currentTime); g.gain.exponentialRampToValueAtTime(0.18, c.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.22);
    o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime + 0.25); setTimeout(() => c.close(), 400);
  } catch {}
}
let localWakeOn = false;
async function syncWake() { // keep the wake listener running exactly when it should be
  const want = !!cfg && cfg.hasKey && cfg.settings.wakeWord && !cfg.settings.handsFree && !live && !connecting && !recorder.active;
  if (cfg && cfg.settings.wakeEngine !== 'cloud') { // local engine: the main process runs Windows' own speech recognizer, nothing is sent to Gemini
    if (wake.running) wake.stop();
    if (want !== localWakeOn) { localWakeOn = want; J.localWake(want); }
    return;
  }
  if (localWakeOn) { localWakeOn = false; J.localWake(false); }
  if (want && !wake.running) {
    try { await wake.start(); } catch (e) { showError('Wake word needs microphone access: ' + e.message); }
  } else if (!want && wake.running && !connecting) wake.stop();
}

// ---------------- log ----------------
const logEl = $('log');
function scroll() { logEl.scrollTop = logEl.scrollHeight; }
function trim() { while (logEl.children.length > 250) logEl.firstChild.remove(); }
function addMsg(role, text) { const d = document.createElement('div'); d.className = 'msg ' + role; d.textContent = text; logEl.appendChild(d); trim(); scroll(); return d; }
function addStep(kind, text) { const d = document.createElement('div'); d.className = 'step ' + kind; d.textContent = text; logEl.appendChild(d); trim(); scroll(); }
function showError(e) { errorUntil = Date.now() + 4000; addStep('err', typeof e === 'string' ? e : e.message); }

// ---------------- state + orb ----------------
const COLORS = { armed: '#6f82e8', idle: '#7c8cff', connecting: '#8b9aab', listening: '#3de0d0', speaking: '#f6c252', acting: '#8c9eff', error: '#ff6b6b', thinking: '#a78bfa' };
const LABELS = { armed: 'Say “Hey Vision”', idle: 'Standing by', connecting: 'Connecting…', listening: 'Listening', speaking: 'Speaking', acting: 'Working…', error: 'Something went wrong', thinking: 'Thinking…' };

let awaiting = 0, lastUserTextAt = 0, turnDoneAt = 0;
let reqBuf = '', turnToolCount = 0, usedMulti = false, lastToolAt = 0, continued = false; // what the user asked, and how much of it has been acted on // awaiting = when we started waiting for Vision to answer
function uiState() {
  if (Date.now() < errorUntil) return 'error';
  if (connecting || reconnecting) return 'connecting';
  if (activity.state === 'acting' || live?.busy) return 'acting';
  if (live?.speaking) return 'speaking';
  // between you finishing a sentence (or a tool finishing) and Vision' first spoken word
  if (live && awaiting && Date.now() - awaiting < 20000 && Date.now() - lastUserTextAt > 900 && live.micLevel < 0.05) return 'thinking';
  if (live) return 'listening';
  if (wake.running) return 'armed';
  return 'idle';
}
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
let rgb = hex(COLORS.idle), lvl = 0, W = 0, H = 0;
const canvas = $('orb'), g = canvas.getContext('2d');
function resize() { const r = canvas.getBoundingClientRect(), d = devicePixelRatio || 1; canvas.width = r.width * d; canvas.height = r.height * d; g.setTransform(d, 0, 0, d, 0, 0); W = r.width; H = r.height; }
new ResizeObserver(resize).observe(canvas); resize();

let shown = '';
function frame(t) {
  const st = uiState();
  const target = st === 'listening' ? Math.min(1, (live?.micLevel || 0) * 7) : st === 'speaking' ? live.outLevel()
    : st === 'acting' ? 0.35 + 0.15 * Math.sin(t / 180) : st === 'thinking' ? 0.22 + 0.10 * Math.sin(t / 260) : st === 'idle' ? 0.06 + 0.04 * Math.sin(t / 900)
    : st === 'armed' ? 0.06 + 0.04 * Math.sin(t / 900) + Math.min(0.25, wake.level * 3) : 0.12;
  lvl += (target - lvl) * 0.2;
  const goal = hex(COLORS[st]); rgb = rgb.map((v, i) => v + (goal[i] - v) * 0.12);
  g.clearRect(0, 0, W, H);
  drawOrb(g, W, H, t, { rgb, lvl, mode: st, cx: W / 2, cy: H / 2 - 4, R: Math.min(46, H * 0.21) });

  if (st !== shown) {
    shown = st;
    $('dot').style.background = COLORS[st]; $('dot').style.boxShadow = `0 0 10px ${COLORS[st]}`;
    $('hint').style.opacity = live ? 0 : 1;
    $('hint').innerHTML = st === 'armed' ? 'Say <b>“Hey Vision”</b> or <b>“Okay Vision”</b> · or press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Space</kbd>' : 'Press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Space</kbd> or tap the mic';
  }
  $('status').textContent = st === 'acting' && activity.text ? activity.text : LABELS[st];
  schedule();
}
// Draw only when the window is actually on screen: full speed while it is the window you are using, a slow trickle while it is
// visible but in the background, and nothing at all while it is hidden, minimized or closed to the tray.
let rafId = 0, slowId = 0;
function visualMode() { return document.hidden ? 'off' : document.hasFocus() ? 'full' : 'slow'; }
function schedule() {
  if (rafId || slowId) return;
  const m = visualMode();
  if (m === 'full') rafId = requestAnimationFrame(t => { rafId = 0; frame(t); });
  else if (m === 'slow') slowId = setTimeout(() => { slowId = 0; frame(performance.now()); }, 200);
}
function resetSchedule() { cancelAnimationFrame(rafId); clearTimeout(slowId); rafId = slowId = 0; schedule(); }
document.addEventListener('visibilitychange', resetSchedule);
window.addEventListener('focus', resetSchedule);
window.addEventListener('blur', resetSchedule);
schedule();

// ---------------- voice session ----------------
// Saying a short "stop" while Vision is working must work even though the voice model is blocked waiting for its tool:
// the server still sends us a transcript of what you say, so we watch it locally.
const STOP_WORDS = /\b(stop|cancel|abort|enough|never\s?mind|forget\s+it)\b|قف|وقف|توقف|كفاية|كفى|الغي|ألغي|إلغاء|الغاء/i;
let heardRecent = '', heardAt = 0, stopCooldown = 0;
// "stop all tasks": everything stops right now (running tasks, approvals, speech), no matter what state Vision is in.
function hardStop(why) {
  addStep('sys', `Stopped everything (${why}).`);
  live?.stopTools(); live?.player?.flush(); speechSynthesis.cancel();
  J.stopAll();
}
function voiceStopCheck(t) {
  const now = Date.now();
  if (now - heardAt > 2500) heardRecent = '';
  heardAt = now; heardRecent = (heardRecent + t).slice(-120);
  if (now >= stopCooldown) {
    const cmd = voiceCommand(heardRecent);
    if (cmd) {
      stopCooldown = now + 2500; heardRecent = '';
      if (cmd === 'stop_all') hardStop('you said “stop all”');
      else stopListening('Stopped listening (you said “stop listening”).');
      return;
    }
  }
  if (now < stopCooldown || !live || !(live.busy || activity.state === 'acting')) return;
  const words = heardRecent.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 5 && STOP_WORDS.test(heardRecent)) {
    stopCooldown = now + 2500; heardRecent = '';
    addStep('sys', 'Stopped (heard “stop”).');
    live.stopTools(); J.stopAll();
  }
}
// Spoken answer: while an action is waiting, "I approve" / "this task is approved" approves it and "I deny" / "decline" / "I don't approve" refuses it, like the buttons.
let approvalHeard = '', approvalAt = 0, approvalCooldown = 0;
function voiceApprovalCheck(t) {
  if (!approvals.length) { approvalHeard = ''; return; }
  const now = Date.now();
  if (now - approvalAt > 4000) approvalHeard = '';
  approvalAt = now; approvalHeard = (approvalHeard + ' ' + t).slice(-160);
  if (now < approvalCooldown) return;
  const cmd = approvalCommand(approvalHeard) || (denyCommand(approvalHeard) ? 'deny' : null);
  if (!cmd) return;
  approvalCooldown = now + 3000; approvalHeard = '';
  const a = approvals[0];
  if (cmd === 'deny') { addStep('sys', 'Denied (you said so).'); J.answerApproval(a.id, false, false, false); return; }
  addStep('sys', cmd === 'approve_task' ? 'Approved (you said so) for this task.' : 'Approved (you said so).');
  J.answerApproval(a.id, true, cmd === 'approve_task', false);
}
function updateMic() { $('btn-mic').classList.toggle('on', !!live || connecting); }

let pendingClient = null; // the voice client that is still connecting, so that Stop can cancel it
async function startListening(pendingText, opts = {}) {
  if (live || connecting) { if (pendingText && live) live.sendText(pendingText); return; }
  if (!cfg.hasKey) { openSettings(true); return; }
  connecting = true; updateMic();
  if (!opts.auto) holdRetries = 0;
  manualHold = !opts.fromWake && cfg.settings.holdOpen !== false;
  if (!opts.fromWake) wake.stop();
  let client = null;
  try {
    const s = await J.liveSetup();
    client = new LiveClient({ apiKey: s.apiKey, models: s.models, voice: s.voice, systemInstruction: s.systemInstruction, tools: s.tools, halfDuplex: !!s.settings.halfDuplex,
      silenceMs: Math.round(Math.min(6, Math.max(0.3, Number(s.settings.silenceWaitSec) || 2.5)) * 1000),
      getPreroll: (opts.fromWake && !opts.local) ? () => { const b = wake.takeBacklog(); wake.stop(); return b; } : null }, {
      onUser: t => { if (Date.now() - lastUserTextAt > 4000) { reqBuf = ''; turnToolCount = 0; usedMulti = false; continued = false; } reqBuf = (reqBuf + t).slice(-600); voiceStopCheck(t); voiceApprovalCheck(t); lastActivity = Date.now(); lastUserTextAt = Date.now(); if (!live?.speaking && Date.now() - turnDoneAt > 1500) awaiting = Date.now(); /* late transcripts must not restart thinking */ if (!curUser) { curUser = addMsg('user', ''); curAsst = null; } curUser.textContent += t; scroll(); },
      onAssistant: t => { lastActivity = Date.now(); awaiting = 0; if (!curAsst) { curAsst = addMsg('assistant', ''); curUser = null; } curAsst.textContent += t; scroll(); },
      onTurnComplete: () => {
        curUser = null; curAsst = null; awaiting = 0; turnDoneAt = Date.now();
        // safety net: it finished its turn after part one of a multi-part request, so tell it once to carry on
        if (live && shouldContinue({ toolCount: turnToolCount, usedMulti, continued, request: reqBuf, sinceToolMs: Date.now() - lastToolAt })) {
          continued = true; addStep('sys', 'Continuing with the rest of your request…'); live.sendText(continueText(reqBuf));
        }
      },
      onInterrupted: () => { curAsst = null; awaiting = 0; },
      onAudio: () => { lastActivity = Date.now(); awaiting = 0; },
      onTool: calls => { lastActivity = Date.now(); curUser = null; awaiting = Date.now(); turnToolCount += (calls || []).length; if ((calls || []).some(isMultiStepCall)) usedMulti = true; lastToolAt = Date.now(); },
      lastRequest: () => reqBuf,
      // start_transcription only runs if the user's own words contain "transcribe" / "start transcribing" (the spoken text can arrive a moment after the tool call, so wait briefly)
      allowTool: async name => { if (name !== 'start_transcription') return true; for (let i = 0; i < 6; i++) { if (transcribeCommand(reqBuf)) return true; await new Promise(r => setTimeout(r, 300)); } return false; },
      onState: st => { reconnecting = st === 'reconnecting'; },
      onModel: (m, lean) => addStep('sys', `Connected (${m})${lean ? ' in basic mode: the silence-wait setting is not supported by this model' : ''}`),
      onClose: reason => { const was = !!live, wasHold = manualHold; manualHold = false; live = null; reconnecting = false; awaiting = 0; curUser = curAsst = null; showError(reason); updateMic(); syncWake(); if (was) endChime();
        if (was && wasHold && holdRetries < 3) { holdRetries++; addStep('sys', 'Connection dropped. Reconnecting…'); setTimeout(() => startListening(undefined, { auto: true }), 1500); } } // keep-listening mode: come back by itself
    });
    pendingClient = client;
    await client.connect();
    if (client.closing) return; // the user pressed stop while it was connecting: do not start a session they cancelled
    live = client; lastActivity = Date.now(); startChime(); setTimeout(() => { holdRetries = 0; }, 60000);
    if (pendingText) live.sendText(pendingText);
  } catch (e) {
    const cancelled = !!client?.closing && /Cancelled/.test(e.message);
    client?.close(); live = null; wake.rearm();
    if (cancelled) return;
    const m = /Permission|NotAllowed|NotFound|Requested device/i.test(e.name + ' ' + e.message) ? 'Microphone unavailable: allow microphone access in Windows privacy settings.' : e.message;
    showError('Could not start voice: ' + m);
  } finally { if (pendingClient === client) pendingClient = null; connecting = false; updateMic(); syncWake(); }
}
function stopListening(msg, silent) {
  const was = !!live, busy = !!(live && live.busy);
  manualHold = false; // a deliberate stop must never trigger the auto-reconnect
  if (pendingClient) { pendingClient.close(); pendingClient = null; } // stop pressed while still connecting
  if (busy) J.stopAll(); // a tool call still waiting for approval would otherwise outlive this session
  live?.close(); live = null; awaiting = 0; curUser = curAsst = null; updateMic(); syncWake();
  if (was && !silent) endChime();
  if (msg) addStep('sys', msg);
}
const toggleListening = () => (live || connecting ? stopListening('Stopped listening.') : startListening());

$('btn-mic').onclick = toggleListening;
$('btn-stop').onclick = () => J.stopAll();
$('composer').onsubmit = e => {
  e.preventDefault();
  const t = $('text').value.trim(); if (!t) return;
  const cmd = voiceCommand(t, { whole: true }); // typed "stop all tasks" / "stop listening" act instantly too
  if (cmd) { $('text').value = ''; addMsg('user', t); if (cmd === 'stop_all') hardStop('typed command'); else stopListening('Stopped listening.'); return; }
  $('text').value = ''; addMsg('user', t); curUser = null; lastActivity = Date.now();
  reqBuf = t; turnToolCount = 0; usedMulti = false; continued = false; lastUserTextAt = Date.now();
  live ? live.sendText(t) : startListening(t);
};

setInterval(() => { // sleep after silence
  if (!live || manualHold || cfg.settings.handsFree || live.speaking || live.busy || activity.state === 'acting') return;
  if (Date.now() - lastActivity > (cfg.settings.idleDisconnectSec || 120) * 1000) stopListening('Going to sleep. Press the mic or Ctrl+Alt+Space to wake me.');
}, 4000);

// ---------------- events from the main process ----------------
J.on('toggle-listening', toggleListening);
J.on('focus-input', () => { if ($('settings').hidden && $('approval').hidden) setTimeout(() => $('text').focus(), 60); }); // Ctrl+Alt+V / tray: start typing at once
J.on('stopped', () => { live?.stopTools(); live?.player?.flush(); activity = { state: 'idle' }; addStep('sys', 'Stopped.'); });
// ---- transcription: the main process says when to start/stop recording ----
J.on('transcribe-start', async ({ source }) => {
  try {
    await recorder.start(source);
    startChime(); syncWake();
    // the voice chat would try to answer the dictation, so it ends a moment after recording starts
    setTimeout(() => { if (live || connecting) stopListening('Voice chat ended while recording.', true); }, 2500);
  } catch (e) {
    const m = /Permission|NotAllowed|NotFound|Requested device/i.test(e.name + ' ' + e.message) ? 'Microphone or system audio unavailable: check Windows privacy settings.' : (e.message || String(e));
    J.recError(m);
  }
});
J.on('transcribe-stop', () => { recorder.stop(); J.recDone(); endChime(); syncWake(); });
J.on('step', s => addStep(s.kind || 'info', s.text));
J.on('activity', a => { activity = a; });
J.on('reminder', msg => {
  addStep('info', 'Reminder: ' + msg);
  if (live) live.sendText(`[System notice] A reminder you set just fired: "${msg}". Tell the user briefly.`);
  else speechSynthesis.speak(new SpeechSynthesisUtterance('Reminder: ' + msg));
});

// ---------------- approvals ----------------
function renderApproval() {
  const a = approvals[0];
  $('approval').hidden = !a;
  if (!a) { speechSynthesis.cancel(); return; }
  $('approval-desc').textContent = a.desc;
  $('ap-task').hidden = !a.canTaskWide;
  $('ap-trust').hidden = !a.shell;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance('Approval needed. ' + a.desc.slice(0, 140)));
}
J.on('approval:request', a => { approvals.push(a); renderApproval(); });
J.on('approval:close', id => { const i = approvals.findIndex(a => a.id === id); if (i >= 0) approvals.splice(i, 1); renderApproval(); });
$('ap-yes').onclick = () => approvals[0] && J.answerApproval(approvals[0].id, true, false);
$('ap-no').onclick = () => approvals[0] && J.answerApproval(approvals[0].id, false, false);
$('ap-task').onclick = () => approvals[0] && J.answerApproval(approvals[0].id, true, true);
$('ap-trust').onclick = () => approvals[0] && J.answerApproval(approvals[0].id, true, false, true);

// ---------------- settings ----------------
function openSettings(setup) { $('setup-note').hidden = !setup; $('settings').hidden = false; fillSettings(); }
$('btn-settings').onclick = () => openSettings(false);
$('settings-close').onclick = () => { $('settings').hidden = true; };
$('btn-min').onclick = () => J.windowControl('minimize');
$('btn-hide').onclick = () => J.windowControl('hide');
$('s-diag').onclick = () => { $('settings').hidden = true; J.runDiagnostics(); };
$('s-quit').onclick = () => J.windowControl('quit');

function fillSelect(sel, current, list, autoLabel) {
  sel.innerHTML = '';
  const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); };
  add('auto', autoLabel);
  for (const m of new Set([...(list || []), ...(current && current !== 'auto' ? [current] : [])])) add(m, m);
  sel.value = current;
}
// ---- colour themes ----
const PRESETS = { vision: ['#7c8cff', '#f6c252', '#3de0d0'], ocean: ['#38bdf8', '#fbbf24', '#34d399'], emerald: ['#34d399', '#fde047', '#22d3ee'], crimson: ['#f43f5e', '#fbbf24', '#fb923c'], mono: ['#cbd5e1', '#ffffff', '#94a3b8'] };
const hexRgb = h => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgbHex = c => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const themeColors = s => PRESETS[s.themePreset] || [s.themeAccent || PRESETS.vision[0], s.themeGold || PRESETS.vision[1], s.themeListen || PRESETS.vision[2]];
function applyTheme(s) {
  const [a, g, l] = themeColors(s).map((h, i) => hexRgb(h) || hexRgb(PRESETS.vision[i]));
  const root = document.documentElement.style, lighten = (c, k) => c.map(v => v + (255 - v) * k);
  root.setProperty('--accent-rgb', a.join(',')); root.setProperty('--gold-rgb', g.join(','));
  Object.assign(COLORS, { idle: rgbHex(a), armed: rgbHex(a.map(v => v * 0.85)), acting: rgbHex(lighten(a, 0.2)), thinking: rgbHex(lighten(a, 0.4)), speaking: rgbHex(g), listening: rgbHex(l) });
  J.setTheme({ speaking: g, thinking: lighten(a, 0.4) });
  shown = ''; // makes the next frame repaint the status dot and label in the new colours
}
$('s-themePreset').addEventListener('change', async e => { const p = e.target.value, c = PRESETS[p]; await patch(c ? { themePreset: p, themeAccent: c[0], themeGold: c[1], themeListen: c[2] } : { themePreset: 'custom' }); fillSettings(); });
for (const k of ['themeAccent', 'themeGold', 'themeListen']) $('s-' + k).addEventListener('input', async e => { await patch({ themePreset: 'custom', [k]: e.target.value }); $('s-themePreset').value = 'custom'; });
// ---- local wake word ----
J.on('wake-detected', ({ phrase }) => { if (live || connecting || recorder.active) return; addStep('sys', `Wake word heard: “${phrase}”.`); localWakeOn = false; J.localWake(false); /* free the microphone for the session */ startListening(null, { fromWake: true, local: true }); });
// Microphone plugged/unplugged or switched, or the network came back: the Windows listener only binds to the microphone when it starts.
let devTimer = null;
try { navigator.mediaDevices.addEventListener('devicechange', () => { clearTimeout(devTimer); devTimer = setTimeout(() => { if (localWakeOn) J.localWake(true); }, 1500); }); } catch {}
window.addEventListener('online', () => { live?.nudge(); if (localWakeOn) J.localWake(true); });
J.on('wake-status', t => { $('w-status').textContent = t; });
J.on('wake-test-done', () => { localWakeOn = false; syncWake(); });
$('w-test').onclick = async () => { $('w-status').textContent = await J.wakeTest(); };

function fillSettings() {
  const s = cfg.settings, m = cfg.models || {};
  $('s-autonomy').value = s.autonomy;
  $('s-userName').value = s.userName || '';
  $('s-excludeModels').value = s.excludeModels || '';
  for (const k of ['wakeEngine', 'wakePhrases', 'wakeSensitivity']) $('s-' + k).value = s[k] || '';
  $('s-shellMaxCommands').value = s.shellMaxCommands ?? 10;
  $('s-themePreset').value = s.themePreset || 'vision'; for (const k of ['themeAccent', 'themeGold', 'themeListen']) $('s-' + k).value = themeColors(s)[k === 'themeAccent' ? 0 : k === 'themeGold' ? 1 : 2];
  for (const k of ['wakeWord', 'handsFree', 'halfDuplex', 'allowShell', 'shellNoAsk', 'holdOpen', 'alwaysOnTop', 'hideFromCapture', 'startWithWindows']) $('s-' + k).checked = !!s[k];
  $('s-silenceWaitSec').value = s.silenceWaitSec; $('s-maxSteps').value = s.maxSteps; $('s-idleDisconnectSec').value = s.idleDisconnectSec;
  const v = $('s-voice'); v.innerHTML = ''; VOICES.forEach(n => { const o = document.createElement('option'); o.value = o.textContent = n; v.appendChild(o); }); v.value = VOICES.includes(s.voice) ? s.voice : VOICES[0];
  fillSelect($('s-liveModel'), s.liveModel, m.allLive, `Auto${m.live ? ' (' + m.live + ')' : ''}`);
  fillSelect($('s-workerModel'), s.workerModel, m.allGenerate, `Auto${m.worker ? ' (' + m.worker + ')' : ''}`);
  fillSelect($('s-fastModel'), s.fastModel, m.allGenerate, `Auto${m.fast ? ' (' + m.fast + ')' : ''}`);
  $('s-key').placeholder = cfg.hasKey ? '•••••••• saved (paste a new key to replace)' : 'AIza…';
  const f = $('facts'); f.innerHTML = '';
  const sc = Object.entries(cfg.shortcuts || {});
  if (!cfg.facts.length && !sc.length) f.textContent = 'Nothing saved yet. Say "remember that…" to teach Vision.';
  const factRow = (label, onForget) => { // every remembered item has its own × so one thing can be forgotten without wiping the rest
    const d = document.createElement('div'), s = document.createElement('span'), b = document.createElement('button');
    d.className = 'fact'; s.textContent = label; b.className = 'x'; b.textContent = '×'; b.title = 'Forget this'; b.setAttribute('aria-label', 'Forget this');
    b.onclick = async () => { cfg = await onForget(); fillSettings(); };
    d.append(s, b); f.appendChild(d);
  };
  sc.forEach(([k, v]) => factRow('• shortcut: ' + k + ' → ' + v, () => J.forgetItem('shortcut', k)));
  cfg.facts.forEach(t => factRow('• ' + t, () => J.forgetItem('fact', t)));
}
async function patch(p) { cfg = await J.setConfig(p); applyTheme(cfg.settings); syncWake(); }
const binds = { silenceWaitSec: v => Math.min(6, Math.max(0.3, Number(v) || 2.5)), autonomy: v => v, userName: v => v.trim(), excludeModels: v => v.trim(), wakeEngine: v => v, wakePhrases: v => v.trim(), wakeSensitivity: v => v, maxSteps: Number, shellMaxCommands: v => Math.max(1, Math.min(50, Math.round(Number(v)) || 10)), idleDisconnectSec: Number, voice: v => v, liveModel: v => v, workerModel: v => v, fastModel: v => v };
for (const [k, fn] of Object.entries(binds)) $('s-' + k).addEventListener('change', e => patch({ [k]: fn(e.target.value) }));
for (const k of ['wakeWord', 'handsFree', 'halfDuplex', 'allowShell', 'shellNoAsk', 'holdOpen', 'alwaysOnTop', 'hideFromCapture', 'startWithWindows']) $('s-' + k).addEventListener('change', e => patch({ [k]: e.target.checked }));

$('s-key-save').onclick = async () => {
  const msg = $('s-key-msg'); msg.textContent = 'Checking…';
  const r = await J.setApiKey($('s-key').value); cfg = r.config; $('s-key').value = '';
  msg.textContent = r.ok ? (cfg.hasKey ? 'Key saved and verified.' : 'Key removed.') : 'Saved, but: ' + r.error;
  fillSettings();
  if (r.ok && cfg.hasKey) { $('setup-note').hidden = true; addStep('sys', 'Ready. Tap the mic and say hello.'); }
};
$('s-refresh').onclick = async () => {
  $('s-refresh-msg').textContent = 'Loading…';
  const r = await J.refreshModels(); cfg = r.config; $('s-refresh-msg').textContent = r.ok ? 'Updated.' : r.error; fillSettings();
};
$('s-clear-mem').onclick = async () => { cfg = await J.clearMemory(); fillSettings(); };

// ---------------- boot ----------------
(async () => {
  cfg = await J.getConfig(); applyTheme(cfg.settings);
  if (!cfg.hasKey) { addMsg('assistant', 'Good to meet you. I need a Gemini API key to get started.'); openSettings(true); }
  else addMsg('assistant', 'Standing by. Say “Hey Vision”, tap the mic, or press Ctrl+Alt+Space, then just tell me what to do.');
  syncWake();
})();

// Tell the main process when Vision is speaking or thinking so it can show the on-screen orb while this window is hidden.
// (setInterval, not requestAnimationFrame: animation frames pause when the window is hidden.)
let orbWasOn = false;
function orbTick() {
  if (live && live.micLevel > 0.06) lastActivity = Date.now();
  const st = uiState();
  const mode = st === 'speaking' ? 'speaking' : (st === 'thinking' || st === 'acting') ? 'thinking' : null;
  if (mode) { J.orb(mode, mode === 'speaking' && live ? live.outLevel() : 0); orbWasOn = true; }
  else if (orbWasOn) { J.orb(null, 0); orbWasOn = false; }
  setTimeout(orbTick, mode || orbWasOn ? 40 : live ? 250 : 500); // 25 updates/s only while the orb is needed; idle is a slow heartbeat
}
orbTick();
