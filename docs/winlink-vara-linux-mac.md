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
| Host | blank (this computer, 127.0.0.1) | Where VARA runs: a computer name or address on your network for VARA on another computer. Only the name or address: a port typed here is refused, it goes in Port. |
| Port | 8300 (HF), 8310 (FM) | VARA's TCP command port, as set in VARA's own Settings. VARA FM ships on 8300 like VARA HF; set it to 8310 so both can run. |
| Test | | Asks VARA at that host and port for its version, using the fields as typed. It says "VARA HF answered at 127.0.0.1:8300 (VARA HF v4.8.7)." or what to check. |
| Bandwidth (HF) | 2300 | As on Windows. |

On Windows the same Host field lets a Windows station use a VARA on another computer; POTACAT
then never starts it, and "Set up VARA for me" says to set it up on that computer.

Ports: VARA also listens one port above its command port (its data port). VARA HF and VARA FM
on the same computer therefore cannot use the same port or ports next to each other; the mail
window greys VARA FM and says so. On different computers any ports will do.

POTACAT connects only to the host and port in these fields (and that port plus one, through
Pat). Nothing else is contacted for VARA.

## Audio

Two ways for VARA on this computer:

1. **Straight to the radio's sound card.** In VARA, choose the radio's USB sound card. POTACAT
   is not in the audio path. Simplest, and the one to try first.
2. **Through two virtual audio devices,** one each way, so POTACAT carries the audio between
   VARA and the radio, as it does on Windows with virtual audio cables. In VARA choose the
   devices' ends; in Settings > Station > Winlink choose the other ends under "From VARA (the
   cable POTACAT listens to)" and "To VARA (the cable POTACAT plays into)".

   This second way has not been tried on Linux or macOS. Candidates are BlackHole on macOS and
   PulseAudio or PipeWire virtual devices on Linux. Two things are unknown: whether Wine shows
   those devices to VARA, and whether POTACAT's device lists show the end it must record from
   (a null sink's monitor source may not be listed).

A radio whose audio comes over the network (Flex Direct, Icom Network) has no sound card VARA
can open on this computer: use the virtual cable route, or VARA on another computer with that
radio's audio there.

## Checked, and what still needs the air

- In CI and locally: the mode list on every system, host handling, Pat's configuration, and the
  real Pat placing a call through a fake VARA at a host and port
  (`test/winlink-vara-anywhere-test.js`).
- Not yet checked on the air: VARA under Wine on Linux, VARA under Wine on macOS, and VARA on
  another computer. Each needs one operator to complete a gateway session and send the session
  log. No VARA session has completed in our hands on any system, Windows included; the tests
  use a stand-in for VARA.
- Not tried at all: the virtual audio device route on Linux and macOS (above).
