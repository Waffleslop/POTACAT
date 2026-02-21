# POTACAT

A desktop app for hunting amateur radio activators across **7 spot sources** — POTA, SOTA, DX Cluster, Reverse Beacon Network, PSKReporter FreeDV, WSJT-X, and DX Expeditions. Shows real-time spots in a filterable table and on an interactive Leaflet map, tunes your radio with one click, and logs QSOs to an ADIF file with optional forwarding to external logbook software.

Built for FlexRadio operators but works with any rig supported by Hamlib or Kenwood-protocol serial CAT.

![POTACAT screenshot](https://potacat.com/images/potacat-screenshot.png)

## Features

### Spot Sources

- **POTA** — Parks on the Air activator spots from the POTA API, polled every 30 seconds
- **SOTA** — Summits on the Air spots with summit coordinate lookups and orange map markers
- **DX Cluster** — Live telnet streaming from AR-Cluster or DXSpider nodes (e.g. W3LPL, DX Summit)
- **Reverse Beacon Network (RBN)** — See where your CQ calls are being heard, with band-colored circle markers showing SNR and WPM
- **PSKReporter FreeDV** — FreeDV digital voice spots via PSKReporter HTTP API
- **WSJT-X** — Decodes from WSJT-X highlighted in the spot table, with click-to-reply and auto-QSO logging
- **DX Expeditions** — Rare DX expedition callsigns from Club Log, pinned to the top of the table with a DXP badge

### Views

- **Table view** — Sortable columns (callsign, frequency, mode, park/summit, location, distance, age, comments), resizable column widths, sticky headers
- **Map view** — Leaflet map with dark OpenStreetMap tiles, color-coded markers per source, home QTH marker, night/day overlay
- **Split view** — Table and map side by side with a draggable splitter
- **Pop-out map** — Detachable map window that floats alongside the main table, controlled by the same filters, with its own tune and log buttons

### Filtering

- **Band filters** — 160m through 6m
- **Mode filters** — CW, SSB, FT8, FT4, FM, and more
- **Source toggles** — Enable/disable each spot source independently from the Spots dropdown
- **Hide worked parks** — Filter out parks you've already activated (requires POTA parks CSV import)
- **Hide out-of-privilege spots** — Filter by license class (Technician, General, Extra)
- **Watchlist** — Comma-separated callsigns; watched spots show a star and trigger desktop notifications

### Radio Control

- **FlexRadio SmartSDR CAT** — TCP connection to SmartSDR CAT slices (ports 5002–5005 for Slices A–D)
- **Hamlib/rigctld** — Bundled rigctld 4.6.5 supports 200+ radio models; search and filter rigs by name
- **Serial CAT (Kenwood)** — Direct serial/COM port using FA/MD commands; works with QRPLabs QMX/QDX (baud 38400, DTR/RTS disabled) and Win4Yaesu Suite (via COM0COM virtual port pair)
- **SmartSDR Panadapter** — Push spots to the FlexRadio panadapter display via the SmartSDR TCP API
- **My Rigs** — Save multiple radio profiles (name + connection config) and switch between them
- **CW XIT Offset** — Configurable Hz offset applied when tuning to CW spots
- **Scan mode** — Auto-tune through filtered spots with configurable dwell time and skip/unskip per row

### QSO Logging

- **Log dialog** — Pre-filled with callsign, frequency, mode, RST, park/summit reference, and operator name
- **ADIF file** — QSOs appended to a local `.adi` file with full ADIF field support
- **Logbook forwarding** — Forward logged QSOs to external software:
  - Log4OM 2 (UDP ADIF)
  - DXKeeper / DXLab Suite (TCP)
  - N1MM+ (UDP, port 2333)
- **Recent QSOs (F2)** — View last 10 logged QSOs in a quick-reference dialog

### Tracking & Enrichment

- **Parks Worked** — Import your POTA parks CSV; new parks get a green border and "NEW" badge; stats overlay shows total/new counts
- **DXCC Tracker** — Import ADIF log and view a band/mode confirmation matrix by DXCC entity
- **QRZ Lookup** — Operator name shown in table tooltip and log dialog; prefers QRZ nickname over legal first name
- **Callsign links** — Click any callsign to open their QRZ page

### Interface

- **Dark theme** with optional light mode
- **Solar propagation panel** — SFI, A-index, K-index, and band condition indicators
- **Tune arc** — Dotted great-circle line from your QTH to the tuned station on the map, color-coded by source
- **Desktop notifications** — Pop-up and sound alerts for watchlist callsigns across all sources
- **Auto-update** — Checks GitHub Releases on startup with an in-app update banner
- **Custom titlebar** — Frameless window with POTACAT branding (native traffic lights on macOS)

## Install (Windows)

Download the latest installer from the [Releases](https://github.com/Waffleslop/POTACAT/releases) page and run it.

> **Windows SmartScreen:** You may see a "Windows protected your PC" warning on first launch. Click **More info** then **Run anyway**. This happens because the app is not code-signed.

A portable `.exe` (no install required) is also available on the Releases page.

## Run from Source

Requires [Node.js](https://nodejs.org/) 18+.

```bash
git clone https://github.com/Waffleslop/POTACAT.git
cd POTACAT
npm install
npm start
```

## Build Installer

```bash
npm run dist:win    # Windows .exe installer + portable
npm run dist:mac    # macOS .dmg (must be run on a Mac)
```

Outputs go to the `dist/` folder.

## Quick Start

1. **Set your grid square** — Open Settings and enter your Maidenhead grid (e.g. `FN20jb`)
2. **Connect your radio** — Add a rig under My Rigs:
   - **FlexRadio**: Select "SmartSDR CAT", enter `127.0.0.1` and the slice port (5002 for Slice A)
   - **Hamlib**: Select "Hamlib/rigctld", pick your rig model, set the serial port
   - **Kenwood serial**: Select "Serial CAT (Kenwood)", pick the COM port, set baud rate
3. **Click a spot** — The radio tunes to that frequency and mode

## FlexRadio CAT Setup

In SmartSDR:

1. Open **Settings > CAT**
2. Enable CAT on the slice you want to control (Slice A = TCP port 5002)
3. In POTACAT Settings, add a rig with type "SmartSDR CAT", host `127.0.0.1`, and the matching port

The app sends standard Kenwood CAT commands (`FA` for frequency, `MD` for mode) over TCP.

## WSJT-X Integration

POTACAT listens for WSJT-X UDP messages on the default port (2237). When WSJT-X is running:

- FT8/FT4 decodes from POTA activators are highlighted green in the decode list
- Click a highlighted decode to auto-reply
- QSOs are logged automatically when WSJT-X reports them
- FlexRadio click-to-tune works via SmartSDR TCP (no CAT conflict with WSJT-X)

## Community

- **Website:** [potacat.com](https://potacat.com)
- **Discord:** [discord.gg/JjdKSshej](https://discord.gg/JjdKSshej)
- **Support:** [potacat.com/support](https://potacat.com/support)

## License

MIT

### Third-Party Software

This application bundles [Hamlib](https://hamlib.github.io/) rigctld for radio control. Hamlib is licensed under the [GNU General Public License v2](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html). Source code is available at [github.com/Hamlib/Hamlib](https://github.com/Hamlib/Hamlib).
