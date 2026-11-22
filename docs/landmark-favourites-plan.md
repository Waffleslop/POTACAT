# Landmark favourites, and Channels / Landmarks tuning from ECHOCAT and SDRs

Status: built 2026-11-10 on feat/329-favorites-and-sdr-tune (GitHub #329). CB channels are #328.

## What Casey asked for

"In Landmarks, let the user favorite a NOAA station, or any stations here they might want to
show. Make a plan for what this functionality would look like and ensure these ideas and the CB
radio channels are 'on the wire' so ECHOCAT can tune to them - especially on SDRs."

## Today (verified in code, 2026-11-10)

- Landmarks (lib/landmarks.js, data/landmarks.json): 44 rows in five categories (time 12, beacon 5,
  weather 11, calling 14, oddity 2). NOAA WX1 to WX7 are rows in "weather". No favourites.
- The `directory` message (lib/remote-server.js) already carries `landmarks`, `landmarkCategories`,
  `ncdxf` and `channels` to ECHOCAT and ECHOCAT Web. So the CB channels from #328 reach the phone
  with no protocol change.
- A tap on the phone sends `tune {freqKhz, mode, channelId?}`. main.js `tuneRadio` runs the listen
  arbiter (`listenSdrArbitrate`, lib/listen-source.js): a frequency the radio cannot reach (NOAA
  162.550 MHz on an HF rig) goes to the SDR, and an SDR in the list that can hear it is brought up.
- **Gap:** the phone's `tune` handler (main.js, `remoteServer.on('tune'`) refuses before it gets
  there whenever no radio is connected, or the rig type is no-CAT ("Radio not connected", "No CAT
  control"). A station listening only through an SDR, or with the radio off, cannot be tuned from
  the phone at all, even though the desktop's own Directory click would reach the SDR.
- CB transmit: with a licence class set, every verified class refuses key-down at 27 MHz
  (lib/privileges.js `txPrivilegeRefusal`). With no class set nothing refuses it. Receive is never
  refused.

## The design

### 1. A favourite

- A star on every Landmarks row (desktop Directory, ECHOCAT Web, the phone). Click toggles.
- Saved as `settings.landmarkFavorites = ['noaa-wx1', 'wwv-10', ...]`: landmark ids, in the order
  starred. Per operator, like the other Directory preferences (question 1 below).
- An id the catalog no longer has is kept but not shown, so a catalog edit never loses a star.
- Rule module: `lib/landmark-favorites.js` (dual-mode, inlined into ECHOCAT Web): `toggle`,
  `normalize` (strings, unique, at most 100), `pick(catalog, ids)` (rows in favourite order),
  `isFavorite`. Test beside it.

### 2. Where favourites show

Phase 1 (one PR):
- Landmarks tab: a **Favorites** chip first in the category chips; when any exist it is the tab's
  default view. Starred rows also sort first under "All".
- ECHOCAT Web: the same, from the same module.

Phase 2 (each its own PR, if Casey wants them; question 2):
- VFO window: a **Favorites** button listing starred landmarks (and starred channels, if 4 is yes)
  for one-tap tuning.
- Band Scope / Bandspread: a small marker at each starred landmark inside the visible span.

### 3. On the wire (ECHOCAT)

All additive; older apps ignore the new fields.

| Message | Dir | Change |
|---|---|---|
| `directory` | S->C | adds `landmarkFavorites: string[]` |
| `landmark-favorite` | C->S | new: `{id, on}`. The host saves it and re-sends `directory` to every client. Refused for a Guest Pass (the owner's settings); a guest sees the owner's stars read-only. |
| `tune` | C->S | adds optional `landmarkId` (like `channelId`): the log line and the "listening via SDR" note can name the station. Older hosts ignore it. |
| `hello.capabilities` | S->C | adds `'landmark-favorites'` and `'sdr-tune-without-rig'` (section 4) so the phone gates on them. |

docs/echocat-protocol.md gets the rows, and the phone gets a DESKTOP_TO_ECHOCAT handoff with the
exact values.

### 4. Tuning from the phone when the radio is not there (the SDR gap)

The `tune` handler asks the listen arbiter first:
1. Radio connected: unchanged, `tuneRadio` (the arbiter inside it already sends out-of-range
   frequencies to the SDR).
2. No radio link, or no-CAT, but an SDR is connected or listed that covers the frequency: listen
   through the SDR (the same path `listenSdrArbitrate` takes for an out-of-range frequency) and
   tell the phone "Listening through <SDR>; the radio is not connected".
3. Nothing can hear it: today's `tune-blocked` reason, plus which SDR range would ("an rtl_tcp
   SDR covers 162.550 MHz; a KiwiSDR does not").

The pure decision goes in lib/listen-source.js (`decideWithoutRig(hz, sdr)`) with a test; main.js
stays glue. Transmit is untouched: an SDR never transmits, and PTT still needs the radio.

### 5. CB on the wire (#328, built)

The 40 channels are starter Channels, so they are in `directory.channels` already. A phone tap
sends `tune {freqKhz: '27065.000', mode: 'AM', channelId: 'cb-9'}`. An HF radio with general
coverage receives 27 MHz itself; otherwise the arbiter uses an SDR. Both kinds cover CB
(lib/listen-source.js: KiwiSDR 0 to 30 MHz; an rtl_tcp dongle is assumed 24 MHz to 1.766 GHz until
its greeting names the tuner). NOAA (162.4 to 162.55 MHz) needs the rtl_tcp kind. After section 4,
a phone with only an SDR can tune both.

### 6. Theme, tests

- The star uses POTACAT's own colour (worked #4fc3f7 for on, the dim text token for off), never
  yellow; every new control uses tokens and is checked in all nine themes.
- Tests: `test/landmark-favorites-test.js` (module, wire fields, Guest Pass refusal, ECHOCAT Web
  wiring), and `test/listen-source-test.js` additions for `decideWithoutRig`.

## Casey's answers (2026-11-10)

1. Per operator. 2. Yes: the VFO window and markers on the band scope. 3. Stars only (the recommendation). 4. Yes, Channels get stars too. 5. Yes, the SDR tune first.

Built as answered; also found and fixed: every directory push after the first left ECHOCAT with an empty Channels list (pushDirectoryToRenderer did not carry the chart).

## Questions that were put to Casey

1. Favourites per operator (like Directory preferences today) or one set per computer?
2. Phase 2: do you want the VFO **Favorites** button and the scope markers, or the Landmarks tab
   only?
3. "Any stations here they might want to show": stars on the existing Landmarks only, or may the
   operator add a landmark of their own (name, frequency, mode, hours)? Channels already holds
   their own frequencies, so my suggestion is stars only.
4. Should Channels get the same star (for example CB 9 or a local repeater), shown with starred
   landmarks in one Favorites list?
5. Build section 4 (tune from the phone through the SDR with no radio) first, on its own? It is
   the part that makes "especially on SDRs" true for every Landmark and Channel, starred or not.

## Size of the work

- Section 4: one small PR (arbiter rule, tune handler, test, protocol line).
- Favourites phase 1: one PR (module, Landmarks tab, ECHOCAT Web, wire, test, theme pass) plus
  the ECHOCAT handoff.
- Phase 2: one PR per surface.
