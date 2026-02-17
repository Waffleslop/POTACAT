# Radio Setup Guide

POTA CAT supports four ways to connect to your radio. Choose the one that matches your setup.

---

## FlexRadio (SmartSDR)

**Best for:** FlexRadio 6000/8000 series running SmartSDR

POTA CAT connects directly to SmartSDR's built-in CAT server over TCP. No additional software or cables are needed — just a network connection to your Flex.

### Setup

1. Open Settings and add a new rig
2. Select **FlexRadio (SmartSDR)**
3. Choose your slice (A, B, C, or D)
4. Save

### How It Works

SmartSDR exposes Kenwood-compatible CAT control on TCP ports 5002–5005, one per slice:

| Slice | Port |
|-------|------|
| A     | 5002 |
| B     | 5003 |
| C     | 5004 |
| D     | 5005 |

POTA CAT connects to `127.0.0.1` on the selected port. If SmartSDR is running on a different computer, use the **IP Radio (TCP CAT)** option instead and enter the Flex's IP address.

### SmartSDR Panadapter Spots

If you enable **Push spots to SmartSDR panadapter** in Settings, POTA CAT will also connect to the FlexRadio API on port 4992 and display spot markers directly on your panadapter. You can choose which spot sources (POTA, SOTA, DX Cluster, RBN) appear on the panadapter.

---

## IP Radio (TCP CAT)

**Best for:** FlexRadio on a remote computer, Elecraft K4, or any radio with a TCP-based Kenwood CAT interface

This is the same Kenwood CAT protocol as the FlexRadio option, but lets you specify a custom IP address and port.

### Setup

1. Open Settings and add a new rig
2. Select **IP Radio (TCP CAT)**
3. Enter the host IP and port
4. Save

### Common Uses

- **FlexRadio on another PC:** Enter the Flex's LAN IP address (e.g., `192.168.1.50`) and the slice port (5002–5005)
- **Elecraft K4:** The K4 offers a TCP CAT server when connected via Ethernet
- **Remote rigs:** Any radio accessible over the network via TCP CAT

---

## Serial CAT (Kenwood)

**Best for:** QRPLabs QMX, QRPLabs QDX, and other radios that speak Kenwood CAT protocol over a USB serial connection

This option sends standard Kenwood CAT commands (`FA`, `MD`) directly over a serial port. It's simpler and more reliable than Hamlib for radios that support basic Kenwood commands but don't perfectly match a specific Hamlib rig model.

### Setup

1. Open Settings and add a new rig
2. Select **Serial CAT (Kenwood)**
3. Choose your COM port from the dropdown (or type it manually)
4. Set the correct baud rate for your radio
5. Check **Disable DTR/RTS on connect** if your radio uses DTR for PTT (see notes below)
6. Click **Test Connection** to verify
7. Save

### Supported Commands

POTA CAT uses only two CAT commands:

- `FA` — Get/set VFO A frequency (11-digit Hz value)
- `MD` — Set mode (CW, USB, LSB, FM, DIGU, DIGL)

Any radio that responds to `FA;` with a frequency like `FA00014060000;` will work.

### DTR/RTS

Many USB serial interfaces (including built-in USB on QRP radios) use the DTR and RTS control lines. Some radios interpret DTR as a PTT signal — when the serial port opens, the OS asserts DTR by default, which keys your transmitter.

**Check "Disable DTR/RTS on connect" if:**
- Your radio transmits unexpectedly when POTA CAT connects
- You use a QRPLabs QMX or QDX
- You use a Digirig, SignaLink, or similar USB audio/serial interface
- Your radio resets or behaves erratically when the serial port opens

### Radio-Specific Notes

#### QRPLabs QMX / QMX+

| Setting | Value |
|---------|-------|
| Connection type | Serial CAT (Kenwood) |
| Baud rate | 38400 (check your QMX firmware settings) |
| Disable DTR/RTS | Yes (required — QMX uses DTR for PTT) |

**Important notes:**
- Do **not** use the "Other Rig (Hamlib)" option — Hamlib's protocol checks are too strict for the QMX's Kenwood implementation and will fail with protocol errors.
- If the QMX stops responding to CAT commands or the Test Connection shows diagnostic text instead of a frequency, **power cycle the radio**. Terminal programs like PuTTY can put the QMX into a debug/terminal mode that persists until reboot.
- The QMX creates a single USB serial port. Make sure no other software (PuTTY, WSJT-X, N3FJP, etc.) has the port open — only one program can use a COM port at a time.

#### QRPLabs QDX

Same settings as the QMX. The QDX also uses Kenwood CAT protocol over USB serial.

#### Kenwood Radios (TS-480, TS-590, TS-2000, etc.)

Most Kenwood radios work with either Serial CAT or Hamlib. Serial CAT is simpler if you only need frequency and mode control. Use Hamlib if you need advanced features.

| Setting | Value |
|---------|-------|
| Connection type | Serial CAT (Kenwood) |
| Baud rate | 9600 (check your radio's menu) |
| Disable DTR/RTS | Usually not needed |

#### Elecraft (KX2, KX3, K3, K3S)

Elecraft radios support Kenwood CAT commands. Serial CAT works well for basic frequency/mode control.

| Setting | Value |
|---------|-------|
| Connection type | Serial CAT (Kenwood) |
| Baud rate | 38400 (default for most Elecraft radios) |
| Disable DTR/RTS | Usually not needed |

---

## Other Rig (Hamlib)

**Best for:** Icom, Yaesu, and other radios that don't speak Kenwood CAT protocol

This option uses [Hamlib](https://hamlib.github.io/) (rigctld) to translate between POTA CAT and your radio's native protocol. Hamlib supports over 200 radio models from all major manufacturers.

POTA CAT bundles Hamlib 4.6.5 for Windows — no separate installation needed.

### Setup

1. Open Settings and add a new rig
2. Select **Other Rig (Hamlib)**
3. Search for your radio model in the dropdown
4. Choose your COM port from the dropdown (or type it manually)
5. Set the correct baud rate
6. Check **Disable DTR/RTS on connect** if needed (see Serial CAT section above for guidance)
7. Click **Test Connection** to verify
8. Save

### How It Works

When you select a Hamlib rig, POTA CAT:

1. Spawns a `rigctld` process with your rig model, serial port, and baud rate
2. Connects to rigctld over TCP (localhost port 4532)
3. Polls frequency using rigctld's simple text protocol
4. Sends tune commands through rigctld, which translates them to your radio's native protocol

### Troubleshooting

#### "Protocol error" on Test Connection

Hamlib's rig backends send initialization commands (ID, power status, etc.) and validate the responses strictly. If your radio's responses don't exactly match what the backend expects, you'll see a protocol error.

**Try these steps:**
1. Make sure you selected the correct rig model (not a similar one)
2. Verify the baud rate matches your radio's settings
3. If your radio supports Kenwood CAT commands, try **Serial CAT (Kenwood)** instead — it's more forgiving
4. Check if a firmware update is available for your radio

#### "Access denied" on Test Connection

Another program has your COM port open. Close any other software that might be using it (logging programs, digital mode software, terminal programs, other CAT controllers).

#### "Timed out" on Test Connection

Rigctld started but your radio didn't respond. Check:
- Is the correct COM port selected?
- Is the baud rate correct?
- Is the cable connected and the radio powered on?
- Is another program holding the COM port?

#### Connection drops after a while

Some radios need the DTR/RTS lines managed carefully. Try toggling the **Disable DTR/RTS on connect** checkbox.

---

## General Tips

### Only One Program Per COM Port

Serial ports can only be used by one program at a time. If POTA CAT can't connect, make sure you've closed any other software using the same port: WSJT-X, fldigi, N3FJP, HRD, PuTTY, etc.

### Finding Your COM Port

- **Windows:** Open Device Manager → Ports (COM & LPT). Your radio's USB serial adapter will be listed with its COM port number.
- When you plug/unplug your radio's USB cable, the port that appears/disappears is the one you want.
- If your COM port isn't in the dropdown, you can type it manually in the text field next to the dropdown.

### CW XIT Offset

When tuning to CW spots, you can set a transmit offset in Settings (CW XIT Offset, in Hz). This shifts your tune frequency so your transmit signal lands at the correct offset from the activator's frequency. Typical values are 0 to 700 Hz.
