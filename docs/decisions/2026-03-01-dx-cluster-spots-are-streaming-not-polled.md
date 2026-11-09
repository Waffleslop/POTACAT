# DX Cluster spots are streaming, not polled

Recorded 2026-03-01 (date is when the note was written, taken from the text or the nearest release). Moved verbatim from the desktop CLAUDE.md on 2026-11-09; the original is archived in the potacat workspace at docs/history/CLAUDE-desktop-2026-11-09.md.

**DX Cluster spots are streaming, not polled** — they accumulate in `clusterSpots[]` in main.js, flushed to renderer every 2s (throttled), FIFO cap at 500
