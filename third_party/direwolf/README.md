# Dire Wolf (AX.25 packet TNC) — bundled as a separate executable

[Dire Wolf](https://github.com/wb2osz/direwolf) by John Langner (WB2OSZ) is
the software TNC POTACAT uses for Winlink packet (AX.25) on VHF/UHF. POTACAT
launches it only for a packet session and Pat talks to it over its loopback
AGWPE port — never linked (the wsprd posture).

- License: GNU GPL v2 (`LICENSE`, copied from the pinned tag)
- Pinned: see `VERSION.txt`
- Built by `scripts/build-winlink-helpers.sh` **with Hamlib** (the build fails
  otherwise): Windows links the official hamlib-w64-4.7.0 zip (checksum-pinned),
  Linux links `libhamlib-dev` and ships the `.so` beside it (RPATH `$ORIGIN`).
  Staged to `assets/direwolf/`, packaged to `resources/direwolf/`.
- **Its only PTT is `PTT RIG 2 127.0.0.1:<shim>`** — Hamlib's NET rig client
  pointed at POTACAT's loopback rigctld shim, so POTACAT keys the radio
  (`lib/direwolf-process.js`). No beacons, digipeating, IGate or KISS port.
- Windows and Linux for now (its sound devices come from ardopcf's listing).
