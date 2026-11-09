# What a record carries beyond the form

Recorded 2026-11-02. Moved verbatim from the desktop CLAUDE.md on 2026-11-09; the original is archived in the potacat workspace at docs/history/CLAUDE-desktop-2026-11-09.md.

**What a record carries beyond the form** (2026-11-02): JTCAT TIME_ON = when the QSO began, TIME_OFF / QSO_DATE_OFF = the log (`lib/jtcat-qso-clock.js`, keyed by call because paths replace the QSO object; 5 min idle = a new attempt), with seconds. CQZ / ITUZ: QRZ's `cqzone`/`ituzone` for a plain home call, else cty.dat (`resolveZones`; only exact where it lists an override, so a W6 in Texas with no QRZ gets cty's zone); CONT from cty.dat; QTH = QRZ `addr2`, home contacts only. Never QRZ's for an away or slash call. QRZ also returns `dxcc` (the ADIF entity number): not taken yet.
