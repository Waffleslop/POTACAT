# POTA CAT

A desktop app for hunting [Parks on the Air (POTA)](https://pota.app) activators with a FlexRadio. Shows real-time activator spots in a filterable table or on an interactive map, and tunes your radio with one click via SmartSDR CAT.

## Features

- **Live POTA spots** — pulls from the POTA API every 30 seconds
- **Table and Map views** — toggle between a sortable table and a Leaflet map with dark OpenStreetMap tiles
- **Band and mode filters** — filter spots by band (160m-6m) and mode (CW, SSB, FT8, FT4, FM)
- **One-click tuning** — click a table row or a map marker's Tune button to QSY your Flex
- **FlexRadio CAT control** — connects to SmartSDR's CAT TCP ports (Slice A-D) or via serial/COM port
- **QRZ lookup** — callsign links open the station's QRZ page
- **Distance sorting** — spots include distance from your QTH (Maidenhead grid square)
- **Home QTH marker** — your location shown on the map as a red dot
- **SOTA spots** — optional Summits on the Air spot support with orange markers
- **DX Cluster** — live telnet streaming from AR-Cluster/DXSpider nodes
- **Reverse Beacon Network** — dedicated map view showing where your CQ calls are being heard, with band-colored markers and SNR/WPM popups
- **Solar propagation** — SFI, A-index, and K-index indicators with band activity heatmap
- **Watchlist notifications** — desktop pop-up notifications when watched callsigns appear on any source (POTA, SOTA, DX Cluster, RBN), with configurable sound and duration
- **DXCC Tracker** — import ADIF log, view band/mode confirmation matrix by entity
- **Hamlib/rigctld support** — control non-Flex radios via Hamlib rigctld
- **CW XIT offset** — configurable Hz offset applied when tuning to CW spots

## Install (Windows)

Download the latest installer from the [Releases](https://github.com/Waffleslop/POTA-CAT/releases) page and run it. No other software required.

## Run from Source

Requires [Node.js](https://nodejs.org/) 18+.

```bash
git clone https://github.com/Waffleslop/POTA-CAT.git
cd POTA-CAT
npm install
npm start
```

## Build Installer

```bash
npm run dist:win    # Windows .exe installer
npm run dist:mac    # macOS .dmg (must be run on a Mac)
```

Outputs go to the `dist/` folder.

## Configuration

- **QTH Grid Square** — click Settings and enter your 4- or 6-character Maidenhead grid (e.g. `FN20jb`). Used for distance calculation and map centering.
- **CAT Connection** — select a SmartSDR CAT slice (TCP 5002-5005) or a COM port from the CAT dropdown. The status indicator shows green when connected.

## CAT / FlexRadio Setup

POTA CAT talks to your Flex through SmartSDR's built-in CAT server. In SmartSDR:

1. Open **Settings > CAT**
2. Enable CAT on the slice you want to control (Slice A defaults to TCP port 5002)
3. In POTA CAT, select the matching slice from the CAT dropdown

The app sends standard CAT commands (`FA` for frequency, `MD` for mode) over TCP to localhost.

## macOS

The app is built with Electron and is cross-platform. You can build a `.dmg` by running `npm run dist:mac` on a Mac. Note that SmartSDR itself is Windows-only, but if your Flex is reachable over the network, the TCP CAT connection works from any machine on the same LAN — just update the CAT host in the source from `127.0.0.1` to your Flex's IP.

## License

MIT

### Third-Party Software

This application uses [Hamlib](https://hamlib.github.io/) for radio control via rigctld. Hamlib is licensed under the [GNU Lesser General Public License v2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html). Hamlib is invoked as a separate process and is not bundled with or linked into this application.
