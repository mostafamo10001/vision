'use strict';
// "Start with Windows". Two mechanisms, picked automatically:
//  1. A scheduled task that runs at logon with the highest privileges. It is the only way to auto-start an app that runs
//     as administrator (Windows silently refuses those from the normal Startup list). It is created whenever Vision itself
//     is running as administrator, which is the only time Windows lets an app create one.
//  2. The user's Run registry key plus the "enabled" mark in Startup Apps, for a normal (non-elevated) app.
// Re-asserted on every launch, and readable back for diagnostics.
const { execFile } = require('child_process');
const RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPROVED = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
const COMPAT = '\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers';
const NAME = 'VisionAssistant', OLD_NAME = 'JarvisAssistant', TASK = 'VisionAssistant'; // the app used to be called Jarvis

const run = (file, args) => new Promise(res => execFile(file, args, { windowsHide: true }, (err, out, se) => res({ ok: !err, out: String(out || ''), err: String(se || '') })));
const reg = args => run('reg.exe', args);
const schtasks = args => run('schtasks.exe', args);

const isElevated = async () => (await run('net.exe', ['session'])).ok;
const taskExists = async () => (await schtasks(['/Query', '/TN', TASK])).ok;
async function runKeyValue() { const r = await reg(['query', RUN, '/v', NAME]); const m = r.ok && r.out.match(/REG_SZ\s+(.+)/); return m ? m[1].trim() : null; }
async function approvedMark() { const r = await reg(['query', APPROVED, '/v', NAME]); const m = r.ok && r.out.match(/REG_BINARY\s+([0-9A-Fa-f]{2})/); return m ? m[1] : null; } // 02 = enabled, 03 = switched off in Task Manager
async function flaggedRunAsAdmin(exe) { for (const hive of ['HKCU', 'HKLM']) { const r = await reg(['query', hive + COMPAT, '/v', exe]); if (r.ok && /RUNASADMIN/i.test(r.out)) return true; } return false; }

async function removeOld() { await reg(['delete', RUN, '/v', OLD_NAME, '/f']); await reg(['delete', APPROVED, '/v', OLD_NAME, '/f']); }
async function enable(exePath) {
  await removeOld();
  let via = 'run-key';
  if (await isElevated()) { // only an administrator can create a highest-privilege task
    const t = await schtasks(['/Create', '/TN', TASK, '/TR', `"${exePath}" --hidden`, '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F', '/DELAY', '0000:08']);
    if (t.ok) via = 'task';
  }
  if (via === 'task') await reg(['delete', RUN, '/v', NAME, '/f']); // one mechanism is enough: two would just start it twice
  else {
    const a = await reg(['add', RUN, '/v', NAME, '/t', 'REG_SZ', '/d', `"${exePath}" --hidden`, '/f']);
    await reg(['add', APPROVED, '/v', NAME, '/t', 'REG_BINARY', '/d', '020000000000000000000000', '/f']); // clears a "disabled" mark left by Task Manager
    if (!a.ok) via = 'failed';
  }
  return via;
}
async function disable() {
  await removeOld(); await schtasks(['/Delete', '/TN', TASK, '/F']);
  await reg(['delete', RUN, '/v', NAME, '/f']); await reg(['delete', APPROVED, '/v', NAME, '/f']);
}
// For the diagnostics report: what is set up, and whether Windows will actually honour it. Throws with the reason when it will not.
async function report(exePath) {
  const [task, value, mark, flagged, elevated] = [await taskExists(), await runKeyValue(), await approvedMark(), await flaggedRunAsAdmin(exePath), await isElevated()];
  if (task) return 'scheduled task at logon, runs with full rights and no prompt' + (value ? ' (a Run entry exists too; harmless)' : '');
  if (!value) throw new Error('not registered in Windows startup (tick "Start with Windows" in Settings)');
  if (mark === '03') throw new Error('it is registered, but switched OFF in Task Manager > Startup apps. Switch it on there, or untick and tick "Start with Windows" in Settings');
  if (flagged && !elevated) throw new Error('Vision is set to "Run as administrator", and Windows silently refuses to auto-start such an app from the Startup list. Start Vision as administrator once: it then sets up a startup task that works (or remove the "Run as administrator" setting in its Properties > Compatibility)');
  return 'Run entry in the Startup list' + (elevated ? ' (this copy is elevated but could not create the startup task)' : '');
}

module.exports = { enable, disable, report, flaggedRunAsAdmin, isElevated, NAME };
