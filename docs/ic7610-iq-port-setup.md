# IC-7610: the I/Q port ([USB 2]) beside POTACAT

Written 2026-11-02 from Icom's own two documents (sources at the end). This is the
reference for the docs and website pages; their wording should come from here.

## What it is, and what POTACAT does with it

The IC-7610 has two USB ports on the back:

- **[USB 1]** (type B): CAT (CI-V) and the radio's sound card. **This is the
  port POTACAT uses.** Nothing about it changes when you add the I/Q port.
- **[USB 2]** (USB 3.0, type B, the blue "SuperSpeed" socket): the **I/Q port**. With
  firmware 1.20 or later it streams the receiver's raw I/Q signal at 1.92 MHz, 16-bit,
  1.66 MHz wide, from the MAIN or the SUB receiver, and accepts a short list of CI-V
  commands. Icom supports it on Windows only, through its "USB I/Q Package for HDSDR"
  (an FTDI D3XX driver plus `ExtIO_IC7610.dll`).

**POTACAT does not read the I/Q port.** Its IC-7610 band scope and audio come over
[USB 1]. The I/Q port is for an SDR program, HDSDR, running next to POTACAT: a 1.66 MHz
wide waterfall of the band, a third receiver, or a feed for CW Skimmer. The two
programs talk to the radio over different cables, so they do not fight over a COM port.

## What you need

- IC-7610 firmware **1.20 or later** (Section 13 of the IC-7610 Advanced manual shows
  how to check and update it).
- A Windows PC with a **USB 3.0** port. Icom lists Windows 7, 8.1 and 10. Plug straight
  into the PC, never through a hub. On-board sound is recommended for the speaker.
- A **USB 3.0 A-to-B cable** (Icom does not supply one), as short as practical. Icom
  notes a long cable can be recognised by the PC and still not work.
- **HDSDR** (free, hdsdr.de). Icom tested version 2.76a.
- **IC-7610 USB I/Q Package for HDSDR** from Icom: on Icom America's support downloads
  it is "USB I/Q Package for HDSDR"; on Icom Japan's world site it is under Support >
  Firmware Updates/Software Downloads > IC-7610.

## Steps

Install in this order. **Do not connect [USB 2] until step 3 is done.**

1. **Check the firmware** is 1.20 or later; update it first if not.
2. **Install HDSDR** first. Note the folder it installs to (normally
   `C:\Program Files\HDSDR`).
3. **Install the USB I/Q Package.** Unzip it and run `setup64.exe` (64-bit Windows) or
   `setup32.exe`. Choose the language, confirm the destination is the HDSDR folder
   (Browse to it if HDSDR went elsewhere), click **Install**, and click **Install** again
   at the Windows Security prompt.
4. **Turn the radio off**, connect the USB 3.0 cable from **[USB 2]** to the PC, then turn
   the radio on. Windows finishes the driver.
5. **Confirm the driver:** Device Manager > Universal Serial Bus controllers should list
   **IC-7610 I/Q OUT Port**. If not, run the package installer again.
6. **Start HDSDR.** If it asks which ExtIO to load, pick **ExtIO_IC7610.dll**.
7. In HDSDR click **ExtIO** to open the IC-7610 I/Q Settings window:
   - **MAIN/SUB:** the receiver to watch (choosing SUB turns Dualwatch on).
   - **Sync Mode:** **Only HDSDR sync** for a waterfall that follows the radio, or
     **Independent Tune in HDSDR** to use HDSDR as a third receiver. Leave **Full sync in
     both directions** for the CW Skimmer setup (below).
   - **Sampling Rate:** 1.92 MHz (BW 1.66 MHz) is the default; pick a lower rate if the
     audio stutters.
8. Click **Soundcard** and pick your PC speaker. Click **Bandwidth** and set **Output
   Sampling Rate** to **12000** (48000 or lower; 12000 is enough for SSB).
9. Click **Start**. The waterfall shows the band around the radio's frequency. Click
   anywhere inside it to listen there in HDSDR; the radio stays where it is.

If no sound comes out: **Options > Output Channel Mode for RX > AF to Both channels**.

## Using it with POTACAT

- Leave POTACAT on **[USB 1]** exactly as before (Settings > My Rigs, Radio Model
  IC-7610, CI-V address 98h). It keeps CAT, audio, FT8, CW keying and its own band scope.
- With **Only HDSDR sync**, HDSDR's centre (LO) follows the radio, so a spot clicked in
  POTACAT moves the radio and HDSDR's waterfall recentres on it.
- With **Independent Tune in HDSDR**, HDSDR keeps listening on its own frequency inside
  the 1.66 MHz window while POTACAT moves the radio, as long as it stays in that window.
- HDSDR cannot move its LO outside the radio's range, and its own **Lock** button and
  **Options > Misc Options > Tune fixed to 'LO <-> Tune Offset'** fight the ExtIO's Sync
  Mode: leave both off unless Sync Mode is Only HDSDR sync.
- **OVF** in the I/Q Settings window means the input is too strong: preamp off, add ATT,
  lower RF gain, or turn DIGI-SEL on (all also in that window).

## CW Skimmer (optional, from Icom's guide)

Icom documents two Skimmer setups. Both send HDSDR's I/Q output to CW Skimmer through
**VB-Audio Hi-Fi Cable**, set to 16-bit 192000 Hz on both its Recording ("Hi-Fi Cable
Output", 2 channel) and Playback ("Hi-Fi Cable Input") sides. In HDSDR: mode **USB**,
**Soundcard** output = Hi-Fi Cable Input, **Output Sampling Rate** 192000, **Options >
Output Channel Mode for RX > IF as I (Left) / Q (Right)**, IQ-Gain 0 dB to start. In CW
Skimmer: Signal I/O Device = Hi-Fi Cable Output, Sampling Rate 192 kHz.

- **Narrow (24 kHz), click a station to tune the radio:** ExtIO Sync Mode **Full sync in
  both directions**; CW Skimmer Hardware Type **SoftRock-IF**; a com0com pair (both
  numbers COM20 or lower, Omni-Rig cannot see higher); HDSDR **Options > CAT to HDSDR**
  on one port and activated; CW Skimmer CAT = Omni-Rig Radio 1, rig type **Kenwood**,
  the other com0com port, poll 100 ms, timeout 100 ms. A tune made in Skimmer moves the
  radio, and POTACAT follows it on its next frequency poll.
- **Wide (~170 kHz), skimmer feeding a logger:** Sync Mode **Independent Tune in HDSDR**,
  HDSDR Tune at the centre of the range (7.085 MHz for 7.000-7.170), CW Skimmer
  Hardware Type **SoftRock** with LO Frequency = that same Tune frequency, Telnet server
  on. Icom's example sends the spots to N1MM Logger+ over telnet; a straight line across
  Skimmer's display means IQ-Gain is too low.

## What this is not

- Not Mac or Linux: Icom's driver package is Windows only.
- Not POTACAT's band scope source. POTACAT reading [USB 2] directly (FTDI D3XX, bulk
  endpoint 0x84, little-endian 16-bit I then Q) would be new work; Icom's I/Q reference
  guide has the full interface if it is ever wanted.
- No transmit through HDSDR: the I/Q port is receive plus a handful of receiver
  settings (antenna, preamp, ATT, RF gain, DIGI-SEL, IP+, frequency, mode).

## Sources

- Icom, "Preparations for using the IC-7610 with the HDSDR application" and "IC-7610
  HDSDR Operating Guide" (one PDF, A7475-3EX / A7475-4EX, 2018): Icom file
  `IC-7610_ENG_ExtIO_Inst_n_OG_0.pdf`, mirrored at k0pir.us.
- Icom, "IC-7610 I/Q Output Reference Guide" (A7380-10EX, 2018): Icom file
  `IC-7610_ENG_I_Q_Supp_0.pdf`, mirrored at k0pir.us and DX Engineering.
- Icom America download: "USB I/Q Package for HDSDR" (icomamerica.com support, firmware
  and drivers, item 1956).
