# VARA HF and VARA FM on Linux and macOS (#287)

POTACAT offers VARA HF and VARA FM on Windows, Linux and macOS. VARA itself stays your own
copy: POTACAT never installs, downloads, bundles or licenses it.

VARA is a Windows program. On Linux and macOS it runs one of two ways:

- **Under Wine on this computer.** How to install and run VARA under Wine is your setup, not
  POTACAT's: Wine versions, prefixes and VARA's own Windows dependencies are outside what
  POTACAT controls or tests.
- **On a Windows computer or virtual machine on your network.** VARA then uses that computer's
  sound card, so the radio's audio must be connected to that computer.

Either way, POTACAT only connects to VARA's two TCP ports. It never starts VARA on Linux or
macOS, and never starts a VARA on another computer.

## What POTACAT does

- Lists VARA HF and VARA FM in the mail window when they are turned on in
  Settings > Station > Winlink > VARA (your own copy).
- Points Pat (the Winlink client inside POTACAT) at VARA's host and port. VARA's data port is
  the command port plus one, as VARA defines it.
- Keys your radio itself: Pat sends PTT through POTACAT's radio control, as for every other
  modem. VARA's own PTT must be set to **VOX**, so VARA keys nothing.
- Before a session, checks that VARA answers at its host and port, and says so in plain words
  if it does not: "VARA HF is not answering at 127.0.0.1:8300 — start VARA HF under Wine on
  this computer with its TCP port set to 8300 and its PTT set to VOX, then try again".

## Settings

In Settings > Station > Winlink > VARA (your own copy), under "Details and manual settings"
(open by default on Linux and macOS):

| Field | Default | Meaning |
|---|---|---|
| Use VARA HF / Use VARA FM | off | List the mode in the mail window. |
| Host | blank (this computer, 127.0.0.1) | Where VARA runs: a computer name or address on your network for VARA on another computer. |
| Port | 8300 (HF), 8310 (FM) | VARA's TCP command port, as set in VARA's own Settings. VARA FM ships on 8300 like VARA HF; set it to 8310 so both can run. |
| Test | | Asks VARA at that host and port for its version, using the fields as typed. |
| Bandwidth (HF) | 2300 | As on Windows. |

On Windows the same Host field lets a Windows station use a VARA on another computer; POTACAT
then never starts it.

## Audio

Two ways for VARA on this computer:

1. **Straight to the radio's sound card.** In VARA, choose the radio's USB sound card. POTACAT
   is not in the audio path. Simplest.
2. **Through a virtual audio cable,** so POTACAT carries the audio between VARA and the radio,
   levels it, and shows it on the waterfall, as it does for ARDOP. You need two cables, one
   each way:
   - macOS: BlackHole (its 2-channel version) provides virtual devices.
   - Linux: two PulseAudio or PipeWire null sinks; each has a monitor source to record from.

   In VARA choose the cables' ends; in Settings > Station > Winlink choose the other ends under
   "From VARA (the cable POTACAT listens to)" and "To VARA (the cable POTACAT plays into)".

A radio whose audio comes over the network (Flex Direct, Icom Network) has no sound card VARA
can open on this computer: use the virtual cable route, or VARA on another computer with that
radio's audio there.

## Checked, and what still needs the air

- In CI and locally: the mode list on every system, host handling, Pat's configuration, and the
  real Pat placing a call through a fake VARA at a host and port
  (`test/winlink-vara-anywhere-test.js`).
- Not yet checked on the air: VARA under Wine on Linux, VARA under Wine on macOS, and VARA on
  another computer. Each needs one operator to complete a gateway session and send the session
  log.
