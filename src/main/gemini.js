'use strict';
// Gemini REST client: model discovery, fallbacks, grounded web lookups.
const cfg = require('./config');
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const FALLBACK_LIVE = ['gemini-3.1-flash-live-preview', 'gemini-2.5-flash-native-audio-preview-12-2025'];

class GeminiError extends Error { constructor(status, message) { super(message); this.status = status; } }

function friendly(status, msg) {
  msg = String(msg || '').slice(0, 300);
  if (status === 400 && /api key/i.test(msg)) return 'Gemini rejected the API key. Check it in Settings.';
  if (status === 401 || status === 403) return `Gemini denied access (${status}). ${msg}`;
  if (status === 404) return `Model not found: ${msg}`;
  if (status === 429) return 'Gemini rate limit or quota reached for this model. ' + msg;
  return `Gemini error ${status}: ${msg}`;
}

async function request(url, { method = 'GET', body, signal, timeoutMs = 120000 } = {}) {
  const key = cfg.getKey();
  if (!key) throw new GeminiError(401, 'No Gemini API key set. Open Settings and paste your key.');
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  try {
    const res = await fetch(url, { method, headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    if (!res.ok) throw new GeminiError(res.status, friendly(res.status, json?.error?.message || text));
    return json;
  } catch (e) {
    if (e instanceof GeminiError) throw e;
    if (timedOut) throw new GeminiError(408, `Gemini did not answer within ${Math.round(timeoutMs / 1000)} s`);
    if (signal?.aborted) throw new Error('Stopped.');
    throw new GeminiError(0, 'Network problem talking to Gemini: ' + e.message);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}

// ---- model discovery ----
const EXCLUDE = /(image|tts|embedding|aqa|robotics|computer-use|learnlm|gemma|vision|imagen|veo|exp-|customtools|deep-research)/i;
function version(name) { const m = name.match(/gemini-(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; }
function score(name) { return version(name) * 100 + (/preview|exp/i.test(name) ? 0 : 5) + (/latest/.test(name) ? 1 : 0); }
function best(models, test) {
  const c = models.filter(n => test(n)).sort((a, b) => score(b) - score(a));
  return c[0] || null;
}
const rank = (models, test) => models.filter(n => test(n)).sort((a, b) => score(b) - score(a));
async function refreshModels() {
  const all = [];
  let pageToken = '';
  for (let i = 0; i < 5; i++) {
    const j = await request(`${BASE}/models?pageSize=200${pageToken ? '&pageToken=' + pageToken : ''}`);
    all.push(...(j.models || []));
    if (!j.nextPageToken) break; pageToken = j.nextPageToken;
  }
  const gen = all.filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, ''));
  const live = all.filter(m => (m.supportedGenerationMethods || []).includes('bidiGenerateContent')).map(m => m.name.replace(/^models\//, ''));
  const found = {
    worker: best(gen, n => /-pro/.test(n) && !EXCLUDE.test(n) && !/live|audio/.test(n)),
    fast: best(gen, n => /flash/.test(n) && !/lite/.test(n) && !EXCLUDE.test(n) && !/live|audio/.test(n)),
    live: best(live, n => /flash/.test(n) && !EXCLUDE.test(n)) || best(live, n => !EXCLUDE.test(n)),
    fastList: [...rank(gen, n => /flash/.test(n) && !/lite/.test(n) && !EXCLUDE.test(n) && !/live|audio/.test(n)), ...rank(gen, n => /flash.*lite/.test(n) && !EXCLUDE.test(n) && !/live|audio/.test(n))].slice(0, 6),
    workerList: rank(gen, n => /-pro/.test(n) && !EXCLUDE.test(n) && !/live|audio/.test(n)).slice(0, 4),
    allGenerate: gen.filter(n => !EXCLUDE.test(n)).sort((a, b) => score(b) - score(a)).slice(0, 25),
    allLive: live.sort((a, b) => score(b) - score(a)).slice(0, 10),
    at: Date.now()
  };
  cfg.setModels(found);
  return found;
}

function resolve(kind) {
  const s = cfg.get(), cache = cfg.getModels();
  const pick = (setting, cached, dflt) => (setting && setting !== 'auto') ? setting : (cached || dflt);
  if (kind === 'worker') return pick(s.workerModel, cache.fast || cache.worker, 'gemini-flash-latest'); // auto = newest Flash: much faster per step; choose a Pro model in Settings for harder jobs
  if (kind === 'fast') return pick(s.fastModel, cache.fast, 'gemini-flash-latest');
  if (kind === 'wake') return pick(s.wakeModel, null, 'gemini-flash-lite-latest');
  return pick(s.liveModel, cache.live, FALLBACK_LIVE[0]);
}
// A model that just failed or stalled goes to the back of the line for a while, so every later call is not slowed down by it.
const bad = new Map(); // model -> time it last failed
const BAD_MS = 10 * 60 * 1000;
const TIMEOUTS = { fast: 25000, wake: 15000, worker: 90000 };
const excludedSet = () => new Set(String(cfg.get().excludeModels || '').split(/[,\s]+/).map(m => m.replace(/^models\//, '').toLowerCase()).filter(Boolean));
function chain(kind) {
  const c = cfg.getModels(), ex = excludedSet(), first = resolve(kind);
  const found = kind === 'worker' ? [...(c.fastList || []), ...(c.workerList || [])] : (kind === 'fast' || kind === 'wake') ? c.fastList : null;
  const base = kind === 'worker' ? ['gemini-flash-latest', 'gemini-pro-latest'] : (kind === 'fast' || kind === 'wake') ? ['gemini-flash-latest', 'gemini-flash-lite-latest'] : FALLBACK_LIVE;
  // "*-latest" aliases follow the newest model, so they are dropped too when a flash/pro model is excluded
  const dropFlashAlias = [...ex].some(m => /-flash/.test(m) && !/lite/.test(m)), dropProAlias = [...ex].some(m => /-pro/.test(m));
  const ok = m => !ex.has(String(m).toLowerCase()) && !(dropFlashAlias && m === 'gemini-flash-latest') && !(dropProAlias && m === 'gemini-pro-latest');
  let all = [...new Set([first, ...(found || []).filter(ok).slice(0, 4), ...base])].filter(ok);
  if (!all.length) all = [...new Set([first, ...base])]; // never leave nothing to call
  const fresh = m => !(bad.has(m) && Date.now() - bad.get(m) < BAD_MS);
  return [...all.filter(fresh), ...all.filter(m => !fresh(m))];
}
const liveModels = () => chain('live');

// ---- thinking control for quick vision calls ----
// Flash models "think" before answering by default (Gemini 3 Flash: high). For "what is on my screen" that is most of the wait.
// Gemini 3 takes thinkingLevel, Gemini 2.5 takes thinkingBudget; Pro models cannot switch thinking off. If a model rejects the field we
// step down the list (and remember what worked), ending with no thinkingConfig at all, so a call can never fail because of this.
const thinkVariants = model => {
  if (/-pro/i.test(model)) return [null];
  const v = version(model);
  if (v && v < 2.5) return [null];
  if (v >= 3) return [{ thinkingLevel: 'minimal' }, { thinkingBudget: 0 }, null];
  if (v >= 2.5) return [{ thinkingBudget: 0 }, null];
  return [{ thinkingLevel: 'minimal' }, { thinkingBudget: 0 }, null]; // "gemini-flash-latest" and other aliases: version unknown
};
const thinkIdx = new Map(); // model -> index of the variant that worked
async function callModel(model, body, { signal, timeoutMs, thinking } = {}) {
  const url = `${BASE}/models/${model}:generateContent`, variants = thinking ? thinkVariants(model) : [null];
  let i = Math.min(thinkIdx.get(model) || 0, variants.length - 1);
  for (;;) {
    const tc = variants[i], b = tc ? { ...body, generationConfig: { ...(body.generationConfig || {}), thinkingConfig: tc } } : body;
    try {
      const res = await request(url, { method: 'POST', body: b, signal, timeoutMs: timeoutMs || TIMEOUTS.fast });
      if (thinking) thinkIdx.set(model, i);
      return res;
    } catch (e) {
      if (e.status === 400 && /think/i.test(String(e.message)) && i < variants.length - 1) { i++; continue; }
      throw e;
    }
  }
}

// Quick vision calls: ask the best model; if it has not answered after hedgeMs, ask the next one at the same time and take whichever
// answers first (a slow or stuck model no longer costs the full timeout). Falls back to the normal chain only for 404/429, which need
// model re-discovery or the quota explanation. opts: { signal, hedgeMs, timeoutMs, thinking }
async function generateFast(body, opts = {}) {
  const { signal, hedgeMs = 6000, timeoutMs = 20000, thinking = true } = opts;
  const models = chain('fast').slice(0, 3);
  let lastErr;
  try {
    return await new Promise((resolve, reject) => {
      let done = false, started = 0, failed = 0, timer = null;
      const ctrls = [], onAbort = () => ctrls.forEach(c => c.abort());
      signal?.addEventListener('abort', onAbort);
      const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); ctrls.forEach(c => c.abort()); fn(v); };
      const launch = () => {
        if (done || started >= models.length) return false;
        const model = models[started++], ctrl = new AbortController(); ctrls.push(ctrl);
        callModel(model, body, { signal: ctrl.signal, timeoutMs, thinking })
          .then(res => { bad.delete(model); res._model = model; finish(resolve, res); })
          .catch(e => {
            if (done) return;
            lastErr = e; failed++;
            if (signal?.aborted) return finish(reject, e);
            if ([404, 408, 429, 500, 503].includes(e.status)) bad.set(model, Date.now());
            else if (e.status && e.status < 500) return finish(reject, e); // 400/401/403: another model will not fix it
            if (!launch() && failed >= started) finish(reject, lastErr);
          });
        clearTimeout(timer); if (started < models.length) timer = setTimeout(launch, hedgeMs);
        return true;
      };
      launch();
    });
  } catch (e) {
    if (signal?.aborted || ![404, 429].includes(e.status)) throw e;
    return generate('fast', body, { signal, timeoutMs, budgetMs: 30000 });
  }
}

// generateContent with automatic fallback to the next model on 404/429/overload
async function generateOnce(kind, body, { signal, onSwitch, timeoutMs, budgetMs, preferPro } = {}) {
  let lastErr;
  const fails = [], deadline = Date.now() + (budgetMs || (kind === 'worker' ? 180000 : 45000)); // stop trying more models after this long
  const queue = chain(kind), tried = new Set(), learned = new Set();
  if (preferPro && kind === 'worker') { // the agent is struggling: try the strongest models first, the usual chain stays as the fallback
    const ex = excludedSet(), pro = [...(cfg.getModels().workerList || []), 'gemini-pro-latest'].filter(m => !ex.has(String(m).toLowerCase()));
    queue.splice(0, queue.length, ...new Set([...pro, ...queue]));
  }
  while (queue.length) {
    const model = queue.shift();
    if (tried.size && Date.now() > deadline) break;
    if (tried.has(model)) continue;
    tried.add(model);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await request(`${BASE}/models/${model}:generateContent`, { method: 'POST', body, signal, timeoutMs: timeoutMs || TIMEOUTS[kind] || 60000 });
        bad.delete(model);
        res._model = model;
        // A replacement model that Google named in an error worked: remember it so we go straight there next time.
        if (learned.has(model) && (kind === 'fast' || kind === 'worker')) { try { cfg.setModels({ ...cfg.getModels(), [kind]: model }); } catch {} }
        return res;
      } catch (e) {
        lastErr = e;
        if (signal?.aborted) throw e;
        if (e.status === 500 || e.status === 503) { await new Promise(r => setTimeout(r, 900)); continue; }
        break;
      }
    }
    if (lastErr && [404, 408, 429, 500, 503].includes(lastErr.status)) {
      bad.set(model, Date.now()); fails.push(lastErr.status);
      // "...no longer available... please use models/gemini-X" -> try the model Google recommends next
      const m = lastErr.status === 404 && String(lastErr.message).match(/\buse\s+models\/([A-Za-z0-9._-]+)/i);
      if (m && !tried.has(m[1]) && !excludedSet().has(m[1].toLowerCase())) { queue.unshift(m[1]); learned.add(m[1]); }
      onSwitch?.(model, lastErr); continue;
    }
    throw lastErr;
  }
  const quota = fails.filter(s => s === 429).length, slow = fails.filter(s => s === 408).length;
  if (fails.length > 1 && quota + slow === fails.length) {
    throw new GeminiError(quota ? 429 : 408, `Gemini is not available right now: ${quota} model(s) are out of quota and ${slow} did not answer in time (${fails.length} tried). Check https://ai.dev/rate-limit. Daily limits reset at midnight Pacific time (about 10:00 AM in Egypt); adding billing to the API key raises the limits.`);
  }
  throw lastErr;
}

async function generate(kind, body, opts = {}) {
  try { return await generateOnce(kind, body, opts); }
  catch (e) {
    if (e.status !== 404 || opts._retried) throw e;
    try { await refreshModels(); } catch { throw e; } // the saved model list is stale: re-discover what this key can use
    return generateOnce(kind, body, { ...opts, _retried: true });
  }
}

const textOf = res => (res?.candidates?.[0]?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('').trim();

async function webLookup(query, signal) {
  const res = await generate('fast', {
    systemInstruction: { parts: [{ text: 'Answer factually using Google Search. Be concise: 2-5 plain sentences with the key numbers, names and dates. No markdown.' }] },
    contents: [{ role: 'user', parts: [{ text: query }] }],
    tools: [{ googleSearch: {} }]
  }, { signal });
  const sources = (res.candidates?.[0]?.groundingMetadata?.groundingChunks || []).map(c => c.web?.title || c.web?.uri).filter(Boolean).slice(0, 3);
  return textOf(res) + (sources.length ? `\n(Sources: ${sources.join('; ')})` : '');
}

module.exports = { TIMEOUTS, request, refreshModels, resolve, chain, liveModels, generate, generateFast, textOf, webLookup, GeminiError, FALLBACK_LIVE };
