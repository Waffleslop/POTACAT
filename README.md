<div align="center">

<a href="https://potacat.com"><img src="https://potacat.com/images/og-image-v2.png" alt="POTACAT — Hunt faster. Operate anywhere." width="860"></a>

# 🐱 POTACAT

### Hunt faster. Operate anywhere.

Eight live spot sources on one screen, one-click CAT tuning — then hand the whole station to your phone.

*Hunt POTA, SOTA and DX from the desk. Work SSB, CW, FT8 and SSTV from the car, the hotel, or the trailhead.*

**Free and open source · Windows · macOS · Linux · 200+ radios · No subscription, ever**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://potacat.com/images/main-table-dark.png">
  <img src="https://potacat.com/images/main-table-light.png" alt="The POTACAT spot table — POTA, SOTA, DX cluster and RBN spots merged into one sortable list, each row one click from a tuned radio" width="900">
</picture>

⚡ **No account, no API keys, no port forwarding.** Install it, pick your radio, click a spot. **[→ Install](#-install)**

<br>

> *"I want you to know I love this platform. **It is the most awesome POTA platform I have seen.**"*
> — **K5MUL**, POTACAT Discord

<a href="https://www.youtube.com/watch?v=JOUWVSQPK4Y">
  <img src="https://i.ytimg.com/vi/JOUWVSQPK4Y/maxresdefault.jpg" alt="Casey K3SBP and Jason KM4ACK discussing POTACAT" width="520">
</a>

▶️ **[POTACAT on KM4ACK's channel](https://www.youtube.com/watch?v=JOUWVSQPK4Y)** — a walkthrough of what it does and why it was built

</div>

---

<div align="center">

**[Install](#-install) · [First Five Minutes](#-the-first-five-minutes) · [What's Inside](#-whats-inside) · [ECHOCAT](#-echocat) · [Share My Rig](#-share-my-rig) · [POTACAT Cloud](#-potacat-cloud) · [Build from Source](#-build-from-source) · [Community](#-community--support)**

[Website](https://potacat.com) · [Docs](https://potacat.com/docs) · [Discord](https://potacat.com/discord) · [Support](https://potacat.com/support.html) · [Buy me a coffee](https://potacat.com/coffee)

</div>

---

## 📻 Why POTACAT Exists

Chasing an activation used to mean three browser tabs, a cluster window, and a hand on the VFO knob.
By the time you'd read the spot, typed the frequency, and picked the right sideband, the pileup had
moved on.

POTACAT collapses all of that into one row and one click. Every major activity network — POTA, SOTA,
GMA, the DX cluster, RBN, WSJT-X — lands in the same table, de-duplicated and filtered down to the
bands you can actually work. Click the row and the radio is already there: frequency, mode, CW
offset, and a log entry pre-filled with the park reference.

Then it keeps going. The same app that drives your rig serves it to your phone, so the station
doesn't stop working when you leave the house.

> Half of it is a spot aggregator that happens to control your radio.
> The other half is your entire shack, on a screen the size of your hand.

Works with **FlexRadio**, **Icom**, **Yaesu**, **Kenwood**, **Elecraft**, **QRP Labs** — and 200+
more rigs via Hamlib. Written by **Casey, K3SBP**, shaped every week by the operators who use it,
and shipped most weeks.

---

## ⚡ Install

Grab the current build from the **[Releases page](https://github.com/Waffleslop/POTACAT/releases/latest)**.
Every release ships Windows, macOS and Linux binaries in both **Intel/AMD (x86-64)** and **ARM
(arm64/aarch64)** flavours.

| Platform | Architecture | Download |
|---|---|---|
| **Windows 10/11** | 64-bit Intel/AMD | `POTACAT-Setup-<ver>.exe` — installer *(recommended)* |
| **Windows 10/11** | 64-bit Intel/AMD | `POTACAT-Portable-<ver>.exe` — no install, run from anywhere |
| **macOS** — Apple Silicon (M1–M4) | arm64 | `POTACAT-<ver>-arm64.dmg` |
| **macOS** — Intel | x86-64 | `POTACAT-<ver>.dmg` |
| **Linux** — PC / server | x86-64 | `POTACAT-<ver>.AppImage` · `potacat_<ver>_amd64.deb` · `potacat-<ver>.x86_64.rpm` |
| **Linux** — Raspberry Pi 4/5, ARM SBC | arm64 | `POTACAT-<ver>-arm64.AppImage` · `potacat_<ver>_arm64.deb` · `potacat-<ver>.aarch64.rpm` |

<details>
<summary><strong>Which architecture do I have?</strong></summary>

<br>

- **Windows** — 64-bit Intel/AMD. There is no ARM Windows build.
- **macOS** —  → About This Mac. "Apple M1/M2/M3/M4" is arm64; "Intel" is x86-64.
- **Linux** — run `uname -m`. `x86_64` takes the amd64 build, `aarch64` the arm64 one.

The `*-mac.zip` and `latest*.yml` files on the Releases page are what the in-app auto-updater
fetches. You don't need to download them.

</details>

POTACAT isn't code-signed yet, so the first launch takes one extra click on Windows and macOS.
That's normal for an independent app and doesn't mean anything is wrong — signing is on the
roadmap, and these steps go away with it.

### 🪟 Windows

1. Download `POTACAT-Setup-<ver>.exe` and run it.
2. If you see **"Windows protected your PC"** — click **More info → Run anyway**.
3. If the installer won't start at all — right-click the `.exe` → **Properties** → tick
   **Unblock** → **OK**, then run it again.

Prefer not to install? `POTACAT-Portable-<ver>.exe` runs straight from your downloads folder.
Settings live in the same place either way. More Windows detail in **[INSTALL.md](INSTALL.md)**.

### 🍎 macOS

1. Download the `.dmg` for **your** chip — `-arm64.dmg` for Apple Silicon, plain `.dmg` for Intel.
2. Open it and drag **POTACAT** into **Applications**.
3. Apple Silicon Macs will say *"POTACAT is damaged and can't be opened."* It isn't damaged —
   that's what macOS says about any app built without a paid Apple Developer ID. Open **Terminal**
   and paste this once:

   ```bash
   sudo xattr -dr com.apple.quarantine /Applications/POTACAT.app
   ```

   Enter your Mac password, then open POTACAT normally. On Intel Macs, right-click → **Open** →
   **Open** is usually enough.

### 🐧 Linux

Pick **one** format. AppImage is the most portable; `.deb` and `.rpm` integrate with your package
manager and ship an AppArmor profile so the full Chromium sandbox stays on.

```bash
# AppImage — any distro
chmod +x POTACAT-<ver>.AppImage && ./POTACAT-<ver>.AppImage

# Debian / Ubuntu
sudo apt install ./potacat_<ver>_amd64.deb        # or _arm64.deb on a Pi

# Fedora / RHEL / openSUSE
sudo dnf install ./potacat-<ver>.x86_64.rpm       # or .aarch64.rpm on a Pi
```

<details>
<summary><strong>Serial ports and the sandbox — two things worth doing up front</strong></summary>

<br>

**Serial permissions.** If POTACAT can't see your radio's serial port, add yourself to the
`dialout` group and log out and back in:

```bash
sudo usermod -aG dialout $USER
```

**Sandbox.** On hardened or very new distros, Chromium's sandbox needs unprivileged user
namespaces. POTACAT detects that and falls back on its own. If an AppImage still refuses to
start, run it with `--no-sandbox`.

</details>

---

## 🕐 The First Five Minutes

**1. Connect your rig.** Settings → **My Rigs** → pick a connection type:

| Your radio | Connection type |
|---|---|
| FlexRadio 6000 / 8000 | **SmartSDR CAT** — auto-discovers on your LAN |
| Icom IC-7300, Elecraft KX2/KX3, Yaesu FT-891, most others | **Hamlib** — 200+ models |
| QRP Labs QMX / QDX, Win4Yaesu | **Serial CAT (Kenwood protocol)** — pick the port and baud |
| IC-705, IC-9700, IC-7610, or wfview's `wfserver` | **Icom Network** — CI-V over IP |

Per-radio walkthroughs with known-working settings are in the
**[rig setup guides](https://potacat.com/radios.html)**.

**2. Set your grid square.** Settings → your Maidenhead grid, e.g. `FN20jb`. Distances, the map,
and the great-circle arc all key off it.

**3. Pick your spot sources.** Start with POTA, SOTA and DX Cluster from the toolbar; add RBN,
WSJT-X or SSTV as you need them.

**4. Click a spot.** The rig moves — frequency, mode, CW offset — and the log dialog opens
pre-filled with the callsign, park or summit reference, and operator name.

**5. Take it with you.** On your home Wi-Fi, open ECHOCAT on your phone, tap your desktop, and
click **Approve**. That's the entire pairing flow. Leave the house and the station comes along.

<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://potacat.com/images/map-view-dark.png">
  <img src="https://potacat.com/images/map-view-light.png" alt="POTACAT map view — colour-coded spot markers by source, home QTH marker, and a great-circle arc to the station being worked" width="880">
</picture>
</div>

> *"POTACAT shines in its ability to make hunting easy, whether that's POTA, SOTA, DX or others."*
> — **K8IKO**

---

## 🎛️ What's Inside

- **📡 Eight spot sources, one table.** POTA, SOTA, GMA, DX Cluster, RBN, WSJT-X, PSKReporter and a
  DXpedition feed — merged, de-duplicated, and filtered by band, mode, distance and what you still
  need. Hide worked parks; hide anything outside your license privileges.
- **🎯 One-click QSY.** Click a spot and the rig tunes — frequency, mode and CW offset. FlexRadio
  native, Hamlib, or direct serial.
- **🗺️ Table, map and split views.** Sortable, resizable table; Leaflet map with per-source marker
  colours, day/night terminator, and a pop-out window driven by the same filters.
- **📻 Flex Direct.** POTACAT drives a FlexRadio all by itself — tune, listen and key CW with no
  SmartSDR running. An SWR guard aborts TX into a bad match before your finals notice.
- **🔊 FT8 built in.** JTCAT runs FT8 and FT4 with auto-sequencing, a-priori decoding and clock-sync
  checks. **Spot Target** is the fun part: click a callsign anywhere in the app and JTCAT works
  them for you.
- **📬 JS8 mailbox.** Keyboard-to-keyboard when you're at the desk; a message drop that quietly
  collects `@ALLCALL` and directed traffic when you're not.
- **🌍 WSPR beacon & footprint.** Run a 1-watt beacon overnight, hop bands on a schedule, and wake
  up to a map of every receiver that actually heard you — then spend your real operating time on
  the band that was working.
- **🖼️ More digital modes.** SSTV send and receive, PSK31 with a live keyboard, FreeDV (including
  RADE), and the Mercury HF data modem for chat and file transfer. No extra software to babysit.
- **📖 Logs everywhere you do.** Local ADIF always, forwarded live to Log4OM, DXKeeper, Ham Radio
  Deluxe, N3FJP and Wavelog, with Cloud sync across your devices. Import a POTA CSV for "NEW park"
  badges, or an ADIF log for a DXCC band/mode matrix.
- **👥 Multi-operator.** Shared shack? Each operator gets their own callsign, logbook, macros and
  watchlist on one install. Ctrl-click several spots to log a multi-op activation in one go.
- **🏁 Contest & event aware.** 13 Colonies, WRTC, America 250 — event checklists and banners show
  up on their own, tick themselves off as you log, and sync to your phone.
- **🔭 Rotators, propagation, alerts.** Rotor-EZ / RotorCard / DCU-1 control, a solar and band
  conditions panel, watchlist desktop notifications, and a scan mode that steps through filtered
  spots on a dwell timer.

### 📶 Your spots, on the panadapter

If you already stare at a waterfall all day, the spot table shouldn't be somewhere else on the
screen. Every spot POTACAT is tracking gets pushed onto the scope as a **labelled marker sitting on
the actual frequency** — you watch the band the way you already do, and the callsigns are simply
*there*, on the signals, updating as the feeds do. Click one and POTACAT does the rest.

<div align="center">
  <img src="https://potacat.com/images/flex-panadapter-spots.png" alt="Spot callsigns rendered as labelled markers on a FlexRadio panadapter, sitting on the actual signals" width="620">
</div>

Works with **SmartSDR** (FlexRadio 6000/8000), **AetherSDR**, **Thetis** for ANAN / Apache Labs /
Hermes-Lite over TCI — or your rig's own built-in panadapter.

> *"AetherSDR and POTACAT is going to be a game changer. It's exciting times to be a Flex user."*
> — **N5ZC**

**[Full documentation →](https://potacat.com/docs)**

---

## 📱 ECHOCAT

### Your radio, anywhere you are.

<div align="center">
  <img src="https://potacat.com/images/phone-spots.png" alt="ECHOCAT spots screen on iPhone — POTA spots with distance, mode and a Log button" width="235">
  &nbsp;&nbsp;&nbsp;
  <img src="https://potacat.com/images/phone-vfo.png" alt="ECHOCAT VFO screen — tuning knob, tuned spot detail and a large PTT button" width="235">
</div>

<div align="center">

<a href="https://apps.apple.com/us/app/echocat-ham-radio-remote/id6766321194"><img src="https://potacat.com/images/badge-app-store.svg" alt="Download ECHOCAT on the App Store" height="44"></a> <a href="https://play.google.com/store/apps/details?id=co.cmox.echocat"><img src="https://potacat.com/images/badge-google-play.png" alt="Get ECHOCAT on Google Play" height="66"></a>

**$9.99, once.** No subscription.

</div>

Not a rented station with a queue — *your* rig, *your* antenna, *your* logbook, in your pocket.
Pair your phone to POTACAT once and the station follows you everywhere.

- **🎙️ SSB.** Real-time two-way audio over WebRTC with a hold-to-talk PTT, plus pre-recorded voice
  macros for when you'd rather not narrate the parking lot.
- **⌨️ CW.** Plug a paddle into your phone and call CQ through your home station — real-time keying
  with local sidetone, so it feels like sitting at the desk. Works with **TinyMIDI**,
  **HaliKey MIDI**, **Vail Adapter** and **VBand**. One-tap macros handle the exchange when one
  hand needs to stay on the wheel.
- **📶 FT8 / FT4.** Tap a spot, let auto-sequencing run the exchange, and log a new entity before
  you turn out the lights. Your shack PC does the decoding; your thumb does the DXing.
- **🖼️ SSTV.** Snap a photo, drop your callsign on it with a template, and send it out over HF from
  wherever you are. Receive works too — watch images paint in line by line.
- **📬 JS8 and WSPR.** Read the mailbox from the passenger seat; check overnight beacon spots with
  your coffee.

> *"I'm sitting in my hotel in Boston, connected to my rig in Upstate NY, and just worked a station
> in Hungary… **it's like magic.**"* — **KD2TJU**

> *"Sitting here in a parking lot waiting on my kid to finish practice. I got a POTA, three
> different W1AWs, Uruguay, and Mexico on remote CW… **This project is amazing.**"* — **AA6C**

> *"I operated for a week from family & friends' homes and hotels. Stations I regularly talk to
> said they couldn't tell I was working remote on SSB."* — **KQ4QWH**

**Prefer a browser?** The web client built into POTACAT is free and does most of the same job over
your LAN or Tailscale.

**No radio yet?** Listen to SDR receivers across the globe in ECHOCAT Web — no install, no account,
just **[sdr.potacat.com](https://sdr.potacat.com)**.

### How it all connects

Your shack computer is the station. Everything else is a remote.

```
                                                    ┌─▶  Your phone — ECHOCAT
                                                    │    SSB · CW · FT8 · SSTV
  Your radio  ──cable or IP──▶  Shack computer  ────┼─▶  Your laptop at the office
  any of 200+ rigs               running POTACAT    │    POTACAT as a client
                                                    └─▶  Your buddy's phone or tablet
                                                         via a Share My Rig guest pass
```

Everything connects *back* to POTACAT — over your LAN, your Tailscale network, or the POTACAT Cloud
Tunnel at `yourcall.potacat.com`, whichever reaches home first. No port forwarding, no static IP,
no monthly fee.

---

## 🤝 Share My Rig

**Lend your station, not your keys.** A Guest Pass lets a friend — or a ham with no radio at all —
operate your station for a window you control. Email them a link; that's the whole setup.

- **✓ Privilege-aware.** Pick their license class and POTACAT enforces the band edges for them.
- **✓ Power-capped and time-boxed.** Set a max TX power and an expiry from 1 hour to 30 days.
  Revoke any pass instantly.
- **✓ Legal by design.** Station, operator and control-op callsigns are recorded per **§97.119**,
  and guest QSOs log to *their* logbook.

> *"My father-in-law in assisted living isn't doing his physical therapy like he's supposed to, so
> I'm going over the next few weeks to work with him — and **his reward is getting on the air**."*
> — **W7RTA**, POTACAT Discord

> *"Being able to limit their TX power is fantastic!!!"* — **KB2UXB**

---

## ☁️ POTACAT Cloud

**Behind a CGNAT? We punch through.**

Plenty of hams set everything up correctly and still can't reach the shack from the road. Usually
it isn't the router — it's Carrier-Grade NAT, what an ISP does when it runs out of IPv4 addresses.
Outbound traffic works fine, which is why you never notice, but nothing on the internet can start a
connection back to *you*. Port forwarding does nothing, because the block sits a layer above your
router, on hardware you don't control. It's the default on most cellular home internet and
Starlink, and increasingly common on fixed wireless and rural fibre.

<details>
<summary><strong>How to tell in about thirty seconds</strong></summary>

<br>

- Open your router's status page and read its **WAN IP**. Then search "what is my IP" in a browser.
  **If the two don't match, you're behind a CGNAT.**
- If that WAN address starts with `100.64` through `100.127`, that's the range reserved for exactly
  this — a dead giveaway.
- You forwarded a port, double-checked it, and an outside port checker still reports it closed.
- Your ISP offers a static or public IP as a paid add-on. That offer exists because the default
  isn't one.

</details>

POTACAT Cloud gives both ends an outbound-only path to an encrypted relay and meets them in the
middle — no ports opened at either end. POTACAT tries a direct connection first and only falls back
to the relay when the network refuses. You don't choose, and you don't configure anything.

**$5/month, entirely optional.** Memberships run through
[Buy Me a Coffee](https://potacat.com/coffee), so that's where the link lands — cancel any time,
from their side, without asking us. The desktop app stays free and unsubscribed; LAN and Tailscale
remain free. Cloud is only for operators whose network won't let them home.

---

## 🔧 Build from Source

POTACAT is open source, telemetry included — clone it, audit it, fork it. Requires
[Git](https://git-scm.com) and [Node.js 22+](https://nodejs.org).

```bash
git clone https://github.com/Waffleslop/POTACAT.git
cd POTACAT
npm install
npm run build-natives     # FT8 / JS8 / FreeDV native decoders
npm start
```

On Linux, install the build dependencies first:

```bash
sudo apt install build-essential python3 libudev-dev cmake libhamlib-utils
```

`build-natives` needs a C/C++ toolchain — Xcode Command Line Tools on macOS, Visual Studio Build
Tools on Windows. Skipping it still runs, but FT8 falls back to a slower WASM decoder with fewer
features, and JS8 and FreeDV are unavailable.

**To package installers:**

```bash
npm run dist:win        # installer + portable
npm run dist:mac        # .dmg  (run this on a Mac)
npm run dist:linux      # AppImage + .deb + .rpm
```

Output lands in `dist/`. The `dist:*` scripts refuse to package until `build-natives` has run — a
build without the native decoders ships a broken JS8 and a degraded FT8. Set
`POTACAT_SKIP_NATIVE_CHECK=1` if you really mean to override that.

Patches welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

### 🍓 Headless / Raspberry Pi

Run POTACAT with no GUI to serve only the remote interface — ideal for a Pi sitting next to the
radio:

```bash
npm start -- --headless
```

CAT control, spots, the FT8 engine, the CW keyer and ECHOCAT all work headless.

---

## 🎓 Also from the POTACAT Workshop

<table>
<tr>
<td width="50%" valign="top">

### [MorseCAT](https://potacat.com/morsecat/)

Learn Morse code the way it's meant to be heard. An **instant character recognition** trainer for
iOS and Android: characters at full speed from day one, answers keyed on your own paddle, and a
Space Invaders clone you play by ear. **Free.**

</td>
<td width="50%" valign="top">

### [ScoutCAT](https://potacat.com/scoutcat/)

An activation planner for finding the parks and summits worth your Saturday — what's near you,
what's never been activated, and where the gaps in the map are.

</td>
</tr>
</table>

---

## 💬 Community & Support

Setup help, feature requests and bug reports all happen on Discord, where the developer answers in
person. Release notes name the operators who reported each issue — read the changelog and judge the
pace yourself.

| | |
|---|---|
| 💬 **Discord** | [potacat.com/discord](https://potacat.com/discord) |
| 📚 **Documentation** | [potacat.com/docs](https://potacat.com/docs) |
| 🛟 **Support & FAQ** | [potacat.com/support.html](https://potacat.com/support.html) |
| 📻 **Rig setup guides** | [potacat.com/radios.html](https://potacat.com/radios.html) |
| 🐛 **Bug reports** | [GitHub Issues](https://github.com/Waffleslop/POTACAT/issues) |
| 📝 **Changelog** | [Releases](https://github.com/Waffleslop/POTACAT/releases) |
| ☕ **Support development** | [potacat.com/coffee](https://potacat.com/coffee) |

**Your data stays yours.** Logs live in a local ADIF file on your machine. Telemetry is opt-in,
anonymous, and [published publicly](https://telemetry.potacat.com/stats) — what you see there is
everything that gets collected. Full
[privacy policy and terms](https://potacat.com/privacy-terms.html).

> *"I'd been wondering whether this could be integrated into POTACAT — and a few days later you
> release that feature. Amazing."* — **DA2PK**

> *"I love this stuff! 77 years old in ABQ, NM."* — **N2GJ**

---

## ⚖️ License

POTACAT is licensed under the **[GNU General Public License v3.0](LICENSE)** or later, because it
incorporates the JS8 modem from
[JS8Call-improved](https://github.com/JS8Call-improved/JS8Call-improved). Files written for POTACAT
carry an `SPDX-License-Identifier: Apache-2.0` header and are additionally available under the
[Apache License 2.0](LICENSES/Apache-2.0.txt) from the copyright holder; the combined work you
download is GPLv3. See [`NOTICE`](NOTICE).

**"POTACAT" and "ECHOCAT" are trademarks of Casey Stanton.** The license covers the source code,
not the names — see [TRADEMARKS.md](TRADEMARKS.md). If you fork and redistribute a modified build,
please give it a different name.

ECHOCAT mobile is a separate, independent program that talks to POTACAT over a documented network
protocol and contains no GPL code.

<details>
<summary><strong>Third-party software</strong></summary>

<br>

The JS8 modem is compiled in from JS8Call-improved (GPLv3), vendored under
[`third_party/js8call/`](third_party/js8call/). Other GPL tools ship as **separate executables**
invoked over a process boundary. See [`NOTICE`](NOTICE) for the full list.

- [Hamlib](https://hamlib.github.io/) `rigctld` for radio control —
  [GPLv2](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html); source at
  [github.com/Hamlib/Hamlib](https://github.com/Hamlib/Hamlib).
- `wsprd` WSPR decoder (K1JT / K9AN, WSJT Development Group) —
  [GPLv3](https://www.gnu.org/licenses/gpl-3.0.html); bundled as a standalone binary, not linked.
  See [`third_party/wsprd/`](third_party/wsprd/).
- POTACAT Cloud's optional tunnel uses Cloudflare's
  [`cloudflared`](https://github.com/cloudflare/cloudflared).

</details>

---

<div align="center">

### Ready to chase some parks?

**[⬇ Download POTACAT](https://github.com/Waffleslop/POTACAT/releases/latest)** · **[Join the Discord](https://potacat.com/discord)** · **[Buy me a coffee](https://potacat.com/coffee)**

<br>

> *"Just worked pota station in **alaska over the northpole** now. found him tnx to potacat 🙂"*
> — **LB3AG**

<br>

<sub>73, Casey **K3SBP** · Built for the ham radio community</sub>

`/\_/\  meow  /\_/\`

</div>
