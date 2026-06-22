# POTACAT

**Hunt POTA, SOTA, and DX faster — see every spot, click once, your radio tunes.**

POTACAT is a desktop app for amateur radio operators that aggregates real-time
spots from every major activity network into one filterable table and an
interactive map, then tunes your rig to any spot with a single click via CAT
control. Log the QSO, push spots to your panadapter, run FT8 — and when you're
away from the shack, operate the whole station (audio, PTT, logging) from your
phone or browser.

Works with FlexRadio, Icom, Yaesu, Kenwood, and 200+ other rigs via Hamlib.
Windows, macOS, and Linux — including Raspberry Pi.

![POTACAT screenshot](https://potacat.com/images/potacat-screenshot.png)

- **Website:** [potacat.com](https://potacat.com)
- **Download:** [Releases](https://github.com/Waffleslop/POTACAT/releases/latest)
- **Discord:** [potacat.com/discord](https://potacat.com/discord)

---

## Download & Install

Grab the latest build from the **[Releases page](https://github.com/Waffleslop/POTACAT/releases/latest)**.
Every release ships binaries for Windows, macOS, and Linux, in both **Intel/AMD
(x86-64)** and **ARM (arm64 / aarch64)** flavors. Pick the file that matches
your machine:

| Platform | Architecture | File to download | Notes |
|---|---|---|---|
| **Windows 10/11** | 64-bit Intel/AMD | `POTACAT-Setup-<ver>.exe` | Standard installer (recommended) |
| **Windows 10/11** | 64-bit Intel/AMD | `POTACAT-Portable-<ver>.exe` | No install — run from anywhere |
| **macOS** (Apple Silicon — M1/M2/M3/M4) | arm64 | `POTACAT-<ver>-arm64.dmg` | |
| **macOS** (Intel) | x86-64 | `POTACAT-<ver>.dmg` | |
| **Linux** (PC/server) | x86-64 | `POTACAT-<ver>.AppImage`, `potacat_<ver>_amd64.deb`, or `potacat-<ver>.x86_64.rpm` | |
| **Linux** (Raspberry Pi 4/5, ARM SBC) | arm64 | `POTACAT-<ver>-arm64.AppImage`, `potacat_<ver>_arm64.deb`, or `potacat-<ver>.aarch64.rpm` | |

> The `latest*.yml` files on the Releases page are for the in-app auto-updater —
> you don't need to download them.

**Which architecture do I have?**
- **Windows:** 64-bit Intel/AMD. (There is no ARM Windows build.)
- **macOS:**  → About This Mac. "Apple M1/M2/M3/M4" = arm64; "Intel" = x86-64.
- **Linux:** run `uname -m`. `x86_64` = the amd64/x86-64 build; `aarch64` = the arm64 build.

Not code-signed yet, so first launch needs one extra click on Windows and macOS
(steps below). This is normal for an independent app and doesn't mean anything's
wrong.

### Windows

1. Download `POTACAT-Setup-<ver>.exe` and run it.
2. If you see **"Windows protected your PC"**, click **More info → Run anyway**.
3. If the installer is blocked, right-click the `.exe` → **Properties** → tick
   **Unblock** → **OK**, then run it again.

Prefer not to install? Download `POTACAT-Portable-<ver>.exe` and double-click —
no installation, settings stored in the same place either way.

### macOS

1. Download the `.dmg` for **your** chip (arm64 for Apple Silicon, the plain
   `.dmg` for Intel — see the table above).
2. Open the `.dmg` and drag **POTACAT** to **Applications**.
3. First launch: right-click (or Control-click) the app → **Open** → **Open**.
   Because the app isn't notarized yet, a normal double-click will say it
   "cannot be opened" — the right-click **Open** is what lets it through.

   If macOS still refuses, run this once in Terminal:
   ```bash
   xattr -dr com.apple.quarantine /Applications/POTACAT.app
   ```

### Linux

Pick **one** package format. AppImage is the most portable; `.deb` and `.rpm`
integrate with your package manager. Match the architecture (`amd64`/`x86_64`
for PCs, `arm64`/`aarch64` for Raspberry Pi & SBCs).

**AppImage** (any distro):
```bash
chmod +x POTACAT-<ver>.AppImage
./POTACAT-<ver>.AppImage
```

**Debian / Ubuntu (.deb):**
```bash
sudo apt install ./potacat_<ver>_amd64.deb      # or _arm64.deb on a Pi
```

**Fedora / RHEL / openSUSE (.rpm):**
```bash
sudo dnf install ./potacat-<ver>.x86_64.rpm     # or .aarch64.rpm on a Pi
```

> **Sandbox note:** on some hardened or newer distros (e.g. Ubuntu 23.10+),
> Chromium's sandbox needs unprivileged user namespaces. POTACAT detects this
> and falls back automatically; the `.deb`/`.rpm` packages ship an AppArmor
> profile so the full sandbox stays on. If an AppImage won't start, try
> `./POTACAT-<ver>.AppImage --no-sandbox`.

**Raspberry Pi / headless:** POTACAT runs on a Pi (use the `arm64` build) and
can run **without a GUI** to serve the ECHOCAT remote interface — see
[Headless mode](#headless--raspberry-pi).

---

## Quick Start

1. **Set your grid square** — Settings → enter your Maidenhead grid (e.g. `FN20jb`).
   Distances, the map, and the great-circle tune arc all key off this.
2. **Add your radio** — Settings → **My Rigs** → New:
   - **FlexRadio:** "SmartSDR CAT", host `127.0.0.1`, slice port `5002` (Slice A).
   - **Most other rigs:** "Hamlib/rigctld", pick your model, set the serial port.
   - **Kenwood-protocol serial:** "Serial CAT (Kenwood)", pick the COM port + baud.
   - **Icom network rigs:** "Icom Network" with the radio's IP.
3. **Click a spot** — POTACAT tunes to that frequency and mode instantly.

---

## Features

### Spot sources

Real-time spots from every major activity network, merged and de-duplicated
into one table and map:

- **POTA** — Parks on the Air activator spots
- **SOTA** — Summits on the Air, with summit coordinate lookups
- **WWBOTA** — Worldwide Bunkers on the Air (spot and re-spot, no login needed)
- **GMA** — Global Mountain Activity (opt-in)
- **DX Cluster** — live telnet from AR-Cluster / DXSpider nodes (W3LPL, DX Summit, …)
- **Reverse Beacon Network (RBN)** — see where your CQ is being heard, with SNR/WPM
- **PSKReporter FreeDV** — FreeDV digital-voice spots
- **WSJT-X** — FT8/FT4 decodes highlighted inline, click-to-reply, auto-logging
- **DX Expeditions** — rare DXpedition callsigns from Club Log, pinned with a DXP badge

### Views & filtering

- **Table, Map, and Split views** — sortable/resizable table; Leaflet map with
  color-coded markers per source, home-QTH marker, day/night overlay, and a
  great-circle tune arc to the station you're working
- **Pop-out map** — detachable map window driven by the same filters
- **Filters** — by band (160m–6m), mode (CW/SSB/FT8/FT4/FM/…), and per-source toggles
- **Hide worked parks** (from your POTA CSV) and **hide out-of-privilege** spots
  (by Technician / General / Extra sub-bands)
- **Watchlist** — flagged callsigns get a star + desktop notification across all sources

### Radio control

- **FlexRadio SmartSDR CAT** — TCP to slice ports 5002–5005 (Slices A–D)
- **Hamlib / rigctld** — bundled rigctld supports 200+ models
- **Serial CAT (Kenwood protocol)** — direct COM port (QRPLabs QMX/QDX, Win4Yaesu, …)
- **Icom Network** — control networked Icom rigs over IP
- **Panadapter spots** — push color-coded spot markers to the FlexRadio
  panadapter, or to **Thetis / ExpertSDR3 / SunSDR** via the TCI protocol
- **Rotator control** — Idiom Press Rotor-EZ / RotorCard / Hy-Gain DCU-1 over serial
- **My Rigs** — save and switch between multiple radio profiles
- **Scan mode** — auto-step through filtered spots with configurable dwell time

### Digital modes & CW

- **JTCAT (FT8/FT4)** — built-in FT8/FT4 engine with WSJT-X-parity features:
  late-start transmit, a-priori (AP) decoding to recover weak/late replies,
  auto-sequencing, and auto-logging
- **SSTV** — receive and transmit SSTV images
- **FreeDV** — digital voice, including RADE
- **CW** — WinKeyer support and a built-in keyer (CWCat)

### Remote operation (ECHOCAT)

- **Operate from your phone or browser** — full audio, PTT, tuning, and logging
  from anywhere, served by POTACAT itself
- **POTACAT Cloud** — one-tap secure remote access with no port-forwarding or
  Tailscale required (optional subscription); LAN and Tailscale remain free
- **Guest Pass** — temporarily share your rig with another operator
- **ECHOCAT mobile app** — companion iOS & Android app for the same remote control

### Logging & tracking

- **QSO logging to ADIF** — pre-filled log dialog (callsign, freq, mode, RST,
  park/summit ref, operator), appended to a local `.adi`
- **Logbook forwarding** — Log4OM 2 (UDP), DXKeeper/DXLab (TCP), N1MM+ (UDP)
- **Parks Worked** — import your POTA CSV; new parks get a "NEW" badge
- **DXCC Tracker** — import an ADIF log for a band/mode confirmation matrix
- **QRZ lookup** — operator names in the table and log dialog; click a callsign
  to open their QRZ page

### Interface

- Dark theme (optional light mode), custom frameless titlebar
- Solar/propagation panel (SFI, A/K-index, band conditions)
- Desktop notifications for watchlist hits
- Auto-update from GitHub Releases with an in-app banner

---

## Run from source

Requires [Node.js](https://nodejs.org/) **22+**.

```bash
git clone https://github.com/Waffleslop/POTACAT.git
cd POTACAT
npm install
npm start
```

## Build binaries

```bash
npm run dist:win      # Windows: installer + portable
npm run dist:mac      # macOS: .dmg  (run on a Mac)
npm run dist:linux    # Linux: AppImage + .deb + .rpm
```

Outputs land in `dist/`. electron-builder produces x86-64 and arm64 artifacts
per the targets in `package.json`.

## Headless / Raspberry Pi

Run POTACAT without a GUI to serve only the ECHOCAT remote interface — ideal for
a Raspberry Pi at the radio:

```bash
npm start -- --headless
```

CAT control, spots, the FT8 engine, the CW keyer, and ECHOCAT all work headless.

---

## Community & support

- **Website:** [potacat.com](https://potacat.com)
- **Discord:** [potacat.com/discord](https://potacat.com/discord)
- **Support:** [potacat.com/support](https://potacat.com/support)
- **Issues:** [GitHub Issues](https://github.com/Waffleslop/POTACAT/issues)

## License

POTACAT is licensed under the [Apache License 2.0](LICENSE).

**"POTACAT" and "ECHOCAT" are trademarks of Casey Stanton.** The license covers
the source code, not the names — see [TRADEMARKS.md](TRADEMARKS.md). If you fork
and redistribute a modified build, please give it a different name.

### Third-party software

POTACAT bundles some GPL-licensed tools as **separate executables**, invoked over
a process boundary (mere aggregation). This does not place POTACAT's own
Apache-2.0 code under the GPL. See [`NOTICE`](NOTICE) for the full list.

- [Hamlib](https://hamlib.github.io/) `rigctld` for radio control — [GPLv2](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html); source at [github.com/Hamlib/Hamlib](https://github.com/Hamlib/Hamlib).
- `wsprd` WSPR decoder (K1JT/K9AN, WSJT Development Group) — [GPLv3](https://www.gnu.org/licenses/gpl-3.0.html); bundled as a standalone binary, not linked. See [`third_party/wsprd/`](third_party/wsprd/).

POTACAT Cloud's optional tunnel uses Cloudflare's [`cloudflared`](https://github.com/cloudflare/cloudflared).
