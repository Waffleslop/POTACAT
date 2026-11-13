# Desktop to ECHOCAT handoff, 2026-11-13: SSTV send status and frequency

From: POTACAT desktop, GitHub #357 (branch fix/357-sstv-echocat-send).
For: the ECHOCAT app (iOS and Android). No desktop change is needed for this to work;
the desktop side ships in the next desktop release after the PR is merged.

## What happened

An operator sent an SSTV picture from the app while the shack radio was still on an
old Winlink gateway frequency (14.105 MHz). The picture keyed on 14.105, the licence
check refused it, the app showed only a privilege error from the `tune-blocked`
message, and then POTACAT on the shack computer crashed. The desktop now:

1. tunes the radio to the SSTV frequency before the picture keys;
2. never crashes or shows a dialog box for a picture from the app;
3. tells the app why a picture was not sent, in `sstv-tx-status`.

## Capability

The server hello lists `sstv-send-tune` in `capabilities` when the desktop does all of
the below. Gate the two app changes on it.

## 1. Send the chosen frequency with the picture

Add `freqKhz` to `sstv-photo`: the SSTV frequency selected on the app's SSTV screen,
as a number in kHz (for example `14230`, not `"14230"`).

```json
{ "type": "sstv-photo", "image": "data:image/jpeg;base64,...", "mode": "martin1", "freqKhz": 14230 }
```

What the desktop does with it (lib/sstv-send.js `sendChannel`):

- Radio within 10 kHz of `freqKhz`: the radio is left where it is (14.233 or 14.240 when
  14.230 is busy are fine).
- Otherwise: the radio is tuned to `freqKhz` (USB, or LSB below 10 MHz except 60 m),
  and then the picture is sent.
- `freqKhz` on a band the radio is not set up for: not tuned; the picture is then
  usually refused with an `error` (below).
- Split on, or a Guest Pass picture: never tuned.
- No `freqKhz` (an older app): the desktop tunes to the SSTV channel of the band the
  radio is on (14.230 on 20 m, 7.171 LSB on 40 m, and so on), unless the radio is
  within 10 kHz of an SSTV channel already.

Send it on every picture. The app no longer needs to send a `tune` before `sstv-photo`;
the desktop keeps the order (tune first, then key).

## 2. Show why a picture was not sent

`sstv-tx-status` can now carry `error`, a one-line plain reason, with `state: 'rx'` or
`state: 'auto-rx'`:

```json
{ "type": "sstv-tx-status", "state": "rx", "error": "Picture not sent: 14.105 MHz phone is outside US Extra privileges. Not transmitted. Tune inside your privileges, or check Settings > Station > License Class." }
```

Other texts the app will see, for testing the layout (long ones wrap):

- `Picture not sent: SSTV could not start on this computer.`
- `Picture not sent: the picture could not be read.`
- `Picture not sent: the SSTV window closed before the audio started.`
- `Picture not sent: transmit was refused (see the log).`
- A Guest Pass refusal, as before (`sstv-guest-check`).

What the app should show:

- On the SSTV screen's status line, where it says "Ready" or "Transmitting...": the
  `error` text, in the screen's warning colour, in place of "Ready". Wrap it; do not
  truncate it. Same size as the status text today.
- Keep it until the user sends again, or the next `sstv-tx-status` arrives without
  `error`, then go back to "Ready" as now.
- Stop any "Sending..." / "Encoding..." spinner and the TX progress bar, and enable
  SEND again, exactly as for a plain `rx`.
- Not an alert or modal. The point of #357 is that nothing blocks the operator who is
  away from the shack.
- No emoji, no icon that stands in for words.

ECHOCAT Web (renderer/remote.js in the desktop repo) does both already; it can be used
as the reference: the status line shows `msg.error` in the accent colour, and SEND
carries `freqKhz` from the SSTV frequency select.

## Wire reference

docs/echocat-protocol.md, SSTV section: `sstv-photo` and `sstv-tx-status` rows.
lib/echocat-protocol.js: `sstv-photo` (`freqKhz: optNumber`), `sstv-tx-status`
(`state`, `durationSec`, `freqKhz`, `error`).

## Tests the app side should have

- `sstv-photo` includes `freqKhz` as a number when the server lists `sstv-send-tune`,
  and leaves it out otherwise.
- `sstv-tx-status {state:'rx', error}` puts the text on the status line and re-enables
  SEND; a following `{state:'rx'}` puts "Ready" back.
- `{state:'auto-rx', error}` shows the error, not the Auto-SSTV banner text, until the
  next status.
