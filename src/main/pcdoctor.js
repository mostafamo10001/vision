'use strict';
// Vision 1.9: Windows diagnostics and repairs.
//  pc_diagnose: read-only checks (health overview, error log, app crashes, blue screens, disks, network, startup, services, devices, updates, security, performance, battery).
//  pc_fix:      a fixed list of well-known repairs. Each one always asks the user first; the ones that need administrator rights trigger the normal Windows UAC prompt.
// Scripts only receive values through environment variables, never by building command text from user input.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { Notification } = require('electron');

const HEAD = "$ErrorActionPreference='SilentlyContinue'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n";
const HEAD_FIX = "$ErrorActionPreference='Continue'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n"; // repairs must show their errors
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- read-only checks ----------------
const CHECKS = {
  overview: String.raw`
$os=Get-CimInstance Win32_OperatingSystem; $cs=Get-CimInstance Win32_ComputerSystem
$up=(Get-Date)-$os.LastBootUpTime
"Windows: $($os.Caption) $($os.Version) (build $($os.BuildNumber)), $($os.OSArchitecture)"
"PC: $($cs.Manufacturer) $($cs.Model)"
"Up for: $([int]$up.TotalDays) days $($up.Hours) h (last start $($os.LastBootUpTime))"
$tot=[math]::Round($os.TotalVisibleMemorySize/1MB,1); $free=[math]::Round($os.FreePhysicalMemory/1MB,1)
"Memory: $([math]::Round($tot-$free,1)) of $tot GB in use"
"CPU load now: $((Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average) %"
Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { "Drive $($_.DeviceID): $([math]::Round($_.FreeSpace/1GB,1)) GB free of $([math]::Round($_.Size/1GB,1)) GB" }
Get-PhysicalDisk | ForEach-Object { "Disk $($_.FriendlyName): health $($_.HealthStatus), $($_.MediaType)" }
$pend=$false
if(Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending'){$pend=$true}
if(Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'){$pend=$true}
"Restart waiting to finish updates: $pend"
$mp=Get-MpComputerStatus
if($mp){ "Defender: real-time protection $($mp.RealTimeProtectionEnabled); definitions from $($mp.AntivirusSignatureLastUpdated); last quick scan $($mp.QuickScanEndTime)" }
$bad=@(Get-PnpDevice -PresentOnly | Where-Object { $_.Status -eq 'Error' })
"Devices with problems: $($bad.Count)"
$bad | Select-Object -First 8 | ForEach-Object { "  - $($_.FriendlyName) [$($_.Class)]" }
$skip='gupdate|gupdatem|edgeupdate|MapsBroker|sppsvc|RemoteRegistry|tiledatamodelsvc|WbioSrvc|CDPUserSvc|OneSyncSvc|PimIndexMaintenanceSvc|UnistoreSvc|UserDataSvc|cbdhsvc|BcastDVRUserService|TrustedInstaller|clr_optimization|MicrosoftEdgeElevationService|edgeupdatem'
$svc=@(Get-CimInstance Win32_Service | Where-Object { $_.StartMode -eq 'Auto' -and $_.State -ne 'Running' -and $_.Name -notmatch $skip })
"Automatic services that are not running: $($svc.Count)"
$svc | Select-Object -First 10 | ForEach-Object { "  - $($_.DisplayName) ($($_.Name))" }
$ev=@(Get-WinEvent -FilterHashtable @{LogName='System','Application';Level=1,2;StartTime=(Get-Date).AddHours(-24)} -MaxEvents 500)
"Errors/critical events in the last 24 h: $($ev.Count)"
$ev | Group-Object ProviderName | Sort-Object Count -Descending | Select-Object -First 5 | ForEach-Object { "  - $($_.Name): $($_.Count)" }
`,
  errors: String.raw`
$h=[int]$env:VISION_HOURS; if($h -le 0){$h=24}
$ev=@(Get-WinEvent -FilterHashtable @{LogName='System','Application';Level=1,2;StartTime=(Get-Date).AddHours(-$h)} -MaxEvents 1500)
"Found $($ev.Count) error/critical events in the last $h hours (most frequent first)."
$ev | Group-Object ProviderName,Id | Sort-Object Count -Descending | Select-Object -First 12 | ForEach-Object {
  $f=$_.Group[0]; $m=($f.Message -replace '\s+',' '); if($m.Length -gt 200){$m=$m.Substring(0,200)}
  "$($_.Count)x $($f.ProviderName) (event $($f.Id)), latest $($f.TimeCreated): $m" }
`,
  crashes: String.raw`
$d=[int]$env:VISION_HOURS; if($d -le 0){$d=168}; $since=(Get-Date).AddHours(-$d); $q=$env:VISION_ARG
$rows=@()
$rows+=@(Get-WinEvent -FilterHashtable @{LogName='Application';ProviderName='Application Error';Id=1000;StartTime=$since} -MaxEvents 300 | ForEach-Object { [pscustomobject]@{T=$_.TimeCreated;Kind='crash';App=$_.Properties[0].Value;Ver=$_.Properties[1].Value;Module=$_.Properties[3].Value;Code=$_.Properties[6].Value} })
$rows+=@(Get-WinEvent -FilterHashtable @{LogName='Application';ProviderName='Application Hang';Id=1002;StartTime=$since} -MaxEvents 300 | ForEach-Object { [pscustomobject]@{T=$_.TimeCreated;Kind='hang';App=$_.Properties[0].Value;Ver=$_.Properties[1].Value;Module='';Code=''} })
if($q){ $rows=@($rows | Where-Object { $_.App -match [regex]::Escape($q) }) }
"Application crashes/hangs in the last $([int]($d/24)) day(s): $($rows.Count)"
$rows | Group-Object App | Sort-Object Count -Descending | Select-Object -First 10 | ForEach-Object {
  $f=$_.Group[0]; $mods=($_.Group | Where-Object {$_.Module} | Group-Object Module | Sort-Object Count -Descending | Select-Object -First 2 | ForEach-Object { "$($_.Name) x$($_.Count)" }) -join ', '
  "$($_.Count)x $($_.Name) $($f.Ver) (latest $($f.T)); faulting module: $mods; exception code: $($f.Code)" }
`,
  bsod: String.raw`
$e=@(Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-WER-SystemErrorReporting';Id=1001} -MaxEvents 5)
"Blue screens recorded: $($e.Count)"
$e | ForEach-Object { $m=($_.Message -replace '\s+',' '); if($m.Length -gt 260){$m=$m.Substring(0,260)}; "$($_.TimeCreated): $m" }
$k=@(Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-Kernel-Power';Id=41} -MaxEvents 5)
"Unexpected shutdowns / power loss (Kernel-Power 41): $($k.Count)"
$k | ForEach-Object { $c=$_.Properties[0].Value; "$($_.TimeCreated): bugcheck code 0x{0:X}" -f [int]$c }
$u=@(Get-WinEvent -FilterHashtable @{LogName='System';Id=6008} -MaxEvents 3)
$u | ForEach-Object { "$($_.TimeCreated): previous shutdown was unexpected" }
$dumps=@(Get-ChildItem "$env:SystemRoot\Minidump" -Filter *.dmp | Sort-Object LastWriteTime -Descending | Select-Object -First 5)
"Crash dump files: $($dumps.Count)"; $dumps | ForEach-Object { "  $($_.Name) $($_.LastWriteTime)" }
if(Test-Path "$env:SystemRoot\MEMORY.DMP"){ "Full memory dump exists: $((Get-Item "$env:SystemRoot\MEMORY.DMP").LastWriteTime)" }
`,
  disk: String.raw`
Get-Volume | Where-Object { $_.DriveLetter } | ForEach-Object { "Volume $($_.DriveLetter): $($_.FileSystemLabel) $($_.FileSystem), health $($_.HealthStatus), $([math]::Round($_.SizeRemaining/1GB,1)) GB free of $([math]::Round($_.Size/1GB,1)) GB" }
Get-PhysicalDisk | ForEach-Object {
  $r=$_ | Get-StorageReliabilityCounter
  "Disk $($_.FriendlyName) ($($_.MediaType), $($_.BusType)): $($_.HealthStatus), $($_.OperationalStatus); temp $($r.Temperature) C; wear $($r.Wear) %; read errors $($r.ReadErrorsTotal); power-on hours $($r.PowerOnHours)" }
$ev=@(Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='disk','Ntfs','stornvme','storahci','volmgr';Level=1,2,3;StartTime=(Get-Date).AddDays(-14)} -MaxEvents 200)
"Disk/file-system warnings and errors in the last 14 days: $($ev.Count)"
$ev | Group-Object ProviderName,Id | Sort-Object Count -Descending | Select-Object -First 6 | ForEach-Object { $f=$_.Group[0]; $m=($f.Message -replace '\s+',' '); if($m.Length -gt 160){$m=$m.Substring(0,160)}; "$($_.Count)x $($f.ProviderName) event $($f.Id): $m" }
`,
  network: String.raw`
$cfg=@(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -ne $null })
if($cfg.Count -eq 0){ "No network adapter has a default gateway (not connected to a network)." }
foreach($c in $cfg){
  $gw=$c.IPv4DefaultGateway.NextHop
  "Adapter $($c.InterfaceAlias): IP $($c.IPv4Address.IPAddress), gateway $gw, DNS $(@($c.DNSServer.ServerAddresses) -join ', ')"
  "Gateway reachable: $(Test-Connection -ComputerName $gw -Count 2 -Quiet)"
}
"Internet reachable by address (1.1.1.1): $(Test-Connection -ComputerName 1.1.1.1 -Count 2 -Quiet)"
try{ $r=Resolve-DnsName example.com -DnsOnly -ErrorAction Stop; "DNS lookup of example.com: OK ($(@($r)[0].IPAddress))" }catch{ "DNS lookup of example.com: FAILED ($($_.Exception.Message))" }
try{ $w=Invoke-WebRequest -Uri 'http://www.msftconnecttest.com/connecttest.txt' -UseBasicParsing -TimeoutSec 8; "Windows connectivity test: $($w.Content.Trim())" }catch{ "Windows connectivity test: FAILED" }
$p=Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
"Proxy: enabled=$($p.ProxyEnable) server=$($p.ProxyServer)"
Get-NetAdapter | ForEach-Object { "Network device $($_.Name): $($_.Status), $($_.LinkSpeed), $($_.InterfaceDescription)" }
$w=netsh wlan show interfaces 2>$null | Select-String -Pattern '^\s*(SSID|Signal|State|Radio type|Receive rate)' ; $w | ForEach-Object { $_.Line.Trim() }
`,
  startup: String.raw`
$s=@(Get-CimInstance Win32_StartupCommand)
"Programs that start with Windows: $($s.Count)"
$s | ForEach-Object { $c=$_.Command; if($c.Length -gt 110){$c=$c.Substring(0,110)}; "  - $($_.Name): $c [$($_.Location)]" }
$t=@(Get-ScheduledTask | Where-Object { $_.State -ne 'Disabled' -and $_.TaskPath -notmatch '^\\Microsoft\\' -and @($_.Triggers | Where-Object { $_.CimClass.CimClassName -match 'Logon|Boot' }).Count -gt 0 })
"Non-Microsoft scheduled tasks that run at logon/boot: $($t.Count)"; $t | Select-Object -First 15 | ForEach-Object { "  - $($_.TaskName)" }
`,
  services: String.raw`
$q=$env:VISION_ARG
if($q){ Get-Service | Where-Object { $_.Name -like "*$q*" -or $_.DisplayName -like "*$q*" } | Select-Object -First 15 | ForEach-Object { "$($_.DisplayName) ($($_.Name)): $($_.Status), start type $($_.StartType)" } }
else {
  $svc=@(Get-CimInstance Win32_Service | Where-Object { $_.StartMode -eq 'Auto' -and $_.State -ne 'Running' })
  "Automatic services that are not running: $($svc.Count) (some stop on purpose after finishing their work)"
  $svc | Select-Object -First 25 | ForEach-Object { "  - $($_.DisplayName) ($($_.Name)), exit code $($_.ExitCode)" }
}
`,
  devices: String.raw`
$bad=@(Get-PnpDevice -PresentOnly | Where-Object { $_.Status -eq 'Error' -or $_.Status -eq 'Degraded' })
"Devices reporting a problem: $($bad.Count)"
$bad | ForEach-Object { $code=(Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName DEVPKEY_Device_ProblemCode).Data; "  - $($_.FriendlyName) [$($_.Class)] status $($_.Status), Device Manager error code $code" }
$unk=@(Get-PnpDevice -PresentOnly | Where-Object { $_.Class -eq 'Unknown' -or -not $_.FriendlyName })
"Devices with no driver / unknown: $($unk.Count)"
`,
  updates: String.raw`
"Latest installed updates:"
Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 8 | ForEach-Object { "  $($_.HotFixID) installed $($_.InstalledOn)" }
$s=Get-Service wuauserv,bits,cryptsvc,TrustedInstaller; $s | ForEach-Object { "Service $($_.Name): $($_.Status), $($_.StartType)" }
$pend=$false
if(Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending'){$pend=$true}
if(Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'){$pend=$true}
"Restart pending: $pend"
$f=@(Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-WindowsUpdateClient/Operational';Level=2;StartTime=(Get-Date).AddDays(-30)} -MaxEvents 30)
"Windows Update failures in the last 30 days: $($f.Count)"
$f | Select-Object -First 6 | ForEach-Object { $m=($_.Message -replace '\s+',' '); if($m.Length -gt 220){$m=$m.Substring(0,220)}; "  $($_.TimeCreated): $m" }
`,
  security: String.raw`
$mp=Get-MpComputerStatus
if($mp){ "Defender: antivirus $($mp.AntivirusEnabled), real-time $($mp.RealTimeProtectionEnabled), definitions $($mp.AntivirusSignatureLastUpdated), last quick scan $($mp.QuickScanEndTime), last full scan $($mp.FullScanEndTime)" } else { "Defender status is not available (another antivirus may be in charge)." }
Get-NetFirewallProfile | ForEach-Object { "Firewall $($_.Name): enabled=$($_.Enabled)" }
$t=@(Get-MpThreatDetection | Sort-Object InitialDetectionTime -Descending | Select-Object -First 5)
"Recent threat detections: $($t.Count)"; $t | ForEach-Object { "  $($_.InitialDetectionTime): threat id $($_.ThreatID), $($_.ActionSuccess)" }
$uac=(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System').EnableLUA; "UAC enabled: $uac"
`,
  performance: String.raw`
$cpu=(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average
$d=Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Where-Object { $_.Name -eq '_Total' }
"CPU load $cpu %, disk busy $($d.PercentDiskTime) %, disk queue $($d.CurrentDiskQueueLength)"
$p=Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' }
"Top by CPU:"; $p | Sort-Object PercentProcessorTime -Descending | Select-Object -First 6 | ForEach-Object { "  $($_.Name) (PID $($_.IDProcess)): $($_.PercentProcessorTime) %" }
"Top by memory:"; $p | Sort-Object WorkingSetPrivate -Descending | Select-Object -First 6 | ForEach-Object { "  $($_.Name) (PID $($_.IDProcess)): $([math]::Round($_.WorkingSetPrivate/1MB)) MB" }
"Top by disk activity:"; $p | Sort-Object IODataBytesPersec -Descending | Select-Object -First 4 | ForEach-Object { "  $($_.Name): $([math]::Round($_.IODataBytesPersec/1MB,1)) MB/s" }
"Programs starting with Windows: $(@(Get-CimInstance Win32_StartupCommand).Count)"
`,
  battery: String.raw`
$b=Get-CimInstance Win32_Battery
if(-not $b){ "No battery found (desktop PC)." } else {
  $b | ForEach-Object { "Battery: $($_.EstimatedChargeRemaining) % charged, status code $($_.BatteryStatus), about $($_.EstimatedRunTime) min left" }
  $full=(Get-CimInstance -Namespace root\wmi -ClassName BatteryFullChargedCapacity).FullChargedCapacity
  $design=(Get-CimInstance -Namespace root\wmi -ClassName BatteryStaticData).DesignedCapacity
  if($full -and $design){ "Battery health: full-charge capacity is $([math]::Round(100*$full/$design)) % of the design capacity ($full of $design mWh)" }
}
`
};

// ---------------------------------------------------------------- repairs ----------------
const PROTECTED_SERVICES = /^(RpcSs|RpcEptMapper|DcomLaunch|LSM|SamSs|EventLog|PlugPlay|Power|ProfSvc|BrokerInfrastructure|CoreMessagingRegistrar|gpsvc|lanmanserver|LanmanWorkstation|Schedule|SystemEventsBroker|TrustedInstaller|WinDefend|mpssvc|BFE|Winmgmt|CryptSvc|KeyIso|nsi|Dhcp|Dnscache|NlaSvc)$/i;
const FIXES = {
  flush_dns: { admin: true, text: 'Clear the DNS cache', script: 'Clear-DnsClientCache -ErrorAction Stop; "DNS cache cleared."' },
  reset_network: { admin: true, text: 'Reset the Windows network stack (winsock + TCP/IP); a restart is needed afterwards', script: 'netsh winsock reset; netsh int ip reset; ipconfig /flushdns; "Network stack reset. Restart the PC to finish."' },
  restart_network_adapter: { admin: true, arg: 'adapter', text: a => `Restart the network adapter "${a}"`, script: 'Restart-NetAdapter -Name $env:VISION_ARG -Confirm:$false -ErrorAction Stop; Start-Sleep 3; Get-NetAdapter -Name $env:VISION_ARG | ForEach-Object { "Adapter $($_.Name): $($_.Status)" }' },
  restart_service: { admin: true, arg: 'service', text: a => `Restart the Windows service "${a}"`, script: '$s=Get-Service -Name $env:VISION_ARG -ErrorAction Stop; Restart-Service -Name $s.Name -Force -ErrorAction Stop; (Get-Service -Name $s.Name) | ForEach-Object { "Service $($_.DisplayName): $($_.Status)" }' },
  restart_explorer: { admin: false, text: 'Restart Windows Explorer (taskbar, desktop and File Explorer windows reload)', script: 'Stop-Process -Name explorer -Force; Start-Sleep 2; if(-not (Get-Process explorer -ErrorAction SilentlyContinue)){ Start-Process explorer.exe }; "Explorer restarted."' },
  restart_audio: { admin: true, text: 'Restart the Windows audio services', script: 'Restart-Service AudioEndpointBuilder -Force -ErrorAction Stop; Start-Service Audiosrv -ErrorAction SilentlyContinue; "Audio services: $((Get-Service Audiosrv).Status)"' },
  restart_bluetooth: { admin: true, text: 'Restart the Bluetooth service', script: 'Restart-Service bthserv -Force -ErrorAction Stop; "Bluetooth service: $((Get-Service bthserv).Status)"' },
  fix_print_spooler: { admin: true, text: 'Clear the print queue and restart the Print Spooler', script: 'Stop-Service Spooler -Force; Start-Sleep 1; Remove-Item "$env:SystemRoot\\System32\\spool\\PRINTERS\\*" -Force -ErrorAction SilentlyContinue; Start-Service Spooler; "Print Spooler: $((Get-Service Spooler).Status), queue cleared."' },
  clear_temp: { admin: false, text: 'Delete temporary files older than 2 days (your Temp folder, and Windows Temp where allowed)', script: '$cut=(Get-Date).AddDays(-2); $freed=0; foreach($d in @($env:TEMP, "$env:SystemRoot\\Temp")){ if(Test-Path $d){ Get-ChildItem -LiteralPath $d -Recurse -Force -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $cut } | ForEach-Object { try{ $l=$_.Length; Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop; $freed+=$l }catch{} } } }; "Freed $([math]::Round($freed/1MB,1)) MB of temporary files."' },
  clear_update_cache: { admin: true, text: 'Reset the Windows Update download cache (renames SoftwareDistribution; Windows rebuilds it)', script: 'Stop-Service wuauserv -Force; Stop-Service bits -Force; Start-Sleep 2; Rename-Item "$env:SystemRoot\\SoftwareDistribution" ("SoftwareDistribution.old." + (Get-Date -Format yyyyMMddHHmm)) -ErrorAction Stop; Start-Service bits; Start-Service wuauserv; "Update cache reset. Check for updates again."' },
  verify_system_files: { admin: true, long: true, text: 'Scan Windows system files for damage without changing anything (sfc /verifyonly, can take 10-20 minutes)', script: 'sfc /verifyonly' },
  repair_system_files: { admin: true, long: true, text: 'Repair damaged Windows system files (sfc /scannow, can take 10-20 minutes)', script: 'sfc /scannow' },
  repair_windows_image: { admin: true, long: true, text: 'Repair the Windows component store (DISM /RestoreHealth, needs internet, can take 20-40 minutes)', script: 'DISM /Online /Cleanup-Image /RestoreHealth' },
  check_disk: { admin: true, long: true, arg: 'drive', text: a => `Scan drive ${a}: for errors without taking it offline (read-only scan)`, script: 'Repair-Volume -DriveLetter $env:VISION_ARG -Scan -ErrorAction Stop; "Scan finished (see result above)."' },
  defender_update_scan: { admin: true, long: true, text: 'Update Defender virus definitions and run a quick scan', script: 'Update-MpSignature; Start-MpScan -ScanType QuickScan; "Defender updated and quick scan finished. Threats found: $(@(Get-MpThreat).Count)"' }
};

function register(h) {
  const { def, str, num, obj, oneOf, runtime, logger, clip } = h;
  const say = (kind, text) => runtime.emit('step', { kind, text });
  const notify = (title, body) => { try { new Notification({ title, body: String(body).slice(0, 220) }).show(); } catch {} };

  const psExec = (script, env, timeoutMs, strict) => new Promise((resolve, reject) => {
    const enc = Buffer.from((strict ? HEAD_FIX : HEAD) + script, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
      { timeout: timeoutMs || 120000, windowsHide: true, maxBuffer: 8e6, encoding: 'utf8', env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        const out = String(stdout || '').replace(/\u0000/g, '').trim();
        if (err && !out) return reject(new Error(String(stderr || err.message).replace(/\u0000/g, '').trim().split(/\r?\n/).filter(Boolean).slice(0, 3).join(' ').slice(0, 400) || 'PowerShell failed.'));
        resolve(out + (err && stderr ? '\n(warnings: ' + String(stderr).replace(/\u0000/g, '').trim().slice(0, 200) + ')' : ''));
      });
  });

  let adminCached = null;
  async function isAdmin() {
    if (adminCached != null) return adminCached;
    try { adminCached = (await psExec('([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)', {}, 20000)).trim().toLowerCase() === 'true'; } catch { adminCached = false; }
    return adminCached;
  }
  // Runs a script with administrator rights: the normal Windows "Do you want to allow this app to make changes?" prompt appears.
  async function psElevated(script, env, timeoutMs) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-fix-')), ps1 = path.join(dir, 'fix.ps1'), out = path.join(dir, 'out.txt');
    try {
      const envLines = Object.entries(env || {}).map(([k, v]) => `$env:${k} = '${String(v).replace(/'/g, "''")}'`).join('\n');
      fs.writeFileSync(ps1, '\uFEFF' + HEAD_FIX + envLines + '\n$r = try { & { ' + script + '\n} *>&1 } catch { "ERROR: " + $_.Exception.Message }\n$r | Out-String -Width 200 | Out-File -FilePath \'' + out.replace(/'/g, "''") + '\' -Encoding utf8\n', 'utf8');
      const launcher = `$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + '${ps1.replace(/'/g, "''")}' + '"'); "exit=" + $p.ExitCode`;
      let lastErr = '';
      try { await psExec(launcher, {}, timeoutMs); } catch (e) { lastErr = e.message; }
      if (!fs.existsSync(out)) throw new Error(/cancel/i.test(lastErr) ? 'The Windows administrator prompt was declined, so nothing was changed.' : (lastErr || 'The repair did not run (the administrator prompt was probably declined or timed out).'));
      return fs.readFileSync(out, 'utf8').replace(/\u0000/g, '').replace(/^\uFEFF/, '').trim();
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  }

  def({
    name: 'pc_diagnose',
    description: 'Read-only Windows troubleshooting: collects facts so a problem can be diagnosed before anything is changed. check: overview (health summary: Windows version, uptime, memory, disks, pending restart, Defender, problem devices, stopped services, recent error counts: START HERE), errors (Event Log errors grouped by source; hours = how far back), crashes (apps that crashed or hung; optional app name), bsod (blue screens / unexpected shutdowns with stop codes), disk (drive health, SMART, disk errors), network (adapter, gateway, internet, DNS, proxy, Wi-Fi), startup (programs that start with Windows), services (stopped automatic services, or look up one by name), devices (Device Manager problems with error codes), updates (Windows Update history and failures), security (Defender, firewall, detections), performance (what is using CPU, memory, disk right now), battery. Explain findings simply; for unknown error codes or event IDs use a web lookup; then offer a fix with pc_fix.',
    parameters: obj({
      check: oneOf('Which check to run.', Object.keys(CHECKS)),
      hours: num('errors / crashes: how many hours back to look (default 24 for errors, 168 for crashes).'),
      name: str('crashes: only this app (part of its name). services: look up this service by name.')
    }, ['check']),
    level: () => 0,
    describe: a => `Diagnose: ${a.check}`,
    run: async a => {
      const sc = CHECKS[a.check]; if (!sc) throw new Error('Unknown check. Use one of: ' + Object.keys(CHECKS).join(', ') + '.');
      const hrs = Math.max(1, Math.min(24 * 60, Math.round(Number(a.hours) || 0)));
      const out = await psExec(sc, { VISION_HOURS: Number(a.hours) > 0 ? String(hrs) : '0', VISION_ARG: String(a.name || '').slice(0, 80) }, 150000);
      return clip(out || 'The check returned no data.', 6000);
    }
  });

  async function withBackground(label, job) {
    const p = job(); p.catch(() => {});
    const w = await Promise.race([p.then(() => 'done', () => 'done'), sleep(30000).then(() => 'slow')]);
    if (w === 'done') return p;
    say('info', `${label} is taking a while; it keeps going in the background.`);
    p.then(r => { notify('Vision: repair finished', label); say('sys', `${label} finished:\n${clip(r, 1500)}`); runtime.emit('reminder', `${label} finished. ${clip(String(r).replace(/\s+/g, ' '), 300)}`); },
      e => { notify('Vision: repair failed', e.message); say('err', `${label} failed: ${e.message}`); runtime.emit('reminder', `${label} failed: ${e.message}`); });
    return `${label} is still running (it can take a long time). It continues in the background and a notification appears when it is done. Tell the user that and do not wait.`;
  }

  def({
    name: 'pc_fix',
    description: 'Apply ONE well-known Windows repair. Always asks the user for approval first, and tells them what will change. Diagnose first with pc_diagnose and explain why this fix fits. fix: flush_dns, reset_network (winsock + TCP/IP reset, needs restart), restart_network_adapter (arg = adapter name), restart_service (arg = service name), restart_explorer (taskbar/desktop frozen), restart_audio (no sound), restart_bluetooth, fix_print_spooler (stuck print queue), clear_temp (frees disk space), clear_update_cache (Windows Update stuck), verify_system_files (sfc /verifyonly), repair_system_files (sfc /scannow), repair_windows_image (DISM), check_disk (arg = drive letter), defender_update_scan. Fixes that need administrator rights show the normal Windows UAC prompt. Long ones (sfc, DISM, disk scans) carry on in the background. After a fix, verify with pc_diagnose and say what changed. Anything not in this list: use run_command (it asks first) only if really needed.',
    parameters: obj({
      fix: oneOf('Which repair.', Object.keys(FIXES)),
      arg: str('Only for restart_network_adapter (adapter name), restart_service (service name) and check_disk (drive letter such as C).')
    }, ['fix']),
    level: () => 2, alwaysAsk: () => true,
    describe: a => { const f = FIXES[a.fix]; return f ? 'FIX: ' + (typeof f.text === 'function' ? f.text(String(a.arg || '?')) : f.text) + (f.admin ? ' (needs administrator approval from Windows)' : '') : `FIX: ${a.fix}`; },
    run: async a => {
      const f = FIXES[a.fix]; if (!f) throw new Error('Unknown fix. Use one of: ' + Object.keys(FIXES).join(', ') + '.');
      let arg = String(a.arg || '').trim();
      if (f.arg === 'service') { if (!/^[\w .-]{1,80}$/.test(arg)) throw new Error('Give the exact service name.'); if (PROTECTED_SERVICES.test(arg)) throw new Error(`${arg} is a core Windows service; restarting it can crash or lock the system, so I will not do that.`); }
      if (f.arg === 'drive') { arg = arg.replace(/[:\\]/g, '').toUpperCase(); if (!/^[A-Z]$/.test(arg)) throw new Error('Give one drive letter, for example C.'); }
      if (f.arg === 'adapter' && !/^[\w .#()\-]{1,80}$/.test(arg)) throw new Error('Give the exact adapter name (see pc_diagnose network).');
      if (f.arg && !arg) throw new Error(`This fix needs "arg" (${f.arg}).`);
      const text = typeof f.text === 'function' ? f.text(arg) : f.text, env = { VISION_ARG: arg };
      const job = async () => {
        const elevated = f.admin && !(await isAdmin());
        say('info', elevated ? `Waiting for the Windows administrator prompt… (${text})` : `Running: ${text}`);
        const out = elevated ? await psElevated(f.script, env, f.long ? 90 * 60000 : 10 * 60000) : await psExec(f.script, env, f.long ? 90 * 60000 : 10 * 60000, true);
        return clip(`${text}: done.\n${out}`.trim(), 3000);
      };
      return f.long ? withBackground(text, job) : job();
    }
  });
}

module.exports = register;
module.exports._CHECKS = CHECKS;
module.exports._FIXES = FIXES;
