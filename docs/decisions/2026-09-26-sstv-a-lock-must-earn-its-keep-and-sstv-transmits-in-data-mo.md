# SSTV: a lock must earn its keep, and SSTV transmits in DATA mode on Icoms

Recorded 2026-09-26. Moved verbatim from the desktop CLAUDE.md on 2026-11-09; the original is archived in the potacat workspace at docs/history/CLAUDE-desktop-2026-11-09.md.

**SSTV: a lock must earn its keep, and SSTV transmits in DATA mode on Icoms** (WB8IMY 2026-09-26). VIS bits need (E1100+E1300) > 1.5×E1900 and max/min ≥ 2, parity repairs only the one doubtful bit (the old flip-any-bit turned image content into Robot 24 / PD-160). An unconfirmed lock (fewer than 2 line-period sync matches in max(6 lines, 3 s)) is dropped and handed to auto-start; a new valid VIS mid-image restarts on the new mode. `test/sstv-lock-test.js`; the PSNR matrix stayed byte-identical. TX: the SSTV key-down passes `{ audio: true, forceDataMode: <Icom> }` — IC-7300 factory DATA OFF MOD = MIC,ACC, so plain USB keyed with silence; other brands follow SSB-over-DATA (Yaesu DATA MODE=PSK shifts the carrier).
