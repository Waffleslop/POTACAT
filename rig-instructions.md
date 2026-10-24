# Rig Setup Instructions

Tested radio configurations for POTACAT. If your rig isn't listed, try **Serial CAT (Kenwood)** first — many radios support FA/MD commands — then fall back to **Hamlib**.

---

## FlexRadio (SmartSDR)

- **Connection:** FlexRadio (SmartSDR) — select Slice A–D
- **Protocol:** TCP CAT on ports 5002–5005
- **Notes:** Works out of the box. No serial port or Hamlib needed. SmartSDR must be running.

---

## QRPLabs QMX

- **Connection:** Serial CAT (Kenwood)
- **Baud Rate:** 38400
- **Disable DTR/RTS:** No (leave unchecked)
- **Known Issues:**
  - Tuning can be off by ~1 Hz. Example: tune to 18.076 kHz and the QMX displays 18.075,99.
- **Notes:**
  - Do **not** use Hamlib. The QMX backend fails strict protocol checks (PS/ID response length mismatch).
  - If the radio stops responding, it may be stuck in terminal mode (e.g. from PuTTY). Power cycle the radio to reset.

---

## QRPLabs QDX

- **Connection:** Serial CAT (Kenwood)
- **Baud Rate:** 38400
- **Disable DTR/RTS:** Yes (required — QDX uses DTR for PTT, asserting it will key the transmitter)
- **Notes:**
  - Do **not** use Hamlib. Same protocol issues as the QMX.

---

## Yaesu FTX-1

- **Connection:** Serial CAT (Kenwood)
- **Baud Rate:** 38400
- **Disable DTR/RTS:** Not required (leave unchecked unless you have issues)
- **Notes:**
  - Confirmed working with click-to-tune via USB serial (COM port).
  - Hamlib 4.7.0 has an FTX-1 backend, but rigctld failed to connect in testing. Use Serial CAT (Kenwood) instead.

---

## Xiegu G90

- **Connection:** Other Rig (Hamlib)
- **Baud Rate:** 19200 (G90 default; also try 9600)
- **Disable DTR/RTS:** Only if using a Digirig or similar USB interface
- **Notes:**
  - Uses Icom CI-V protocol — Serial CAT (Kenwood) will **not** work.
  - Connect via USB-C. The G90 appears as a COM port.
  - If Hamlib doesn't list the G90, try the Xiegu X5105 or Icom IC-718 backend as a fallback.

---

## Xiegu X6100 (via flrig)

- **Connection:** rigctld Network
- **Host:** `127.0.0.1` (if flrig is on the same machine) or the IP of the machine running flrig
- **Port:** `4532` (flrig's default rigctld port)
- **Notes:**
  - The X6100 uses Icom CI-V protocol — Serial CAT (Kenwood) will **not** work.
  - Use **flrig** to manage the serial connection to the radio, then connect POTACAT to flrig's rigctld server.
  - Tested on Raspberry Pi 5 with flrig controlling the X6100 over USB.
  - Make sure flrig's rigctld server is enabled: **Config → Setup → Server**.

---

## DXLab Commander

- **Connection:** DXLab Commander
- **Host:** `127.0.0.1` (Commander on the same PC) or the IP of the PC running Commander
- **Port:** `52002`
- **Notes:**
  - Commander must be running and controlling your radio. POTACAT talks to Commander, not to the radio.
  - Commander listens for TCP commands on its **Base Port + 2**. In Commander, click **Net Serv** (Configuration → General → Radio) to see the Base Port; the default 52000 gives 52002. After changing the Base Port, click Restart in that window and set the same port plus 2 in POTACAT.
  - Commander's TCP interface covers frequency, mode, split, PTT and CW text. Those all work.
  - It has no commands for noise blanker, noise reduction, auto-notch, compressor, ATU tune or radio power. To use them from POTACAT, build a command sequence for each in Commander's Command Sequences window, then enter its name (or `#3` for Commander's third sequence) under **Commander command sequences** in the rig settings. A control with an on and an off needs both. Controls without a sequence stay hidden.
  - Custom CAT buttons send Commander's own message format, for example `<command:10>CmdSetFreq<parameters:17><xcvrfreq:5>21230`.
  - **Decimal point:** only matters for a frequency with a fraction of a kHz (for example 14074.5). Set it to match the Windows number format on the computer running Commander.

---

## General Tips

- **Test Connection** button is the fastest way to verify your settings. It queries the radio's frequency and reports success or failure.
- **Verbose CAT log** (Settings → Tuning) shows raw commands and rigctld stderr — enable it when troubleshooting.
- Only one program can hold a COM port at a time. Close WSJT-X, fldigi, HRD, etc. before connecting.
- If Hamlib test fails with "connection closed" or "exited with code null", check the verbose log for rigctld's stderr output — it usually contains the real error.
- The bundled Hamlib is v4.6.5. If your rig requires a newer version, set `"rigctldPath"` in `settings.json` (in your AppData/potacat folder) to point to a newer `rigctld.exe`.
