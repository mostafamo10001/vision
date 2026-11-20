'use strict';
// Vision 1.9: automations. "When this download finishes, finish the installer, then save my work": a chain of WAIT steps and DO steps that
// runs in the background of the app (not in the voice session), is saved to disk so it resumes after a restart, and keeps Windows awake while it runs.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const { app, Notification, powerSaveBlocker } = require('electron');

const WAITS = ['wait_download', 'wait_file', 'wait_process_exit', 'wait_process_start', 'wait_window', 'wait_window_gone', 'wait_network_idle', 'wait_minutes'];
const DOS = ['do_goal', 'do_tool', 'notify'];
const KINDS = new Set([...WAITS, ...DOS]);
const NEVER_TOOLS = new Set(['automation', 'end_conversation']); // no automations inside automations
const TMP_RE = /\.(crdownload|part|partial|tmp|download|opdownload|!ut|aria2|filepart)$/i;
const MAX_JOBS = 8, MAX_STEPS = 12, DAY = 24 * 3600e3;
const base = n => String(n || '').toLowerCase().replace(/\.exe$/, '');

function register(h) {
  const { def, str, num, bool, obj, oneOf, runtime, logger, resolveForCreate, clip, invoke, toolInfo, runGoal, bridge, startHooks } = h;
  const T = Object.assign({ tickMs: 3000, stableMs: 5000, netIdleSec: 30, netKBps: 40, netNeverBusySec: 150, procGraceSec: 90 }, h.testOpts || {});
  const say = (kind, text) => runtime.emit('step', { kind, text });

  // ---------- storage ----------
  let data = null, timer = null, powerIds = { sys: null, disp: null }, uiChain = Promise.resolve();
  const file = () => path.join(app.getPath('userData'), 'automations.json');
  const load = () => {
    if (data) return data;
    try { data = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { data = {}; }
    if (!data || typeof data !== 'object') data = {};
    data.jobs = Array.isArray(data.jobs) ? data.jobs : []; data.history = Array.isArray(data.history) ? data.history : [];
    return data;
  };
  const save = () => { try { fs.mkdirSync(path.dirname(file()), { recursive: true }); const tmp = file() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, file()); } catch (e) { logger.log('automation-save', e.message); } };
  const running = () => load().jobs.filter(j => j.status === 'running');
  const logLine = (job, text) => { job.log.push({ t: Date.now(), text: String(text).slice(0, 300) }); if (job.log.length > 40) job.log.shift(); };

  // ---------- helpers ----------
  const exec = (cmd, args) => new Promise(res => execFile(cmd, args, { windowsHide: true, timeout: 15000, maxBuffer: 4e6, encoding: 'utf8' }, (e, out) => res(e && !out ? '' : String(out || ''))));
  let procCache = { t: 0, names: [] };
  async function processNames() {
    if (Date.now() - procCache.t < 1500) return procCache.names;
    const out = await exec('tasklist', ['/FO', 'CSV', '/NH']);
    procCache = { t: Date.now(), names: out.split(/\r?\n/).map(l => (l.match(/^"([^"]+)"/) || [])[1]).filter(Boolean) };
    return procCache.names;
  }
  async function findProcess(target) { // -> the running program's name, or null
    const t = String(target || '').trim();
    if (/^\d+$/.test(t)) { const out = await exec('tasklist', ['/FI', `PID eq ${t}`, '/FO', 'CSV', '/NH']); const m = out.match(new RegExp(`^"([^"]+)","${t}"`, 'm')); return m ? m[1] : null; }
    const names = await processNames(), b = base(t);
    return names.find(n => base(n) === b) || names.find(n => base(n).includes(b)) || null;
  }
  async function findWindow(target) {
    const r = await bridge.call('windows', {}, 5000), w = (r && r.windows) || [], q = String(target).toLowerCase();
    return w.find(x => String(x.title || '').toLowerCase().includes(q)) || null;
  }
  function netBytes(out) { // first line of "netstat -e" that holds two numbers (received, sent)
    for (const l of out.split(/\r?\n/)) {
      const tok = l.trim().split(/\s{2,}/); if (tok.length < 3) continue;
      const a = Number(tok[1].replace(/\D/g, '')), b = Number(tok[2].replace(/\D/g, ''));
      if (a > 0 || b > 0) return a;
    }
    return null;
  }
  const fill = (s, v) => String(s).replace(/\{(file|name|folder|process|window|last)\}/g, (m, k) => (v[k] != null && v[k] !== '' ? v[k] : m));
  const deepFill = (x, v) => (typeof x === 'string' ? fill(x, v) : Array.isArray(x) ? x.map(i => deepFill(i, v)) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, val]) => [k, deepFill(val, v)])) : x);
  const notify = (title, body) => { try { new Notification({ title, body: String(body).slice(0, 220) }).show(); } catch {} };

  function describeStep(s) {
    switch (s.kind) {
      case 'wait_download': return `wait for a download to finish in ${s.folder || 'Downloads'}${s.target ? ` (name contains "${s.target}")` : ''}`;
      case 'wait_file': return `wait for the file ${s.target} to appear and finish being written`;
      case 'wait_process_exit': return `wait for ${s.target} to close`;
      case 'wait_process_start': return `wait for ${s.target} to start`;
      case 'wait_window': return `wait for a window titled "${s.target}"`;
      case 'wait_window_gone': return `wait for the window "${s.target}" to close`;
      case 'wait_network_idle': return 'wait until the network goes quiet (a download or update has finished)';
      case 'wait_minutes': return `wait ${s.minutes} minute(s)`;
      case 'do_goal': return `do on screen: ${clip(s.text, 100)}`;
      case 'do_tool': return `run ${s.tool}`;
      default: return `tell you: ${clip(s.text, 80)}`;
    }
  }

  function normStep(raw, i) {
    const n = i + 1, kind = String((raw && raw.kind) || '').trim().toLowerCase();
    if (!KINDS.has(kind)) throw new Error(`Step ${n}: unknown kind "${raw && raw.kind}". Use one of: ${[...KINDS].join(', ')}.`);
    const s = { kind, target: String(raw.target || '').trim(), folder: String(raw.folder || '').trim(), text: String(raw.text || '').trim(), tool: String(raw.tool || '').trim(), cont: raw.continue_on_error === true };
    const tm = Number(raw.timeout_minutes); s.timeoutMin = tm > 0 ? Math.min(1440, tm) : 360;
    if (['wait_file', 'wait_process_exit', 'wait_process_start', 'wait_window', 'wait_window_gone'].includes(kind) && !s.target) throw new Error(`Step ${n} (${kind}) needs "target".`);
    if (kind === 'wait_minutes') { s.minutes = Number(raw.minutes); if (!(s.minutes > 0 && s.minutes <= 1440)) throw new Error(`Step ${n}: "minutes" must be between 0 and 1440.`); }
    if (kind === 'do_goal' || kind === 'notify') { if (!s.text) throw new Error(`Step ${n} (${kind}) needs "text".`); }
    if (kind === 'do_tool') {
      if (!s.tool || NEVER_TOOLS.has(s.tool) || !toolInfo(s.tool)) throw new Error(`Step ${n}: "${s.tool}" is not a tool I can run in an automation.`);
      try { s.args = raw.args_json ? JSON.parse(raw.args_json) : {}; } catch { throw new Error(`Step ${n}: args_json is not valid JSON.`); }
      if (!s.args || typeof s.args !== 'object' || Array.isArray(s.args)) throw new Error(`Step ${n}: args_json must be a JSON object.`);
    }
    return s;
  }

  // ---------- power: keep Windows awake while jobs run ----------
  function updatePower() {
    const jobs = running(), need = jobs.some(j => j.keepAwake !== false);
    const visual = jobs.some(j => j.keepAwake !== false && j.steps.slice(j.stepIndex).some(s => s.kind === 'do_goal'));
    const set = (key, type, on) => {
      try {
        if (on && powerIds[key] == null) powerIds[key] = powerSaveBlocker.start(type);
        else if (!on && powerIds[key] != null) { powerSaveBlocker.stop(powerIds[key]); powerIds[key] = null; }
      } catch (e) { logger.log('automation-power', e.message); }
    };
    set('sys', 'prevent-app-suspension', need); set('disp', 'prevent-display-sleep', visual);
  }
  function ensureTimer() { if (!timer && running().length) timer = setInterval(tick, T.tickMs); if (timer && !running().length) { clearInterval(timer); timer = null; } updatePower(); }

  // ---------- finishing ----------
  function finish(job, status, msg) {
    job.status = status; job.finishedAt = Date.now(); job.error = status === 'failed' ? msg : undefined; logLine(job, `${status}${msg ? ': ' + msg : ''}`);
    const d = load(); d.jobs = d.jobs.filter(j => j.id !== job.id);
    d.history.unshift({ id: job.id, name: job.name, status, msg: String(msg || '').slice(0, 300), at: job.finishedAt, steps: job.steps.length, doneSteps: job.stepIndex, log: job.log.slice(-8) }); d.history = d.history.slice(0, 20);
    save(); ensureTimer();
    if (status === 'cancelled') return;
    const text = status === 'done' ? `Automation "${job.name}" finished.${msg ? ' ' + msg : ''}` : `Automation "${job.name}" stopped: ${msg}`;
    notify(status === 'done' ? 'Vision: automation finished' : 'Vision: automation stopped', text); say(status === 'done' ? 'sys' : 'err', text); runtime.emit('reminder', text);
  }
  function next(job) { job.stepIndex++; job.stepStartedAt = Date.now(); job.state = {}; job.inDo = false; if (job.stepIndex >= job.steps.length) { finish(job, 'done', job.vars.lastKind === 'do_goal' && job.vars.last ? clip(job.vars.last, 200) : ''); return; } save(); updatePower(); }

  // ---------- waits: return null (not yet), or an object of values to remember ----------
  async function checkWait(job, st) {
    const s = job.state;
    switch (st.kind) {
      case 'wait_minutes': return Date.now() - job.stepStartedAt >= st.minutes * 60000 ? {} : null;
      case 'wait_download': {
        const dir = st.folder ? resolveForCreate(fill(st.folder, job.vars)) : app.getPath('downloads');
        let names; try { names = await fsp.readdir(dir); } catch { throw new Error(`I cannot read the folder ${dir}.`); }
        if (!s.snap) { s.snap = {}; for (const n of names) { try { s.snap[n] = (await fsp.stat(path.join(dir, n))).mtimeMs; } catch {} } s.seen = {}; save(); return null; }
        const want = fill(st.target, job.vars).toLowerCase(), now = Date.now();
        for (const n of names) {
          if (TMP_RE.test(n) || (want && !n.toLowerCase().includes(want))) continue;
          const fp = path.join(dir, n); let stt; try { stt = await fsp.stat(fp); } catch { continue; }
          if (!stt.isFile() || (n in s.snap && stt.mtimeMs <= s.snap[n] + 1000)) continue; // was already there before we started waiting
          if (names.some(x => x !== n && x.toLowerCase().startsWith(n.toLowerCase()) && TMP_RE.test(x))) continue; // browser still has a .crdownload for it
          const k = s.seen[n];
          if (!k || k.size !== stt.size) { s.seen[n] = { size: stt.size, since: now }; continue; }
          if (now - k.since >= T.stableMs && stt.size > 0) return { file: fp, name: n, folder: dir };
        }
        return null;
      }
      case 'wait_file': {
        const fp = resolveForCreate(fill(st.target, job.vars)); let stt; try { stt = await fsp.stat(fp); } catch { s.k = null; return null; }
        if (!stt.isFile()) throw new Error(`${fp} is a folder, not a file.`);
        if (!s.k || s.k.size !== stt.size) { s.k = { size: stt.size, since: Date.now() }; return null; }
        return Date.now() - s.k.since >= T.stableMs && stt.size > 0 ? { file: fp, name: path.basename(fp), folder: path.dirname(fp) } : null;
      }
      case 'wait_process_exit': {
        const tgt = fill(st.target, job.vars), p = await findProcess(tgt);
        if (p) { s.seen = true; s.name = p; return null; }
        if (s.seen) return { process: s.name || tgt };
        if (Date.now() - job.stepStartedAt > T.procGraceSec * 1000) throw new Error(`I never saw ${tgt} running, so I cannot tell when it finishes.`);
        return null;
      }
      case 'wait_process_start': { const p = await findProcess(fill(st.target, job.vars)); return p ? { process: p } : null; }
      case 'wait_window': { const w = await findWindow(fill(st.target, job.vars)); return w ? { window: String(w.title) } : null; }
      case 'wait_window_gone': {
        const tgt = fill(st.target, job.vars), w = await findWindow(tgt);
        if (w) { s.seen = true; return null; }
        if (s.seen) return {};
        if (Date.now() - job.stepStartedAt > T.procGraceSec * 1000) throw new Error(`I never saw a window titled "${tgt}".`);
        return null;
      }
      case 'wait_network_idle': {
        const now = Date.now(), b = netBytes(await exec('netstat', ['-e']));
        if (b == null) throw new Error('I could not read the network counters.');
        if (s.last == null) { s.last = b; s.lastT = now; return null; }
        if (now - s.lastT < 2000) return null;
        const kbps = Math.max(0, (b - s.last) / 1024 / ((now - s.lastT) / 1000)); s.last = b; s.lastT = now;
        if (kbps > T.netKBps) { s.busy = true; s.quietSince = null; return null; }
        s.quietSince = s.quietSince || now;
        if (s.busy && now - s.quietSince >= T.netIdleSec * 1000) return {};
        if (!s.busy && now - job.stepStartedAt > T.netNeverBusySec * 1000) throw new Error('I never saw any network activity to wait for.');
        return null;
      }
      default: throw new Error('Unknown wait.');
    }
  }
  // Only one on-screen task at a time (the screen and mouse are shared by every job and by the user's own requests).
  const onScreen = fn => { const r = uiChain.then(fn, fn); uiChain = r.catch(() => {}); return r; };
  const failedText = r => /^(ERROR|DENIED|ALREADY IN PROGRESS)/.test(r) || /^Stopped by the user/.test(r) || /^I (stopped because|ran out of steps)/.test(r);

  async function runDo(job, st) {
    if (st.kind === 'notify') { const m = fill(st.text, job.vars); notify('Vision', m); say('sys', m); runtime.emit('reminder', m); return; }
    job.inDo = true; save(); // if Vision dies in the middle of an action it is NOT repeated automatically after a restart
    let res;
    if (st.kind === 'do_goal') {
      const goal = 'UNATTENDED AUTOMATION STEP (the user is probably away). Do only this, nothing more: ' + fill(st.text, job.vars) +
        '\nDo not install extra software, accept offers or toolbars, or change settings that were not asked for. If something unexpected or risky appears, stop and report it instead of guessing.';
      res = String(await onScreen(() => runGoal(goal)));
    } else {
      const info = toolInfo(st.tool);
      if (!info) throw new Error(`The tool ${st.tool} no longer exists.`);
      const out = await invoke(st.tool, deepFill(st.args, job.vars), { scope: info.scope[0] });
      res = String(typeof out === 'string' ? out : (out && out.text) || '');
    }
    job.vars.last = res.slice(0, 400); job.vars.lastKind = st.kind;
    if (failedText(res)) throw new Error(clip(res, 250));
  }

  async function advance(job) {
    if (job.busy || job.status !== 'running') return;
    job.busy = true;
    try {
      if (Date.now() - job.createdAt > 2 * DAY) return finish(job, 'failed', 'it was still running after 48 hours.');
      const st = job.steps[job.stepIndex];
      if (!st) return finish(job, 'done', '');
      try {
        if (WAITS.includes(st.kind)) {
          if (st.kind !== 'wait_minutes' && Date.now() - job.stepStartedAt > st.timeoutMin * 60000) throw new Error(`gave up waiting after ${st.timeoutMin} minutes (${describeStep(st)}).`);
          const got = await checkWait(job, st);
          if (!got) return;
          Object.assign(job.vars, got); logLine(job, `step ${job.stepIndex + 1} done: ${describeStep(st)}${got.file ? ' -> ' + got.file : ''}`);
        } else { await runDo(job, st); logLine(job, `step ${job.stepIndex + 1} done: ${describeStep(st)}`); }
      } catch (e) {
        if (st.cont) { logLine(job, `step ${job.stepIndex + 1} failed, continuing: ${e.message}`); say('err', `Automation "${job.name}" step ${job.stepIndex + 1} failed (continuing): ${e.message}`); }
        else return finish(job, 'failed', `step ${job.stepIndex + 1} (${describeStep(st)}): ${e.message}`);
      }
      next(job);
    } catch (e) { logger.log('automation', e.stack || e.message); finish(job, 'failed', e.message); }
    finally { job.busy = false; }
  }
  async function tick() { for (const job of running()) advance(job); }

  // ---------- start-up: resume what was running ----------
  function start() {
    const d = load();
    for (const job of d.jobs.slice()) {
      if (job.status !== 'running') continue;
      job.busy = false; job.log = job.log || []; job.vars = job.vars || {};
      if (job.inDo) { finish(job, 'failed', `Vision restarted while step ${job.stepIndex + 1} (${describeStep(job.steps[job.stepIndex] || {})}) was running, so it was not repeated automatically. Ask me to set it up again if you still need it.`); continue; }
      job.state = job.state || {}; logLine(job, 'resumed after Vision restarted');
    }
    save(); ensureTimer();
    if (running().length) say('info', `Resuming ${running().length} automation(s) that were running.`);
  }
  if (Array.isArray(startHooks)) startHooks.push(start);

  // ---------- the tool ----------
  const STEP = obj({
    kind: oneOf('What this step does.', [...KINDS]),
    target: str('wait_download: part of the file name (optional). wait_file: full path of the file. wait_process_exit / wait_process_start: program name such as "setup.exe" or a PID. wait_window / wait_window_gone: part of the window title.'),
    folder: str('wait_download only: folder to watch (default: Downloads).'),
    text: str('do_goal: what to do on the screen, in plain words (the on-screen agent does it; you can use {file}, {name}, {folder}, {process}, {window}, {last}). notify: the message to tell the user.'),
    tool: str('do_tool: exact name of the tool to run.'),
    args_json: str('do_tool: the tool arguments as a JSON object string, e.g. {"path":"{file}"}.'),
    minutes: num('wait_minutes: how many minutes to wait.'),
    timeout_minutes: num('Wait steps: give up after this many minutes (default 360, max 1440).'),
    continue_on_error: bool('If this step fails, carry on with the next one instead of stopping the automation.')
  }, ['kind']);

  def({
    name: 'automation', scope: ['live'],
    description: 'Run a chain of steps in the BACKGROUND, even when the voice chat ends, the window is closed or the PC is left alone: it keeps Windows awake, is saved to disk and resumes if Vision restarts, and tells the user when it finishes or fails. Use it for "when X finishes, then do Y, then Z": e.g. "when this download ends, open the installer and finish the installation", "when the installer closes, save the document", "in 30 minutes close X". Steps run in order. WAIT steps: wait_download (a new file finishes downloading), wait_file, wait_process_exit / wait_process_start, wait_window / wait_window_gone, wait_network_idle (downloads inside apps such as Steam or Windows Update), wait_minutes. DO steps: do_goal (the on-screen agent does something described in words), do_tool (run any Vision tool with JSON arguments), notify (tell the user). Later steps can use {file}, {name}, {folder}, {process}, {window}, {last} from earlier steps. Actions that need approval still ask the user when they run. Use action list to see running ones and action cancel to stop one (or "all").',
    parameters: obj({
      action: oneOf('create (default), list or cancel.', ['create', 'list', 'cancel']),
      name: str('create: a short name for the automation.'),
      steps: { type: 'ARRAY', description: 'create: the steps, in order (at most 12). Usually start with a wait step.', items: STEP },
      keep_awake: bool('create: keep Windows from sleeping while it runs (default true).'),
      id: str('cancel: the automation id from list, or "all".')
    }, ['action']),
    level: a => (a.action === 'create' || !a.action ? 1 : 0),
    describe: a => (a.action === 'cancel' ? `Cancel automation ${a.id || ''}` : a.action === 'list' ? 'List automations' : `Create automation: ${clip(String(a.name || ''), 80)}`),
    run: async a => {
      const act = a.action || 'create', d = load();
      if (act === 'list') {
        const lines = running().map(j => `- ${j.id} "${j.name}": step ${j.stepIndex + 1} of ${j.steps.length}, now ${describeStep(j.steps[j.stepIndex] || {})}; running for ${Math.round((Date.now() - j.createdAt) / 60000)} min`);
        const hist = d.history.slice(0, 5).map(x => `- ${x.id} "${x.name}": ${x.status}${x.msg ? ' (' + clip(x.msg, 120) + ')' : ''}`);
        return (lines.length ? 'Running:\n' + lines.join('\n') : 'No automations are running.') + (hist.length ? '\nRecently finished:\n' + hist.join('\n') : '');
      }
      if (act === 'cancel') {
        const id = String(a.id || '').trim().toLowerCase(); if (!id) throw new Error('Say which automation (id from list, or "all").');
        const hit = running().filter(j => id === 'all' || j.id.toLowerCase() === id || j.name.toLowerCase().includes(id));
        if (!hit.length) throw new Error('No running automation matches that.');
        hit.forEach(j => finish(j, 'cancelled', 'cancelled by the user')); return `Cancelled ${hit.length} automation(s): ${hit.map(j => j.name).join(', ')}.`;
      }
      if (running().length >= MAX_JOBS) throw new Error(`There are already ${MAX_JOBS} automations running; cancel one first.`);
      const raw = Array.isArray(a.steps) ? a.steps : [];
      if (!raw.length) throw new Error('An automation needs at least one step.');
      if (raw.length > MAX_STEPS) throw new Error(`At most ${MAX_STEPS} steps.`);
      const steps = raw.map(normStep);
      const job = {
        id: 'a' + Date.now().toString(36).slice(-5), name: String(a.name || 'Automation').slice(0, 60), createdAt: Date.now(), status: 'running', keepAwake: a.keep_awake !== false,
        steps: steps.map(s => ({ ...s })), stepIndex: 0, stepStartedAt: Date.now(), state: {}, vars: {}, log: [], busy: false, inDo: false
      };
      d.jobs.push(job); logLine(job, 'created'); save(); ensureTimer(); advance(job);
      return `Automation ${job.id} "${job.name}" is running in the background:\n${steps.map((s, i) => `${i + 1}. ${describeStep(s)}`).join('\n')}\n${job.keepAwake ? 'Windows is kept awake while it runs. ' : ''}It continues if the voice chat ends or the window is closed, resumes if Vision restarts, and notifies the user when it finishes or fails. Tell the user this briefly.`;
    }
  });
}

module.exports = register;
