# Local wake word: Windows' own offline speech recognizer, listening only for a few phrases.
# Nothing is sent anywhere. Prints one line per event for the app to read:
#   READY|<culture>   WAKE|<phrase>|<confidence>   HEARD|<text>|<confidence> (test mode only)   WARN|<text>   ERROR|<text>
param([string]$Phrases = 'hey vision,okay vision,hey jarvis,okay jarvis', [double]$Threshold = 0.75, [int]$ParentPid = 0, [int]$Test = 0)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Send([string]$s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }
function Num($v) { ([double]$v).ToString('0.00', [System.Globalization.CultureInfo]::InvariantCulture) } # not "0,75": other regions use a comma
# Speech recognition on the default microphone lowers the Windows microphone level by itself. We record the level before it starts,
# put it back if it drops, and restore it again when the script ends.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolumeCap {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
  int j();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCap { int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolumeCap aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumeratorCap { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDeviceCap endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCapObj { }
public static class MicLevel {
  static IAudioEndpointVolumeCap Vol() {
    var en = new MMDeviceEnumeratorCapObj() as IMMDeviceEnumeratorCap;
    IMMDeviceCap dev = null;
    Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(1, 1, out dev)); // 1 = microphone (capture), 1 = default communications role
    IAudioEndpointVolumeCap epv = null;
    var id = typeof(IAudioEndpointVolumeCap).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref id, 23, 0, out epv));
    return epv;
  }
  public static float Get() { float v = -1; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; }
  public static void Set(float v) { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(v, Guid.Empty)); }
}
'@
function Get-MicLevel { try { return [double][MicLevel]::Get() } catch { return -1 } }
function Set-MicLevel([double]$v) { try { [MicLevel]::Set([float]$v) } catch {} }
$micBase = Get-MicLevel   # the level the user chose, read before the recognizer touches the microphone
$rec = $null
try {
  Add-Type -AssemblyName System.Speech
  $installed = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())
  if ($installed.Count -eq 0) { Send 'ERROR|No Windows speech recognizer is installed. Add one in Settings > Time & language > Speech.'; exit 2 }
  $info = $installed | Where-Object { $_.Culture.Name -like 'en-*' } | Select-Object -First 1
  if (-not $info) {
    $names = ($installed | ForEach-Object { $_.Culture.Name }) -join ', '
    Send ("ERROR|The wake phrases are English, but the only Windows speech recognizer installed is: $names. Add English (United States) speech in Settings > Time & language > Speech.")
    exit 3
  }
  $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
  try { $rec.SetInputToDefaultAudioDevice() } catch { Send ('ERROR|Could not open the microphone: ' + $_.Exception.Message); exit 4 }

  $choices = New-Object System.Speech.Recognition.Choices
  foreach ($p in ($Phrases -split ',')) { $t = $p.Trim(); if ($t.Length -gt 0) { $choices.Add($t) } }
  $gb = New-Object System.Speech.Recognition.GrammarBuilder
  $gb.Culture = $info.Culture
  $gb.Append($choices)
  $wake = New-Object System.Speech.Recognition.Grammar($gb)
  $wake.Name = 'wake'
  $rec.LoadGrammar($wake)
  # Everything else you say is matched against ordinary dictation, so it cannot be forced into sounding like a wake phrase.
  try { $dict = New-Object System.Speech.Recognition.DictationGrammar; $dict.Name = 'dictation'; $rec.LoadGrammar($dict) }
  catch { Send ('WARN|Dictation is unavailable, so there may be more false triggers: ' + $_.Exception.Message) }

  Register-ObjectEvent -InputObject $rec -EventName SpeechRecognized -SourceIdentifier 'vision.recog' | Out-Null
  $rec.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
  if ($micBase -ge 0) { Set-MicLevel $micBase }
  Send ('READY|' + $info.Culture.Name)

  while ($true) {
    $ev = Wait-Event -SourceIdentifier 'vision.recog' -Timeout 1
    if ($ev) {
      $r = $ev.SourceEventArgs.Result
      Remove-Event -EventIdentifier $ev.EventIdentifier
      if ($r.Grammar.Name -eq 'wake' -and $r.Confidence -ge $Threshold) { Send ('WAKE|' + $r.Text + '|' + (Num $r.Confidence)) }
      elseif ($Test -eq 1) { Send ('HEARD|' + $r.Text + '|' + (Num $r.Confidence) + $(if ($r.Grammar.Name -eq 'wake') { '|too quiet or unclear to count' } else { '' })) }
    }
    # Put the microphone level back if the recognizer lowered it. A higher level set by the user becomes the new baseline.
    if ($micBase -ge 0) { $cur = Get-MicLevel; if ($cur -ge 0) { if ($cur -lt $micBase - 0.02) { Set-MicLevel $micBase } elseif ($cur -gt $micBase) { $micBase = $cur } } }
    if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break } # the app is gone: do not linger
  }
}
catch { Send ('ERROR|' + $_.Exception.Message); exit 1 }
finally {
  if ($rec) { try { $rec.RecognizeAsyncCancel(); $rec.Dispose() } catch {} }
  if ($micBase -ge 0) { Set-MicLevel $micBase }
}
