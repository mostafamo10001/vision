# Vision Windows helper: reads JSON requests on stdin, writes JSON replies on stdout (one per line).
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

[StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
[StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }

public static class Native {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);

  static INPUT Key(ushort vk, ushort scan, uint flags) {
    var inp = new INPUT(); inp.type = 1; inp.u.ki.wVk = vk; inp.u.ki.wScan = scan; inp.u.ki.dwFlags = flags; return inp;
  }
  public static void TypeText(string s) {
    var list = new List<INPUT>();
    foreach (char c in s) {
      if (c == '\r') continue;
      if (c == '\n') { list.Add(Key(0x0D, 0, 0)); list.Add(Key(0x0D, 0, 2)); continue; }
      list.Add(Key(0, c, 4)); list.Add(Key(0, c, 6));
    }
    int i = 0;
    while (i < list.Count) {
      int n = Math.Min(40, list.Count - i);
      var chunk = new INPUT[n]; list.CopyTo(i, chunk, 0, n);
      SendInput((uint)n, chunk, Marshal.SizeOf(typeof(INPUT)));
      i += n; Thread.Sleep(8);
    }
  }
}

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
  int j();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }

public class Audio {
  static IAudioEndpointVolume Vol() {
    var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev = null;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out dev));
    IAudioEndpointVolume epv = null;
    var epvid = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref epvid, 23, 0, out epv));
    return epv;
  }
  public static float Volume {
    get { float v = -1; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; }
    set { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(value, Guid.Empty)); }
  }
  public static bool Mute {
    get { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
    set { Marshal.ThrowExceptionForHR(Vol().SetMute(value, Guid.Empty)); }
  }
}
'@

try { [Native]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {}

# ---------- output ----------
function Write-Reply($obj) {
  $json = ConvertTo-Json -InputObject $obj -Depth 8 -Compress
  $json = [regex]::Replace($json, '[^\x00-\x7F]', [System.Text.RegularExpressions.MatchEvaluator]{ param($m) '\u{0:x4}' -f [int][char]$m.Value })
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

# ---------- keyboard ----------
$VK = @{ ctrl=0x11; control=0x11; alt=0x12; shift=0x10; win=0x5B; windows=0x5B; super=0x5B; enter=0x0D; return=0x0D; tab=0x09; esc=0x1B; escape=0x1B;
  space=0x20; spacebar=0x20; backspace=0x08; delete=0x2E; del=0x2E; insert=0x2D; home=0x24; end=0x23; pageup=0x21; pgup=0x21; pagedown=0x22; pgdn=0x22;
  left=0x25; up=0x26; right=0x27; down=0x28; capslock=0x14; printscreen=0x2C; prtsc=0x2C; menu=0x5D; apps=0x5D;
  volumeup=0xAF; volumedown=0xAE; volumemute=0xAD; medianext=0xB0; mediaprev=0xB1; mediastop=0xB2; mediaplaypause=0xB3;
  plus=0xBB; minus=0xBD; comma=0xBC; period=0xBE; slash=0xBF; semicolon=0xBA; quote=0xDE; backslash=0xDC; backtick=0xC0 }
$PUNCT = @{ ','=0xBC; '.'=0xBE; '-'=0xBD; '='=0xBB; '/'=0xBF; ';'=0xBA; "'"=0xDE; '['=0xDB; ']'=0xDD; '\'=0xDC; '`'=0xC0 }

function Get-VK([string]$k) {
  $k = $k.Trim().ToLower()
  if ($VK.ContainsKey($k)) { return [int]$VK[$k] }
  if ($k -match '^f(\d{1,2})$') { $n = [int]$Matches[1]; if ($n -ge 1 -and $n -le 24) { return (0x70 + $n - 1) } }
  if ($k.Length -eq 1) {
    $code = [int][char]$k
    if ($code -ge 97 -and $code -le 122) { return ($code - 32) }
    if ($code -ge 48 -and $code -le 57) { return $code }
    if ($PUNCT.ContainsKey($k)) { return [int]$PUNCT[$k] }
  }
  throw "Unknown key '$k'"
}
function Get-KeyFlags([int]$vk) {
  if (($vk -ge 0x21 -and $vk -le 0x28) -or $vk -eq 0x2D -or $vk -eq 0x2E -or $vk -eq 0x5B -or $vk -eq 0x5C -or $vk -eq 0x5D) { return 1 }
  return 0
}
function Press-Combo([string]$combo, [int]$repeat) {
  if ($repeat -lt 1) { $repeat = 1 }
  $keys = @($combo -split '\+' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if ($keys.Count -eq 0) { throw 'No keys given' }
  $codes = @($keys | ForEach-Object { Get-VK $_ })
  for ($r = 0; $r -lt $repeat; $r++) {
    foreach ($c in $codes) { [Native]::keybd_event([byte]$c, 0, [uint32](Get-KeyFlags $c), [UIntPtr]::Zero) }
    Start-Sleep -Milliseconds 30
    for ($i = $codes.Count - 1; $i -ge 0; $i--) { [Native]::keybd_event([byte]$codes[$i], 0, [uint32]((Get-KeyFlags $codes[$i]) -bor 2), [UIntPtr]::Zero) }
    Start-Sleep -Milliseconds 40
  }
}

# ---------- mouse ----------
function Mouse-Click([int]$x, [int]$y, [string]$button, [int]$count) {
  if ($count -lt 1) { $count = 1 }
  [Native]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 40
  switch ($button) { 'right' { $d = 0x8; $u = 0x10 } 'middle' { $d = 0x20; $u = 0x40 } default { $d = 0x2; $u = 0x4 } }
  for ($i = 0; $i -lt $count; $i++) {
    [Native]::mouse_event([uint32]$d, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 25
    [Native]::mouse_event([uint32]$u, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 70
  }
}
function Mouse-Drag([int]$x1, [int]$y1, [int]$x2, [int]$y2) {
  [Native]::SetCursorPos($x1, $y1) | Out-Null; Start-Sleep -Milliseconds 60
  [Native]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 90
  $steps = 24
  for ($i = 1; $i -le $steps; $i++) {
    [Native]::SetCursorPos([int]($x1 + ($x2 - $x1) * $i / $steps), [int]($y1 + ($y2 - $y1) * $i / $steps)) | Out-Null
    Start-Sleep -Milliseconds 12
  }
  Start-Sleep -Milliseconds 60
  [Native]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
}


# ---------- reliable window enumeration (File Explorer / UWP windows are invisible to Get-Process) ----------
$script:HaveEnum = $false
try {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class WinInfo { public IntPtr Handle; public string Title; public string Cls; public uint Pid; }
public static class Win2 {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);

  public static List<WinInfo> TopWindows() {
    var list = new List<WinInfo>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      string t = sb.ToString(); if (t.Length == 0) return true;
      int ex = GetWindowLong(h, -20);
      if ((ex & 0x80) != 0 && (ex & 0x40000) == 0) return true;
      int cloaked = 0; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      var cb = new StringBuilder(256); GetClassName(h, cb, 256); string c = cb.ToString();
      if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd") return true;
      uint pid = 0; GetWindowThreadProcessId(h, out pid);
      var w = new WinInfo(); w.Handle = h; w.Title = t; w.Cls = c; w.Pid = pid;
      list.Add(w); return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@
$script:HaveEnum = $true
} catch { }

# ---------- windows ----------
function Get-TopWindows {
  if ($script:HaveEnum) {
    $names = @{}
    foreach ($w in [Win2]::TopWindows()) {
      $procId = [int]$w.Pid
      if (-not $names.ContainsKey($procId)) { $n = ''; try { $n = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}; $names[$procId] = $n }
      [pscustomobject]@{ title = $w.Title; process = $names[$procId]; id = $procId; minimized = [Native]::IsIconic($w.Handle); handle = $w.Handle }
    }
  } else {
    Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle } | ForEach-Object {
      [pscustomobject]@{ title = $_.MainWindowTitle; process = $_.ProcessName; id = $_.Id; minimized = [Native]::IsIconic($_.MainWindowHandle); handle = $_.MainWindowHandle }
    }
  }
}
function Find-TopWindow([string]$q) {
  $q = ($q.ToLower().Trim()) -replace '\.exe$',''
  $all = @(Get-TopWindows)
  $dash = '\s+[-|' + [char]0x2013 + [char]0x2014 + ']\s+'
  # "Desktop - File Explorer" -> also try "Desktop" and "File Explorer"; File Explorer windows belong to the explorer process
  $cands = @($q) + @($q -split $dash | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -ne $q })
  if ($q -match 'file explorer|windows explorer') { $cands += 'explorer' }
  foreach ($c in $cands) {
    $hit = $all | Where-Object { $_.process.ToLower() -eq $c } | Select-Object -First 1
    if (-not $hit) { $hit = $all | Where-Object { $_.title.ToLower() -eq $c } | Select-Object -First 1 }
    if (-not $hit) { $hit = $all | Where-Object { $_.title.ToLower().Contains($c) } | Select-Object -First 1 }
    if (-not $hit) { $hit = $all | Where-Object { $_.process.ToLower().Contains($c) } | Select-Object -First 1 }
    if ($hit) { return $hit }
  }
  $titles = (@($all | Select-Object -First 12 | ForEach-Object { $_.title }) -join ' | ')
  throw "No open window matches '$q'. Open windows: $titles"
}
function Focus-Window($w) {
  $h = [IntPtr]$w.handle
  if ([Native]::IsIconic($h)) { [Native]::ShowWindow($h, 9) | Out-Null }
  [Native]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [Native]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero) # alt tap defeats focus-steal lock
  [Native]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 150
}

# ---------- UI Automation ----------
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
function New-InteractiveCondition {
  $CT = [System.Windows.Automation.ControlType]
  $types = @($CT::Button, $CT::Edit, $CT::MenuItem, $CT::TabItem, $CT::ListItem, $CT::CheckBox, $CT::RadioButton, $CT::ComboBox, $CT::Hyperlink, $CT::TreeItem, $CT::SplitButton, $CT::DataItem)
  $conds = New-Object 'System.Collections.Generic.List[System.Windows.Automation.Condition]'
  foreach ($t in $types) { $conds.Add([System.Windows.Automation.PropertyCondition]::new($AE::ControlTypeProperty, $t)) }
  $or = [System.Windows.Automation.OrCondition]::new($conds.ToArray())
  $on = [System.Windows.Automation.PropertyCondition]::new($AE::IsOffscreenProperty, $false)
  return [System.Windows.Automation.AndCondition]::new($or, $on)
}
function Get-SearchRoots([int]$excludePid) {
  $roots = New-Object System.Collections.ArrayList
  $seen = @{}
  $h = [Native]::GetForegroundWindow()
  if ($h -ne [IntPtr]::Zero) {
    $procId = [uint32]0; [Native]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
    if ([int]$procId -ne $excludePid) { [void]$roots.Add($AE::FromHandle($h)); $seen[[int64]$h] = $true }
  }
  $wins = $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($w in $wins) {
    try {
      if ($w.Current.ProcessId -eq $excludePid -or $w.Current.IsOffscreen) { continue }
      $nh = [int64]$w.Current.NativeWindowHandle
      if ($seen.ContainsKey($nh)) { continue }
      $seen[$nh] = $true; [void]$roots.Add($w)
    } catch { continue }
    if ($roots.Count -ge 10) { break }
  }
  return $roots
}
function Find-UiElement([string]$query, [int]$excludePid) {
  $cond = New-InteractiveCondition
  $q = $query.ToLower().Trim()
  foreach ($root in (Get-SearchRoots $excludePid)) {
    $hits = @()
    try { $els = $root.FindAll($TS::Descendants, $cond) } catch { continue }
    foreach ($e in $els) {
      try {
        $n = [string]$e.Current.Name; $aid = [string]$e.Current.AutomationId
        $nl = $n.ToLower(); $score = -1
        if ($nl -eq $q -or $aid.ToLower() -eq $q) { $score = 0 }
        elseif ($nl.StartsWith($q)) { $score = 1 }
        elseif ($nl.Contains($q)) { $score = 2 }
        if ($score -ge 0) { $hits += [pscustomobject]@{ el = $e; score = $score; len = $n.Length; name = $n } }
      } catch { continue }
    }
    if ($hits.Count -gt 0) { return ($hits | Sort-Object score, len | Select-Object -First 1) }
  }
  return $null
}
function Click-Element($e) {
  $r = $e.Current.BoundingRectangle
  if ($r.Width -gt 0 -and $r.Height -gt 0 -and -not [double]::IsInfinity($r.X)) {
    Mouse-Click ([int]($r.X + $r.Width / 2)) ([int]($r.Y + $r.Height / 2)) 'left' 1
    return 'clicked'
  }
  $pat = $null
  if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) { $pat.Invoke(); return 'invoked' }
  if ($e.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) { $pat.Select(); return 'selected' }
  if ($e.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) { $pat.Toggle(); return 'toggled' }
  throw 'Element has no usable position or pattern'
}
function Get-UiList([int]$excludePid) {
  $cond = New-InteractiveCondition
  $roots = @(Get-SearchRoots $excludePid)
  if ($roots.Count -eq 0) { return @{ window = ''; items = @() } }
  $out = @()
  $title = [string]$roots[0].Current.Name
  foreach ($e in $roots[0].FindAll($TS::Descendants, $cond)) {
    try {
      $n = [string]$e.Current.Name
      if (-not $n.Trim()) { continue }
      $t = ([string]$e.Current.ControlType.ProgrammaticName) -replace '^ControlType\.', ''
      $out += ('{0} [{1}]' -f $n.Substring(0, [Math]::Min(70, $n.Length)), $t)
    } catch { continue }
    if ($out.Count -ge 90) { break }
  }
  return @{ window = $title; items = @($out) }
}

# ---------- apps ----------
function Open-App([string]$name) {
  $n = $name.Trim()
  $pattern = '*' + [WildcardPattern]::Escape($n) + '*'
  $apps = @(Get-StartApps | Where-Object { $_.Name -like $pattern } | Sort-Object { $_.Name.Length })
  if ($apps.Count -gt 0) {
    Start-Process ('shell:AppsFolder\' + $apps[0].AppID)
    return ('Opened ' + $apps[0].Name)
  }
  try { Start-Process $n; return ('Opened ' + $n) } catch { throw "Could not find an app called '$n'" }
}

function Tap-Vk([int]$vk, [int]$n) { for ($i = 0; $i -lt $n; $i++) { [Native]::keybd_event([byte]$vk, 0, 1, [UIntPtr]::Zero); [Native]::keybd_event([byte]$vk, 0, 3, [UIntPtr]::Zero); Start-Sleep -Milliseconds 15 } } # a short pause: Windows drops key presses sent back to back

# ---------- dispatcher ----------
function Invoke-Cmd([string]$cmd, $p) {
  switch ($cmd) {
    'ping' { return 'pong' }
    'click' { Mouse-Click ([int]$p.x) ([int]$p.y) ([string]$p.button) ([int]$p.count); return 'ok' }
    'drag' { Mouse-Drag ([int]$p.x1) ([int]$p.y1) ([int]$p.x2) ([int]$p.y2); return 'ok' }
    'scroll' {
      if ($null -ne $p.x -and $null -ne $p.y) { [Native]::SetCursorPos([int]$p.x, [int]$p.y) | Out-Null; Start-Sleep -Milliseconds 40 }
      $flag = if ($p.horizontal) { 0x1000 } else { 0x0800 }
      [Native]::mouse_event([uint32]$flag, 0, 0, ([int]$p.amount * 120), [UIntPtr]::Zero); return 'ok'
    }
    'type' { [Native]::TypeText([string]$p.text); return 'ok' }
    'keys' { Press-Combo ([string]$p.combo) ([int]$p.repeat); return 'ok' }
    'ui_list' { return (Get-UiList ([int]$p.excludePid)) }
    'ui_click' {
      $hit = Find-UiElement ([string]$p.name) ([int]$p.excludePid)
      if (-not $hit) { throw "No visible control matching '$($p.name)'" }
      return ((Click-Element $hit.el) + ': ' + $hit.name)
    }
    'ui_set_text' {
      $hit = Find-UiElement ([string]$p.name) ([int]$p.excludePid)
      if (-not $hit) { throw "No visible field matching '$($p.name)'" }
      $pat = $null
      if ($hit.el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pat) -and -not $pat.Current.IsReadOnly) {
        $pat.SetValue([string]$p.text); return ('Set text in: ' + $hit.name)
      }
      Click-Element $hit.el | Out-Null; Start-Sleep -Milliseconds 120
      Press-Combo 'ctrl+a' 1; [Native]::TypeText([string]$p.text); return ('Typed into: ' + $hit.name)
    }
    'windows' { return @{ windows = @(Get-TopWindows | Select-Object title, process, id, minimized) } }
    'active_window' {
      $h = [Native]::GetForegroundWindow(); $sb = New-Object System.Text.StringBuilder 512
      [Native]::GetWindowText($h, $sb, 512) | Out-Null
      $procId = [uint32]0; [Native]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
      $pn = ''; try { $pn = (Get-Process -Id ([int]$procId)).ProcessName } catch {}
      return @{ title = $sb.ToString(); process = $pn }
    }
    'window_action' {
      $w = Find-TopWindow ([string]$p.title); $h = [IntPtr]$w.handle
      switch ([string]$p.action) {
        'focus' { Focus-Window $w }
        'minimize' { [Native]::ShowWindow($h, 6) | Out-Null }
        'maximize' { [Native]::ShowWindow($h, 3) | Out-Null }
        'restore' { [Native]::ShowWindow($h, 9) | Out-Null }
        'close' { [Native]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
        'snap_left' { Focus-Window $w; Press-Combo 'win+left' 1 }
        'snap_right' { Focus-Window $w; Press-Combo 'win+right' 1 }
        'next_monitor' { Focus-Window $w; Press-Combo 'win+shift+right' 1 }
        default { throw "Unknown window action '$($p.action)'" }
      }
      return ($p.action + ': ' + $w.title)
    }
    'open_app' { return (Open-App ([string]$p.name)) }
    'volume' {
      $via = 'com'; $why = ''
      try {
        switch ([string]$p.action) {
          'get' { }
          'set' {
            $t = [Math]::Max(0.0, [Math]::Min(1.0, [double]$p.level / 100.0)) # 1.0 / 0.0 on purpose: with whole-number literals PowerShell rounds 0.5 to 0 and 0.8 to 1
            [Audio]::Volume = $t; [Audio]::Mute = $false
            $back = [Audio]::Volume
            if ([Math]::Abs($back - $t) -gt 0.03) { # Windows did not take it: use the keyboard volume keys (2% each), then read again
              $via = 'keys'; $why = "Windows reported $([int][Math]::Round($back * 100))% after asking for $([int][Math]::Round($t * 100))%"
              Tap-Vk 0xAE 50; Tap-Vk 0xAF ([int][Math]::Round($t * 50)); Start-Sleep -Milliseconds 150
            }
          }
          'up' { [Audio]::Volume = [Math]::Min(1.0, [double][Audio]::Volume + 0.1) }
          'down' { [Audio]::Volume = [Math]::Max(0.0, [double][Audio]::Volume - 0.1) }
          'mute' { [Audio]::Mute = $true }
          'unmute' { [Audio]::Mute = $false }
          default { throw "Unknown volume action '$($p.action)'" }
        }
        return @{ level = [int][Math]::Round([Audio]::Volume * 100); muted = [bool][Audio]::Mute; via = $via; why = $why }
      } catch {
        $err = $_
        # the Windows audio service was unreachable: fall back to the keyboard volume keys
        switch ([string]$p.action) {
          'set' { Tap-Vk 0xAE 50; Tap-Vk 0xAF ([int][Math]::Round([double]$p.level / 2)); return @{ level = [int]$p.level; muted = $false; via = 'keys'; why = [string]$err.Exception.Message } }
          'up' { Tap-Vk 0xAF 5; return @{ level = -1; muted = $false; via = 'keys'; why = [string]$err.Exception.Message } }
          'down' { Tap-Vk 0xAE 5; return @{ level = -1; muted = $false; via = 'keys'; why = [string]$err.Exception.Message } }
          'mute' { Tap-Vk 0xAD 1; return @{ level = -1; muted = $true; via = 'keys'; why = [string]$err.Exception.Message } }
          'unmute' { Tap-Vk 0xAD 1; return @{ level = -1; muted = $false; via = 'keys'; why = [string]$err.Exception.Message } }
          default { throw $err }
        }
      }
    }
    'status' {
      $b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
      $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
      $r = @{ uptimeHours = [Math]::Round(((Get-Date) - $boot).TotalHours, 1) }
      if ($b) { $r.batteryPercent = [int]$b.EstimatedChargeRemaining; $r.charging = ($b.BatteryStatus -eq 2) }
      return $r
    }
  }
  throw "Unknown helper command '$cmd'"
}

Write-Reply @{ ready = $true }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = 0
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $res = Invoke-Cmd ([string]$req.cmd) $req.args
    Write-Reply @{ id = $id; ok = $true; result = $res }
  } catch {
    Write-Reply @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
}
