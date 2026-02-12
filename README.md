# POTA Hunt

A desktop app for hunting [Parks on the Air (POTA)](https://pota.app) activators with a FlexRadio. Shows real-time activator spots in a filterable table or on an interactive map, and tunes your radio with one click via SmartSDR CAT.

## Features

- **Live POTA spots** — pulls from the POTA API every 30 seconds
- **Table and Map views** — toggle between a sortable table and a Leaflet map with dark OpenStreetMap tiles
- **Band and mode filters** — filter spots by band (160m–6m) and mode (CW, SSB, FT8, FT4, FM)
- **One-click tuning** — click a table row or a map marker's Tune button to QSY your Flex
- **FlexRadio CAT control** — connects to SmartSDR's CAT TCP ports (Slice A–D) or via serial/COM port
- **QRZ lookup** — callsign links open the station's QRZ page
- **Distance sorting** — spots include distance from your QTH (Maidenhead grid square)
- **Home QTH marker** — your location shown on the map as a red dot

## Requirements

- Windows 10/11
- [Node.js](https://nodejs.org/) 18+
- A FlexRadio running SmartSDR with CAT enabled

## Setup

```bash
git clone https://github.com/Waffleslop/POTA-Hunt.git
cd POTA-Hunt
npm install
npm start
```

## Configuration

- **QTH Grid Square** — click Settings and enter your 4- or 6-character Maidenhead grid (e.g. `FN20jb`). Used for distance calculation and map centering.
- **CAT Connection** — select a SmartSDR CAT slice (TCP 5002–5005) or a COM port from the CAT dropdown. The status indicator shows green when connected.

## CAT / FlexRadio Setup

POTA Hunt talks to your Flex through SmartSDR's built-in CAT server. In SmartSDR:

1. Open **Settings > CAT**
2. Enable CAT on the slice you want to control (Slice A defaults to TCP port 5002)
3. In POTA Hunt, select the matching slice from the CAT dropdown

The app sends standard CAT commands (`FA` for frequency, `MD` for mode) over TCP to localhost.

## License

MIT
