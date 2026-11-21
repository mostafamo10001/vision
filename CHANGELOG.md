# Changelog

## 1.10.0
**New interface**
- Redesigned look: a J.A.R.V.I.S.-style HUD with an arc-reactor orb, a lifted-centre backdrop and a cleaner conversation view, approval card and Settings page.
- **Background colour is now changeable** (Settings → Appearance). Text, lines and surfaces switch automatically between light-on-dark and dark-on-light.
- New colour themes: Aurora (violet and teal) and Plasma (white-blue and warm light). Choosing a Main colour re-tunes Highlight and Listening so they sit well together.
- **Floating orb while you talk:** when Vision's window is hidden, a small orb appears at the bottom of the screen and follows your voice (can be switched off in Settings).
- The "working" orb now starts only when Vision is really answering, not during a short pause in your sentence.

## 1.9.4
**Security / platform update**
- Electron 33 (unsupported since April 2025) -> **Electron 45**, the current supported release, with the latest Chromium and Node.js security fixes. Build tooling updated to electron-builder 26; the CI build uses the current Node.js LTS.
- Clipboard: Electron 44 made the main-process clipboard asynchronous. Paste-typing, the clipboard tool, "read selection", the diagnostics report and transcript copy now handle that (and still work on older Electron).
- System-audio transcription: Electron 45 reports screen/audio capture as `display-capture`; Vision now allows it (and `media`) so recording the PC's audio keeps working.

## 1.9.3
**Wake word**
- The wake listener no longer gives up after one startup error. Right after login the microphone or audio service is often not ready; it now retries with increasing delays (2 s up to 30 s) and never stops trying. Only "no English speech recognizer installed" is treated as permanent.
- The listener restarts after sleep, screen unlock, a microphone being plugged in or switched, and when the network comes back (it binds to the microphone only once, when it starts).

**Voice session**
- Pressing Stop while Vision is still connecting now cancels the connection (before, it was ignored and could leave the mic button stuck until the app was restarted).
- Microphone setup happens once, after the connection is up, with a 12 s timeout and full cleanup on failure (before, a microphone failure opened a new connection and audio player for every setup variant).
- When the network returns, a silently dead connection is closed so the normal reconnect runs.

## 1.9.2
- Web search with several sources and automatic failover.
