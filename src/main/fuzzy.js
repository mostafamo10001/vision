'use strict';
// Forgiving name matching, so a request does not fail because a name is a little off: typos, a different word order,
// "_" "-" "." in file names, a missing extension, capitals, accents and Arabic spelling variants ("افلام" = "أفلام").
// Numbers must match exactly: asking for episode E03 never quietly gives you E04.
const fs = require('fs');
const path = require('path');

const FILLER = new Set(['the', 'my', 'a', 'an', 'of', 'named', 'called', 'folder', 'folders', 'directory', 'file', 'files', 'مجلد', 'ملف']);

function norm(s) {
  return String(s || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2') // ReportFinal2023 -> Report Final 2023
    .normalize('NFKD').replace(/\p{M}/gu, '')                      // accents and Arabic diacritics
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')   // Arabic letter variants
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function lev(a, b, max) { // Levenshtein distance, giving up early once it must exceed max
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let rowMin = i;
    for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); if (cur[j] < rowMin) rowMin = cur[j]; }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function tokenSim(a, b) {
  if (a === b) return 1;
  if (/\d/.test(a) || /\d/.test(b)) return a.replace(/^0+(?=\d)/, '') === b.replace(/^0+(?=\d)/, '') ? 1 : 0; // numbers are exact (03 = 3)
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 3 && l.startsWith(s)) return 0.92;   // "doc" ~ "document"
  if (s.length >= 4 && l.includes(s)) return 0.8;
  const allowed = l.length <= 3 ? 0 : l.length <= 5 ? 1 : l.length <= 9 ? 2 : 3;
  if (!allowed) return 0;
  const d = lev(a, b, allowed);
  return d > allowed ? 0 : 1 - d / l.length;
}

function queryTokens(query) {
  const all = norm(query).split(' ').filter(Boolean), kept = all.filter(t => !FILLER.has(t));
  return kept.length ? kept : all;
}

// 0..1: how well `name` matches what was asked for
function scoreName(query, name) {
  const qt = queryTokens(query), n = norm(name);
  if (!qt.length || !n) return 0;
  const nt = n.split(' ');
  if (qt.join(' ') === n) return 1;
  let sum = 0, numberMiss = false;
  for (const t of qt) {
    let best = 0; for (const u of nt) { const v = tokenSim(t, u); if (v > best) best = v; }
    if (/\d/.test(t) && best < 1) numberMiss = true;
    sum += best;
  }
  let score = sum / qt.length;
  if (n.includes(qt.join(' '))) score = Math.max(score, 0.9);  // the whole query appears in the name
  score -= Math.min(0.15, Math.max(0, nt.length - qt.length) * 0.02); // prefer the closer name
  if (numberMiss) score = Math.min(score, 0.45);               // a different number is a different thing
  return Math.max(0, Math.min(1, score));
}

function rank(query, names, min = 0.6) {
  return names.map(n => ({ name: n, score: scoreName(query, n) })).filter(x => x.score >= min).sort((a, b) => b.score - a.score);
}
function bestOf(query, names, min = 0.85) { const r = rank(query, names, min); return r.length && (r.length === 1 || r[0].score - r[1].score >= 0.08) ? r[0].name : null; }

// Resolve a path whose pieces may be slightly wrong, one folder level at a time. Returns { path, fuzzy }.
function resolveExisting(full) {
  if (fs.existsSync(full)) return { path: full, fuzzy: false };
  const root = path.parse(full).root, parts = path.relative(root, full).split(path.sep).filter(Boolean);
  let cur = root, fuzzy = false;
  for (let i = 0; i < parts.length; i++) {
    const direct = path.join(cur, parts[i]);
    if (fs.existsSync(direct)) { cur = direct; continue; }
    let entries; try { entries = fs.readdirSync(cur); } catch { throw new Error(`Not found: ${full}`); }
    const r = rank(parts[i], entries, 0.6);
    if (!r.length) {
      const near = rank(parts[i], entries, 0.35).slice(0, 4).map(x => x.name);
      throw new Error(`Not found: "${parts[i]}" in ${cur}.${near.length ? ' Closest names there: ' + near.join(', ') : ''}`);
    }
    if (r.length > 1 && r[0].score - r[1].score < 0.1 && r[0].score < 0.999) throw new Error(`"${parts[i]}" in ${cur} could mean: ${r.slice(0, 5).map(x => x.name).join(' | ')}. Ask the user which one.`);
    cur = path.join(cur, r[0].name); fuzzy = true;
  }
  return { path: cur, fuzzy };
}
// For something that is about to be CREATED (a destination, a new folder): fix the folders that already exist
// ("Entertanmen" -> Entertainment) and keep the parts that match nothing as they are, because those are the new ones.
function walkDeepest(full) {
  const root = path.parse(full).root, parts = path.relative(root, full).split(path.sep).filter(Boolean);
  let cur = root, fuzzy = false;
  for (let i = 0; i < parts.length; i++) {
    const direct = path.join(cur, parts[i]);
    if (fs.existsSync(direct)) { cur = direct; continue; }
    let entries; try { entries = fs.readdirSync(cur); } catch { return { path: path.join(cur, ...parts.slice(i)), fuzzy }; }
    const r = rank(parts[i], entries, 0.6);
    if (!r.length) return { path: path.join(cur, ...parts.slice(i)), fuzzy }; // nothing like it: from here on it is new
    if (r.length > 1 && r[0].score - r[1].score < 0.1 && r[0].score < 0.999) throw new Error(`"${parts[i]}" in ${cur} could mean: ${r.slice(0, 5).map(x => x.name).join(' | ')}. Ask the user which one.`);
    cur = path.join(cur, r[0].name); fuzzy = true;
  }
  return { path: cur, fuzzy };
}
function resolveParent(full) {
  if (fs.existsSync(full)) return { path: full, fuzzy: false };
  const dir = path.dirname(full);
  if (dir === full) return { path: full, fuzzy: false };
  const r = walkDeepest(dir);
  return { path: path.join(r.path, path.basename(full)), fuzzy: r.fuzzy }; // the last name stays exactly as given
}

// Search names under root, forgiving. Scores the name, and the name together with its folder.
async function search(root, query, { max = 25, min = 0.58, deadlineMs = 9000, maxEntries = 120000 } = {}) {
  const fsp = fs.promises, end = Date.now() + deadlineMs, hits = [], queue = [[root, 0, '']];
  const skip = new Set(['node_modules', '.git', '$recycle.bin', 'windows', 'appdata', 'system volume information']);
  let seen = 0;
  while (queue.length && Date.now() < end && seen < maxEntries) {
    const [dir, depth, parentName] = queue.shift();
    let items; try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      seen++;
      let s = scoreName(query, it.name);
      if (s < min && parentName) s = Math.max(s, 0.85 * scoreName(query, parentName + ' ' + it.name)); // the folder name can carry part of the query
      if (s >= min - 0.2) hits.push({ full: path.join(dir, it.name) + (it.isDirectory() ? path.sep : ''), score: s });
      if (it.isDirectory() && depth < 7 && !skip.has(it.name.toLowerCase())) queue.push([path.join(dir, it.name), depth + 1, it.name]);
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return { good: hits.filter(h => h.score >= min).slice(0, max), near: hits.filter(h => h.score < min).slice(0, 5), scanned: seen };
}

module.exports = { norm, scoreName, rank, bestOf, resolveExisting, resolveParent, search };
