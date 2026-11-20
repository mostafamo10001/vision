'use strict';
// Dictation and recordings -> a text file. Audio is only sent to Gemini when a recording STOPS (or when you hand over a file):
// there is no live voice session, so nothing answers you back and the cost is tiny compared with a long conversation.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { app, shell, Notification, clipboard } = require('electron');
const cfg = require('./config');
const gemini = require('./gemini');
const runtime = require('./runtime');
const logger = require('./log');

const RATE = 16000, SEG_BYTES = RATE * 2 * 420; // 7 minutes of 16 kHz mono 16-bit per request (about the largest that fits an inline request)
const MAX_RECORD_MS = 90 * 60 * 1000, INLINE_LIMIT = 14 * 1024 * 1024, UPLOAD_LIMIT = 1024 * 1024 * 1024;
const PROMPT = 'Transcribe this audio exactly as spoken, in the original language(s) (do not translate). Output plain text only: no commentary, no timestamps. Start a new paragraph when the speaker pauses or changes topic. If several different speakers are clearly distinguishable, label them "Speaker 1:", "Speaker 2:". If there is no speech at all, reply exactly: [no speech detected]';
const AUDIO_TYPES = { '.wav': 'audio/wav', '.mp3': 'audio/mp3', '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mpeg': 'video/mpeg', '.mov': 'video/mov' };

let rec = null, stateListener = () => {}, waitScale = 1; // waitScale: lets tests skip the quota waits
const outDir = () => path.join(app.getPath('documents'), 'Vision Transcripts');
const recDir = () => path.join(app.getPath('userData'), 'recordings');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`; };
const notify = (title, body) => { try { new Notification({ title, body, silent: true }).show(); } catch {} };
const say = (kind, text) => runtime.emit('step', { kind, text });

function wavHeader(dataLen) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataLen, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(dataLen, 40);
  return h;
}

// ---------- silence removal ----------
// Long pauses are cut down to ~1.2 s before anything is sent: fewer minutes of audio means fewer requests against the quota.
async function trimToWav(pcmPath, wavPath) {
  const data = await fsp.readFile(pcmPath), B = 3200, n = Math.floor(data.length / B); // 100 ms blocks
  if (n < 1) return { speech: false, total: data.length, kept: 0 };
  const rms = new Float64Array(n);
  for (let b = 0; b < n; b++) { let sum = 0; const o = b * B; for (let i = 0; i < B; i += 2) { const v = data.readInt16LE(o + i); sum += v * v; } rms[b] = Math.sqrt(sum / (B / 2)); }
  const sorted = Float64Array.from(rms).sort(), floor = sorted[Math.floor(n * 0.1)], loud = sorted[Math.floor(n * 0.9)];
  // 3x the background level, but never more than 35% of how loud the recording is: steady audio with no pauses must not be thrown away
  const thr = Math.min(Math.max(floor * 3, 150), loud * 0.35);
  const voiced = new Uint8Array(n); let voicedCount = 0;
  for (let b = 0; b < n; b++) if (rms[b] > thr) { voiced[b] = 1; voicedCount++; }
  if (voicedCount < 3) return { speech: false, total: n * B, kept: 0 };
  const PAD = 6, pre = new Int32Array(n + 1); for (let b = 0; b < n; b++) pre[b + 1] = pre[b] + voiced[b]; // keep 0.6 s around anything voiced
  const keep = new Uint8Array(n); let keptBlocks = 0;
  for (let b = 0; b < n; b++) { const lo = Math.max(0, b - PAD), hi = Math.min(n, b + PAD + 1); if (pre[hi] - pre[lo] > 0) { keep[b] = 1; keptBlocks++; } }
  const ws = fs.createWriteStream(wavPath);
  const write = async buf => { if (!ws.write(buf)) await new Promise(res => ws.once('drain', res)); };
  await write(wavHeader(keptBlocks * B));
  for (let b = 0; b < n;) { if (!keep[b]) { b++; continue; } let e = b; while (e < n && keep[e]) e++; await write(data.subarray(b * B, e * B)); b = e; }
  await new Promise(res => ws.end(res));
  return { speech: true, total: n * B, kept: keptBlocks * B };
}

// ---------- recording (the window captures the audio, this side writes it to disk) ----------
function start(source) {
  if (rec) throw new Error('Already recording. Press Ctrl+Alt+T (or use the tray menu) to stop.');
  fs.mkdirSync(recDir(), { recursive: true });
  const file = path.join(recDir(), `rec-${Date.now()}.pcm`);
  rec = { source, file, stream: fs.createWriteStream(file), bytes: 0, timer: null, failsafe: null, finishing: false, label: source === 'system' ? 'System audio' : 'Dictation' };
  rec.timer = setTimeout(() => { try { stop(); } catch {} }, MAX_RECORD_MS);
  runtime.emit('transcribe-start', { source });
  stateListener(true);
  notify('Vision is recording', (source === 'system' ? 'Capturing the audio playing on this PC.' : 'Listening to your microphone.') + ' Press Ctrl+Alt+T to stop.');
  say('sys', `Recording ${source === 'system' ? 'system audio' : 'the microphone'}… press Ctrl+Alt+T to stop.`);
  return `Recording ${source === 'system' ? 'the audio playing on this PC' : 'your microphone'}. Press Ctrl+Alt+T (or use the tray menu) to stop; the text will be saved and opened.`;
}
function chunk(buf) { if (rec && rec.stream && !rec.finishing) { const b = Buffer.from(buf); rec.stream.write(b); rec.bytes += b.length; } }
function stop() {
  if (!rec) throw new Error('Nothing is being recorded.');
  if (rec.stopping) return 'Already stopping.';
  rec.stopping = true;
  runtime.emit('transcribe-stop');
  rec.failsafe = setTimeout(() => finish().catch(() => {}), 5000); // if the window never answers, finish with what we have
  return 'Stopped. Transcribing now; the text file will open when it is ready.';
}
const toggle = source => (rec ? stop() : start(source));
function fail(msg) { // the window could not record (microphone blocked, no system audio...)
  if (!rec) return;
  const r = rec; rec = null; clearTimeout(r.timer); clearTimeout(r.failsafe); stateListener(false);
  try { r.stream.destroy(); fs.unlink(r.file, () => {}); } catch {}
  say('err', 'Recording failed: ' + msg); notify('Vision recording failed', String(msg).slice(0, 120));
  logger.log('transcribe', 'record failed: ' + msg);
}
async function finish() {
  const r = rec;
  if (!r || r.finishing) return;
  r.finishing = true; rec = null; clearTimeout(r.timer); clearTimeout(r.failsafe); stateListener(false);
  await new Promise(res => r.stream.end(res));
  if (r.bytes < RATE * 2) { fs.unlink(r.file, () => {}); say('info', 'Nothing was recorded.'); notify('Vision', 'Nothing was recorded.'); return; }
  const wavPath = path.join(outDir(), `${r.label} recording ${stamp()}.wav`);
  let t;
  try { await fsp.mkdir(outDir(), { recursive: true }); t = await trimToWav(r.file, wavPath); fs.unlink(r.file, () => {}); }
  catch (e) { return failure(e, r.file); }
  if (!t.speech) { fsp.unlink(wavPath).catch(() => {}); say('info', 'No speech or sound was detected, so nothing was sent to Gemini.'); notify('Vision', 'No speech was detected in the recording.'); return; }
  const secs = b => Math.round(b / (RATE * 2));
  say('info', `Recorded ${secs(t.total)} s; ${secs(t.kept)} s remain after removing silence. Transcribing…`);
  try { const parts = await transcribeOwnWav(wavPath); await saveTranscript(parts.filter(Boolean).join('\n\n'), r.label, wavPath); fsp.unlink(wavPath).catch(() => {}); }
  catch (e) { await failure(e, wavPath); }
}

// ---------- Gemini ----------
async function askGemini(src) {
  const part = src.fileUri ? { fileData: { mimeType: src.mime, fileUri: src.fileUri } } : { inlineData: { mimeType: src.mime, data: src.inline } };
  const res = await gemini.generate('fast', { contents: [{ role: 'user', parts: [{ text: PROMPT }, part] }], generationConfig: { temperature: 0.1 } }, { timeoutMs: 180000, budgetMs: 420000 });
  return gemini.textOf(res).trim();
}
// A quota/timeout error is usually a per-minute limit: wait it out and retry the same piece instead of losing everything.
async function askWithRetry(src, label) {
  for (let attempt = 0; ; attempt++) {
    try { return await askGemini(src); }
    catch (e) {
      if (!(e && (e.status === 429 || e.status === 408)) || attempt >= 3) throw e;
      const wait = 65 + attempt * 20;
      say('info', `Gemini quota pause${label ? ' (' + label + ')' : ''}: waiting ${wait} s, then trying again…`);
      await sleep(wait * 1000 * waitScale);
    }
  }
}
// Our own recordings: 44-byte header + PCM, cut into 7-minute pieces. Progress is saved after every piece,
// so a quota stop in the middle loses nothing: run it again and it continues from where it stopped.
async function transcribeOwnWav(wavPath) {
  const st = await fsp.stat(wavPath), dataLen = st.size - 44, total = Math.ceil(dataLen / SEG_BYTES), side = wavPath + '.progress.json';
  let prog = { parts: [] };
  try { const j = JSON.parse(await fsp.readFile(side, 'utf8')); if (Array.isArray(j.parts)) prog = j; } catch {}
  if (prog.parts.length) say('info', `Continuing from part ${prog.parts.length + 1} of ${total} (earlier parts are already done).`);
  const fh = await fsp.open(wavPath, 'r');
  try {
    for (let i = prog.parts.length; i < total; i++) {
      const off = i * SEG_BYTES, len = Math.min(SEG_BYTES, dataLen - off);
      if (len < RATE) { prog.parts.push(''); continue; } // a tail shorter than half a second
      const buf = Buffer.alloc(len); await fh.read(buf, 0, len, 44 + off);
      if (total > 1) say('info', `Transcribing part ${i + 1} of ${total}…`);
      let text;
      try { text = await askWithRetry({ inline: Buffer.concat([wavHeader(len), buf]).toString('base64'), mime: 'audio/wav' }, `part ${i + 1} of ${total}`); }
      catch (e) { e.partial = prog.parts.filter(Boolean).join('\n\n'); e.done = prog.parts.length; e.total = total; throw e; }
      prog.parts.push(text); await fsp.writeFile(side, JSON.stringify(prog));
    }
  } finally { await fh.close(); }
  fsp.unlink(side).catch(() => {});
  return prog.parts;
}
function isOwnWav(p) { // 16 kHz mono 16-bit PCM with a plain 44-byte header (what Vision records)
  try { const fd = fs.openSync(p, 'r'), h = Buffer.alloc(44); fs.readSync(fd, h, 0, 44, 0); fs.closeSync(fd);
    return h.toString('ascii', 0, 4) === 'RIFF' && h.toString('ascii', 8, 12) === 'WAVE' && h.toString('ascii', 36, 40) === 'data' && h.readUInt32LE(24) === RATE && h.readUInt16LE(22) === 1 && h.readUInt16LE(34) === 16; }
  catch { return false; }
}
async function uploadFile(p, mime, size) { // Gemini Files API: for anything too big to send inline
  const key = cfg.getKey(); if (!key) throw new Error('No Gemini API key set.');
  const BASE = 'https://generativelanguage.googleapis.com';
  const begin = await fetch(`${BASE}/upload/v1beta/files`, { method: 'POST', headers: { 'x-goog-api-key': key, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start', 'X-Goog-Upload-Header-Content-Length': String(size), 'X-Goog-Upload-Header-Content-Type': mime, 'Content-Type': 'application/json' }, body: JSON.stringify({ file: { display_name: path.basename(p) } }) });
  if (!begin.ok) throw new Error(`Upload could not start (HTTP ${begin.status})`);
  const url = begin.headers.get('x-goog-upload-url'); if (!url) throw new Error('Upload address missing from the reply.');
  const up = await fetch(url, { method: 'POST', headers: { 'Content-Length': String(size), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }, body: await fsp.readFile(p) });
  if (!up.ok) throw new Error(`Upload failed (HTTP ${up.status})`);
  const info = (await up.json()).file || {};
  for (let i = 0; i < 90 && info.state && info.state !== 'ACTIVE'; i++) { // wait until Gemini has processed it
    await sleep(2000);
    const s = await (await fetch(`${BASE}/v1beta/${info.name}`, { headers: { 'x-goog-api-key': key } })).json();
    info.state = s.state; if (s.state === 'FAILED') throw new Error('Gemini could not process that file.');
  }
  return { ...info, remove: () => fetch(`${BASE}/v1beta/${info.name}`, { method: 'DELETE', headers: { 'x-goog-api-key': key } }).catch(() => {}) };
}
async function transcribeAny(p, mime, size) {
  if (size <= INLINE_LIMIT) return askWithRetry({ inline: (await fsp.readFile(p)).toString('base64'), mime });
  say('info', 'Large file: uploading to Gemini first…');
  const f = await uploadFile(p, mime, size);
  try { return await askWithRetry({ fileUri: f.uri, mime }); } finally { f.remove(); }
}

// ---------- an existing audio/video file ----------
function fromFile(p) {
  const ext = path.extname(p).toLowerCase(), mime = AUDIO_TYPES[ext];
  if (!mime) throw new Error(`I can transcribe ${Object.keys(AUDIO_TYPES).join(' ')} files; this one is "${ext || 'no extension'}".`);
  let st; try { st = fs.statSync(p); } catch { throw new Error('That file does not exist.'); }
  if (!st.isFile()) throw new Error('That is not a file.');
  if (st.size > UPLOAD_LIMIT) throw new Error('That file is over 1 GB, which is too big to send.');
  const name = path.basename(p);
  say('info', `Transcribing ${name}…`); notify('Vision', `Transcribing ${name}…`);
  (async () => {
    try {
      if (ext === '.wav' && isOwnWav(p)) { // resumable, piece by piece
        const parts = await transcribeOwnWav(p);
        await saveTranscript(parts.filter(Boolean).join('\n\n'), path.basename(p, ext), null);
        if (path.dirname(p) === outDir() && /recording/i.test(name)) fsp.unlink(p).catch(() => {}); // a recording Vision kept after an earlier failure
      } else await saveTranscript(await transcribeAny(p, mime, st.size), path.basename(p, ext), null);
    } catch (e) { await failure(e, ext === '.wav' && isOwnWav(p) ? p : null); }
  })();
  return `Transcribing "${name}" in the background. The text file will open when it is ready.`;
}

// ---------- result ----------
async function saveTranscript(text, label, audioKept, quiet) {
  text = String(text || '').trim();
  await fsp.mkdir(outDir(), { recursive: true });
  const file = path.join(outDir(), `${label} - transcript ${stamp()}.txt`);
  await fsp.writeFile(file, '\ufeff' + text + '\n', 'utf8'); // BOM so Notepad shows Arabic and other scripts correctly
  try { clipboard.writeText(text); } catch {}
  shell.openPath(file).catch(() => {});
  const words = text ? text.split(/\s+/).length : 0;
  if (!quiet) { notify('Transcript ready', `${words} words. Saved and copied to the clipboard.`); say('sys', `Transcript saved: ${file} (${words} words, also copied to the clipboard).`); }
  return file;
}
async function failure(e, keptAudio) {
  logger.log('transcribe', `failed: ${e.message}`);
  let saved = '';
  if (e.partial) { // keep the finished pieces as a text file so nothing is lost
    try { saved = await saveTranscript(e.partial, `${keptAudio ? path.basename(keptAudio, '.wav') : 'Transcript'} (partial ${e.done} of ${e.total} parts)`, null, true); } catch {}
  }
  const keep = keptAudio ? ` Your recording is kept at ${keptAudio}: when Gemini works again, say "transcribe that file" and it continues where it stopped.` : '';
  say('err', `Transcription stopped: ${String(e.message).replace(/[.\s]+$/, '')}.${saved ? ` The part finished so far (${e.done} of ${e.total}) was saved to ${saved}.` : ''}${keep}`);
  notify('Transcription stopped', e.message.slice(0, 120));
}

module.exports = { start, stop, toggle, chunk, finish, fail, fromFile, isRecording: () => !!rec, onState: fn => { stateListener = fn; }, _wavHeader: wavHeader, _setWaitScale: n => { waitScale = n; }, outDir };
