# Changelog

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
