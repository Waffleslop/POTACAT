# TCI mirrors SmartSDR pattern

Recorded 2026-03-01 (date is when the note was written, taken from the text or the nearest release). Moved verbatim from the desktop CLAUDE.md on 2026-11-09; the original is archived in the potacat workspace at docs/history/CLAUDE-desktop-2026-11-09.md.

**TCI mirrors SmartSDR pattern** — `connectTci()`/`disconnectTci()`/`pushSpotsToTci()` in main.js, 5s throttle, per-source + max-age filtering, called from `sendMergedSpots()` alongside SmartSDR. Uses `ws` npm package; when Electron upgrades to 35+ (Node 22+), can drop `ws` for native WebSocket.
