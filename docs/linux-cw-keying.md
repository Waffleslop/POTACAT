# CW keying on Linux (IC-7300 and other USB-serial rigs)

This covers keying CW from POTACAT / ECHOCAT on Linux (Mint, Ubuntu, Debian,
Raspberry Pi OS) when the radio keys CW off a USB-serial control line — the
IC-7300 and IC-7300 MK II being the common case.

## How USB CW keying works

The IC-7300's single USB cable enumerates on Linux as a **Silicon Labs CP210x**
(`/dev/ttyUSB0`, driver `cp210x`, USB id `10c4:ea60`). It carries CAT (CI-V) and,
separately, two modem-control lines — **DTR** and **RTS**. The radio's menu maps
one of them to CW keying:

> **Menu → SET → Connectors → USB SEND/Keying**
> - **USB SEND** — PTT/TX control (DTR, RTS, or OFF)
> - **USB Keying (CW)** — the CW key line (DTR, RTS, or OFF)
> - **USB Keying (RTTY)** — FSK line

The de-facto standard in most setup guides (fldigi, HRD, N1MM) is
**USB Keying (CW) = RTS** with **USB SEND = DTR**. POTACAT's IC-7300 default now
matches this: it drives **RTS** for CW keying.

## Two ways to key CW from POTACAT / ECHOCAT

### 1. CW text / macros — no control line, works everywhere (recommended)

Typing CW or tapping a macro in ECHOCAT sends the text over CI-V command `0x17`
("Send CW message") to the radio's internal keyer. This needs **no DTR/RTS**, no
udev rules, and no menu changes beyond having the rig in **CW / CW-R** with
**BK-IN on**. If you just want to send CW messages remotely, use this — it sidesteps
every Linux control-line issue below.

### 2. Real-time paddle — uses the DTR/RTS control line

The ECHOCAT on-screen paddle keys the radio live via the DTR or RTS line. This is
where the "RTS not working on Linux" problems live. Get it working with the steps
below.

## Getting the paddle working

### A. Match the keying line

POTACAT must drive the **same** line your radio menu reads for CW.

- **Settings → Rig → CW keying line**: `Auto` (uses the model default — RTS for the
  IC-7300), `DTR`, or `RTS`. Set this to match your radio's **USB Keying (CW)** menu.
- Recommended IC-7300 config:
  - **USB Keying (CW) = RTS**, POTACAT **CW keying line = RTS (or Auto)**
  - **USB SEND = OFF**, **BK-IN = ON** (break-in transitions TX; no separate SEND line)
- Alternative (equally fine):
  - **USB Keying (CW) = DTR**, POTACAT **CW keying line = DTR**, USB SEND = OFF, BK-IN = ON

POTACAT always drives *both* lines explicitly (keyed line follows the paddle, the
other is forced low), so the old node-serialport bug where the unused line latched
high and stuck the radio in transmit no longer applies.

### B. Serial port permissions

Your user must be in the `dialout` group to open `/dev/ttyUSB0`:

```bash
sudo usermod -aG dialout "$USER"
# log out and back in (or reboot) for the group to take effect
```

### C. Keep ModemManager off the port

ModemManager probes new serial devices at plug-in — it can assert RTS/DTR (keying
the radio at boot) or hold the port so pin control misbehaves. Tell it to ignore
the CP210x.

Create **`/etc/udev/rules.d/99-potacat-hamradio.rules`**:

```udev
# Keep ModemManager away from ham-radio USB-serial adapters so it can't grab the
# port or toggle DTR/RTS (which would key the rig). Add more idVendor/idProduct
# lines for other adapters as needed.

# Silicon Labs CP210x — Icom IC-7300 / IC-7300 MK II, many others
SUBSYSTEM=="tty", ATTRS{idVendor}=="10c4", ATTRS{idProduct}=="ea60", ENV{ID_MM_DEVICE_IGNORE}="1"
# FTDI FT232 (external USB-UART on a CW KEY jack, some rigs)
SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", ATTRS{idProduct}=="6001", ENV{ID_MM_DEVICE_IGNORE}="1"
# Prolific PL2303
SUBSYSTEM=="tty", ATTRS{idVendor}=="067b", ATTRS{idProduct}=="2303", ENV{ID_MM_DEVICE_IGNORE}="1"
# CH340/CH341
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="7523", ENV{ID_MM_DEVICE_IGNORE}="1"
```

Reload udev and replug the radio:

```bash
sudo udevadm control --reload-rules
sudo udevadm trigger
# then unplug/replug the USB cable
```

> **Gotcha:** on some distros ModemManager runs with `--filter-policy=strict`, which
> ignores the `ID_MM_DEVICE_IGNORE` tag entirely. If the radio still keys at boot,
> switch it to `default`:
> ```bash
> sudo systemctl edit ModemManager
> ```
> and add:
> ```ini
> [Service]
> ExecStart=
> ExecStart=/usr/sbin/ModemManager --filter-policy=default
> ```
> then `sudo systemctl restart ModemManager`. If you don't use cellular modems at
> all, you can instead just remove/disable it:
> `sudo systemctl disable --now ModemManager`.

### D. Confirm the chip / device

```bash
lsusb | grep -i "CP210\|Silicon Labs"      # 10c4:ea60 = the IC-7300
dmesg | grep -i "cp210x\|ttyUSB"           # shows which /dev/ttyUSB* it claimed
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Radio goes to TX but sends no CW (dead carrier) | POTACAT keying the wrong line vs. the radio menu | Match **CW keying line** to **USB Keying (CW)** (step A) |
| Radio stuck in TX / continuous key-down | (old bug — un-keyed line latched high) or **USB SEND** on the same line as keying, held high | Update POTACAT; set USB SEND = OFF, keying line distinct |
| Radio keys at boot / port "busy" | ModemManager grabbing the CP210x | udev rule + filter-policy (step C) |
| `permission denied` opening `/dev/ttyUSB0` | not in `dialout` | step B |
| Paddle disabled in ECHOCAT, "text still works" | connected via **rigctld/hamlib** (no per-element CW) | use CW text box, or an external CW Key Port |

## Notes

- **rigctld / hamlib** has no per-element CW key command (only `send_morse` text),
  so paddle keying is unavailable over that backend — use the CW text box, or wire
  an external USB-UART (FTDI/CH340) to the rig's CW KEY jack and set it as the
  **CW Key Port** in Settings → Rig.
- CI-V command `0x1C 0x01` is the **antenna tuner** on Icom, not a CW key — POTACAT
  never uses it for keying.
