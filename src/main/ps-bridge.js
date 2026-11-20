'use strict';
// Persistent PowerShell helper process: fast native input, UI Automation, windows, volume.
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const asciiJson = obj => JSON.stringify(obj).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

class PsBridge {
  constructor() { this.proc = null; this.ready = null; this.pending = new Map(); this.seq = 0; this.lastErr = ''; }
  script() { return path.join(__dirname, 'helper.ps1').replace('app.asar', 'app.asar.unpacked'); }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      if (process.platform !== 'win32') return reject(new Error('The PC control helper only runs on Windows.'));
      const p = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script()],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = p;
      const timer = setTimeout(() => reject(new Error('PC control helper did not start. ' + this.lastErr)), 30000);
      readline.createInterface({ input: p.stdout }).on('line', line => {
        let msg; try { msg = JSON.parse(line); } catch { return; }
        if (msg.ready) { clearTimeout(timer); return resolve(); }
        const slot = this.pending.get(msg.id);
        if (!slot) return;
        this.pending.delete(msg.id); clearTimeout(slot.timer);
        msg.ok ? slot.resolve(msg.result) : slot.reject(new Error(msg.error || 'helper error'));
      });
      p.stderr.on('data', d => { this.lastErr = String(d).slice(-400); });
      p.on('error', e => { clearTimeout(timer); reject(e); });
      p.on('exit', () => {
        clearTimeout(timer);
        for (const s of this.pending.values()) { clearTimeout(s.timer); s.reject(new Error('PC control helper stopped. ' + this.lastErr)); }
        this.pending.clear(); this.proc = null; this.ready = null;
      });
    }).catch(e => { try { this.proc?.kill(); } catch {} this.proc = null; this.ready = null; throw e; });
    return this.ready;
  }

  async call(cmd, args = {}, timeoutMs = 30000) {
    await this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`PC helper timed out on "${cmd}"`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(asciiJson({ id, cmd, args }) + '\n');
    });
  }
  stop() { try { this.proc?.kill(); } catch {} }
}
module.exports = new PsBridge();
