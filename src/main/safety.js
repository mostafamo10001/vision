'use strict';
const path = require('path');
const { app } = require('electron');
const logic = require('./screen-logic');

const PROTECTED_ROOTS = [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData]
  .filter(Boolean).map(p => path.resolve(p).toLowerCase());

function isProtectedPath(p) {
  const lp = path.resolve(p).toLowerCase();
  if (/^[a-z]:\\?$/.test(lp)) return true; // a drive root
  return PROTECTED_ROOTS.some(r => lp === r || lp.startsWith(r + path.sep));
}
function isPrivatePath(p) { // Vision' own config (contains the encrypted key)
  try { return path.resolve(p).toLowerCase().startsWith(path.resolve(app.getPath('userData')).toLowerCase()); } catch { return false; }
}

const BLOCKED_SHELL = [
  /format-volume/i, /\bdiskpart\b/i, /\bbcdedit\b/i, /\bcipher\s+\/w/i, /\bformat\s+[a-z]:/i,
  /remove-item[^|;&]*[a-z]:\\\s*(?:$|[|;&])/i, /\brd\s+\/s\s+\/q\s+[a-z]:\\\s*$/i,
  /reg(?:\.exe)?\s+delete\s+hk(?:lm|ey_local_machine)/i, /set-executionpolicy/i, /disable-windowsoptionalfeature/i,
  /invoke-expression[^|;]*downloadstring/i, /\biex\b[^|;]*(?:iwr|invoke-webrequest|downloadstring)/i,
  // switching protection off, persistence, and download-and-run tricks
  /disablerealtimemonitoring|disablebehaviormonitoring|disableioavprotection|set-mppreference|add-mppreference/i,
  /\bnetsh\s+advfirewall\s+set\b[^\n]*\boff\b/i, /\bschtasks(?:\.exe)?\s+\/create/i, /\breg(?:\.exe)?\s+add\b[^\n]*\\run(?:once)?\b/i,
  /\bcertutil\b[^\n]*-(?:urlcache|decode)/i, /\bbitsadmin\b/i, /\bmshta\b/i, /\bregsvr32\b[^\n]*\/i/i,
  /powershell(?:\.exe)?\b[^\n]*\s-e(?:nc|ncodedcommand)?\s/i, /frombase64string[^\n]*(?:iex|invoke-expression)/i,
  /(?:invoke-webrequest|\biwr\b|\bcurl\b|\bwget\b|start-bitstransfer|downloadfile)[^\n]*\.(?:exe|msi|bat|cmd|scr|ps1|vbs|js|hta)\b/i
];
const shellBlocked = cmd => BLOCKED_SHELL.some(r => r.test(cmd));
// Commands that install, download or launch programs always need the user's OK, even when "don't ask before PowerShell" is on.
const NEEDS_APPROVAL = /\b(?:winget|choco|scoop)\b[^\n]*\b(?:install|upgrade|add)\b|\bmsiexec\b|start-process|\.(?:exe|msi|msix|bat|cmd|scr|ps1)\b|invoke-webrequest|\biwr\b|\bcurl\b|\bwget\b|start-bitstransfer|downloadfile|add-appxpackage|new-service|\bsc(?:\.exe)?\s+(?:create|config)|\bschtasks\b|\breg(?:\.exe)?\s+(?:add|import)\b/i;
const shellNeedsApproval = cmd => NEEDS_APPROVAL.test(String(cmd || ''));

// level: 0 harmless, 1 changes state, 2 hard to undo / leaves the machine
function shouldAsk(level, mode, alwaysAsk) {
  if (alwaysAsk) return true;
  if (mode === 'autopilot') return false;
  if (mode === 'cautious') return level >= 1;
  return level >= 2;
}

module.exports = { isProtectedPath, isPrivatePath, shellBlocked, shellNeedsApproval, shouldAsk, riskyClickTarget: logic.riskyClickTarget, riskyClickWords: logic.riskyClickWords, isExecutablePath: logic.isExecutablePath };
