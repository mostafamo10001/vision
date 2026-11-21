'use strict';
// Settings, encrypted API key, model cache, memories and reminders (all stored in the app's userData folder).
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  liveModel: 'auto',          // voice model ("auto" = newest Live-capable Flash model your key can use)
  workerModel: 'auto',        // "brain" for multi-step computer tasks ("auto" = newest Pro model)
  fastModel: 'auto',          // quick vision / web lookups ("auto" = newest Flash model)
  wakeWord: true,             // say "Hey Vision" / "Okay Vision" to wake (listens locally, checks short clips with Gemini)
  wakeModel: 'gemini-flash-lite-latest',
  voice: 'Charon',
  autonomy: 'balanced',       // cautious | balanced | autopilot
  allowShell: true,           // allow run_command (every command still asks for approval)
  maxSteps: 25,
  handsFree: false,           // keep the mic session open and only react when addressed
  silenceWaitSec: 2.5,        // how long you must be silent before Vision treats your turn as finished and answers
  idleDisconnectSec: 120,     // close the voice session after this much silence (when not hands-free)
  halfDuplex: false,          // mute mic while Vision speaks (use with laptop speakers if it hears itself)
  alwaysOnTop: true,
  hideFromCapture: false,     // when on, Windows blanks the window in every capture (Win+Shift+S, screen sharing, Vision's own screenshots)
  startWithWindows: false,   // the installed .exe switches this on at first launch
  startupInitialised: false, // internal: first-run flag
  themePreset: 'vision', themeAccent: '#7c8cff', themeGold: '#f6c252', themeListen: '#3de0d0', themeBg: '#06080e',
  orbWhileTalking: true,      // show the small floating orb at the bottom of the screen while you talk and Vision' window is hidden
  excludeModels: 'gemini-3.8-flash', // comma-separated models Vision must never call (short quota)
  wakeEngine: 'local',               // 'local' = Windows speech recognition (offline, no quota) | 'cloud' = Gemini
  wakePhrases: 'hey vision, okay vision, hey jarvis, okay jarvis',
  wakeSensitivity: 'normal',         // strict | normal | sensitive
  shellMaxCommands: 10,       // most PowerShell commands Vision may run per request (also the per-minute cap)
  shellNoAsk: false,          // true = run PowerShell without asking (dangerous commands stay blocked)
  holdOpen: true,             // mic button = keep listening until pressed again (no auto-sleep)
  shellDefaultApplied: false, // internal: one-time switch of shell access on (every command still asks)
  visionFast: true,           // quick screen looks / click finding: switch the model's "thinking" down for speed (set false to let it think, slower)
  userName: ''
};

let data = null;
let filePath = null;
const fp = () => filePath || (filePath = path.join(app.getPath('userData'), 'jarvis-config.json'));

function load() {
  if (data) return data;
  let raw = null;
  for (const f of [fp(), fp() + '.bak']) { try { raw = JSON.parse(fs.readFileSync(f, 'utf8')); break; } catch {} } // fall back to the backup if the main file is damaged
  data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  data.settings = { ...DEFAULTS, ...(data.settings || {}) };
  data.models = data.models || {};
  data.facts = Array.isArray(data.facts) ? data.facts : [];
  data.reminders = Array.isArray(data.reminders) ? data.reminders : [];
  data.todos = Array.isArray(data.todos) ? data.todos : [];
  data.shortcuts = data.shortcuts && typeof data.shortcuts === 'object' && !Array.isArray(data.shortcuts) ? data.shortcuts : {};
  return data;
}
function save() { // write to a temp file, keep a backup of the previous version, then swap: a crash can never leave a half-written file
  const file = fp();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try { if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak'); } catch {}
  fs.renameSync(tmp, file);
}

const get = () => load().settings;
function set(patch) {
  const c = load();
  for (const k of Object.keys(patch || {})) if (k in DEFAULTS) c.settings[k] = patch[k];
  save();
  return c.settings;
}
function getKey() {
  const k = load().key;
  if (!k) return '';
  try {
    if (k.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(k.slice(4), 'base64'));
    return k.slice(4);
  } catch { return ''; }
}
function setKey(key) {
  key = String(key || '').trim();
  const c = load();
  if (!key) c.key = '';
  else if (safeStorage.isEncryptionAvailable()) c.key = 'enc:' + safeStorage.encryptString(key).toString('base64');
  else c.key = 'raw:' + key;
  save();
}
const hasKey = () => !!getKey();

const getModels = () => load().models;
function setModels(m) { load().models = m; save(); }

// ---- long-term memory + reminders ----
const facts = () => load().facts;
function addFact(text) {
  const c = load();
  text = String(text).trim().slice(0, 300);
  if (!text || c.facts.some(f => f.toLowerCase() === text.toLowerCase())) return false;
  c.facts.push(text);
  if (c.facts.length > 120) c.facts.shift();
  save();
  return true;
}
function removeFacts(match) {
  const c = load();
  const m = String(match).toLowerCase();
  const before = c.facts.length;
  c.facts = c.facts.filter(f => !f.toLowerCase().includes(m));
  save();
  return before - c.facts.length;
}
const reminders = () => load().reminders;
// ---- to-do list (the `todo` tool) ----
const todos = () => load().todos;
function setTodos(list) { load().todos = Array.isArray(list) ? list : []; save(); }
// Settings screen: remove ONE remembered fact or shortcut exactly (removeFacts() would also delete every other fact that merely contains the text)
function removeFactExact(text) { const c = load(), n = c.facts.indexOf(String(text)); if (n < 0) return false; c.facts.splice(n, 1); save(); return true; }
function removeShortcutExact(name) { const c = load(), k = String(name || '').trim().toLowerCase(); if (!(k in c.shortcuts)) return false; delete c.shortcuts[k]; save(); return true; }
function setReminders(list) { load().reminders = list; save(); }

// ---- personal shortcuts: words the user uses (e.g. "downloads") that always mean a specific folder/file ----
const shortcuts = () => load().shortcuts;
function setShortcut(name, target) {
  name = String(name || '').trim().toLowerCase().slice(0, 40);
  target = String(target || '').trim().replace(/^["']|["']$/g, '').slice(0, 400);
  if (!name || !target) return false;
  const c = load(); c.shortcuts[name] = target; save(); return true;
}
function removeShortcut(name) {
  const c = load(), n = String(name || '').trim().toLowerCase();
  const keys = Object.keys(c.shortcuts).filter(k => k === n || k.includes(n));
  keys.forEach(k => delete c.shortcuts[k]); if (keys.length) save(); return keys.length;
}
const configPath = () => fp();

module.exports = { todos, setTodos, removeFactExact, removeShortcutExact, shortcuts, setShortcut, removeShortcut, configPath, DEFAULTS, get, set, getKey, setKey, hasKey, getModels, setModels, facts, addFact, removeFacts, reminders, setReminders };
