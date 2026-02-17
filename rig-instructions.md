# Rig Setup Instructions

Tested radio configurations for POTA CAT. If your rig isn't listed, try **Serial CAT (Kenwood)** first — many radios support FA/MD commands — then fall back to **Hamlib**.

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

## General Tips

- **Test Connection** button is the fastest way to verify your settings. It queries the radio's frequency and reports success or failure.
- **Verbose CAT log** (Settings → Tuning) shows raw commands and rigctld stderr — enable it when troubleshooting.
- Only one program can hold a COM port at a time. Close WSJT-X, fldigi, HRD, etc. before connecting.
- If Hamlib test fails with "connection closed" or "exited with code null", check the verbose log for rigctld's stderr output — it usually contains the real error.
- The bundled Hamlib is v4.6.5. If your rig requires a newer version, set `"rigctldPath"` in `settings.json` (in your AppData/pota-cat folder) to point to a newer `rigctld.exe`.
