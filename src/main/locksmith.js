'use strict';
// Vision 1.9: "what is locking this file?" (a File Locksmith for the voice agent).
// No extra program is installed: it asks Windows itself through the Restart Manager API (rstrtmgr.dll), the documented way to list
// the programs that hold a file open. tools.js loads this inside try/catch, so a failure here never affects the other tools.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PS = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class VisionRM {
  [StructLayout(LayoutKind.Sequential)]
  struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, int flags, string key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint nFiles, string[] files, uint nApps, IntPtr apps, uint nSvc, IntPtr svc);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);

  public static string[] Who(string[] files) {
    var result = new List<string>();
    var seen = new HashSet<int>();
    uint h; string key = Guid.NewGuid().ToString();
    int rc = RmStartSession(out h, 0, key);
    if (rc != 0) throw new Exception("Restart Manager could not start (error " + rc + ").");
    try {
      for (int i = 0; i < files.Length; i += 200) {
        int n = Math.Min(200, files.Length - i);
        string[] chunk = new string[n];
        Array.Copy(files, i, chunk, 0, n);
        rc = RmRegisterResources(h, (uint)n, chunk, 0, IntPtr.Zero, 0, IntPtr.Zero);
        if (rc != 0) throw new Exception("Restart Manager could not read the file list (error " + rc + ").");
      }
      uint needed = 0, count = 0, reasons = 0;
      rc = RmGetList(h, out needed, ref count, null, ref reasons);
      for (int attempt = 0; rc == 234 && attempt < 5; attempt++) {
        count = needed + 4;
        var info = new RM_PROCESS_INFO[count];
        rc = RmGetList(h, out needed, ref count, info, ref reasons);
        if (rc == 0) {
          for (int k = 0; k < count; k++) {
            int pid = info[k].Process.dwProcessId;
            if (!seen.Add(pid)) continue;
            string name = info[k].strAppName, exe = "";
            try { var p = Process.GetProcessById(pid); exe = p.MainModule.FileName; if (string.IsNullOrEmpty(name)) name = p.ProcessName; } catch { }
            string kind = info[k].ApplicationType == 3 ? "service" : (info[k].ApplicationType == 4 ? "explorer" : "app");
            result.Add(pid + "\t" + name + "\t" + kind + "\t" + exe);
          }
        }
      }
      if (rc != 0 && rc != 234) throw new Exception("Restart Manager could not list the programs (error " + rc + ").");
    } finally { RmEndSession(h); }
    return result.ToArray();
  }
}
'@
$target = $env:VISION_LOCK_PATH
$limit = 5000
$t = [char]9
if (Test-Path -LiteralPath $target -PathType Container) {
  $files = @(Get-ChildItem -LiteralPath $target -Recurse -File -Force -ErrorAction SilentlyContinue | Select-Object -First $limit | ForEach-Object { $_.FullName })
  $prefix = $target.TrimEnd('\') + '\'
  # programs running from inside the folder also keep it from being deleted or renamed
  Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
    try { if ($_.Path -and $_.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { Write-Output ("$($_.Id)$t$($_.ProcessName)$($t)runs from folder$t$($_.Path)") } } catch {}
  }
  $mode = 'all'; if ($files.Count -ge $limit) { $mode = 'truncated' }
  Write-Output ("#files$t$($files.Count)$t$mode")
} else {
  $files = @($target)
  Write-Output ("#files$($t)1$($t)all")
}
if ($files.Count -gt 0) { [VisionRM]::Who([string[]]$files) | ForEach-Object { Write-Output $_ } }
`;

function register(h) {
  const { def, str, obj, resolveLoose, clip, safety } = h;

  const run = target => new Promise((resolve, reject) => {
    const enc = Buffer.from(PS, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
      { timeout: 60000, windowsHide: true, maxBuffer: 4e6, encoding: 'utf8', env: { ...process.env, VISION_LOCK_PATH: target } },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(String(stderr || err.message).trim().split(/\r?\n/).filter(Boolean).slice(0, 2).join(' ').slice(0, 300) || 'PowerShell failed.'));
        resolve(String(stdout || ''));
      });
  });

  def({
    name: 'who_locks_file',
    description: 'Find out which programs have a file or folder open or locked: use it for "why can\'t I delete / rename / move / eject this", "file is in use", "what is using this folder". Read-only: it changes nothing. Tell the user the program names; to free the file offer to close that program with end_process (it asks first) or ask the user to close it themselves.',
    parameters: obj({ path: str('The file or folder, as the user said it (typos are fine; shortcuts like downloads/report.docx work).') }, ['path']),
    level: () => 0,
    describe: a => `Who locks: ${clip(String(a.path || ''), 120)}`,
    run: async a => {
      const target = resolveLoose(a.path);
      if (safety.isPrivatePath(target)) throw new Error('Not allowed.');
      if (!fs.existsSync(target)) throw new Error('That file or folder does not exist.');
      const lines = (await run(target)).split(/\r?\n/).map(l => l.replace(/\r/g, '')).filter(Boolean);
      const meta = lines.find(l => l.startsWith('#files')), procs = [], seen = new Set();
      for (const l of lines) {
        if (l.startsWith('#')) continue;
        const [pid, name, kind, exe] = l.split('\t');
        if (!/^\d+$/.test(pid || '') || seen.has(pid)) continue;
        seen.add(pid); procs.push({ pid, name: name || '?', kind: kind || 'app', exe: exe || '' });
      }
      const m = meta ? meta.split('\t') : [], isDir = fs.statSync(target).isDirectory();
      const scope = isDir ? `the folder ${target} (${m[1] || '0'} file(s) checked${m[2] === 'truncated' ? ', only the first 5000' : ''})` : target;
      if (!procs.length) return `Nothing is holding ${scope} open right now, as far as Windows reports. ${isDir ? 'A program can still keep a folder busy just by having it as its working folder or showing it in a window.' : 'If it still will not delete, it may be read-only, protected, or needs administrator rights.'}`;
      const rows = procs.slice(0, 25).map(p => `- ${p.name} (PID ${p.pid})${p.kind === 'service' ? ' [Windows service]' : p.kind === 'explorer' ? ' [File Explorer]' : ''}${p.exe ? ' ' + p.exe : ''}`).join('\n');
      return clip(`These ${procs.length} program(s) hold ${scope}:\n${rows}\nTo free it: close the program, or end it with end_process using the PID (the user is asked first; unsaved work in it is lost).`, 4000);
    }
  });
}

module.exports = register;
module.exports._PS = PS;
