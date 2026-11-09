# worked-overlay legend, LoTW detail, modem RX level (appendix 10/23)

Recorded 2026-10-23 (date is when the note was written, taken from the text or the nearest release). Moved verbatim from the desktop CLAUDE.md on 2026-11-09; the original is archived in the potacat workspace at docs/history/CLAUDE-desktop-2026-11-09.md.

Originally a stray appendix at the bottom of CLAUDE.md, dated "(10/23 later)".

**worked-overlay legend, LoTW detail, modem RX level (appendix 10/23)** (10/23 later) worked-overlay.js legend: "Update from LoTW | QRZ" row (desktop only; IPC worked-sync → named lotwDownloadConfirmations / wasBackfillStates in main). lib/lotw-report.js fillLotwDetail: LoTW QSL detail (STATE/CNTY/GRIDSQUARE/DXCC/COUNTRY/CQZ/ITUZ/IOTA) fills what the log lacks; settings.lotwDetailPulled = the one-time full re-pull done. lib/modem-rx-level.js also has TxLeveler (modem TX audio → full scale, gain kept in settings.winlinkModemTxGain per modem); lib/winlink-spectrum.js is dual-mode (BusyDetector + markerBand(mode,{ardop,vara,mercury}), "center").
