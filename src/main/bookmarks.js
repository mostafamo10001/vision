'use strict';
// Chrome/Edge keep bookmarks in a plain JSON file. Reading it is instant, complete and exact (no screen reading).
const fs = require('fs');
const path = require('path');

function userDataDir(browser) {
  const local = process.env.LOCALAPPDATA || '';
  return browser === 'edge' ? path.join(local, 'Microsoft', 'Edge', 'User Data') : path.join(local, 'Google', 'Chrome', 'User Data');
}
const FILES = ['Bookmarks', 'AccountBookmarks']; // newer Chrome keeps account-synced bookmarks in AccountBookmarks
function candidates(base) {
  let dirs; try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return null; }
  const out = [];
  for (const d of dirs) {
    const files = [];
    let m = 0;
    for (const f of FILES) { try { const st = fs.statSync(path.join(base, d, f)); if (st.isFile()) { files.push(path.join(base, d, f)); m = Math.max(m, st.mtimeMs); } } catch {} }
    if (files.length) out.push({ dir: d, files, m });
  }
  return { dirs, out };
}
function locate(browser) {
  const base = userDataDir(browser), name = browser === 'edge' ? 'Edge' : 'Chrome';
  const c = candidates(base);
  if (!c) throw new Error(`Could not find ${name} data on this PC.`);
  if (!c.out.length) {
    const seen = []; for (const d of c.dirs.slice(0, 12)) { try { fs.readdirSync(path.join(base, d)).filter(f => /bookmark/i.test(f)).forEach(f => seen.push(d + '/' + f)); } catch {} }
    throw new Error(`No bookmarks file found. Looked in ${base} (folders: ${c.dirs.slice(0, 12).join(', ') || 'none'}; bookmark-like files: ${seen.join(', ') || 'none'}).`);
  }
  let last = null; try { last = JSON.parse(fs.readFileSync(path.join(base, 'Local State'), 'utf8')).profile.last_used; } catch {}
  const pick = c.out.find(x => x.dir === last) || c.out.sort((a, b) => b.m - a.m)[0]; // the profile you used most recently
  return { files: pick.files, profile: pick.dir };
}
function mergeRoots(a, b) {
  const out = JSON.parse(JSON.stringify(a)); out.roots = out.roots || {};
  for (const k of ['bookmark_bar', 'other', 'synced']) {
    const n = b.roots && b.roots[k]; if (!n) continue;
    out.roots[k] = out.roots[k] || { type: 'folder', name: k, children: [] };
    out.roots[k].children = [...(out.roots[k].children || []), ...(n.children || [])];
  }
  return out;
}
function read(browser) {
  const l = locate(browser); let merged = null;
  for (const f of l.files) { let d; try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; } merged = merged ? mergeRoots(merged, d) : d; }
  if (!merged) throw new Error('The bookmarks file could not be read.');
  return { data: merged, profile: l.profile };
}

function flatten(data) {
  const out = [];
  const walk = (node, trail, root) => {
    for (const c of node.children || []) {
      if (c.type === 'folder') walk(c, [...trail, c.name], root);
      else if (c.type === 'url' && c.url) out.push({ name: c.name || c.url, url: c.url, folder: trail.join(' / '), root });
    }
  };
  const r = data.roots || {};
  walk(r.bookmark_bar || {}, [], 'bar'); walk(r.other || {}, [], 'other'); walk(r.synced || {}, [], 'mobile');
  return out;
}
function folders(data) {
  const out = [];
  const walk = (node, root) => { for (const c of node.children || []) if (c.type === 'folder') { out.push({ name: c.name, node: c, root }); walk(c, root); } };
  const r = data.roots || {}; walk(r.bookmark_bar || {}, 'bar'); walk(r.other || {}, 'other'); walk(r.synced || {}, 'mobile');
  return out;
}
function urlsIn(node) { const o = []; const w = n => { for (const c of n.children || []) { if (c.type === 'url' && c.url) o.push({ name: c.name, url: c.url }); else if (c.type === 'folder') w(c); } }; w(node); return o; }

const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
function score(item, q) {
  const n = norm(item.name), h = norm(host(item.url)), toks = q.split(' ').filter(Boolean);
  if (!q) return 0;
  if (n === q) return 100;
  if (n.startsWith(q)) return 85;
  if (n.includes(q)) return 70;
  if (toks.length && toks.every(t => n.includes(t) || h.includes(t))) return 60;
  if (h.includes(q) || h.replace(/\./g, ' ').includes(q)) return 55;
  const hit = toks.filter(t => n.includes(t) || h.includes(t)).length;
  return toks.length ? Math.round(40 * hit / toks.length) : 0;
}
// Returns { kind: 'bookmark'|'folder'|'ambiguous'|'none', ... }
function find(data, query) {
  const q = norm(query);
  const ranked = flatten(data).map(i => ({ ...i, s: score(i, q) })).filter(i => i.s >= 40).sort((a, b) => b.s - a.s);
  const fld = folders(data).map(f => ({ ...f, s: norm(f.name) === q ? 90 : norm(f.name).includes(q) && q.length > 2 ? 65 : 0 })).filter(f => f.s > 0).sort((a, b) => b.s - a.s);
  const top = ranked[0];
  if (fld[0] && (!top || fld[0].s > top.s)) { const urls = urlsIn(fld[0].node); if (urls.length) return { kind: 'folder', name: fld[0].name, urls }; }
  if (!top) { // nothing matched literally: try a forgiving match (typos, other word order)
    const fz = require('./fuzzy'), items = flatten(data).map(i => ({ ...i, s: fz.scoreName(query, i.name) })).filter(i => i.s >= 0.7).sort((a, b) => b.s - a.s);
    if (items.length && (items.length === 1 || items[0].s - items[1].s >= 0.1)) return { kind: 'bookmark', item: items[0] };
    if (items.length) return { kind: 'ambiguous', options: items.slice(0, 5) };
    return { kind: 'none' };
  }
  const rivals = ranked.filter(i => i.url !== top.url && i.s >= top.s - 8);
  if (rivals.length) return { kind: 'ambiguous', options: [top, ...rivals].slice(0, 5) };
  return { kind: 'bookmark', item: top };
}

function lines(node, depth, out) {
  for (const c of node.children || []) {
    const pad = '  '.repeat(depth);
    if (c.type === 'folder') { out.push(`${pad}[folder] ${c.name} (${(c.children || []).length})`); lines(c, depth + 1, out); }
    else if (c.type === 'url') out.push(`${pad}${c.name} - ${c.url}`);
  }
}
function format(data, scope) {
  const r = data.roots || {}, out = [];
  const add = (label, n) => { if (n && (n.children || []).length) { out.push(label + ':'); lines(n, 1, out); } };
  add('Bookmarks bar', r.bookmark_bar);
  if (scope === 'all') { add('Other bookmarks', r.other); add('Mobile bookmarks', r.synced); }
  return out.length ? out.join('\n') : '(no bookmarks found)';
}
module.exports = { read, find, format, flatten };
