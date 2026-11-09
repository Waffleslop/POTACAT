# Every `remoteServer` listener or one-time setter goes through `onRemoteServer(fn)`

Recorded 2026-09-26. Moved verbatim from the desktop CLAUDE.md on 2026-11-09; the original is archived in the potacat workspace at docs/history/CLAUDE-desktop-2026-11-09.md.

**Every `remoteServer` listener or one-time setter goes through `onRemoteServer(fn)`** (2026-09-26): `connectRemote()` strips all listeners and builds a NEW server, so wiring attached once at startup silently died on the first rebuild — or never attached when ECHOCAT was enabled after launch (pairing "asking for approval" with no desktop window until restart; Guest Pass validator gone). `test/remote-server-rewire-test.js` fails on any `remoteServer.on(` outside `connectRemote()`.
