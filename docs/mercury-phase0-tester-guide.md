# Mercury phase 0: one Winlink session over Mercury (tester guide)

Written 2026-11-22 for Mercury 1.9.25 and POTACAT 1.14.7 on Windows. Part of
`docs/mercury-winlink-modem-plan.md`, phase 0.

Mercury is experimental. It is a young open-source HF modem by Rhizomatica
(https://github.com/Rhizomatica/mercury). POTACAT does not ship it yet. This
test is to find out whether one Winlink session to a Mercury gateway works
from a station like yours, before anything is built into POTACAT.

What you do: install Mercury yourself, start it in a window, and tell POTACAT
to use it in place of VARA HF. POTACAT keeps the radio as usual: it tunes,
sets the mode and keys the transmitter. Mercury only makes and hears the
sound.

It takes about an hour the first time. You need:

- Windows, POTACAT 1.14.7 (or the test build you were sent), and a radio with
  a USB sound card that POTACAT already controls (CAT), for example an
  IC-7300, FT-710, FT-991A or TS-590.
- A Winlink account that already works in POTACAT. If you have never sent
  Winlink mail from POTACAT, do one Send / Receive with Send via set to
  "Internet (telnet)" first.
- A Mercury gateway you can reach on HF (step 4).

## 1. Get Mercury 1.9.25

1. Open https://github.com/Rhizomatica/mercury/releases/tag/v1.9.25.
2. Under Assets, download `mercury-1.9.25-w64-33efac4e.zip`. Use this zip,
   not the Setup program: the zip holds `mercury.exe`, the command-line modem
   this guide uses.
3. Unzip it to a folder of its own, for example `C:\Mercury-1.9.25`.

Use exactly 1.9.25. Mercury's release notes say: "1.9.25 does not connect to
1.9.24 or any older version, in either direction." A gateway on another
version will not answer you.

## 2. Find your radio's sound card in Mercury

1. Open the Mercury folder in File Explorer. Click the address bar, type
   `cmd` and press Enter. A black Command Prompt window opens in that folder.
2. Type this and press Enter:

   ```
   mercury.exe -V
   ```

   It prints Mercury's version. Keep that line for your report.
3. Type this and press Enter:

   ```
   mercury.exe -x wasapi -z
   ```

   `-z` lists the sound cards. Find your radio's USB sound card twice: once
   as a capture (input) device and once as a playback (output) device. On
   Icom radios it is usually called "USB Audio CODEC". Copy each id exactly as
   Mercury prints it.

## 3. Start Mercury: its own sound card, radio control off

In the same window, type this on one line, with your two ids in the quotes,
and press Enter:

```
mercury.exe -x wasapi -i "CAPTURE-ID" -o "PLAYBACK-ID" -P none -v -L mercury-log.txt
```

What each part does (from Mercury's own `mercury -h` list):

| Part | Meaning |
|---|---|
| `-x wasapi` | Windows audio, the backend that finds a USB sound card again by name if its id changes |
| `-i "..."` | The radio's receive audio (capture device) |
| `-o "..."` | The radio's transmit audio (playback device) |
| `-P none` | PTT method none: "Mercury then leaves radio keying to the TCP client". POTACAT keys the radio. |
| `-v` | More detail in the window, which helps us read what happened |
| `-L mercury-log.txt` | Also writes a log file in the Mercury folder |

Do not add `-R`, `-A`, `-S` or a `-P` other than `none`: those make Mercury
key the radio itself, and POTACAT must be the only thing that keys it.

Mercury now listens for a Winlink program on port 8300 (control) and 8301
(data), its defaults, the same ports VARA HF uses. Leave the window open for
the whole test.

The first time, Windows Firewall may ask whether Mercury may use the
network. Choose Cancel. POTACAT reaches Mercury on this computer either way,
and Mercury's ports have no password, so nothing else should reach them.

On the radio: turn VOX and DATA VOX off, so only POTACAT keys it. Set the
power you would use for VARA. Mercury 1.9.25 drives about 4 dB harder than
earlier versions; if the ALC meter sits at the top on every transmission,
lower the radio's USB modulation level.

## 4. Find a Mercury gateway

Winlink has no Mercury mode yet. A gateway that runs Mercury is listed as a
**VARA** channel with the service code **MERCURY**.

1. Open https://winlink.org/RMSChannels.
2. Select **VARA** and enter the service code **MERCURY**.
3. Pick a gateway on a band your radio covers and where the path is open now.
   Write down its call (with the -number) and the frequency the map shows.

The map shows the channel's centre frequency. Your radio's dial goes 1.5 kHz
below it, in USB: a channel listed at 7102.8 kHz is dialled at 7101.3 kHz.
POTACAT does this sum for you when the gateway comes from its own list.

Gateways that run Mercury must also be on 1.9.25. Which versions connect to
which: https://github.com/Rhizomatica/mercury/discussions/637.

## 5. Tell POTACAT to use Mercury in place of VARA HF

In POTACAT: **Settings**, the **Station** tab, the section **Winlink (email
over radio)**, then **VARA (your own copy)**. Open **Details and manual
settings** and set:

| Setting | Set it to |
|---|---|
| **Use VARA HF** | ticked |
| **Program** | blank |
| **Host** | blank (this computer) |
| **Port** | 8300 |
| **Bandwidth** | 2300 |
| **Start VARA for me when a session needs it** | unticked |

Do not press **Set up VARA HF for me** or **Find / test**: those are for the
real VARA program.

Also on the Station tab, in **Mercury (HF data)**, leave **Enable Mercury HF
data modem** unticked. That is POTACAT's separate Mercury chat feature; with
it on, POTACAT reports a port clash with VARA HF on 8300.

Press Save.

## 6. Pick the gateway in Winlink Mail

Open **More**, then **Winlink Mail**. Set **Send via** to **VARA HF (radio,
your own VARA)**.

**With a POTACAT test build that lists Mercury gateways:** Mercury gateways
appear in the **Gateway** list with **MERCURY** after the call. Pick the one
you chose in step 4. POTACAT sets the dial for you.

**With POTACAT 1.14.7:** the Gateway list does not show Mercury gateways,
because POTACAT asks Winlink for PUBLIC gateways only. Add the gateway as a
favourite by hand:

1. With the Winlink Mail window in front, press F12. A developer panel opens.
   Click its **Console** tab.
2. If the console says pasting is blocked, type `allow pasting` and press
   Enter.
3. Paste this line, with your gateway's call and its dial frequency in kHz
   (the map's frequency minus 1.5), and press Enter:

   ```
   window.api.favourite('add', { call: 'GATEWAY-10', mode: 'vara', dialKhz: 7101.3 })
   ```

4. Close the developer panel and press the refresh button beside the
   Gateway list (its tooltip says "Fetch the gateway list again"). The
   gateway appears under **Favorites** (or **Favorites not in this list**).
   Pick it.

## 7. Send and receive

1. Write a short message to your own callsign, for example subject "Mercury
   test", so you have one mail to send.
2. Check that the Mercury window is still open.
3. Press **Send / Receive**. POTACAT tunes the radio to the gateway in USB
   data mode and hands the call to Mercury. Mercury calls the gateway; its
   window shows the call and, if the gateway answers, the connection.
4. If nothing answers after the call gives up, try again once or twice: a
   gateway that scans several frequencies can miss a Mercury call. Then try
   another gateway.
5. When the session ends, do one more **Send / Receive** a few minutes later
   to bring your test message back into the Inbox.

## 8. What counts as success

- **Success:** the session connects, your test message leaves the Outbox,
  and it comes back into your Inbox on the same or the next Mercury session.
  That is one mail sent and received over the air through Mercury.
- **Partly:** Mercury connects to the gateway but the mail exchange does not
  finish. Still worth a report.
- **No answer:** the gateway never answers. Report it with the gateway's call
  and frequency: it tells us whether gateways answer at all.

Press **Abort** in Winlink Mail at any time to stop the session and release
the radio. When you are done, close the Mercury window (or press Ctrl+C in it),
untick **Use VARA HF** if you do not use VARA, and Save.

## 9. What to send back

Send these to the POTACAT tester who contacted you (Discord #bug-report is
fine):

1. **The bug report paste.** Right after the session, in POTACAT: Settings,
   then **Report a Bug** at the bottom of the left-hand list. Paste what it
   gives you. It holds POTACAT's Winlink session log.
2. **Mercury's console output.** Click in the Mercury window, select all its
   text (Ctrl+A, or Ctrl+Shift+A in Windows Terminal), copy it (Ctrl+C) and
   paste it into Notepad. Send that, and `mercury-log.txt` from the Mercury
   folder.
3. **The gateway call and frequency** you called, the time (UTC), and your
   radio model.
4. **Mercury's version line** from `mercury.exe -V`.
5. One sentence on what happened: connected or not, mail sent or not, mail
   received or not.

Thank you. One honest result, good or bad, decides whether POTACAT builds
Mercury in.

## Sources

- Mercury 1.9.25 release and assets: https://github.com/Rhizomatica/mercury/releases/tag/v1.9.25
  (tag commit 33efac4e3089f64f493fde1232b8e96305d15185).
- Command-line options, PTT and sound card notes, Windows install, network
  access: Mercury README at that tag.
- Winlink gateways with Mercury, service code MERCURY, finding gateways:
  Mercury docs/WINLINK.md.
- TNC ports 8300/8301, one client at a time, VERSION reply for Pat: Mercury
  docs/TNC.md.
- POTACAT 1.14.7: `renderer/index.html` (labels), `lib/winlink-modes.js` (the
  VARA HF mode and the Mercury port clash), `lib/winlink-pat.js` (Pat's
  `service_codes` and the VARA HF address), `lib/vara-process.js` and main.js
  `winlinkVaraReady` (with Mercury already answering on 8300, POTACAT starts
  no program), `lib/winlink-favourites.js` and `preload-winlink-popout.js`
  (the favourite call in step 6).
