# WSJT-X

POTACAT listens for WSJT-X UDP messages (default port 2237) and cross-references decoded callsigns against active POTA spots.

**Features:**
- POTA activators in the WSJT-X decode list are highlighted green
- Decode indicators appear on matching rows in the POTACAT spot table
- Click-to-tune sends the frequency to your FlexRadio via SmartSDR TCP (no CAT conflict with WSJT-X)
- Auto-log: QSOs completed in WSJT-X can be automatically logged in POTACAT

Enable WSJT-X in Settings → Spot Sources. Set the UDP port to match your WSJT-X configuration.


