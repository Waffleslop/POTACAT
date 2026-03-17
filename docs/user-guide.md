# POTACAT User Guide

**The desktop app for hunting Parks on the Air activators with your radio.**

[Join the Discord](https://discord.gg/cuNQpES38C) · [Support POTACAT](https://buymeacoffee.com/potacat) · [Website](https://potacat.com)

---

## Table of Contents

- [Getting Started](#getting-started)
  - [Installation](#installation)
  - [First Launch](#first-launch)
- [Quick Start](#quick-start)
- [Hunter Mode](#hunter-mode)
  - [Spot Table](#spot-table)
  - [Map View](#map-view)
  - [Split View](#split-view)
  - [Pop-out Windows](#pop-out-windows)
- [Activator Mode](#activator-mode)
  - [Starting an Activation](#starting-an-activation)
  - [Logging Contacts](#logging-contacts)
  - [Multi-Park Activations](#multi-park-activations)
  - [Exporting ADIF](#exporting-adif)
- [Spot Sources](#spot-sources)
  - [POTA](#pota)
  - [SOTA](#sota)
  - [WWFF & LLOTA](#wwff--llota)
  - [DX Cluster](#dx-cluster)
  - [Reverse Beacon Network (RBN)](#reverse-beacon-network-rbn)
  - [FreeDV / PSKReporter](#freedv--pskreporter)
  - [WSJT-X](#wsjt-x)
  - [DX Expeditions](#dx-expeditions)
- [Filters](#filters)
  - [Band & Mode](#band--mode)
  - [Region](#region)
  - [Hide Worked Parks](#hide-worked-parks)
  - [Hide Out-of-Privilege](#hide-out-of-privilege)
  - [Watchlist](#watchlist)
  - [Max Spot Age](#max-spot-age)
- [Radio Setup](#radio-setup)
  - [FlexRadio (SmartSDR)](#flexradio-smartsdr)
  - [IP Radio (TCP CAT)](#ip-radio-tcp-cat)
  - [Serial CAT (Kenwood)](#serial-cat-kenwood)
  - [Other Rig (Hamlib)](#other-rig-hamlib)
  - [rigctld Network](#rigctld-network)
  - [My Rigs](#my-rigs)
  - [Win4Yaesu Setup](#win4yaesu-setup)
  - [Tested Radios](#tested-radios)
  - [SmartSDR Panadapter Spots](#smartsdr-panadapter-spots)
  - [TCI Panadapter Spots](#tci-panadapter-spots)
- [QSO Logging](#qso-logging)
  - [Log Dialog](#log-dialog)
  - [Quick Log](#quick-log)
  - [ADIF File](#adif-file)
  - [Logbook Forwarding](#logbook-forwarding)
  - [Pop-out QSO Logbook](#pop-out-qso-logbook)
- [Tracking & Enrichment](#tracking--enrichment)
  - [Parks Worked](#parks-worked)
  - [DXCC Tracker](#dxcc-tracker)
  - [QRZ Lookup](#qrz-lookup)
  - [DX Expedition Tracking](#dx-expedition-tracking)
- [CW Keyer](#cw-keyer)
- [Scan Mode](#scan-mode)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Settings Reference](#settings-reference)
- [Troubleshooting](#troubleshooting)
- [Community & Support](#community--support)

---

## Getting Started

### Installation

1. Download the latest installer from the [GitHub Releases](https://github.com/Waffleslop/POTACAT/releases) page
2. Run the installer (`.exe` for Windows, `.dmg` for macOS)
3. **Windows SmartScreen:** Since POTACAT is not code-signed by Microsoft, Windows may show a SmartScreen warning. Click **"More info"** then **"Run anyway"** to proceed
4. A portable version (no install) is also available on the Releases page — it uses the same settings location as the installer version

> **Tip:** If "More info" doesn't appear, right-click the downloaded file → Properties → check "Unblock" → OK, then try again.

### First Launch

On first launch, POTACAT shows a **Welcome Screen** to get you up and running:

1. **Callsign** — Enter your callsign (required for DX Cluster login and QSO logging)
2. **QTH Grid Square** — Your Maidenhead grid locator (e.g. `FN20jb`). Used for distance and heading calculations
3. **Distance Unit** — Miles or kilometers
4. **License Class** — Your license privileges (used for the "hide out-of-privilege" filter)
5. **Spot Sources** — Toggle which sources to show (POTA, SOTA, WWFF, LLOTA)
6. **App Mode** — Hunter (spot chaser) or Activator (park activator)
7. **Import Data** — Optionally import your QSO history (ADIF or Log4OM SQLite) and POTA Parks Worked CSV
8. **Add Your Radio** — Configure your rig connection right from the welcome screen
9. **Theme** — Dark or light mode

Click **Get Started** when you're done. You can return to this screen anytime with **F11**.

---

## Quick Start

1. Set your **grid square** in the welcome screen or Settings
2. **Add your radio** — pick a connection type, configure it, and click Test Connection
3. **Spots appear automatically** — POTA spots load every 60 seconds
4. **Click any spot** in the table or on the map to tune your radio to that frequency
5. Work the contact and click **Log** to save the QSO

That's it — you're hunting parks.

---

## Hunter Mode

Hunter mode is the default view. It shows live spots from all your enabled sources in a sortable table and/or interactive map.

### Spot Table

The main table shows one row per spot with these columns (right-click any column header to show/hide columns):

| Column | Description |
|--------|-------------|
| Log | Click to open the log dialog for this contact |
| Callsign | Activator's callsign (click to open QRZ page, hover for operator name) |
| Operator | Operator's name (from QRZ lookup) |
| Freq (kHz) | Frequency — click the row to tune your radio here |
| Mode | CW, SSB, FT8, FT4, FM, RTTY, FreeDV |
| Source | POTA, SOTA, WWFF, LLOTA, DXC, RBN, PSKR, WSJT, DXP |
| Ref | Park or summit reference (e.g. K-1234, W6/CT-001) |
| Name | Park or summit name |
| State | US state or DX entity |
| Grid | Maidenhead grid square |
| Dist | Distance from your QTH in miles or km |
| Heading | Beam heading from your QTH in degrees |
| Age | Time since the spot was posted (e.g. "5m", "1h 30m") |
| Comments | Spot comment text |
| Skip | Toggle to skip this spot during scan |

**Column widths** are resizable — drag the border between column headers. Widths are saved automatically.

**Sorting** — Click any column header to sort. Click again to reverse. Sort state is preserved across sessions.

**Color coding** — Rows are tinted by source: green for POTA, orange for SOTA, purple for DX Cluster. Spots for new (unworked) parks show a green border and "NEW" badge when you have parks worked data loaded.

**Watchlist stars** — Spots matching your watchlist callsigns show a star icon.

**WSJT-X decodes** — When WSJT-X integration is active, a decode indicator appears on rows where POTACAT hears the activator in WSJT-X.

### Map View

Toggle between Table and Map using the view buttons in the toolbar (or press **S** for split view).

The map uses dark OpenStreetMap tiles and shows:

- **Your QTH** as a home marker
- **POTA activators** as green markers with park info popups
- **SOTA activators** as orange markers
- **DX Cluster spots** as purple markers (positioned via cty.dat country database)
- **Tune arcs** — great-circle lines from your QTH to the selected spot
- **Band activity heatmap** — a color bar at the bottom showing spot density per band (enable in Settings → Display)

Click any marker to see spot details in a popup. Click the frequency in the popup to tune. The map remembers your zoom level and center position.

### Split View

Press **S** or enable **Split view** in Settings → Display to show the table and map side-by-side (or stacked — configurable). A draggable splitter lets you resize the panes. The split height/width is saved.

### Pop-out Windows

POTACAT supports detachable pop-out windows:

- **Pop-out Map** — Click the ↗ button in the view toolbar. Opens the map in its own resizable window with full functionality (markers, popups, tune arcs, Log button). Remembers position and size.
- **Pop-out Spots** — In Activator mode, click the pop-out button in the activator toolbar to detach the hunter spots table into a separate window.
- **Pop-out QSO Logbook** — Press **F2** or click the Logbook toolbar button. See [Pop-out QSO Logbook](#pop-out-qso-logbook).

Pop-out windows sync theme (dark/light) with the main window and auto-reopen if they were open when you last closed POTACAT.

---

## Activator Mode

Switch to Activator mode from the Settings quick dropdown in the toolbar, or in Settings → App Mode.

Activator mode replaces the hunter table with a streamlined interface for running a POTA/SOTA/WWFF activation.

### Starting an Activation

1. **Enter your park reference** (e.g. `K-1234`) in the park input field — autocomplete helps you find parks
2. **Set your frequency** — type it or let POTACAT read it from your radio via CAT
3. **Select your mode** (CW, SSB, FT8, etc.)
4. Click **Start Activation**

A timer starts counting your activation time. Your contact count is displayed prominently.

### Logging Contacts

The quick-log form at the top has:
- **Callsign** — type the hunter's callsign
- **RST Sent / Received** — split-digit input boxes with auto-advance (or single-field N1MM-style if enabled in Settings)
- **Hunter Park** — if the hunter is also at a park (park-to-park QSO), enter their reference
- **Operator name** — auto-filled from QRZ lookup

Press **Enter** or click **Log** to save. The contact appears in the activation log table below.

Use **Alt+R** to reload the last contact into the form (handy for correcting mistakes).

### Multi-Park Activations

If you're activating multiple parks from the same location (two-fer, three-fer), press **Ctrl+M** to open the Multi-Park dialog. Add additional park references and all your contacts will be logged for each park.

### Exporting ADIF

Click **Export ADIF** in the activator toolbar to save your activation log as an ADIF file for upload to pota.app or sotadata.org.uk. For multi-park activations, you can export per-park or combined.

The activator toolbar also has buttons for:
- **Map** — show your park location on a map
- **Past activations** — view your previous activations at this park
- **Spots** — toggle the hunter spot table below the activator view (split view)
- **Logbook** (F2) — open the pop-out QSO logbook

---

## Spot Sources

Toggle sources on and off from the **Spots dropdown** in the toolbar (the funnel icon) or in Settings → Spot Sources.

### POTA

Parks on the Air spots from the [POTA API](https://api.pota.app). Refreshed automatically (default every 60 seconds, configurable). Green markers on the map.

**Parks Worked:** Import your parks worked CSV from pota.app (Settings → Spot Sources → POTA → Import CSV). Spots for parks you've already worked show no "NEW" badge, and you can filter them out with "Hide worked parks" in the Spots dropdown.

**Stats overlay:** When parks data is loaded, click the Stats button in the status bar to see your Parks Worked count, Total QSOs, unique locations, and how many new-to-you parks are on the air right now.

### SOTA

Summits on the Air spots from the SOTA API. Orange markers on the map positioned at summit coordinates.

### WWFF & LLOTA

World Wide Flora & Fauna and Lighthouses on the Air spots. These are additional park/award programs that pull from their respective APIs.

### DX Cluster

Live DX spots streamed via telnet from DX cluster nodes. POTACAT supports up to **3 simultaneous cluster connections**.

**Setup:**
1. Enable DX Cluster in Settings → Spot Sources
2. Enter your callsign (required for cluster login)
3. Choose from 13 preset nodes (W3LPL, VE7CC, DXUSA, NC7J, K1TTT, and more) or add a custom node
4. Optionally add a second and third node for broader coverage

DX Cluster spots appear with a purple left border in the table and purple markers on the map. Location is resolved from the callsign using the bundled cty.dat country database.

**DX Command Bar:** When DX Cluster is enabled, a command bar appears below the table. Use it to self-spot or spot other stations on the cluster. Enter a callsign, frequency, and optional comment, then click Send.

**Spotting on the cluster:** The Log dialog includes a "Spot on DX Cluster" checkbox for non-park contacts. Press **Ctrl+R** for quick re-spotting with template variables.

### Reverse Beacon Network (RBN)

The RBN shows where your CQ calls (and watchlist callsigns) are being heard by the worldwide skimmer network.

**Setup:**
1. Enable RBN in Settings → Spot Sources
2. Enter your callsign

A dedicated **RBN view** appears in the view toolbar. It shows a map with band-colored circle markers (sized by SNR), a spot table, and a dynamic legend. Filters for band and max age are available at the top.

### FreeDV / PSKReporter

FreeDV spots from PSKReporter. Polls every 5 minutes (with automatic backoff on server errors). Coral-colored spots in the table and map.

Hover over the FreeDV checkbox in the Spots dropdown to see a countdown to the next poll.

### WSJT-X

POTACAT listens for WSJT-X UDP messages (default port 2237) and cross-references decoded callsigns against active POTA spots.

**Features:**
- POTA activators in the WSJT-X decode list are highlighted green
- Decode indicators appear on matching rows in the POTACAT spot table
- Click-to-tune sends the frequency to your FlexRadio via SmartSDR TCP (no CAT conflict with WSJT-X)
- Auto-log: QSOs completed in WSJT-X can be automatically logged in POTACAT

Enable WSJT-X in Settings → Spot Sources. Set the UDP port to match your WSJT-X configuration.

### DX Expeditions

POTACAT checks the [Club Log](https://clublog.org) DX expedition database and marks active expeditions with a **DXP** badge. DX expedition spots are pinned to the top of the table and shown with a red/gold marker on the map.

---

## Filters

### Band & Mode

Use the **Band** and **Mode** dropdowns in the toolbar to filter spots:

- **Bands:** All, 160m, 80m, 60m, 40m, 30m, 20m, 17m, 15m, 12m, 10m, 6m
- **Modes:** All, CW, SSB, FT8, FT4, FM, RTTY, FreeDV

The default view shows 20m CW. These filters apply to both the table and map views.

### Region

Filter spots by continent using the **Region** dropdown: All, AF (Africa), AS (Asia), EU (Europe), NA (North America), OC (Oceania), SA (South America).

### Hide Worked Parks

Available in the Spots dropdown when you have parks worked data loaded. Hides spots for parks you've already activated or hunted.

### Hide Out-of-Privilege

Hides spots on frequencies outside your license privileges. Set your license class in Settings → Station (or the welcome screen) to enable this.

### Watchlist

Enter comma-separated callsigns in Settings → Spot Filters → Watchlist. Spots matching these callsigns show a star icon in the table.

**Notifications:** Enable pop-up and/or sound notifications for watchlist matches in Settings → Spot Filters. Configure auto-dismiss duration.

### Max Spot Age

Set in Settings → Spot Filters. Spots older than this value (in minutes) are hidden. Set to 0 for no limit.

---

## Radio Setup

POTACAT supports five connection methods. Open Settings and click **Add Rig** to configure your radio.

### FlexRadio (SmartSDR)

**Best for:** FlexRadio 6000/8000 series running SmartSDR.

POTACAT connects to SmartSDR's built-in CAT server over TCP. No additional software or cables needed.

1. Add a new rig → select **FlexRadio (SmartSDR)**
2. Choose your slice (A, B, C, or D)
3. Save

SmartSDR exposes Kenwood-compatible CAT on TCP ports 5002–5005:

| Slice | Port |
|-------|------|
| A     | 5002 |
| B     | 5003 |
| C     | 5004 |
| D     | 5005 |

If SmartSDR is on a different computer, use **IP Radio (TCP CAT)** instead with the Flex's IP address.

### IP Radio (TCP CAT)

**Best for:** FlexRadio on a remote PC, Elecraft K4, or any radio with a TCP-based Kenwood CAT interface.

1. Add a new rig → select **IP Radio (TCP CAT)**
2. Enter the host IP and port
3. Save

### Serial CAT (Kenwood)

**Best for:** QRPLabs QMX/QDX, Kenwood, Elecraft, Yaesu (via FA/MD commands), and any radio that speaks Kenwood protocol over USB serial.

1. Add a new rig → select **Serial CAT (Kenwood)**
2. Choose your COM port
3. Set the baud rate
4. Check **Disable DTR/RTS** if your radio uses DTR for PTT
5. Click **Test Connection** to verify
6. Save

POTACAT sends only `FA` (frequency) and `MD` (mode) commands. Any radio that responds to `FA;` with a frequency will work.

**Yaesu radios** also support these commands — POTACAT auto-detects 9-digit (Yaesu) vs 11-digit (Kenwood) FA format from the radio's response.

### Other Rig (Hamlib)

**Best for:** Icom, Yaesu, and radios that don't speak Kenwood protocol.

POTACAT bundles **Hamlib 4.6.5** (rigctld) — no separate installation needed. Supports 200+ radio models.

1. Add a new rig → select **Other Rig (Hamlib)**
2. Search for your radio model
3. Choose your COM port and baud rate
4. Click **Test Connection**
5. Save

POTACAT spawns a `rigctld` process, connects via TCP, and translates commands to your radio's native protocol.

### rigctld Network (flrig, grig, etc.)

**Best for:** Radios controlled by flrig, grig, or any software that exposes a rigctld-compatible TCP server — especially on Linux (Raspberry Pi, etc.).

If you already use **flrig** to control your radio, you don't need POTACAT's bundled Hamlib at all. flrig includes a built-in rigctld emulation server that POTACAT can connect to directly.

1. Add a new rig → select **rigctld Network**
2. Set the host (`127.0.0.1` if on the same machine, or the remote IP)
3. Set the port to `4532` (flrig's default rigctld port)
4. Save

In flrig, make sure the rigctld server is enabled: **Config → Setup → Server**.

### My Rigs

POTACAT supports multiple saved rig profiles. Each profile stores a name and connection settings. Switch between rigs by clicking the CAT status pill in the status bar and selecting from the rig list.

### Win4Yaesu Setup

If you use Win4Yaesu Suite, both programs need access to the radio's serial port. The solution is **COM0COM** (free virtual COM port driver):

1. Install COM0COM (signed 64-bit version)
2. Create a virtual port pair (e.g. COM18 ↔ COM19)
3. In Win4Yaesu: assign COM18 to an AUX/CAT port
4. In POTACAT: set up Serial CAT (Kenwood) on COM19

```
POTACAT ←→ COM19 ──(COM0COM)── COM18 ←→ Win4Yaesu ←→ Radio
```

Win4Yaesu caches radio state, so POTACAT's polling doesn't add load on the radio. Multiple programs can run simultaneously on separate AUX/CAT ports.

### Tested Radios

| Radio | Connection | Baud | DTR/RTS Off? | Notes |
|-------|-----------|------|:------------:|-------|
| FlexRadio 6000/8000 | FlexRadio (SmartSDR) | — | — | Works out of the box |
| QRPLabs QMX | Serial CAT (Kenwood) | 38400 | No | Don't use Hamlib; power cycle if stuck in terminal mode |
| QRPLabs QDX | Serial CAT (Kenwood) | 38400 | Yes | DTR = PTT on QDX |
| Yaesu FTX-1 | Serial CAT (Kenwood) | 38400 | No | Hamlib backend failed in testing |
| Xiegu G90 | Other Rig (Hamlib) | 19200 | Only with Digirig | CI-V protocol; try X5105 or IC-718 backend as fallback |
| Kenwood TS-480/590/2000 | Serial CAT (Kenwood) | 9600 | No | Also works with Hamlib |
| Elecraft KX2/KX3/K3 | Serial CAT (Kenwood) | 38400 | No | |
| Elecraft K4 | IP Radio (TCP CAT) | — | — | Ethernet TCP CAT |
| Xiegu X6100 | rigctld Network (flrig) | — | — | CI-V via flrig; tested on Raspberry Pi 5 |

If your rig isn't listed, try **Serial CAT (Kenwood)** first — many radios support FA/MD commands — then fall back to **Hamlib** or **rigctld Network** (if you use flrig).

### SmartSDR Panadapter Spots

For FlexRadio users: enable **Push spots to SmartSDR panadapter** in Settings → Display. POTACAT connects to the FlexRadio API on port 4992 and displays color-coded spot markers directly on your SmartSDR panadapter.

Configure which sources appear (POTA, SOTA, DX Cluster, RBN, etc.) and set a max spot age.

### TCI Panadapter Spots

For Thetis (ANAN/Hermes-Lite 2), ExpertSDR3 (SunSDR), and other TCI-compatible SDR software: enable **Push to Thetis/TCI panadapter** in Settings → Display.

POTACAT connects via WebSocket and sends color-coded spot markers to your panadapter. Configure:
- Host and port (default `127.0.0.1:50001`)
- Per-source filters (POTA, SOTA, DX Cluster, RBN, WWFF, LLOTA, FreeDV)
- Max spot age

---

## QSO Logging

### Log Dialog

Click the **Log** button on any spot row, map popup, or use **Ctrl+L** for an unspotted QSO. The dialog pre-fills:

- Callsign, frequency, mode, band (from the spot)
- Operator name (from QRZ lookup)
- RST Sent and Received (split-digit boxes with auto-advance)
- TX Power (from your default in Settings)
- Park/summit reference
- "Spot on DX Cluster" checkbox (for non-park contacts)

Press **Enter** to save.

### Quick Log

**Ctrl+L** opens a log dialog for contacts that aren't in the spot table — useful for logging a QSO you found by tuning around.

### ADIF File

QSOs are saved to a local ADIF file. Set the file path in Settings → Logging. Each QSO is appended as a standard ADIF record with fields including CALL, FREQ, MODE, BAND, RST_SENT, RST_RCVD, QSO_DATE, TIME_ON, OPERATOR, TX_PWR, SIG_INFO (park ref), and QRZ-derived fields (NAME, STATE, CNTY, GRIDSQUARE, COUNTRY).

### Logbook Forwarding

POTACAT can forward QSOs in real-time to external logging software:

| Logbook | Protocol | Default Port |
|---------|----------|:------------:|
| Log4OM 2 | UDP ADIF | 2237 |
| N1MM Logger+ | UDP ADIF | 2333 |
| N3FJP | TCP XML-wrapped ADIF | 1100 |
| Ham Radio Deluxe | UDP ADIF | 2333 |
| DXKeeper | TCP `externallog` | 52001 |

Enable in Settings → Logging → Send to Logbook. Select your logger and configure the host/port.

### Pop-out QSO Logbook

Press **F2** or click the **Logbook** button in the toolbar to open a detachable logbook window showing all your logged QSOs.

Features:
- **Search** across all fields
- **Sortable columns** (click headers)
- **Inline edit** — click any cell to modify
- **Delete** — two-click delete (click once to confirm, click again to remove)
- **Export ADIF** — save your entire log
- **Real-time updates** — new QSOs appear instantly via toast notifications
- **Stats footer** — total QSO count and session summary

---

## Tracking & Enrichment

### Parks Worked

Import your POTA parks worked CSV (download from your pota.app profile) in Settings → Spot Sources → POTA.

Once loaded:
- New (unworked) parks show a **green border** and **"NEW" badge** on table rows
- The **Hide worked parks** filter removes already-worked parks from the table
- The **Stats overlay** (status bar button) shows your progress

### DXCC Tracker

Enable the DXCC Tracker in the Spots dropdown → Events & Awards → check **DXCC Tracker**, then click **Board**.

The tracker shows a band × entity matrix of your worked DXCC entities. It reads from your POTACAT logfile (no separate ADIF import needed).

Features:
- Band and mode filter dropdowns
- Entity count and DXCC Challenge score (total band-entity slots)
- **"DXCC!"** badge when you reach 100+ entities

### QRZ Lookup

If you enter your QRZ credentials in Settings → Station, POTACAT enriches spots with operator names, grid squares, state, county, and country from QRZ.

- **Hover tooltip** — hover over a callsign in the table to see the operator's name
- **Nickname preference** — POTACAT uses the QRZ nickname field when available (e.g. "Bob" instead of "Robert")
- **Log dialog** — the operator name is shown in a read-only field

### DX Expedition Tracking

POTACAT checks Club Log for active DX expeditions. Matched spots receive:
- A **DXP** source badge
- **Pinned-to-top** positioning in the table
- A **red/gold map marker**

Active events are shown in the Spots dropdown → Events & Awards section with a track/progress button.

---

## CW Keyer

POTACAT includes a built-in CW keyer for FlexRadio users with a MIDI paddle (e.g. HaliKey).

**Setup:**
1. Enable CW Keyer in Settings → CW Keyer
2. Select your **Keyer Mode**: Iambic B, Iambic A, or Straight key
3. Set your **Speed** (WPM)
4. Click **Refresh** to detect MIDI devices, then select yours
5. Use the **Learn** buttons to map dit and dah MIDI notes from your paddle
6. Enable **Local sidetone** and adjust pitch/volume

**How it works:** POTACAT reads MIDI paddle events via the Web MIDI API, runs an Iambic keyer state machine, and sends `cw key` commands directly to your FlexRadio via the SmartSDR TCP API. This preserves your exact fist timing — no buffering.

**CW status:** The CW pill in the status bar shows keyer state. Click it for a popover with volume and WPM controls. The sidetone requires one click anywhere in the app to unlock (browser audio policy).

---

## Scan Mode

Click the **Scan** button in the toolbar or press **Space** to start scanning.

Scan automatically tunes through all visible (filtered) spots, dwelling on each for a configurable time (Settings → Tuning → Scan Dwell Time, default 7 seconds).

- The current scan row is highlighted and auto-scrolled into view
- **Skip** individual spots by checking the Skip column — scan will skip those frequencies
- Press **Space** again to stop scanning

---

## Keyboard Shortcuts

Press **F1** to see this list in the app.

| Shortcut | Action |
|----------|--------|
| **F1** | Show keyboard shortcuts |
| **F2** | Open/focus QSO logbook |
| **F5** | Check for updates |
| **F11** | Show welcome/setup screen |
| **Space** | Start / stop scan |
| **S** | Toggle split view (table + map) |
| **Ctrl+L** | Quick log (unspotted QSO) |
| **Ctrl+R** | Quick re-spot |
| **Ctrl+M** | Multi-park dialog (activator mode) |
| **Alt+R** | Reload last contact (activator mode) |
| **Ctrl+=** | Zoom in |
| **Ctrl+-** | Zoom out |
| **Ctrl+0** | Reset zoom |
| **Esc** | Close popover |
| **Enter** | Save QSO (in log dialog) |

---

## Settings Reference

Open Settings from the toolbar dropdown → "Open Settings..." or from the welcome screen.

### Station

| Setting | Description |
|---------|-------------|
| My Callsign | Your callsign — used for DX Cluster login, RBN, logging, and OPERATOR field |
| QTH Grid Square | Maidenhead locator for distance/heading calculations |
| QRZ Lookup | Username and password for QRZ XML data (operator name, grid, state, country) |
| Distance Unit | Miles or kilometers |
| License Class | US (Technician/General/Advanced/Extra) or Canadian (Basic/Honours) — for out-of-privilege filter |

### Radio

See [Radio Setup](#radio-setup). Multiple rig profiles with add/edit/delete. Active rig selected from the CAT status pill.

### Spot Sources

| Setting | Description |
|---------|-------------|
| POTA | Enable POTA spots + parks CSV import |
| SOTA | Enable SOTA spots |
| WWFF | Enable WWFF spots |
| LLOTA | Enable LLOTA spots |
| DX Cluster | Enable telnet cluster (up to 3 nodes, 13 presets + custom) |
| Show Beacons | Include beacon spots from DX Cluster |
| DX Command Bar | Show the DX spotting command bar below the table |
| RBN | Enable Reverse Beacon Network view |
| WSJT-X | UDP port, highlight activators, auto-log |
| FreeDV | PSKReporter FreeDV spots |

### Spot Filters

| Setting | Description |
|---------|-------------|
| Max Spot Age | Hide spots older than this (minutes, 0 = no limit) |
| Refresh Interval | POTA/SOTA poll interval in seconds (default 60) |
| Hide Out-of-Band | Hide spots outside your license privileges |
| Hide Already-Worked | Hide spots for stations you've already worked |
| Watchlist | Comma-separated callsigns to highlight with a star |
| Notifications | Pop-up and/or sound alerts for watchlist matches + auto-dismiss duration |

### Tuning

| Setting | Description |
|---------|-------------|
| Scan Dwell Time | Seconds per frequency during scan (default 7) |
| CW XIT Offset | Hz offset for CW spots (range -999 to +999) |
| CW/SSB/Digital Filter Width | Filter bandwidth in Hz sent to the radio when tuning |
| Enable Split Mode | Tune using split (VFO B) for certain modes |
| Tune Confirmation Sound | Audio feedback when tuning completes |

### Antenna

| Setting | Description |
|---------|-------------|
| Show Beam Heading | Display heading column and tune arc on map |
| PstRotator | Enable rotor control via PstRotator (host/port, default port 12040) |

### Logging

| Setting | Description |
|---------|-------------|
| Enable QSO Logging | Master toggle for logging |
| ADIF Path | Where to save the log file |
| Import Log | Import an existing ADIF file |
| Default TX Power | Pre-filled power in the log dialog |
| N1MM-style RST | Single-field RST input instead of split digits |
| Send to Logbook | Forward QSOs to Log4OM / DXKeeper / N1MM+ / N3FJP / HRD |

### Events & Awards

| Setting | Description |
|---------|-------------|
| Active Events | List of currently tracked events |
| DXCC Tracker | Enable the DXCC board view |

### Display

| Setting | Description |
|---------|-------------|
| Dark/Light Mode | Toggle app theme |
| Color Rows by Source | Tint table rows by spot source |
| Solar Propagation | Show SFI/A/K indices in the status bar |
| Band Activity Heatmap | Show band activity bar on the map |
| Split View | Enable side-by-side table + map |
| Split Layout | Side-by-side or stacked |
| SmartSDR Panadapter | Push spots to FlexRadio panadapter (host, max age, per-source filters) |
| TCI Panadapter | Push spots to Thetis/TCI (host, port, max age, per-source filters) |

### CW Keyer

| Setting | Description |
|---------|-------------|
| Enable | Master toggle |
| Keyer Mode | Iambic B, Iambic A, or Straight key |
| Speed (WPM) | Keying speed |
| Swap Paddles | Reverse dit/dah |
| MIDI Device | Select your paddle's MIDI device |
| Dit/Dah Note | Map MIDI notes with Learn buttons |
| Local Sidetone | Enable/disable sidetone with pitch and volume controls |

### About

| Setting | Description |
|---------|-------------|
| Auto-Update | Check for updates on launch |
| Verbose CAT Log | Show raw CAT commands in a slide-out panel (for debugging) |

---

## Troubleshooting

### Radio won't connect

- **Check Test Connection** — click it in Settings for immediate feedback
- **One program per COM port** — close WSJT-X, fldigi, HRD, or any other CAT software first
- **Verify baud rate** — must match your radio's settings
- **Try DTR/RTS toggle** — some radios need it disabled, others don't
- **Enable Verbose CAT Log** (Settings → About) — shows raw commands and rigctld errors

### Spots not appearing

- Check that at least one source is enabled in the Spots dropdown
- Verify your internet connection
- Check band/mode/region filters — try setting all to "All"
- Check the Max Spot Age filter (set to 0 for no limit)

### SmartScreen blocks the installer

Right-click the `.exe` → Properties → check **Unblock** → OK. Then run the installer again. Or click "More info" → "Run anyway" on the SmartScreen dialog.

### DX Cluster won't connect

- Enter your callsign in Settings → Station (required for cluster login)
- Verify the cluster node is reachable (some nodes may be down)
- Check your firewall isn't blocking outbound telnet connections
- Connection status pills at the top of Settings show live status

### WSJT-X integration not working

- Make sure WSJT-X is configured to send UDP reports
- The UDP port must match (default 2237 in both apps)
- POTACAT must be started before WSJT-X (or restart WSJT-X after opening POTACAT)

### CW Keyer not producing audio

- Click anywhere in the POTACAT window first — the browser audio policy requires a user gesture to start audio
- Verify your MIDI device is detected (click Refresh in CW Keyer settings)
- Check the sidetone volume is not at zero

### CAT status pill stays red

If the status pill shows disconnected after a settings save, this is usually a transient event caused by the old connection closing. Wait a few seconds — it should reconnect automatically.

### Finding your COM port (Windows)

Open **Device Manager** → expand **Ports (COM & LPT)**. Your radio's USB serial adapter will be listed with its COM number. Plug/unplug the USB cable to see which port appears and disappears.

---

## Community & Support

**Website:** [potacat.com](https://potacat.com)

**Discord:** Join the community at [discord.gg/cuNQpES38C](https://discord.gg/cuNQpES38C) — get help, share your setup, request features, and chat with other POTACAT users.

**Support development:** If POTACAT helps you chase parks, consider supporting the project at [buymeacoffee.com/potacat](https://buymeacoffee.com/potacat).

**Report bugs:** [github.com/Waffleslop/POTACAT/issues](https://github.com/Waffleslop/POTACAT/issues)

**Author:** Casey Stanton, K3SBP

**License:** MIT. Bundles [Hamlib](https://hamlib.github.io/) (GPL v2).
