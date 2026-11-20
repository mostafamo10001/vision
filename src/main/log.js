'use strict';
// One plain-text log of everything that goes wrong (tool failures, crashes, window errors), so problems can be read, not guessed.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const dir = () => path.join(app.getPath('userData'), 'logs');
const file = () => path.join(dir(), 'jarvis.log');

function log(kind, msg) {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const f = file();
    try { if (fs.statSync(f).size > 1000000) fs.renameSync(f, f + '.old'); } catch {}
    fs.appendFileSync(f, `${new Date().toISOString()} [${kind}] ${String(msg).replace(/\s+/g, ' ').slice(0, 700)}\n`);
  } catch {}
}
function tail(n = 25) { try { return fs.readFileSync(file(), 'utf8').trim().split('\n').slice(-n).join('\n') || '(empty)'; } catch { return '(no errors logged yet)'; } }
module.exports = { log, tail, dir, file };
