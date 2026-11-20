'use strict';
// Vision web search that does not depend on Gemini. Several independent search sources are tried with automatic failover:
//   keyed APIs (only if the user added a key)  ->  Bing (RSS + HTML), DuckDuckGo (two kinds), Yahoo, Brave, Mojeek, SearXNG
//   plus "extras" that run alongside: Wikipedia (English/Arabic), DuckDuckGo instant answers, Google News / Bing News headlines.
// An engine that keeps failing (blocked, rate-limited, changed its page) is skipped for a few minutes, so it never slows the next question.
// Optional keys: put {"brave":"...","tavily":"...","serper":"...","searxng":["https://..."]} in search-keys.json in Vision's data folder,
// or set the environment variables VISION_BRAVE_KEY / VISION_TAVILY_KEY / VISION_SERPER_KEY.
const fs = require('fs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' };
const WIKI_UA = { 'User-Agent': 'VisionAssistant/1.9 (personal desktop assistant)' };
const ARABIC = /[\u0600-\u06FF]/;

// ---------------------------------------------------------------- text helpers ----------------
const decode = s => String(s)
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#x27;|&#39;/g, "'")
  .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(+n); } catch { return ' '; } })
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ' '; } })
  .replace(/&amp;/g, '&');
const unCdata = s => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
const stripTags = h => decode(decode(unCdata(h).replace(/<[^>]+>/g, ' ')).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); // twice: RSS descriptions often hold escaped HTML
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return String(u); } };
const isHttp = u => /^https?:\/\//i.test(u);

// ---------------------------------------------------------------- parsers (pure; each returns [{title,url,snippet}]) ----------------
function parseRss(xml) {
  const items = [];
  for (const m of String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const b = m[1], tag = n => { const r = b.match(new RegExp('<' + n + '\\b[^>]*>([\\s\\S]*?)</' + n + '>', 'i')); return r ? stripTags(r[1]) : ''; };
    const link = tag('link'); if (!isHttp(link)) continue;
    items.push({ title: tag('title'), url: link, snippet: tag('description'), date: tag('pubDate'), source: tag('source') });
  }
  return items;
}
function decodeBingUrl(u) { // Bing wraps result links as bing.com/ck/a?...&u=a1<base64url of the real address>
  const m = String(u).match(/[?&]u=a1([A-Za-z0-9_-]+)/); if (!m) return u;
  try { let b = m[1].replace(/-/g, '+').replace(/_/g, '/'); while (b.length % 4) b += '='; const d = Buffer.from(b, 'base64').toString('utf8'); return isHttp(d) ? d : u; } catch { return u; }
}
function parseBingHtml(html) {
  const out = [];
  for (const chunk of String(html).split(/<li\b[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>/).slice(1)) {
    const h = chunk.match(/<h2\b[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i); if (!h) continue;
    const url = decodeBingUrl(decode(h[1])); if (!isHttp(url) || /bing\.com\/(ck|aclick)/i.test(url)) continue;
    const p = chunk.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    out.push({ title: stripTags(h[2]), url, snippet: p ? stripTags(p[1]) : '' });
  }
  return out;
}
function parseDuckDuckGo(html) {
  const out = [];
  for (const chunk of String(html).split(/class="[^"]*result__body[^"]*"/).slice(1)) {
    const a = chunk.match(/<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/); if (!a) continue;
    const href = (a[0].match(/href="([^"]+)"/) || [])[1]; if (!href || /duckduckgo\.com\/y\.js/.test(href)) continue;
    let url = decode(href); const u = url.match(/[?&]uddg=([^&]+)/); if (u) { try { url = decodeURIComponent(u[1]); } catch {} }
    if (url.startsWith('//')) url = 'https:' + url; if (!isHttp(url)) continue;
    const sn = chunk.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/);
    out.push({ title: stripTags(a[1]), url, snippet: sn ? stripTags(sn[1]) : '' });
  }
  return out;
}
function parseDuckDuckGoLite(html) {
  const out = [], anchors = [...String(html).matchAll(/<a\b[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g)];
  anchors.forEach((m, i) => {
    const href = (m[0].match(/href=['"]([^'"]+)['"]/) || [])[1]; if (!href || /y\.js/.test(href)) return;
    let url = decode(href); const u = url.match(/[?&]uddg=([^&]+)/); if (u) { try { url = decodeURIComponent(u[1]); } catch {} }
    if (url.startsWith('//')) url = 'https:' + url; if (!isHttp(url)) return;
    const seg = String(html).slice(m.index + m[0].length, i + 1 < anchors.length ? anchors[i + 1].index : undefined);
    const sn = seg.match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/);
    out.push({ title: stripTags(m[1]), url, snippet: sn ? stripTags(sn[1]) : '' });
  });
  return out;
}
function parseYahoo(html) {
  const out = [];
  for (const chunk of String(html).split(/<div\b[^>]*class="[^"]*\balgo\b[^"]*"[^>]*>/).slice(1)) {
    const a = chunk.match(/<a\b[^>]*href="([^"]+)"[^>]*>/i); if (!a) continue;
    let url = decode(a[1]); const ru = url.match(/\/RU=([^/]+)\/R[KS]=/);
    if (ru) { try { url = decodeURIComponent(ru[1]); } catch {} }
    if (!isHttp(url) || /search\.yahoo\.com/i.test(url)) continue;
    const t = chunk.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i), p = chunk.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    out.push({ title: t ? stripTags(t[1]) : host(url), url, snippet: p ? stripTags(p[1]) : '' });
  }
  return out;
}
function parseBrave(html) {
  const out = [];
  for (const chunk of String(html).split(/<div\b[^>]*data-type="web"[^>]*>/).slice(1)) {
    const a = chunk.match(/<a\b[^>]*href="(https?:\/\/[^"]+)"/i); if (!a) continue;
    const t = chunk.match(/class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i), d = chunk.match(/class="[^"]*snippet-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    out.push({ title: t ? stripTags(t[1]) : host(a[1]), url: decode(a[1]), snippet: d ? stripTags(d[1]) : '' });
  }
  return out;
}
function parseMojeek(html) {
  const out = [];
  for (const chunk of String(html).split(/<li\b[^>]*>/).slice(1)) {
    const a = chunk.match(/<a\b[^>]*class="[^"]*\btitle\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) || chunk.match(/<a\b[^>]*href="([^"]+)"[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a || !isHttp(decode(a[1]))) continue;
    const p = chunk.match(/<p\b[^>]*class="[^"]*\bs\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    out.push({ title: stripTags(a[2]), url: decode(a[1]), snippet: p ? stripTags(p[1]) : '' });
  }
  return out;
}
function parseDdgInstant(j) { // DuckDuckGo instant-answer JSON -> [{title,url,snippet}] (answer boxes, definitions, topics)
  const out = []; if (!j || typeof j !== 'object') return out;
  if (j.Answer && typeof j.Answer === 'string') out.push({ title: 'Answer', url: '', snippet: j.Answer });
  if (j.AbstractText) out.push({ title: j.Heading || 'Summary', url: j.AbstractURL || '', snippet: j.AbstractText });
  if (j.Definition) out.push({ title: 'Definition', url: j.DefinitionURL || '', snippet: j.Definition });
  for (const t of (j.RelatedTopics || []).slice(0, 4)) if (t && t.Text) out.push({ title: 'Related', url: t.FirstURL || '', snippet: t.Text });
  return out;
}
function parseWikiExtracts(j) {
  const pages = Object.values((j && j.query && j.query.pages) || {}).filter(p => p && p.extract && !/may (also )?refer to|يمكن أن يشير/i.test(p.extract.slice(0, 160)));
  return pages.sort((a, b) => (a.index || 0) - (b.index || 0)).slice(0, 2).map(p => ({ title: p.title, url: p.fullurl || '', snippet: String(p.extract).replace(/\s+/g, ' ').trim().slice(0, 700) }));
}

// ---------------------------------------------------------------- query helpers ----------------
const FILLER = /^(?:please\s+|hey\s+|can you\s+|could you\s+)*(?:search(?: the web| online)?(?: for)?|look ?up|google|find(?: me)?|tell me(?: about)?|give me|show me|what(?:'s| is| are| was| were)(?: the)?|who(?:'s| is| was| are)|when (?:is|was|did|does)(?: the)?|where (?:is|are|was)(?: the)?|how (?:old|tall|big|many|much|long) (?:is|are|was)?)\s+/i;
const simplifyQuery = q => { let s = String(q).trim().replace(/[?!.]+$/g, ''); for (let i = 0; i < 2; i++) s = s.replace(FILLER, ''); return s.replace(/^(?:the|a|an)\s+/i, '').trim() || String(q).trim(); };
const looksLikeNews = q => /\b(news|latest|today|tonight|yesterday|breaking|headlines?|scores?|results?|won|wins|match|game|prices?|stocks?|rates?|election|updates?|released?|announce[sd]?|launch(?:ed)?|this (?:week|month))\b/i.test(q) || /(أخبار|اخبار|آخر|اليوم|عاجل|نتيجة|نتائج|سعر|أسعار|مباراة|تحديث|الان|الآن)/.test(q);
const looksFactual = q => /^(who|what|when|where|why|how (old|tall|big|many|much|long)|define|meaning of|tell me about|explain|history of)\b/i.test(q.trim()) || /^(من|ما|ماذا|متى|أين|كم|عرف|معنى)/.test(q.trim()) || q.trim().split(/\s+/).length <= 4;

// ---------------------------------------------------------------- engine core ----------------
const isNetErr = e => /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ERR_(INTERNET|NAME|CONNECTION|NETWORK|TIMED|PROXY|SSL|CERT|ADDRESS)|network|timed out/i.test(String((e && e.message) || '') + ' ' + String((e && e.cause && (e.cause.code || e.cause.message)) || '') + ' ' + String((e && e.code) || ''));

function raceFirst(fns, signal) { // first engine to succeed wins; the others are cancelled
  return new Promise((resolve, reject) => {
    const ctl = new AbortController(), errors = [];
    if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', () => ctl.abort(), { once: true }); }
    let pending = fns.length, done = false;
    if (!pending) { const e = new Error('no engines'); e.errors = []; return reject(e); }
    for (const fn of fns) {
      Promise.resolve().then(() => fn(ctl.signal)).then(v => { if (!done) { done = true; ctl.abort(); resolve(v); } },
        e => { errors.push(e); if (--pending === 0 && !done) { const err = new Error('all engines failed'); err.errors = errors; reject(err); } });
    }
  });
}

function createLookup(opts = {}) {
  const now = opts.now || Date.now, log = (opts.logger && opts.logger.log) ? (...a) => opts.logger.log('websearch', ...a) : () => {};
  let netFetch = null;
  const doFetch = opts.fetchImpl || ((url, init) => {
    if (netFetch === null) { try { const { net } = require('electron'); netFetch = net && net.fetch ? (u, i) => net.fetch(u, i) : false; } catch { netFetch = false; } } // Chromium's network stack: follows the system proxy and certificates
    return (netFetch || fetch)(url, init);
  });
  const health = new Map(), cache = new Map();
  const cooling = id => ((health.get(id) || {}).until || 0) > now();
  const markOk = id => health.set(id, { fails: 0, until: 0 });
  const markFail = id => { const h = health.get(id) || { fails: 0, until: 0 }; h.fails++; h.until = h.fails >= 2 ? now() + Math.min(30, 2 * h.fails) * 60000 : 0; health.set(id, h); };

  function timed(signal, ms) {
    const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
    if (signal) { if (signal.aborted) c.abort(); else signal.addEventListener('abort', () => c.abort(), { once: true }); }
    return { signal: c.signal, done: () => clearTimeout(t) };
  }
  async function http(url, { signal, ms = 7000, headers, method = 'GET', body } = {}) {
    const t = timed(signal, ms);
    try {
      const r = await doFetch(url, { method, headers: { ...HEADERS, ...(headers || {}) }, body, signal: t.signal, redirect: 'follow' });
      const text = await r.text();
      if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
      return text;
    } catch (e) {
      if (e && (e.name === 'AbortError' || /aborted/i.test(e.message))) { const err = new Error(signal && signal.aborted ? 'stopped' : 'timed out'); err.code = signal && signal.aborted ? 'ABORT' : 'TIMEOUT'; throw err; }
      throw e;
    } finally { t.done(); }
  }
  const json = async (url, o) => { const t = await http(url, { ...o, headers: { Accept: 'application/json', ...((o && o.headers) || {}) } }); try { return JSON.parse(t); } catch { throw new Error('answer was not JSON'); } };
  const need = (r, what) => { if (!r || !r.length) throw new Error(what || 'no results (blocked, rate-limited or the page changed)'); return r; };

  // ---- keys ----
  let keysCache = { t: 0, v: {} };
  function keys() {
    if (now() - keysCache.t < 30000) return keysCache.v;
    let v = {}; const f = typeof opts.keysFile === 'function' ? opts.keysFile() : opts.keysFile;
    try { if (f && fs.existsSync(f)) v = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch (e) { log('search-keys.json unreadable:', e.message); }
    const env = process.env; v = { ...v, brave: v.brave || env.VISION_BRAVE_KEY, tavily: v.tavily || env.VISION_TAVILY_KEY, serper: v.serper || env.VISION_SERPER_KEY };
    keysCache = { t: now(), v }; return v;
  }

  // ---- engines: (query, {sig, lang, k}) -> results ----
  const mkt = lang => (lang === 'ar' ? 'ar-EG' : 'en-US');
  const E = {
    brave_api: { name: 'Brave Search', key: 'brave', run: async (q, c) => need((((await json(`https://api.search.brave.com/res/v1/web/search?count=8&q=${encodeURIComponent(q)}`, { signal: c.sig, headers: { 'X-Subscription-Token': c.k.brave } })).web || {}).results || []).map(r => ({ title: r.title, url: r.url, snippet: stripTags(r.description || '') }))) },
    tavily: { name: 'Tavily', key: 'tavily', run: async (q, c) => { const j = await json('https://api.tavily.com/search', { signal: c.sig, ms: 9000, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.k.tavily }, body: JSON.stringify({ query: q, max_results: 6, include_answer: true, search_depth: 'basic' }) }); const r = need((j.results || []).map(x => ({ title: x.title, url: x.url, snippet: String(x.content || '').slice(0, 400) }))); if (j.answer) r.unshift({ title: 'Summary', url: '', snippet: String(j.answer) }); return r; } },
    serper: { name: 'Serper (Google)', key: 'serper', run: async (q, c) => { const j = await json('https://google.serper.dev/search', { signal: c.sig, method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-KEY': c.k.serper }, body: JSON.stringify({ q, num: 8, ...(c.lang === 'ar' ? { gl: 'eg', hl: 'ar' } : {}) }) }); const r = (j.organic || []).map(x => ({ title: x.title, url: x.link, snippet: x.snippet || '' })); const ab = j.answerBox && (j.answerBox.answer || j.answerBox.snippet); if (ab) r.unshift({ title: 'Answer', url: '', snippet: String(ab) }); return need(r); } },
    bing_rss: { name: 'Bing', run: async (q, c) => need(parseRss(await http(`https://www.bing.com/search?format=rss&count=10&mkt=${mkt(c.lang)}&q=${encodeURIComponent(q)}`, { signal: c.sig }))) },
    ddg: { name: 'DuckDuckGo', run: async (q, c) => need(parseDuckDuckGo(await http('https://html.duckduckgo.com/html/', { signal: c.sig, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'q=' + encodeURIComponent(q) }))) },
    bing_html: { name: 'Bing', run: async (q, c) => need(parseBingHtml(await http(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setmkt=${mkt(c.lang)}&count=10`, { signal: c.sig }))) },
    yahoo: { name: 'Yahoo', run: async (q, c) => need(parseYahoo(await http(`https://search.yahoo.com/search?p=${encodeURIComponent(q)}`, { signal: c.sig }))) },
    brave_html: { name: 'Brave', run: async (q, c) => need(parseBrave(await http(`https://search.brave.com/search?source=web&q=${encodeURIComponent(q)}`, { signal: c.sig }))) },
    ddg_lite: { name: 'DuckDuckGo Lite', run: async (q, c) => need(parseDuckDuckGoLite(await http('https://lite.duckduckgo.com/lite/', { signal: c.sig, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'q=' + encodeURIComponent(q) }))) },
    mojeek: { name: 'Mojeek', run: async (q, c) => need(parseMojeek(await http(`https://www.mojeek.com/search?q=${encodeURIComponent(q)}`, { signal: c.sig }))) },
    searxng: { name: 'SearXNG', run: async (q, c) => {
      const list = (Array.isArray(c.k.searxng) && c.k.searxng.length ? c.k.searxng : ['https://searx.be', 'https://search.ononoki.org', 'https://searx.tiekoetter.com']);
      try { return await raceFirst(list.map(u => async sig => need(((await json(`${String(u).replace(/\/$/, '')}/search?format=json&q=${encodeURIComponent(q)}`, { signal: sig, ms: 5000 })).results || []).map(r => ({ title: r.title, url: r.url, snippet: r.content || '' })))), c.sig); }
      catch (e) { throw (e.errors && e.errors[0]) || e; }
    } }
  };
  const WEB_ORDER = ['bing_rss', 'ddg', 'bing_html', 'yahoo', 'brave_html', 'ddg_lite', 'mojeek', 'searxng'];

  async function runEngine(id, q, ctx, sig) {
    try { const r = await E[id].run(q, { ...ctx, sig }); markOk(id); log(`${id} ok (${r.length})`); return { id, name: E[id].name, results: r }; }
    catch (e) { if (!sig.aborted) { markFail(id); log(`${id} failed: ${e.message}`); } throw Object.assign(e, { engine: id }); }
  }

  // ---- extras that run alongside ----
  const extras = {
    async wiki(q, lang, signal) {
      const s = simplifyQuery(q);
      const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrlimit=3&prop=extracts%7Cinfo&exintro=1&explaintext=1&exsentences=4&inprop=url&gsrsearch=${encodeURIComponent(s)}`;
      return need(parseWikiExtracts(await json(url, { signal, ms: 6000, headers: WIKI_UA })), 'Wikipedia had nothing');
    },
    async instant(q, lang, signal) { return need(parseDdgInstant(await json(`https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&t=vision&q=${encodeURIComponent(simplifyQuery(q))}`, { signal, ms: 5000 })), 'no instant answer'); },
    async news(q, lang, signal) {
      const g = lang === 'ar' ? 'hl=ar&gl=EG&ceid=EG:ar' : 'hl=en-US&gl=US&ceid=US:en';
      try { return need(parseRss(await http(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&${g}`, { signal, ms: 6000 })).slice(0, 6), 'no headlines'); }
      catch (e) { if (signal && signal.aborted) throw e; return need(parseRss(await http(`https://www.bing.com/news/search?format=rss&q=${encodeURIComponent(q)}`, { signal, ms: 6000 })).slice(0, 6), 'no headlines'); }
    }
  };
  const settle = (p, ms) => Promise.race([p.then(v => v, () => null), new Promise(r => setTimeout(() => r(null), ms))]);

  // ---- page text (so the model gets facts, not only snippets) ----
  async function pageText(url, signal) {
    const clean = h => stripTags(h.slice(0, 600000).replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)[\s\S]*?<\/\1>/gi, ' ')).slice(0, 2500);
    try { const t = clean(await http(url, { signal, ms: 6000, headers: { 'Accept-Language': 'en' } })); if (t.length > 250) return t; } catch (e) { if (signal && signal.aborted) return ''; }
    try { const t = await http('https://r.jina.ai/' + url, { signal, ms: 8000, headers: { Accept: 'text/plain' } }); return String(t).replace(/\s+/g, ' ').trim().slice(0, 2500); } catch { return ''; } // reader service for pages that block direct fetching
  }

  function format(q, r) {
    let t = `Web results for "${q}" from ${r.source} (answer the user in one or two spoken sentences from these; name the source only if useful):\n`;
    r.results.forEach((x, i) => { t += `${i + 1}. ${x.title}${x.url ? ' [' + host(x.url) + ']' : ''}\n   ${x.snippet || ''}\n`; });
    if (r.news && r.news.length) { t += '\nLatest headlines:\n'; r.news.forEach(n => { t += `- ${n.title}${n.date ? ' (' + n.date.replace(/\s*\d\d:\d\d:\d\d.*$/, '') + ')' : ''}\n`; }); }
    if (r.wiki && r.wiki.length) { t += '\nEncyclopedia (Wikipedia):\n'; r.wiki.forEach(w => { t += `- ${w.title}: ${w.snippet}\n`; }); }
    if (r.instant && r.instant.length) { t += '\nInstant answers (DuckDuckGo):\n'; r.instant.slice(0, 3).forEach(w => { t += `- ${w.title}: ${w.snippet}\n`; }); }
    (r.pages || []).forEach(p => { if (p.text) t += `\nText from ${host(p.url)}:\n${p.text}\n`; });
    return t.length > 9000 ? t.slice(0, 9000) + '…' : t;
  }

  async function lookup(query, { signal } = {}) {
    const q = String(query || '').trim(); if (!q) throw new Error('Nothing to search for.');
    const lang = ARABIC.test(q) ? 'ar' : 'en', ck = lang + '|' + q.toLowerCase(), hit = cache.get(ck);
    if (hit && now() - hit.t < (looksLikeNews(q) ? 3 : 10) * 60000) return hit.text;
    const total = timed(signal, 16000), k = keys(), ctx = { lang, k };
    try {
      const sig = total.signal, news = looksLikeNews(q), fact = looksFactual(q);
      // extras start right away, in parallel with the main search
      const ex = {}; const start = n => { if (!ex[n]) ex[n] = extras[n](q, lang, sig); return ex[n]; };
      if (news) start('news'); if (fact) { start('wiki'); start('instant'); }
      Object.values(ex).forEach(p => p.catch(() => {}));

      const keyed = ['brave_api', 'tavily', 'serper'].filter(id => k[E[id].key]);
      const order = [...keyed, ...WEB_ORDER], errors = []; let main = null;
      for (const pass of [false, true]) { // pass 2 also tries engines that are cooling down
        const avail = order.filter(id => !errors.some(e => e.engine === id) && (pass || !cooling(id)));
        const kv = avail.filter(id => keyed.includes(id)), rest = avail.filter(id => !keyed.includes(id));
        const waves = [...(kv.length ? [kv] : []), ...rest.reduce((a, id, i) => { if (i % 2 === 0) a.push([id]); else a[a.length - 1].push(id); return a; }, [])]; // official-API keys first, then the free engines two at a time
        for (const wave of waves) {
          if (main || sig.aborted) break;
          try { main = await raceFirst(wave.map(id => s => runEngine(id, q, ctx, s)), sig); }
          catch (e) { errors.push(...(e.errors || [e])); }
        }
        if (main || sig.aborted) break;
      }
      if (signal && signal.aborted) throw new Error('stopped by the user');

      if (!main) { // every web engine failed: the extras may still answer
        ['wiki', 'instant', 'news'].forEach(start); Object.values(ex).forEach(p => p.catch(() => {}));
        const got = {}; for (const n of Object.keys(ex)) got[n] = await settle(ex[n], 4000);
        const all = [...(got.news || []).map(x => ({ ...x, snippet: x.snippet || x.source || '' })), ...(got.wiki || []), ...(got.instant || [])];
        if (all.length) { const text = format(q, { source: 'Wikipedia / news feeds (the main search engines were unavailable)', results: all.slice(0, 6) }); cache.set(ck, { t: now(), text }); return text; }
        const netDown = errors.length > 1 && errors.every(isNetErr);
        const reasons = [...new Map(errors.map(e => [e.engine || 'x', `${(E[e.engine] || {}).name || e.engine}: ${String(e.message).slice(0, 60)}`])).values()].slice(0, 6).join('; ');
        const err = new Error(netDown ? 'There is no internet connection right now (every search source was unreachable).' : `Every search source failed (${reasons}).`);
        err.code = netDown ? 'NONET' : 'NOSEARCH'; throw err;
      }

      const [wiki, instant, newsItems] = await Promise.all([settle(ex.wiki || Promise.resolve(null), 1500), settle(ex.instant || Promise.resolve(null), 1500), settle(ex.news || Promise.resolve(null), 1500)]);
      const results = main.results.slice(0, 7), withUrl = results.filter(r => r.url && isHttp(r.url));
      const pages = await Promise.all(withUrl.slice(0, 2).map(async r => ({ url: r.url, text: await pageText(r.url, sig) })));
      const text = format(q, { source: main.name, results, news: newsItems, wiki, instant, pages });
      cache.set(ck, { t: now(), text }); if (cache.size > 60) cache.delete(cache.keys().next().value);
      return text;
    } finally { total.done(); }
  }
  const status = () => Object.keys(E).map(id => { const h = health.get(id); return `${id}: ${h && h.fails ? `${h.fails} fail(s)${cooling(id) ? ', resting' : ''}` : 'ok/untried'}`; }).join('; ');
  return { lookup, status, _health: health };
}

module.exports = { createLookup, parsers: { parseRss, parseBingHtml, parseDuckDuckGo, parseDuckDuckGoLite, parseYahoo, parseBrave, parseMojeek, parseDdgInstant, parseWikiExtracts, decodeBingUrl }, simplifyQuery, looksLikeNews, looksFactual, raceFirst };
