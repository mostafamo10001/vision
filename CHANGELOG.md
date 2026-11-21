# Changelog

## [3.9.0]

### Fixed
- Blank window / wake word not working on the first start after an update: cached scripts from the previous version are now cleared once whenever the app files change; a page that is slow to load (or hangs) is reloaded automatically; the window retries reading its settings at startup so the wake listener always starts; every load and reload is written to the log.
- Start with Windows: a window that was created hidden at login is checked when first shown and reloaded if it is not drawing; the wake listener no longer gives up if Windows' speech service is not ready yet right after login (it tries several times before reporting that no recognizer is installed).

## [3.8.0]

(Version numbering now follows the app.asar release counter.)

### Added
- **Accurate text for what you say.** After each thing you say, the recorded audio is sent once to a normal Gemini model that only transcribes, and your message in the chat is replaced with that result. The quick live caption is shown first and stays if the check fails. Turn it off in Settings ("Accurate text for what I say"). Voice handling and commands are unchanged.

## [1.10.2]

### Changed
- "Hide Vision from screenshots and screen sharing" is now clearly labelled and **off by default**. When on, Windows draws Vision as a black box in every capture (Win+Shift+S, screen sharing, and Vision's own screenshots). Existing installs keep their saved choice; switch it off in Settings → Window.

## [1.10.1]

### Fixed
- Blank main window on the very first start: the window now reloads itself if the page fails to load, the renderer exits, or the UI has not drawn shortly after loading, and it is always shown even if `ready-to-show` is missed.

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
