'use strict';
// The agent's tool registry. "live" tools are exposed to the voice model; "worker" tools to the screen-driving agent.
const { app, BrowserWindow, clipboard, shell, Notification } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const diagnostics = require('./diagnostics');
const bookmarks = require('./bookmarks');
const fuzzy = require('./fuzzy');
const vision = require('./vision');
const transcribe = require('./transcribe');
const logger = require('./log');
const NO_LOG_ARGS = new Set(['type_text', 'ui_set_text', 'write_file', 'clipboard', 'remember', 'set_shortcut']); // never write what you typed or saved to the log
const cfg = require('./config');
const bridge = require('./ps-bridge');
const capture = require('./capture');
const gemini = require('./gemini');
const safety = require('./safety');
const runtime = require('./runtime');
const pure = require('./pure');

// ---------- schema helpers (Gemini function-declaration format) ----------
const str = (d) => ({ type: 'STRING', description: d });
const num = (d) => ({ type: 'NUMBER', description: d });
const bool = (d) => ({ type: 'BOOLEAN', description: d });
const oneOf = (d, vals) => ({ type: 'STRING', description: d, enum: vals });
const obj = (properties, required = []) => ({ type: 'OBJECT', properties, required });
const RISKY = bool('Set true if this action sends, posts, submits, books, pays, deletes, or otherwise cannot be undone.');
const GRID = 'on the 0-1000 grid of the latest screenshot';

// ---------- path helpers ----------
function resolveBuiltin(p) {
  p = String(p || '').trim().replace(/^["']|["']$/g, '').replace(/%([^%]+)%/g, (_, v) => process.env[v] || '');
  if (!p) throw new Error('No path given.');
  const m = p.toLowerCase().match(/^(desktop|documents|downloads|pictures|music|videos|home)(?:[\\/].*)?$/);
  if (m) return path.join(app.getPath(m[1]), p.slice(m[1].length).replace(/^[\\/]+/, ''));
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return path.isAbsolute(p) ? path.normalize(p) : path.join(os.homedir(), p);
}
// The user's own shortcuts ("downloads" -> D:\Downloads) win over the built-in folder names.
function resolvePath(p) {
  p = String(p || '').trim().replace(/^["']|["']$/g, '');
  if (!p) throw new Error('No path given.');
  const sm = p.match(/^([^\\/]+)(?:[\\/]+(.*))?$/);
  const target = sm && cfg.shortcuts()[sm[1].trim().toLowerCase()];
  if (target) return resolveBuiltin(sm[2] ? target.replace(/[\\/]+$/, '') + path.sep + sm[2] : target);
  if (sm && !path.isAbsolute(p) && !p.startsWith('~') && !/^[a-zA-Z]:$/.test(sm[1])) { // "downlods" / "my downloads folder" -> downloads
    const alt = fuzzy.bestOf(sm[1], [...Object.keys(cfg.shortcuts()), 'desktop', 'documents', 'downloads', 'pictures', 'music', 'videos'], 0.85);
    if (alt && alt !== sm[1].trim().toLowerCase()) return resolvePath(alt + (sm[2] ? path.sep + sm[2] : ''));
  }
  return resolveBuiltin(p);
}
// Existing files/folders: a name that is a little off (typo, other word order, missing extension...) still finds the real one.
function resolveLoose(p, { quiet = false } = {}) {
  const r = fuzzy.resolveExisting(resolvePath(p));
  if (r.fuzzy && !quiet) runtime.emit('step', { kind: 'info', text: `Matched "${p}" to ${r.path}` });
  return r.path;
}
const displayPath = p => { try { return resolveLoose(p, { quiet: true }); } catch { return p; } }; // what a prompt should show the user
// New files/folders: the folder they go into may be a little off; the new name itself is kept exactly as given.
function resolveForCreate(p) {
  const full = resolvePath(p);
  try { return fuzzy.resolveParent(full).path; } catch (e) { if (/could mean/.test(e.message)) throw e; return full; }
}
function guardWrite(p) {
  if (safety.isProtectedPath(p)) throw new Error('That location is protected (system folder or drive root).');
  if (safety.isPrivatePath(p)) throw new Error("That is Vision' private data folder.");
}
// Where a moved/copied item really ends up. "to" is usually the FOLDER the user named, not the item's new name: when it is an existing folder
// (or is written with a trailing slash) the item goes INSIDE it under its own name, like Windows' own move. Otherwise "to" is the full new path (a rename).
function destFor(f, rawTo) {
  const t0 = resolveForCreate(rawTo); guardWrite(t0);
  let isDir = false; try { isDir = fs.statSync(t0).isDirectory(); } catch {}
  const dest = (isDir || /[\\/]\s*$/.test(String(rawTo))) ? path.join(t0, path.basename(f)) : t0;
  guardWrite(dest);
  let srcDir = false; try { srcDir = fs.statSync(f).isDirectory(); } catch {}
  if (srcDir && (dest.toLowerCase() + path.sep).startsWith(f.toLowerCase() + path.sep)) throw new Error('A folder cannot be moved or copied into itself.');
  return dest;
}
const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n...[truncated ${s.length - n} chars]` : s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtSize = b => (b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : b > 1e3 ? Math.round(b / 1e3) + ' KB' : b + ' B');

// ---------- overlay ("here it is") ----------
function showOverlay(nx, ny, label) {
  const d = capture.current().display;
  const w = new BrowserWindow({
    x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
    transparent: true, frame: false, focusable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false, resizable: false, show: false,
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  w.setIgnoreMouseEvents(true);
  w.setContentProtection(true);
  w.setAlwaysOnTop(true, 'screen-saver');
  w.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'), {
    query: { x: String(Math.round(nx / 1000 * d.bounds.width)), y: String(Math.round(ny / 1000 * d.bounds.height)), label: String(label || '').slice(0, 60) }
  });
  w.once('ready-to-show', () => w.showInactive());
  setTimeout(() => { if (!w.isDestroyed()) w.close(); }, 5000);
}

// ---------- reminders ----------
// Reminders are saved to disk and checked by a poll (not one long timer each), so they survive sleep/hibernate and restarts.
let remTimer = null;
function fireReminder(r) {
  const rest = cfg.reminders().filter(x => x.id !== r.id), nd = r.repeat ? pure.nextDue(r.due, r.repeat) : null;
  cfg.setReminders(nd ? [...rest, { ...r, due: nd }] : rest); // a repeating reminder comes back at its next time
  const msg = (Date.now() - r.due > 120000 ? '(missed while Vision was off) ' : '') + r.message;
  try { new Notification({ title: 'Vision reminder', body: msg }).show(); } catch {}
  runtime.emit('reminder', msg);
}
function checkDue() { const now = Date.now(); for (const r of cfg.reminders().slice()) if (r.due <= now) fireReminder(r); }
const startHooks = []; // modules that need to resume work when Vision starts (automations)
function scheduleAll() {
  for (const f of startHooks) { try { f(); } catch (e) { logger.log('start-hook', (e && e.stack) || e); } }
  if (remTimer) return;
  setTimeout(() => { checkDue(); remTimer = setInterval(checkDue, 10000); }, 8000); // let the window finish loading before anything fires at startup
  remTimer = remTimer || true;
}

// ---------- file search ----------
async function walk(root, query, { max = 40, deadlineMs = 8000 } = {}) {
  const q = query.toLowerCase(), end = Date.now() + deadlineMs, out = [], queue = [[root, 0]];
  const skip = new Set(['node_modules', '.git', '$recycle.bin', 'windows', 'appdata', 'system volume information']);
  while (queue.length && out.length < max && Date.now() < end) {
    const [dir, depth] = queue.shift();
    let items; try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.name.toLowerCase().includes(q)) { out.push(full + (it.isDirectory() ? path.sep : '')); if (out.length >= max) break; }
      if (it.isDirectory() && depth < 6 && !skip.has(it.name.toLowerCase())) queue.push([full, depth + 1]);
    }
  }
  return out;
}

// If Vision itself holds keyboard focus (e.g. you clicked its mic button), typed keys would land in Vision.
// Briefly hide its window so Windows hands focus back to the app you were using, then show it again without stealing focus.
async function yieldFocus() {
  const w = runtime.state.win;
  if (w && !w.isDestroyed() && w.isFocused()) { w.hide(); await sleep(250); w.showInactive(); await sleep(80); }
}
async function typeText(text) {
  await yieldFocus();
  try { await bridge.call('type', { text }, 60000); return 'Typed.'; } catch (e1) { /* fall through */ }
  const prev = await clipboard.readText(); // Electron 44+ made the clipboard async (older versions are sync): await works for both
  try { // fallback 1: paste through the clipboard
    await clipboard.writeText(text); await bridge.call('keys', { combo: 'ctrl+v' }); await sleep(300); return 'Typed (pasted).';
  } catch (e2) { /* fall through */ } finally { setTimeout(() => { try { Promise.resolve(clipboard.writeText(prev)).catch(() => {}); } catch {} }, 700); }
  // fallback 2: a fresh PowerShell with SendKeys
  const esc = text.replace(/[+^%~(){}\[\]]/g, m => '{' + m + '}').replace(/\r?\n/g, '{ENTER}').replace(/'/g, "''");
  await runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${esc}')`);
  return 'Typed (fallback).';
}

function runPowerShell(command) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const out = clip((stdout || '') + (stderr ? '\n[stderr] ' + stderr : ''), 5000).trim();
        if (err && !out) return reject(err);
        resolve(out || '(no output)');
      });
  });
}

// When the exact app name is not found: list the installed apps and pick the closest name (typos, spaces, other word order).
async function fuzzyOpenApp(name) {
  const script = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-StartApps | ForEach-Object { $_.Name + '|||' + $_.AppID }";
  const out = await new Promise(res => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 20000, windowsHide: true, maxBuffer: 4e6, encoding: 'utf8' }, (err, so) => res(err ? '' : String(so))));
  const apps = out.split(/\r?\n/).map(l => l.split('|||')).filter(p => p.length === 2 && p[0].trim()).map(p => ({ name: p[0].trim(), id: p[1].trim() }));
  if (!apps.length) return null;
  const flat = s => fuzzy.norm(s).replace(/ /g, ''), q = flat(name);
  let best = null;
  for (const ap of apps) {
    const n = flat(ap.name); let s = fuzzy.scoreName(name, ap.name);
    if (q.length >= 3 && n.includes(q)) s = Math.max(s, 0.9 - Math.min(0.2, (n.length - q.length) * 0.01)); // "whats app" matches "WhatsApp"
    if (!best || s > best.s) best = { ...ap, s };
  }
  if (!best || best.s < 0.72) return null;
  await new Promise(res => execFile('explorer.exe', ['shell:AppsFolder\\' + best.id], { windowsHide: true }, () => res())); // explorer reports exit code 1 even on success
  return `Opened ${best.name} (matched "${name}").`;
}

// ---------- registry ----------
const REG = [];
const def = t => REG.push({ scope: ['live', 'worker'], level: () => 0, ...t });
const ex = () => ({ excludePid: process.pid });

def({
  name: 'open_app', description: 'Open or switch to an application by name (e.g. "chrome", "spotify", "calculator", "word", "settings").',
  parameters: obj({ name: str('App name as the user would say it.') }, ['name']),
  describe: a => `Open app: ${a.name}`,
  run: async a => {
    try { return await bridge.call('open_app', { name: a.name }, 20000); }
    catch (e) { if (!/Could not find an app/i.test(e.message)) throw e; const r = await fuzzyOpenApp(String(a.name)); if (r) return r; throw e; } // "whats app" -> WhatsApp, "spotfy" -> Spotify
  }
});
def({
  name: 'open_url', description: 'Open a web address (http/https/mailto/ms-settings:) in the default handler.',
  parameters: obj({ url: str('Full URL, e.g. https://youtube.com') }, ['url']),
  level: a => { const u = String(a.url || ''), i = u.search(/[?#]/); return i >= 0 && u.length - i > 400 ? 2 : 0; }, // a huge query string could carry private text out to a website
  describe: a => `Open URL: ${clip(String(a.url), 300)}`,
  run: async a => {
    let u = String(a.url).trim();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
    if (!/^(https?:|mailto:|ms-settings:|tel:)/i.test(u)) throw new Error('Only http(s), mailto, tel and ms-settings links are allowed.');
    await shell.openExternal(u); return 'Opened ' + u;
  }
});
def({
  name: 'open_path', description: 'Open a file or folder with its default app. Accepts the user\'s saved shortcuts, known names like "downloads", "documents", "desktop", or a full path. Programs, installers and scripts always need the user\'s approval.',
  parameters: obj({ path: str('File or folder path or known folder name.') }, ['path']),
  level: a => (opensProgram(a) ? 2 : 0), alwaysAsk: a => opensProgram(a), gateKey: a => (opensProgram(a) ? 'run:' + String(a.path).toLowerCase() : null),
  describe: a => (opensProgram(a) ? `RUN PROGRAM / OPEN FILE THAT CAN RUN CODE: ${a.path}` : `Open: ${a.path}`),
  run: async a => { const p = resolveLoose(a.path); const e = await shell.openPath(p); if (e) throw new Error(e); return 'Opened ' + p; }
});
// ----- web search without the Gemini search-tool quota -----
// DuckDuckGo results + the text of the top pages go straight back to the voice model, which writes the answer.
// No extra Gemini call is made, so the "quota exceeded" errors of Google-Search grounding no longer apply.
// If the free search is blocked or empty, it falls back to Gemini's Google Search tool.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const decodeEntities = h => h.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'");
const stripTags = h => decodeEntities(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
function timed(signal, ms) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  if (signal) { if (signal.aborted) c.abort(); else signal.addEventListener('abort', () => c.abort(), { once: true }); }
  return { signal: c.signal, done: () => clearTimeout(t) };
}
function parseDuckDuckGo(html) {
  const out = [];
  for (const chunk of html.split(/class="[^"]*result__body[^"]*"/).slice(1)) {
    const a = chunk.match(/<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const href = (a[0].match(/href="([^"]+)"/) || [])[1];
    if (!href || /duckduckgo\.com\/y\.js/.test(href)) continue; // sponsored result
    let url = decodeEntities(href);
    const u = url.match(/[?&]uddg=([^&]+)/); if (u) { try { url = decodeURIComponent(u[1]); } catch {} }
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//.test(url)) continue;
    const sn = chunk.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/);
    out.push({ title: stripTags(a[1]), url, snippet: sn ? stripTags(sn[1]) : '' });
  }
  return out;
}
async function ddgSearch(q, signal) {
  const t = timed(signal, 10000);
  try {
    const r = await fetch('https://html.duckduckgo.com/html/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body: 'q=' + encodeURIComponent(q), signal: t.signal });
    if (!r.ok) throw new Error('search returned HTTP ' + r.status);
    const results = parseDuckDuckGo(await r.text());
    if (!results.length) throw new Error('search returned no results (it may be rate-limiting or blocking)');
    return results;
  } finally { t.done(); }
}
async function pageSummaryText(url, signal) {
  const t = timed(signal, 6000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: t.signal });
    if (!r.ok || !/html|text/i.test(r.headers.get('content-type') || '')) return '';
    const html = (await r.text()).slice(0, 600000).replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)[\s\S]*?<\/\1>/gi, ' ');
    return stripTags(html).slice(0, 2500);
  } catch { return ''; } finally { t.done(); }
}
function parseDuckDuckGoLite(html) {
  const out = [], anchors = [...html.matchAll(/<a\b[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g)];
  anchors.forEach((m, i) => {
    const href = (m[0].match(/href=['"]([^'"]+)['"]/) || [])[1];
    if (!href || /y\.js/.test(href)) return;
    let url = decodeEntities(href); const u = url.match(/[?&]uddg=([^&]+)/); if (u) { try { url = decodeURIComponent(u[1]); } catch {} }
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//.test(url)) return;
    const seg = html.slice(m.index + m[0].length, i + 1 < anchors.length ? anchors[i + 1].index : html.length);
    const sn = seg.match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/);
    out.push({ title: stripTags(m[1]), url, snippet: sn ? stripTags(sn[1]) : '' });
  });
  return out;
}
async function ddgLiteSearch(q, signal) {
  const t = timed(signal, 10000);
  try {
    const r = await fetch('https://lite.duckduckgo.com/lite/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body: 'q=' + encodeURIComponent(q), signal: t.signal });
    if (!r.ok) throw new Error('lite search returned HTTP ' + r.status);
    const results = parseDuckDuckGoLite(await r.text());
    if (!results.length) throw new Error('lite search returned no results');
    return results;
  } finally { t.done(); }
}
const WIKI_UA = { 'User-Agent': 'VisionAssistant/1.3 (personal desktop assistant)' };
async function wikiSearch(q, signal) { // definitions and facts: no key, no rate-limit trouble
  const t = timed(signal, 9000);
  try {
    const r = await fetch('https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=3&format=json&srsearch=' + encodeURIComponent(q), { headers: WIKI_UA, signal: t.signal });
    if (!r.ok) throw new Error('Wikipedia returned HTTP ' + r.status);
    const hits = (((await r.json()).query || {}).search || []).slice(0, 3);
    if (!hits.length) throw new Error('Wikipedia had no matching article');
    return await Promise.all(hits.map(async h => {
      const slug = encodeURIComponent(h.title.replace(/ /g, '_')); let extract = '';
      try { const s = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + slug, { headers: WIKI_UA, signal: t.signal }); if (s.ok) extract = (await s.json()).extract || ''; } catch {}
      return { title: h.title, url: 'https://en.wikipedia.org/wiki/' + slug, snippet: stripTags(h.snippet || ''), extract };
    }));
  } finally { t.done(); }
}
async function freeLookup(q, signal) {
  let results = null, source = '', lastErr;
  for (const [name, fn] of [['DuckDuckGo', ddgSearch], ['DuckDuckGo Lite', ddgLiteSearch], ['Wikipedia', wikiSearch]]) {
    try { const r = await fn(q, signal); if (r && r.length) { results = r.slice(0, 6); source = name; break; } }
    catch (e) { lastErr = e; if (signal && signal.aborted) throw e; }
  }
  if (!results) throw lastErr || new Error('no results');
  const pages = await Promise.all(results.slice(0, 2).map(r => r.extract ? Promise.resolve(r.extract) : pageSummaryText(r.url, signal)));
  const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  let text = `Web results for "${q}" from ${source} (answer the user in one or two spoken sentences from these; name the source only if useful):\n`;
  results.forEach((r, i) => { text += `${i + 1}. ${r.title} [${host(r.url)}]\n   ${r.snippet}\n`; });
  pages.forEach((p, i) => { if (p) text += `\nText from ${host(results[i].url)}:\n${p}\n`; });
  return clip(text, 9000);
}
// v1.9.2: many independent search sources with automatic failover (websearch.js); Gemini's own search is only the very last resort.
const websearch = require('./websearch');
const webEngine = websearch.createLookup({ keysFile: () => path.join(app.getPath('userData'), 'search-keys.json'), logger });
def({
  name: 'web_lookup', description: 'Search the web and get the latest facts. Use for news, weather, prices, scores, and anything that changes. Returns search results and page text; summarise them for the user.',
  parameters: obj({ query: str('What to look up, as a short search query.') }, ['query']),
  describe: a => `Web lookup: ${a.query}`,
  run: async a => {
    const signal = runtime.signal();
    try { return await webEngine.lookup(String(a.query), { signal }); }
    catch (e1) {
      if (signal.aborted) throw new Error('stopped by the user');
      if (e1.code === 'NONET') throw new Error(e1.message + ' Tell the user to check the internet connection.');
      try { return await gemini.webLookup(a.query, signal); } // last resort: Gemini's Google Search tool (has its own daily quota)
      catch (e2) { throw new Error(`${e1.message} Gemini's own search is not available either (${String(e2.message).slice(0, 100)}).`); }
    }
  }
});
def({
  name: 'set_volume', description: 'Control the PC volume. For "louder", "lower", "a bit more" use action up/down (changes by 10 points unless "amount" is given). Use "set" ONLY when the user names an exact level like "volume 30". Never use set 100 or set 0 for an up/down request.',
  parameters: obj({ action: oneOf('What to do.', ['get', 'set', 'up', 'down', 'mute', 'unmute']), level: num('0-100 percent, only for "set".'), amount: num('Percent points for up/down (default 10, max 50).') }, ['action']),
  describe: a => `Volume ${a.action}${a.level != null ? ' ' + a.level : ''}${a.amount != null ? ' by ' + a.amount : ''}`,
  run: async a => {
    const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    let r;
    if (a.action === 'up' || a.action === 'down') {
      let cur = null; try { cur = await bridge.call('volume', { action: 'get' }); } catch {}
      if (cur && cur.level >= 0) { // work out the new level here, then set it: predictable, and the answer is the real result
        const step = clampN(Math.round(Number(a.amount)) || 10, 1, 50);
        r = await bridge.call('volume', { action: 'set', level: clampN(cur.level + (a.action === 'up' ? step : -step), 0, 100) });
      } else r = await bridge.call('volume', { action: a.action });
    } else if (a.action === 'set') {
      let lv = Number(a.level);
      if (!Number.isFinite(lv)) throw new Error('Give a level from 0 to 100.');
      if (lv > 0 && lv < 1) lv *= 100; // 0.3 meant 30%
      r = await bridge.call('volume', { action: 'set', level: clampN(Math.round(lv), 0, 100) });
    } else r = await bridge.call('volume', { action: a.action });
    logger.log('volume', `${a.action} level=${a.level} amount=${a.amount} -> ${r.level}% via=${r.via || '?'}${r.why ? ' why=' + r.why : ''}`);
    const asked = a.action === 'set' ? Math.round(Number(a.level) > 0 && Number(a.level) < 1 ? Number(a.level) * 100 : Number(a.level)) : null;
    if (r.level < 0) return 'Done.';
    return `Volume is ${r.level}%${r.muted ? ' (muted)' : ''}.` + (asked != null && Math.abs(r.level - asked) > 5 ? ` (I asked for ${asked}% but Windows reports ${r.level}%.)` : '');
  }
});
def({
  name: 'media_control', description: 'Control media playback for whatever is playing (Spotify, YouTube, etc.).',
  parameters: obj({ action: oneOf('Action.', ['play_pause', 'next', 'previous', 'stop']) }, ['action']),
  describe: a => `Media: ${a.action}`,
  run: async a => { const k = { play_pause: 'mediaplaypause', next: 'medianext', previous: 'mediaprev', stop: 'mediastop' }[a.action]; if (!k) throw new Error('Unknown action'); await bridge.call('keys', { combo: k }); return 'Done.'; }
});
def({
  name: 'clipboard', description: 'Read or write the clipboard text.',
  parameters: obj({ action: oneOf('get or set', ['get', 'set']), text: str('Text to put on the clipboard (set only).') }, ['action']),
  level: a => (a.action === 'set' ? 1 : 0), describe: a => `Clipboard ${a.action}`,
  run: async a => { if (a.action === 'set') { await clipboard.writeText(String(a.text ?? '')); return 'Copied to clipboard.'; } const t = await clipboard.readText(); return t ? clip(t, 4000) : '(clipboard is empty or not text)'; }
});
def({
  name: 'system_status', description: 'Battery, CPU load, memory, free disk space, uptime and the current time.',
  describe: () => 'Check system status',
  run: async () => {
    const a = os.cpus().map(c => ({ ...c.times })); await sleep(300); const b = os.cpus().map(c => ({ ...c.times }));
    let idle = 0, total = 0; b.forEach((t, i) => { const d = Object.keys(t).reduce((s, k) => s + (t[k] - a[i][k]), 0); total += d; idle += t.idle - a[i].idle; });
    const cpu = total ? Math.round((1 - idle / total) * 100) : 0;
    const out = [`Time: ${new Date().toLocaleString()}`, `CPU: ${cpu}% busy`, `Memory: ${fmtSize(os.totalmem() - os.freemem())} used of ${fmtSize(os.totalmem())}`];
    try { const s = await fsp.statfs(process.env.SystemDrive ? process.env.SystemDrive + '\\' : 'C:\\'); out.push(`Disk: ${fmtSize(s.bavail * s.bsize)} free`); } catch {}
    try { const h = await bridge.call('status', {}, 15000); if (h.batteryPercent != null) out.push(`Battery: ${h.batteryPercent}%${h.charging ? ' (charging)' : ''}`); out.push(`Uptime: ${h.uptimeHours} h`); } catch {}
    return out.join('\n');
  }
});
def({
  name: 'set_reminder', description: 'Set a reminder that fires a notification and a spoken alert. Give EITHER minutes from now OR an exact local date and time in "at" (use "at" for "tomorrow at 9", "on Friday", etc.). For "every day / every weekday / every week / every month" also set "repeat".',
  parameters: obj({ message: str('What to remind about.'), minutes: num('Minutes from now (can be fractional).'), at: str('Exact local date-time "YYYY-MM-DDTHH:MM", e.g. "2026-11-05T09:00".'), repeat: oneOf('Optional: make it come back automatically.', ['daily', 'weekdays', 'weekly', 'monthly']) }, ['message']),
  describe: a => `Reminder${a.at ? ' at ' + a.at : ' in ' + a.minutes + ' min'}${a.repeat ? ' (repeats ' + a.repeat + ')' : ''}: ${a.message}`,
  run: async a => {
    let due;
    if (a.at) { due = new Date(String(a.at)).getTime(); if (!Number.isFinite(due)) throw new Error('Could not understand that date/time.'); if (due < Date.now() - 1000) throw new Error('That time is already in the past.'); }
    else { const mins = Number(a.minutes); if (!(mins > 0)) throw new Error('Give minutes from now or an exact "at" time.'); due = Date.now() + mins * 60000; }
    const repeat = ['daily', 'weekdays', 'weekly', 'monthly'].includes(a.repeat) ? a.repeat : null;
    const r = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 6), message: String(a.message).slice(0, 300), due, ...(repeat ? { repeat } : {}) };
    cfg.setReminders([...cfg.reminders(), r]);
    setTimeout(checkDue, Math.min(Math.max(500, due - Date.now() + 300), 2147483000));
    return `Reminder saved for ${new Date(due).toLocaleString()}${repeat ? `, repeating ${repeat}` : ''}.`;
  }
});
def({
  name: 'list_reminders', description: 'List the reminders that are currently set.', describe: () => 'List reminders',
  run: async () => { const l = cfg.reminders().slice().sort((x, y) => x.due - y.due); return l.length ? l.map(r => `${new Date(r.due).toLocaleString()}${r.repeat ? ' (repeats ' + r.repeat + ')' : ''}: ${r.message}`).join('\n') : 'No reminders are set.'; }
});
def({
  name: 'cancel_reminder', description: 'Cancel reminders whose text contains the given words.',
  parameters: obj({ match: str('Words from the reminder to cancel.') }, ['match']), describe: a => `Cancel reminder: ${a.match}`,
  run: async a => { const m = String(a.match).toLowerCase(), all = cfg.reminders(), keep = all.filter(r => !r.message.toLowerCase().includes(m)); cfg.setReminders(keep); return `Cancelled ${all.length - keep.length} reminder(s).`; }
});
def({
  name: 'remember', description: 'Save a lasting fact or preference about the user for future conversations.',
  parameters: obj({ fact: str('Short fact, e.g. "Prefers Chrome for browsing".') }, ['fact']),
  describe: a => `Remember: ${a.fact}`, run: async a => (cfg.addFact(a.fact) ? 'Saved.' : 'Already known.')
});
def({
  name: 'set_shortcut', description: 'Save a personal shortcut: a word or phrase the user says (like "downloads", "work", "my project") that must always mean one specific folder or file. User shortcuts override the built-in folder names. Use this whenever the user says "when I say X open Y", "X means Y", or tells you where something lives.',
  parameters: obj({ name: str('What the user says, e.g. "downloads".'), path: str('Full folder or file path, e.g. "D:\\Downloads".') }, ['name', 'path']),
  describe: a => `Shortcut: ${a.name} -> ${a.path}`,
  run: async a => {
    if (!cfg.setShortcut(a.name, a.path)) throw new Error('Need both a name and a path.');
    const real = resolveBuiltin(a.path), ok = fs.existsSync(real);
    return `Saved: "${String(a.name).trim().toLowerCase()}" now means ${a.path}.${ok ? '' : ' (Note: that path does not exist right now.)'}`;
  }
});
def({
  name: 'forget', description: 'Remove saved memories or shortcuts that contain the given text.',
  parameters: obj({ match: str('Text contained in the memory or shortcut name to remove.') }, ['match']),
  describe: a => `Forget: ${a.match}`, run: async a => `Removed ${cfg.removeFacts(a.match)} memory item(s) and ${cfg.removeShortcut(a.match)} shortcut(s).`
});

// ----- files -----
def({
  name: 'list_directory', description: 'List files and folders in a directory.',
  parameters: obj({ path: str('Folder path or known name (downloads, documents, desktop...).') }, ['path']),
  describe: a => `List folder: ${a.path}`,
  run: async a => {
    const p = resolveLoose(a.path); if (safety.isPrivatePath(p)) throw new Error('Not allowed.');
    const items = await fsp.readdir(p, { withFileTypes: true }); const lines = [];
    for (const it of items.slice(0, 150)) {
      if (it.isDirectory()) lines.push(`[folder] ${it.name}`);
      else { let s = ''; try { const st = await fsp.stat(path.join(p, it.name)); s = ` (${fmtSize(st.size)}, ${st.mtime.toISOString().slice(0, 10)})`; } catch {} lines.push(it.name + s); }
    }
    return `${p}\n${lines.join('\n')}${items.length > 150 ? `\n...and ${items.length - 150} more` : ''}`;
  }
});
def({
  name: 'search_files', description: 'Find files or folders by name. Forgiving: typos, a different word order, "_" "-" "." in names and a missing extension still match, so pass what the user said and do not give up if the first try is empty.',
  parameters: obj({ query: str('The name, or part of it, as the user said it.'), folder: str('Where to search (default: the user home folder).') }, ['query']),
  describe: a => `Search files: ${a.query}`,
  run: async a => {
    const root = a.folder ? resolveLoose(a.folder) : os.homedir();
    const r = await fuzzy.search(root, String(a.query));
    if (r.good.length) {
      const exact = r.good.some(h => h.score >= 0.9);
      return r.good.map(h => h.full + (h.score < 0.9 ? `  (~${Math.round(h.score * 100)}% match)` : '')).join('\n') + (exact ? '' : '\n(No exact match: these are the closest names. Offer the best one.)');
    }
    return r.near.length ? `No close match for "${a.query}". Nearest names: ${r.near.map(h => h.full).join(' | ')}` : 'No matches.';
  }
});
def({
  name: 'read_file', description: 'Read a text file (txt, md, csv, json, code, logs...).',
  parameters: obj({ path: str('File path.') }, ['path']),
  describe: a => `Read file: ${a.path}`,
  run: async a => {
    const p = resolveLoose(a.path); if (safety.isPrivatePath(p)) throw new Error('Not allowed.');
    const st = await fsp.stat(p); if (st.size > 3e6) throw new Error('File is too large to read (' + fmtSize(st.size) + ').');
    const buf = await fsp.readFile(p); if (buf.includes(0)) throw new Error(/\.(pdf|docx?|xlsx?|pptx?|od[tsp]|png|jpe?g|webp)$/i.test(p) ? 'That is a PDF / Office / image file: use read_document for it.' : 'That looks like a binary file.');
    return `[${p}]\n` + clip(buf.toString('utf8'), 20000);
  }
});
def({
  name: 'write_file', description: 'Create or overwrite a text file (or append to it).',
  parameters: obj({ path: str('File path.'), content: str('Text content.'), append: bool('Append instead of overwrite.') }, ['path', 'content']),
  level: a => { try { return fs.existsSync(resolvePath(a.path)) && !a.append ? 2 : 1; } catch { return 1; } },
  describe: a => `${a.append ? 'Append to' : 'Write'} file: ${a.path}`,
  run: async a => { const p = resolvePath(a.path); guardWrite(p); await fsp.mkdir(path.dirname(p), { recursive: true }); await (a.append ? fsp.appendFile : fsp.writeFile)(p, String(a.content), 'utf8'); return 'Saved ' + p; }
});
def({
  name: 'make_folder', description: 'Create a folder.', parameters: obj({ path: str('Folder path.') }, ['path']),
  level: () => 1, describe: a => `Create folder: ${a.path}`, run: async a => { const p = resolveForCreate(a.path); guardWrite(p); await fsp.mkdir(p, { recursive: true }); return 'Created ' + p; }
});
def({
  name: 'move_path', description: 'Move or rename a file or folder. "to" can be the destination FOLDER (the item is put inside it, keeping its name) or a full new path to rename it.', parameters: obj({ from: str('Source path.'), to: str('Destination folder (the item goes inside it) or the full new path.') }, ['from', 'to']),
  level: () => 1, describe: a => `Move ${a.from} -> ${a.to}`,
  run: async a => {
    const f = resolveLoose(a.from), t = destFor(f, a.to); guardWrite(f);
    if (t.toLowerCase() === f.toLowerCase()) return `It is already there: ${f}`;
    if (fs.existsSync(t)) throw new Error(`Another item named "${path.basename(t)}" is already in ${path.dirname(t)}, so nothing was moved.`);
    await fsp.mkdir(path.dirname(t), { recursive: true });
    try { await fsp.rename(f, t); }
    catch (e) { if (e.code !== 'EXDEV') throw e; await fsp.cp(f, t, { recursive: true, errorOnExist: true, force: false }); await fsp.rm(f, { recursive: true, force: true }); } // another drive: copy, then remove the original
    return `Moved ${f} -> ${t}`;
  }
});
def({
  name: 'copy_path', description: 'Copy a file or folder. "to" can be the destination FOLDER (the copy goes inside it, keeping its name) or a full new path.', parameters: obj({ from: str('Source path.'), to: str('Destination folder (the copy goes inside it) or the full new path.') }, ['from', 'to']),
  level: () => 1, describe: a => `Copy ${a.from} -> ${a.to}`,
  run: async a => {
    const f = resolveLoose(a.from), t = destFor(f, a.to);
    if (t.toLowerCase() === f.toLowerCase()) throw new Error('The destination is the same as the source.');
    if (fs.existsSync(t)) throw new Error(`Another item named "${path.basename(t)}" is already in ${path.dirname(t)}, so nothing was copied.`);
    await fsp.mkdir(path.dirname(t), { recursive: true }); await fsp.cp(f, t, { recursive: true }); return `Copied ${f} -> ${t}`;
  }
});
def({
  name: 'delete_path', description: 'Move a file or folder to the Recycle Bin (always asks the user first).', parameters: obj({ path: str('Path to delete.') }, ['path']),
  level: () => 2, alwaysAsk: () => true, describe: a => `DELETE (Recycle Bin): ${displayPath(a.path)}`, // shows the real file, even when the name was a little off
  run: async a => { const p = resolveLoose(a.path); guardWrite(p); await shell.trashItem(p); return `Moved to the Recycle Bin: ${p}`; }
});
def({
  name: 'save_screenshot', description: 'Save a screenshot of the screen to Pictures/Vision.', describe: () => 'Save a screenshot',
  run: async () => { const dir = path.join(app.getPath('pictures'), 'Vision'); await fsp.mkdir(dir, { recursive: true }); const f = path.join(dir, `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`); await fsp.writeFile(f, await capture.fullResPng()); return 'Saved ' + f; }
});

// ----- sight -----
def({
  name: 'look_at_screen', scope: ['live'],
  description: 'ONLY describes what is on screen (read text, say what is open, find info). It cannot click or type. If the user wants anything DONE on screen ("look and click...", "find it and open it", "fill this in"), put the complete goal in "goal" (or call do_task): the visual agent then looks AND does it, in one go. Never call this and then stop when the user asked for an action.',
  parameters: obj({ question: str('What to find out (read-only questions).'), goal: str('If the user wants something done on screen, the complete goal. Leave empty for plain questions.') }),
  describe: a => `Look at screen${a.goal ? ' and act: ' + a.goal : a.question ? ': ' + a.question : ''}`,
  run: async a => {
    if (a.goal && String(a.goal).trim()) { logger.log('tool', `look_at_screen handed over to the visual agent: ${String(a.goal).slice(0, 160)}`); return require('./worker').runTask(String(a.goal)); }
    const out = await vision.describe(a.question, { signal: runtime.signal() }); // quick questions: local model; complex ones: online model
    return (out.text || 'Could not read the screen.') + '\n[This was only a description. If the user also asked you to DO something on screen, do it now: call click_on for a single thing to click, or do_task for a longer job. Do not stop here.]';
  }
});
def({
  name: 'point_at_on_screen', scope: ['live'], description: 'Find something on the screen and highlight it with a glowing ring so the user can see where it is.',
  parameters: obj({ description: str('What to find, e.g. "the Save button" or "the Wi-Fi icon".') }, ['description']),
  describe: a => `Find on screen: ${a.description}`,
  run: async a => {
    const shot = await capture.capture();
    const res = await gemini.generate('fast', {
      contents: [{ role: 'user', parts: [{ text: `Locate: "${a.description}". Reply ONLY with JSON {"found":boolean,"x":number,"y":number,"label":string} where x,y are the centre of the target on a 0-1000 grid over this screenshot (0,0 top-left).` }, { inlineData: { mimeType: shot.mime, data: shot.data } }] }],
      generationConfig: { responseMimeType: 'application/json' }
    }, { signal: runtime.signal() });
    let j; try { j = JSON.parse(gemini.textOf(res)); } catch { throw new Error('Could not locate it.'); }
    if (!j.found) return 'I could not see that on the screen.';
    showOverlay(j.x, j.y, j.label || a.description); return `Highlighted: ${j.label || a.description}.`;
  }
});
def({
  name: 'point_at', scope: ['worker'], description: 'Highlight a spot on the screen with a ring (to show the user something).',
  parameters: obj({ x: num('x ' + GRID), y: num('y ' + GRID), label: str('Short label.') }, ['x', 'y']),
  describe: a => `Highlight: ${a.label || ''}`, run: async a => { showOverlay(a.x, a.y, a.label); return 'Highlighted.'; }
});

// ----- windows & input -----
def({
  name: 'list_windows', description: 'List open windows and the active window.', describe: () => 'List windows',
  run: async () => { const [w, a] = await Promise.all([bridge.call('windows'), bridge.call('active_window')]); return `Active: ${a.title} (${a.process})\n` + (w.windows || []).map(x => `- ${x.title} (${x.process})${x.minimized ? ' [minimized]' : ''}`).join('\n'); }
});
def({
  name: 'window_action', description: 'Focus, minimize, maximize, restore, close or snap an open window found by part of its title or process name.',
  parameters: obj({ title: str('Part of the window title or the process name.'), action: oneOf('Action.', ['focus', 'minimize', 'maximize', 'restore', 'close', 'snap_left', 'snap_right', 'next_monitor']) }, ['title', 'action']),
  level: a => (a.action === 'close' ? 1 : 0), dedupe: a => a.action === 'close', describe: a => `Window ${a.action}: ${a.title}`,
  run: async a => {
    const r = await bridge.call('window_action', { title: a.title, action: a.action });
    // Be explicit: the window takes a moment to vanish, and the voice model used to read that as "failed" and retry.
    return a.action === 'close' ? `Sent the close request (${r}). That is done; the window may take a moment to disappear. Do not close it again.` : r;
  }
});
def({
  name: 'press_keys', description: 'Press a keyboard shortcut or key, e.g. "ctrl+c", "alt+tab", "win+d", "enter", "ctrl+shift+t", "f5".',
  parameters: obj({ keys: str('Keys joined with +. Names: ctrl alt shift win enter tab esc space backspace delete home end pageup pagedown up down left right f1-f24, letters, digits.'), repeat: num('Times to press (default 1).'), risky: RISKY }, ['keys']),
  level: () => 1, describe: a => `Press ${a.keys}${a.repeat > 1 ? ' x' + a.repeat : ''}`,
  run: async a => { await yieldFocus(); await bridge.call('keys', { combo: a.keys, repeat: Math.min(Number(a.repeat) || 1, 50) }); return 'Pressed ' + a.keys; }
});
def({
  name: 'type_text', description: 'Type text into whatever has keyboard focus. Click the field first if needed.',
  parameters: obj({ text: str('Text to type (newlines press Enter).'), risky: RISKY }, ['text']),
  level: () => 1, describe: a => `Type: "${clip(String(a.text), 60).replace(/\n/g, ' ')}"`,
  run: async a => { if (!a.text) throw new Error('No text given.'); return typeText(String(a.text)); }
});
def({
  name: 'ui_list', description: 'List the clickable controls (buttons, fields, tabs, menu items) of the active window by name.', describe: () => 'Inspect controls',
  run: async () => { const r = await bridge.call('ui_list', ex(), 45000); return `Window: ${r.window}\n` + (r.items || []).join('\n'); }
});
def({
  name: 'ui_click', description: 'Click a control by its visible name using Windows UI Automation (more reliable than coordinates). Searches the active window first.',
  parameters: obj({ name: str('Visible name of the button/tab/menu item/link.'), risky: RISKY }, ['name']),
  level: a => (riskyClick(a.name) ? 2 : 1), gateKey: (a, ctx) => clickGate(a.name, ctx), describe: a => `Click "${a.name}"`, run: async a => bridge.call('ui_click', { name: a.name, ...ex() }, 45000)
});
def({
  name: 'ui_set_text', description: 'Put text into a text field found by its visible name (replaces its content).',
  parameters: obj({ name: str('Visible name or label of the field.'), text: str('Text to enter.'), risky: RISKY }, ['name', 'text']),
  level: () => 1, describe: a => `Fill "${a.name}"`, run: async a => bridge.call('ui_set_text', { name: a.name, text: a.text, ...ex() }, 45000)
});
def({
  name: 'run_command', description: 'Run a PowerShell command and return its output. Last resort when no other tool fits: keep to as few commands as the job needs (the limit is stated in the instructions), and if one keeps failing tell the user instead of trying variations.',
  parameters: obj({ command: str('The PowerShell command.') }, ['command']),
  level: a => (cfg.get().shellNoAsk && !safety.shellNeedsApproval(a.command) ? 0 : 2), alwaysAsk: a => !cfg.get().shellNoAsk || safety.shellNeedsApproval(a.command), describe: a => `RUN POWERSHELL: ${clip(String(a.command), 200)}`,
  run: async a => {
    if (!cfg.get().allowShell) throw new Error('Shell commands are disabled. The user can enable them in Settings.');
    if (safety.shellBlocked(a.command)) throw new Error('That command is blocked for safety.');
    return runPowerShell(String(a.command));
  }
});

// ----- deeper PC integration -----
def({
  name: 'read_selection', description: 'Read the text the user currently has selected in any app (copies it, reads it, restores the clipboard).',
  describe: () => 'Read selected text',
  run: async () => {
    await yieldFocus();
    const prev = await clipboard.readText(); await clipboard.writeText('');
    try { await bridge.call('keys', { combo: 'ctrl+c' }); await sleep(300); const t = await clipboard.readText(); return t ? clip(t, 8000) : '(nothing is selected)'; }
    finally { try { await clipboard.writeText(prev); } catch {} }
  }
});
// ----- transcription: speech or audio -> a text file -----
def({
  name: 'start_transcription', scope: ['live'], description: 'Start recording to transcribe. Call this ONLY when the user\'s own words are exactly the command "transcribe" or "start transcribing" (optionally with "system audio"). NEVER call it for any other wording: not for "listening", "listen", "notes", "take notes", "write this down", "record", or because the word transcription/transcribe came up in conversation or in what you said yourself. If you are unsure, do not call it. Source "mic" (default) records the user\'s voice; source "system" records the audio playing on the PC. Nothing is sent anywhere until it is stopped; the text is saved as a .txt file in Documents\\Vision Transcripts, opened, and copied to the clipboard. The voice chat ends when recording starts so Vision does not answer the dictation.',
  parameters: obj({ source: oneOf('"mic" (default) or "system".', ['mic', 'system']) }), level: () => 1,
  describe: a => `Start transcribing (${a.source === 'system' ? 'system audio' : 'microphone'})`,
  run: async a => transcribe.start(a.source === 'system' ? 'system' : 'mic')
});
def({
  name: 'stop_transcription', description: 'Stop the current recording and turn it into a text file.', describe: () => 'Stop transcribing',
  run: async () => transcribe.stop()
});
def({
  name: 'transcribe_file', description: 'Transcribe an existing audio or video file (wav, mp3, m4a, ogg, flac, aac, mp4...) into a text file that opens when ready. Runs in the background.',
  parameters: obj({ path: str('Full path, or a shortcut/folder name like downloads/recording.mp3.') }, ['path']),
  level: () => 0, describe: a => `Transcribe ${a.path}`, run: async a => transcribe.fromFile(resolveLoose(a.path))
});

// ----- Chrome / Edge bookmarks: read straight from the browser's own file -----
function browserExe(browser) {
  const pf = process.env.ProgramFiles || 'C:\\Program Files', pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', local = process.env.LOCALAPPDATA || '';
  const c = browser === 'edge'
    ? [path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
    : [path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')];
  return c.find(f => { try { return fs.existsSync(f); } catch { return false; } }) || null;
}
async function openUrls(urls, browser) {
  const exe = browserExe(browser);
  if (exe) { const ch = require('child_process').spawn(exe, urls, { detached: true, stdio: 'ignore', windowsHide: false }); ch.unref(); return; }
  for (const u of urls) await shell.openExternal(u); // browser not found: use the default one
}
def({
  name: 'open_bookmark', description: 'Open one of the user\'s Chrome (or Edge) bookmarks by name, or every bookmark in a bookmark folder. Matches by name on this PC (instant, no screen needed). Use for "open my X bookmark", "open the work folder".',
  parameters: obj({ name: str('Part of the bookmark or folder name, e.g. "github" or "work".'), browser: oneOf('Which browser (default chrome).', ['chrome', 'edge']) }, ['name']),
  describe: a => `Open bookmark: ${a.name}`,
  run: async a => {
    const br = a.browser === 'edge' ? 'edge' : 'chrome';
    const { data } = bookmarks.read(br), f = bookmarks.find(data, a.name);
    if (f.kind === 'none') return `No bookmark or folder matches "${a.name}". Try list_bookmarks to see what is saved.`;
    if (f.kind === 'ambiguous') return `Several bookmarks match "${a.name}": ${f.options.map(o => `${o.name} (${o.url})`).join('; ')}. Ask the user which one.`;
    if (f.kind === 'folder') { const urls = f.urls.slice(0, 8); await openUrls(urls.map(u => u.url), br); return `Opened ${urls.length} bookmark(s) from the "${f.name}" folder${f.urls.length > 8 ? ` (first 8 of ${f.urls.length})` : ''}.`; }
    await openUrls([f.item.url], br);
    return `Opened "${f.item.name}" (${f.item.url}).`;
  }
});
def({
  name: 'list_bookmarks', description: 'List the user\'s Chrome (or Edge) bookmarks instantly by reading the browser\'s data file: the bookmarks bar by default, or everything. Use this, NOT the screen, for any question about what bookmarks exist.',
  parameters: obj({ scope: oneOf('"bar" = bookmarks bar only (default), "all" = everything.', ['bar', 'all']), browser: oneOf('Which browser (default chrome).', ['chrome', 'edge']) }),
  describe: a => `List ${a.browser || 'chrome'} bookmarks`,
  run: async a => { const { data, profile } = bookmarks.read(a.browser === 'edge' ? 'edge' : 'chrome'); return clip(`(profile: ${profile})\n` + bookmarks.format(data, a.scope === 'all' ? 'all' : 'bar'), 12000); }
});
def({
  name: 'play_youtube', description: 'Find a video or song on YouTube and play it right now in the browser (no API key, no steps). Use for any "play X on YouTube" or "open the X video" request.',
  parameters: obj({ query: str('What to play, e.g. "Billie Eilish Bad Guy".') }, ['query']),
  describe: a => `Play on YouTube: ${a.query}`,
  run: async a => {
    const q = String(a.query || '').trim();
    if (!q) throw new Error('Nothing to search for.');
    let id = null, title = '';
    try {
      const t = timed(runtime.signal(), 8000);
      const r = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(q) + '&sp=EgIQAQ%253D%253D', { headers: { 'User-Agent': UA, 'Accept-Language': 'en', Cookie: 'CONSENT=YES+1; SOCS=CAI' }, signal: t.signal });
      const html = await r.text(); t.done();
      const m = html.match(/"videoRenderer":\{"videoId":"([\w-]{11})"/);
      if (m) { id = m[1]; const tm = html.slice(m.index, m.index + 4000).match(/"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/); try { title = tm ? JSON.parse('"' + tm[1] + '"') : ''; } catch {} }
    } catch { /* fall through to the search page */ }
    const url = id ? `https://www.youtube.com/watch?v=${id}` : 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q);
    await shell.openExternal(url);
    return id ? `Playing "${title || q}" on YouTube.` : `Opened the YouTube search results for "${q}" (could not pick a video automatically).`;
  }
});
def({
  name: 'scroll_capture', scope: ['live'], description: 'Takes a SERIES OF SCREENSHOTS while scrolling down, saved to Pictures/Vision. ONLY when the user literally asks for screenshots / captures / a screen recording of a page while scrolling (e.g. "take 40 screenshots while scrolling", "capture the whole page"). The words "scroll down" or "scroll" alone are NEVER this: use the scroll tool. A single screenshot with no scrolling is save_screenshot, not this. There is no fixed limit on the number. Give pages = the number the user said, or until_end = true when they want the whole page / everything / until the end. If the user did not say how many, ASK THEM first; never invent a number. It also stops by itself if the page stops moving.',
  parameters: obj({ user_said_screenshots: bool('true ONLY if the user\'s request itself contained screenshot / capture / screen-record. For "scroll", "scroll down", "go down" it must be false (and you should have called scroll instead).'), pages: num('How many screenshots the user asked for (any number, no fixed limit). Leave empty if they did not say a number.'), until_end: bool('true if the user wants the whole page / until the end / all of it instead of a number.'), notches: num('Mouse-wheel notches per scroll (default 8).') }, ['user_said_screenshots']),
  level: () => 1, describe: a => { if (a.user_said_screenshots !== true) return 'Scroll down'; const n = Math.round(Number(a.pages)); return n >= 1 ? `Scroll-capture ${n} screenshot${n === 1 ? '' : 's'}` : a.until_end === true ? 'Scroll-capture until the end of the page' : 'Scroll-capture screenshots'; },
  run: async a => {
    await yieldFocus();
    if (a.user_said_screenshots !== true) { // a plain scroll request that reached the wrong tool: just scroll, take no screenshots
      await bridge.call('scroll', { amount: -5, horizontal: false });
      return 'That was a plain scroll request, so I only scrolled down: no screenshots were taken or saved. For scrolling use the scroll tool; use scroll_capture only when the user asks for screenshots while scrolling.';
    }
    const wanted = Math.round(Number(a.pages)), hasCount = wanted >= 1, untilEnd = a.until_end === true;
    if (!hasCount && !untilEnd) return 'NEED AN ANSWER: the user did not say how many screenshots to take, and no screenshots were taken. Ask them ONE short question: "How many screenshots do you want, or should I capture until the end of the page?" Do not guess a number. When they answer, call scroll_capture again with pages (their number) or until_end=true. (For a single screenshot with no scrolling, use save_screenshot instead.)';
    // No fixed limit: the user's number is used as given. SAFETY_MAX only stops a page that never ends (endless scrolling) from filling the disk; Stop works at any time.
    const SAFETY_MAX = 500, max = hasCount ? Math.min(wanted, SAFETY_MAX) : SAFETY_MAX, notches = Math.min(Math.max(Math.round(Number(a.notches)) || 8, 1), 20);
    const dir = path.join(app.getPath('pictures'), 'Vision', 'scroll-' + new Date().toISOString().replace(/[:.]/g, '-'));
    await fsp.mkdir(dir, { recursive: true });
    const signal = runtime.signal(); // taken ONCE: stopAll() replaces the controller, so asking runtime.signal() again in the loop would never see the stop
    const nap = ms => new Promise(r => { const t = setTimeout(r, ms); signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); }); // a stop cuts the wait short
    const mid = px(500, 500); let prev = null, saved = 0, endOfPage = false, stopped = false;
    for (let i = 0; i < max; i++) {
      if (signal.aborted) { stopped = true; break; }
      const png = await capture.fullResPng();
      if (signal.aborted) { stopped = true; break; } // stop arrived while taking the picture: no more saving, no more scrolling
      const h = require('crypto').createHash('md5').update(png).digest('hex');
      if (h === prev) { endOfPage = true; break; } // the page did not move: we reached the end
      prev = h;
      await fsp.writeFile(path.join(dir, String(i + 1).padStart(Math.max(2, String(max).length), '0') + '.png'), png); saved++;
      if (i === max - 1) break; // that was the last one asked for: do not scroll the page one more time
      if (signal.aborted) { stopped = true; break; }
      await bridge.call('scroll', { x: mid.x, y: mid.y, amount: -notches, horizontal: false });
      await nap(700);
    }
    if (stopped) return `STOPPED by the user after ${saved} screenshot${saved === 1 ? '' : 's'} (saved in ${dir}). Do not start the capture again or call any other tool for it; just tell the user it stopped.`;
    shell.openPath(dir).catch(() => {});
    const why = endOfPage ? (hasCount && saved < wanted ? ` (the page ended after ${saved}, you asked for ${wanted})` : ' (reached the end of the page)') : (!hasCount && saved >= SAFETY_MAX ? ` (stopped at the ${SAFETY_MAX}-picture safety ceiling: the page seems endless)` : (hasCount && wanted > SAFETY_MAX ? ` (capped at ${SAFETY_MAX} for safety; you asked for ${wanted})` : ''));
    return `Saved ${saved} screenshot${saved === 1 ? '' : 's'} to ${dir}${why}`;
  }
});
def({
  name: 'fetch_webpage', description: 'Download a web page and return its readable text (articles, docs, listings).',
  parameters: obj({ url: str('http(s) address.') }, ['url']), describe: a => `Read page: ${a.url}`,
  run: async a => {
    let u = String(a.url).trim(); if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    let host = ''; try { host = new URL(u).hostname; } catch { throw new Error('That is not a valid web address.'); }
    if (pure.isPrivateHost(host)) throw new Error('Blocked: that address is on this PC or your local network, not the internet.');
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 Vision' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const html = (await r.text()).slice(0, 1500000);
    const text = html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
    return clip(text, 9000) || '(page had no readable text)';
  }
});
def({
  name: 'list_processes', description: 'List the running programs using the most memory.', describe: () => 'List running programs',
  run: async () => new Promise((resolve, reject) => execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 4e6 }, (err, out) => {
    if (err) return reject(err);
    const rows = out.split(/\r?\n/).filter(Boolean).map(l => l.replace(/^"|"$/g, '').split('","')).map(c => ({ name: c[0], pid: c[1], kb: parseInt(String(c[4] || '0').replace(/[^\d]/g, ''), 10) || 0 }));
    const by = new Map(); for (const r of rows) { const e = by.get(r.name) || { name: r.name, kb: 0, n: 0 }; e.kb += r.kb; e.n++; by.set(r.name, e); }
    resolve([...by.values()].sort((a, b) => b.kb - a.kb).slice(0, 25).map(e => `${e.name}${e.n > 1 ? ' x' + e.n : ''}: ${fmtSize(e.kb * 1024)}`).join('\n'));
  }))
});
def({
  name: 'end_process', description: 'Force-close a running program by its process name (e.g. "chrome.exe") or PID. Always asks the user first.',
  parameters: obj({ name: str('Process name like "notepad.exe", or a numeric PID.') }, ['name']),
  level: () => 2, alwaysAsk: () => true, describe: a => `END PROGRAM: ${a.name}`,
  run: async a => {
    const n = String(a.name).trim();
    if (!/^[\w .()-]{1,80}$/.test(n)) throw new Error('Invalid process name.');
    if (/^(system|csrss|wininit|winlogon|lsass|services|smss|svchost|dwm|jarvis|vision)(\.exe)?$/i.test(n)) throw new Error('That is a critical process and is protected.');
    const args = /^\d+$/.test(n) ? ['/PID', n, '/F'] : ['/IM', /\.exe$/i.test(n) ? n : n + '.exe', '/F'];
    return new Promise((resolve, reject) => execFile('taskkill.exe', args, { windowsHide: true }, (err, out, se) => err ? reject(new Error((se || out || err.message).trim())) : resolve(out.trim() || 'Closed.')));
  }
});
def({
  name: 'lock_screen', description: 'Lock the computer (Windows lock screen).', level: () => 1, describe: () => 'Lock the PC',
  run: async () => { execFile('rundll32.exe', ['user32.dll,LockWorkStation'], { windowsHide: true }); return 'Locked.'; }
});
def({
  name: 'power_action', description: 'Put the PC to sleep, restart it, shut it down, or cancel a pending restart/shutdown. Always asks the user first.',
  parameters: obj({ action: oneOf('What to do.', ['sleep', 'restart', 'shutdown', 'cancel']) }, ['action']),
  level: () => 2, alwaysAsk: () => true, describe: a => `POWER: ${a.action}`,
  run: async a => {
    const m = { restart: ['shutdown.exe', ['/r', '/t', '30']], shutdown: ['shutdown.exe', ['/s', '/t', '30']], cancel: ['shutdown.exe', ['/a']], sleep: ['rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']] }[a.action];
    if (!m) throw new Error('Unknown action.');
    await new Promise((res, rej) => execFile(m[0], m[1], { windowsHide: true }, e => (e && a.action !== 'sleep' ? rej(e) : res())));
    return a.action === 'restart' || a.action === 'shutdown' ? `${a.action} in 30 seconds (say "cancel" to stop it).` : 'Done.';
  }
});
def({
  name: 'set_brightness', description: 'Get or set screen brightness (laptops / built-in displays).',
  parameters: obj({ level: num('0-100. Omit to just read the current brightness.') }),
  level: a => (a.level != null ? 1 : 0), describe: a => (a.level != null ? `Brightness ${a.level}%` : 'Read brightness'),
  run: async a => { const out = await (a.level != null
    ? runPowerShell(`(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods).WmiSetBrightness(1, ${Math.max(0, Math.min(100, Math.round(Number(a.level))))}); 'Brightness set.'`)
    : runPowerShell('(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness).CurrentBrightness'));
    if (/\[stderr\]|not supported|invalid class/i.test(out)) throw new Error('Brightness control is not supported on this display (normal for desktop monitors).');
    return out;
  }
});
def({
  name: 'run_diagnostics', scope: ['live'], description: 'Test your own abilities (screen capture, typing, PC control helper, vision model) and report what works. Use when the user says something is not working.',
  describe: () => 'Run diagnostics', run: async () => diagnostics.run()
});

// ----- visual (worker only) -----
const px = (x, y) => capture.toPhysical(x, y);
// Clicking something called "Install", "Allow", "Yes", "Download", "Pay"... asks the user first (settings: clickGuard=false turns this off).
const riskyClick = s => cfg.get().clickGuard !== false && safety.riskyClickTarget(s);
// The click safety gate asks only when (1) the label has an install / security word, and (2) the user's own request did not already say that word
// (if you said "install VLC", clicking Install is what you asked for). Returns a key naming what is being asked, or null = nothing to ask.
function clickGate(label, ctx) {
  const words = cfg.get().clickGuard === false ? [] : safety.riskyClickWords(label);
  const task = String((ctx && ctx.task) || '');
  const unasked = words.filter(w => !(task && new RegExp('\\b' + w.replace(/\s+/g, '\\s+'), 'i').test(task)));
  return unasked.length ? 'click:' + unasked.join(',') : null;
}
function opensProgram(a) { try { return safety.isExecutablePath(resolveLoose(a.path)); } catch { return safety.isExecutablePath(String(a.path || '')); } }
// After a click: wait until the screen settles and say whether anything changed, so the agent never assumes a click worked.
async function clickAndWatch(click) {
  const before = await capture.signature().catch(() => null);
  await click();
  const w = await capture.waitStable({ before, changeMs: 800 }).catch(() => null);
  if (!w || w.changed == null) return { note: '', changed: null };
  return { changed: w.changed, note: w.changed ? ' The screen changed after the click.' : ' WARNING: no visible change after the click (it may have missed, or the app is slow). If the screenshot already shows the goal achieved, the job is done. Otherwise look before deciding; do not click the same spot blindly again.' };
}

def({
  name: 'click_on',
  description: 'Click something visible on the screen by describing it ("the Save button", "the second search result", "the red Close icon"). It looks at the screen ONCE with the vision model, finds the thing and clicks it ONCE: no coordinates needed, no looking-and-retrying. Use this whenever you need to click, double-click or right-click something you can name. Set risky=true for anything that sends, pays, deletes or cannot be undone.',
  parameters: obj({ target: str('What to click, described as you would to a person.'), button: oneOf('Mouse button (default left).', ['left', 'right', 'middle']), double: bool('Double-click.'), risky: RISKY }, ['target']),
  level: a => (riskyClick(a.target) ? 2 : 1), gateKey: (a, ctx) => clickGate(a.target, ctx), describe: a => `Click on: ${a.target}`,
  run: async a => {
    const r = await vision.locate(String(a.target), { signal: runtime.signal() });
    if (!r.found) return `NOT FOUND: I could not see "${a.target}" on the screen${r.note ? ' (' + String(r.note).slice(0, 100) + ')' : ''}. Do not keep retrying the same words: use ui_list for control names, zoom into the area, scroll, or describe it differently (position, colour, nearby text).`;
    const click = (p) => bridge.call('click', { x: p.x, y: p.y, button: a.button || 'left', count: a.double ? 2 : 1 });
    const t0 = Date.now();
    let w = await clickAndWatch(() => click(r)), extra = '', retried = false;
    // The fast path missed: now (and only now) take a close-up look, and click again if it finds a better spot. Never for risky, double or right clicks.
    if (w.changed === false && !r.verified && !riskyClick(a.target) && a.risky !== true && !a.double && (a.button || 'left') === 'left') {
      const r2 = await vision.relocate(String(a.target), r, { signal: runtime.signal() });
      if (r2.found && !r2.same) { w = await clickAndWatch(() => click(r2)); retried = true; extra = ` The first click did nothing, so I re-aimed with a close-up and clicked again at ${r2.x},${r2.y}.`; }
      else if (r2.found && r2.same) extra = ' A close-up confirms that is the right spot, so the click probably worked without a visible change or the app is slow.';
      else extra = ' A close-up found no better spot.';
    }
    logger.log('timing', `click_on "${clip(String(a.target), 40)}": look ${r.ms} ms${r.verified ? ' (+close-up)' : ''}, total ${Date.now() - t0 + r.ms} ms, changed=${w.changed}${retried ? ', re-aimed' : ''}`);
    return `Clicked "${r.label || a.target}" at ${r.x},${r.y} (found in ${(r.ms / 1000).toFixed(1)} s${r.verified ? ', confirmed on a close-up' : ''}${r.count > 1 ? `; ${r.count} things matched, I took the most likely` : ''}).${w.note}${extra}${w.changed === false ? '' : ' That is done: do not click it again unless the next screenshot shows it did not work.'}`;
  }
});
def({
  name: 'find_on_screen',
  description: 'Find something visible on the screen and say where it is, without clicking it. Returns its position on the 0-1000 grid so you can then drag, zoom or point at it.',
  parameters: obj({ target: str('What to find, described as you would to a person.') }, ['target']),
  describe: a => `Find on screen: ${a.target}`,
  run: async a => {
    const r = await vision.locate(String(a.target), { signal: runtime.signal() });
    if (!r.found) return `NOT FOUND: "${a.target}" is not visible.`;
    const t = capture.current(), gx = Math.round((r.x - t.origin.x) / t.size.w * 1000), gy = Math.round((r.y - t.origin.y) / t.size.h * 1000);
    return `Found "${r.label || a.target}" at x=${gx}, y=${gy} on the 0-1000 grid (screen pixel ${r.x},${r.y}), by the vision model.`;
  }
});
def({
  name: 'click_at', scope: ['worker'], description: 'Click at a point on the screen.',
  parameters: obj({ x: num('x ' + GRID), y: num('y ' + GRID), button: oneOf('Mouse button.', ['left', 'right', 'middle']), double: bool('Double-click.'), risky: RISKY }, ['x', 'y']),
  level: () => 1, describe: a => `Click ${a.double ? '(double) ' : ''}at ${Math.round(a.x)},${Math.round(a.y)}`,
  run: async a => { const p = px(a.x, a.y); const w = await clickAndWatch(() => bridge.call('click', { ...p, button: a.button || 'left', count: a.double ? 2 : 1 })); return 'Clicked.' + w.note; }
});
def({
  name: 'drag', scope: ['worker'], description: 'Click-and-drag from one point to another.',
  parameters: obj({ x1: num('start x'), y1: num('start y'), x2: num('end x'), y2: num('end y'), risky: RISKY }, ['x1', 'y1', 'x2', 'y2']),
  level: () => 1, describe: a => `Drag ${Math.round(a.x1)},${Math.round(a.y1)} -> ${Math.round(a.x2)},${Math.round(a.y2)}`,
  run: async a => { const s = px(a.x1, a.y1), e = px(a.x2, a.y2); await bridge.call('drag', { x1: s.x, y1: s.y, x2: e.x, y2: e.y }); return 'Dragged.'; }
});
def({
  name: 'scroll', scope: ['live', 'worker'], description: 'PLAIN scrolling with the mouse wheel: "scroll down", "scroll up a bit", "scroll left", "go to the bottom / top of the page". This is the tool for EVERY scroll request. It takes no screenshots and saves nothing (screenshots while scrolling are a different tool, scroll_capture, used only when the user says screenshot or capture).',
  parameters: obj({ direction: oneOf('Direction.', ['up', 'down', 'left', 'right']), amount: num('Wheel notches (default 5; use 2-3 for "a little", 10-15 for "a lot").'), to: oneOf('Optional: jump straight to the top or the bottom of the page / document.', ['top', 'bottom']), x: num('x ' + GRID + ' (worker only; by default it scrolls where the mouse pointer is)'), y: num('y ' + GRID) }, ['direction']),
  level: () => 1, describe: a => (a.to ? `Scroll to the ${a.to}` : `Scroll ${a.direction}`),
  run: async (a, ctx) => {
    if (ctx && ctx.scope === 'live') await yieldFocus(); // the wheel must go to the app the user is looking at, not to Vision's own window
    if (a.to === 'top' || a.to === 'bottom') { await bridge.call('keys', { combo: a.to === 'top' ? 'ctrl+home' : 'ctrl+end', repeat: 1 }); return `Scrolled to the ${a.to}.`; }
    const n = Math.min(Math.max(Number(a.amount) || 5, 1), 30), horiz = a.direction === 'left' || a.direction === 'right';
    const amount = (a.direction === 'up' || a.direction === 'right') ? n : -n;
    const p = a.x != null && a.y != null ? px(a.x, a.y) : {};
    await bridge.call('scroll', { ...p, amount, horizontal: horiz }); return `Scrolled ${a.direction}.`;
  }
});
def({
  name: 'zoom', scope: ['worker'], description: 'Get a closer, higher-detail look at a region of the screen to read small text or find small controls.',
  parameters: obj({ x1: num('left ' + GRID), y1: num('top ' + GRID), x2: num('right ' + GRID), y2: num('bottom ' + GRID) }, ['x1', 'y1', 'x2', 'y2']),
  describe: () => 'Zoom in', run: async a => ({ text: 'Zoomed view of the requested region (coordinates stay on the full-screen 0-1000 grid).', image: await capture.zoom(a.x1, a.y1, a.x2, a.y2) })
});
def({
  name: 'finish', scope: ['worker'],
  description: 'Call this ONCE the moment the task is complete (or truly cannot be completed): it ends the job immediately. Do not take any more steps after the goal is achieved.',
  parameters: obj({ summary: str('Plain-text result: what was done, or exactly what is blocking.') }, ['summary']),
  describe: () => 'Finished', run: async a => String(a.summary || 'Done.')
});
def({ name: 'wait', scope: ['worker'], description: 'Wait for something to load.', parameters: obj({ seconds: num('1-15') }, ['seconds']), describe: a => `Wait ${a.seconds}s`, run: async a => { await sleep(Math.min(Math.max(Number(a.seconds) || 1, 0.5), 15) * 1000); return 'Waited.'; } });
def({ name: 'screenshot', scope: ['worker'], description: 'Take a fresh screenshot to see the current state.', describe: () => 'Look at screen', run: async () => 'Fresh screenshot attached.' });

def({
  name: 'do_task', scope: ['live'],
  description: 'Hand a multi-step job that needs seeing and operating the screen to the visual agent (e.g. "search YouTube for lo-fi beats and play the first result", "change the default browser", "fill in this form"). Give a complete, self-contained goal. Takes 10-90 seconds.',
  parameters: obj({ task: str('Complete description of the goal, including relevant details the user gave.') }, ['task']),
  describe: a => `Task: ${a.task}`,
  run: async a => {
    const task = String(a.task || ''), now = Date.now();
    // The same job asked again right after it finished is not repeated (the voice model sometimes "double-checks" by redoing it).
    const hit = recentTasks.find(d => now - d.at < 90000 && sameTask(d.task, task));
    if (hit) return `ALREADY DONE ${Math.round((now - hit.at) / 1000)} s ago: ${hit.result}\n[Do NOT run it again. Tell the user the result in one short sentence.]`;
    const res = String(await require('./worker').runTask(task));
    if (/^(ERROR|DENIED|Stopped by the user|I stopped because|I ran out of steps)/i.test(res)) return `TASK NOT COMPLETED: ${res}\n[Do not retry it by yourself or look for other ways. Tell the user plainly what blocked it and ask what they want.]`;
    recentTasks.unshift({ task, at: Date.now(), result: res.slice(0, 200) }); recentTasks.length = Math.min(recentTasks.length, 5);
    return `TASK COMPLETE: ${res}\n[The job is finished. Do NOT call do_task, look_at_screen or any other tool to check it, redo it or find another way. Tell the user the result in one short sentence. Only continue if their request had a separate part that is still not done.]`;
  }
});
const recentTasks = []; // finished do_task goals (newest first)
const taskWords = s => new Set(String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
function sameTask(a, b) { // mostly the same words = the same job
  const A = taskWords(a), B = taskWords(b); if (!A.size || !B.size) return false;
  let i = 0; for (const w of A) if (B.has(w)) i++;
  return i / (A.size + B.size - i) >= 0.7;
}

// ---------- extra tools (v1.8): calculator, weather, currency, documents, to-dos, notes, zip, calendar, e-mail... ----------
try {
  require('./extras')({ def, str, num, bool, oneOf, obj, app, shell, cfg, runtime, logger, safety, fuzzy, gemini, resolveLoose, resolvePath, resolveForCreate, guardWrite, displayPath, clip, fmtSize, runPowerShell, timed, UA, NO_LOG_ARGS });
} catch (e) { logger.log('extras-load', (e && e.stack) || e); }

// ---------- file converter (v1.9): pictures <-> pdf/png/jpg/webp, txt/md/html -> pdf, csv <-> json, plus optional free engines (FFmpeg, LibreOffice, pandoc, ImageMagick, Poppler) ----------
try {
  require('./converter')({ def, str, num, bool, oneOf, obj, app, shell, cfg, runtime, logger, safety, resolveLoose, resolvePath, resolveForCreate, guardWrite, clip, fmtSize });
} catch (e) { logger.log('converter-load', (e && e.stack) || e); }
try { // v1.9: background automations ("when X finishes, then do Y"), saved to disk and resumed at start-up
  require('./automation')({ def, str, num, bool, obj, oneOf, runtime, logger, resolveForCreate, clip, invoke: (n, a, c) => invoke(n, a, c), toolInfo: n => byName.get(n), runGoal: t => require('./worker').runTask(t), bridge, startHooks });
} catch (e) { logger.log('automation-load', (e && e.stack) || e); }
try { // v1.9: Windows diagnostics (read-only) and a fixed list of repairs (always ask first)
  require('./pcdoctor')({ def, str, num, obj, oneOf, runtime, logger, clip });
} catch (e) { logger.log('pcdoctor-load', (e && e.stack) || e); }
try { // v1.9: which programs hold a file or folder open (Windows Restart Manager, no extra program needed)
  require('./locksmith')({ def, str, obj, resolveLoose, clip, safety });
} catch (e) { logger.log('locksmith-load', (e && e.stack) || e); }

// ---------- public API ----------
const byName = new Map(REG.map(t => [t.name, t]));
function declarations(scope) {
  return REG.filter(t => t.scope.includes(scope)).map(t => {
    const d = { name: t.name, description: t.description };
    if (t.parameters && Object.keys(t.parameters.properties).length) d.parameters = t.parameters;
    return d;
  });
}

// Stops the endless-PowerShell loop: too many commands in a minute, or two refusals in a row, ends shell use for a while.
const shellLog = { calls: [], denied: [] };
function shellGuard() {
  const now = Date.now();
  shellLog.calls = shellLog.calls.filter(t => now - t < 60000); shellLog.denied = shellLog.denied.filter(t => now - t < 300000);
  if (shellLog.denied.length >= 2) return 'REFUSED: the user declined PowerShell commands twice just now. Do not run any more shell commands; tell the user what you were trying to do and ask how to proceed.';
  const max = Math.max(1, Math.min(50, Number(cfg.get().shellMaxCommands) || 10)); // the user's limit (Settings)
  if (shellLog.calls.length >= max) return `REFUSED: that is the limit of ${max} PowerShell commands per minute (the user can raise it in Settings). Stop trying variations; tell the user what is not working.`;
  shellLog.calls.push(now); return null;
}

const gateOk = new Map(); // approved safety-gate asks: key -> until
async function invokeInner(name, args, ctx = {}) {
  const t = byName.get(name);
  if (!t) return `ERROR: unknown tool "${name}".`;
  if (ctx.scope && !t.scope.includes(ctx.scope)) return `ERROR: tool "${name}" is not available here.`;
  args = args && typeof args === 'object' ? args : {};
  const desc = t.describe ? t.describe(args) : name;
  let level = Math.max(t.level(args), args.risky === true ? 2 : 0);
  let always = !!(t.alwaysAsk && t.alwaysAsk(args));
  // Safety-gate asks (risky click label, program file) are not repeated: not when you asked for it yourself, and not for 5 minutes after you approved the same thing in this task.
  const gk = t.gateKey ? t.gateKey(args, ctx) : null, memKey = gk ? (ctx.taskId || 'live') + '|' + gk : null;
  if (t.gateKey && args.risky !== true && (gk === null || (gateOk.get(memKey) || 0) > Date.now())) { level = Math.min(level, 1); always = false; }
  if (name === 'run_command') { const g = shellGuard(); if (g) return g; }
  if (safety.shouldAsk(level, cfg.get().autonomy, always)) {
    if (!ctx.quiet) runtime.emit('step', { kind: 'ask', text: desc });
    const ok = await runtime.requestApproval(desc, { taskId: ctx.taskId, alwaysAsk: always, shell: name === 'run_command' });
    if (ok !== true) {
      if (ok === 'timeout') return 'DENIED: nobody answered the approval prompt in time (the user may be away). Nothing was done. Do not retry; tell the user what is waiting for their approval.';
      if (ok === 'stopped') return 'DENIED: the user pressed stop. Do not retry; ask what they want next.';
      if (name === 'run_command') shellLog.denied.push(Date.now());
      return 'DENIED: the user did not approve this action. Do not retry it.';
    }
    if (memKey) gateOk.set(memKey, Date.now() + 5 * 60000);
  }
  if (runtime.signal().aborted) return 'ERROR: stopped by the user.';
  if (!ctx.quiet) { runtime.emit('step', { kind: 'act', text: desc }); runtime.emit('activity', { state: 'acting', text: desc }); }
  const t0 = Date.now();
  try {
    const out = await t.run(args, ctx);
    if (Date.now() - t0 > 3000) runtime.emit('step', { kind: 'info', text: `${name} took ${((Date.now() - t0) / 1000).toFixed(1)}s` });
    return typeof out === 'string' || (out && out.text !== undefined) ? out : JSON.stringify(out);
  } catch (e) {
    if (!ctx.quiet) runtime.emit('step', { kind: 'err', text: `${name}: ${e.message}` });
    logger.log('tool-error', `${name} ${NO_LOG_ARGS.has(name) ? '(args hidden)' : JSON.stringify(args, (k, v) => (typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '…' : v))} :: ${e.message}`);
    return `ERROR: ${e.message}`;
  } finally { if (!ctx.quiet) runtime.emit('activity', { state: 'idle' }); }
}

// Guard against the model repeating an action (it was re-asking to close a window in a loop):
// an identical approval-gated action that is already running is refused, and so is one that just succeeded.
const recent = new Map(); // key -> { pending } | { at, result }
const DEDUPE_MS = 15000;
// A tool that keeps getting the exact same action (after "done", or in a loop) is stopped: 4th identical call in 15 s is refused.
const repeatLog = new Map();
const REPEAT_EXEMPT = new Set(['press_keys', 'scroll', 'wait', 'zoom', 'screenshot', 'set_volume', 'media_control', 'look_at_screen', 'finish', 'point_at']);
function repeatGuard(t, name, a) {
  if (!t || REPEAT_EXEMPT.has(name) || name.startsWith('list_')) return null;
  let lv = 0; try { lv = t.level(a); } catch {}
  if (lv < 1) return null;
  const key = name + '|' + JSON.stringify(a, Object.keys(a).sort()), now = Date.now();
  const hits = (repeatLog.get(key) || []).filter(x => now - x < 15000);
  const limit = name === 'click_on' ? 2 : 3;
  if (hits.length >= limit) return `REFUSED: you have already done exactly this ${limit === 2 ? 'twice' : 'three times'} in the last few seconds. It is done. Tell the user the result in one sentence and stop; do not repeat it.`;
  hits.push(now); repeatLog.set(key, hits); return null;
}
async function invoke(name, args, ctx = {}) {
  const t = byName.get(name);
  const a = args && typeof args === 'object' ? args : {};
  const repeated = repeatGuard(t, name, a); if (repeated) return repeated;
  let guarded = false;
  try { guarded = !!t && (Math.max(t.level(a), a.risky === true ? 2 : 0) >= 2 || !!(t.alwaysAsk && t.alwaysAsk(a)) || !!(t.dedupe && t.dedupe(a))); } catch {}
  if (!guarded) return invokeInner(name, args, ctx);
  const key = name + '|' + JSON.stringify(a, Object.keys(a).sort());
  const hit = recent.get(key);
  if (hit && hit.pending) return 'ALREADY IN PROGRESS: this exact action is already running or waiting for the user. Do not call it again; just wait for its result.';
  if (hit && Date.now() - hit.at < DEDUPE_MS) return `ALREADY DONE a moment ago (${hit.result}). Do not repeat it unless the user asks again.`;
  recent.set(key, { pending: true });
  let out;
  try { out = await invokeInner(name, args, ctx); } catch (e) { recent.delete(key); throw e; }
  const text = String(typeof out === 'string' ? out : (out && out.text) || '');
  if (/^(ERROR|DENIED)/.test(text)) recent.delete(key); else recent.set(key, { at: Date.now(), result: text.slice(0, 100) });
  return out;
}

module.exports = { declarations, invoke, scheduleAll };
