# Add your own Winlink gateways (plan)

Status: plan, 2026-11-22. Casey: "please plan for this." Pieces 2.1 (list refresh on Refresh and daily) and 2.2 (Other service codes) built 2026-11-22 (feat/938); 2.3 (Add a gateway) held by Casey. The codes stay out of session.log (only their count is logged) until Casey answers whether they belong in logs and bug reports.

The ask, from an operator: "Also would there be a way to add custom winlink gateways for digital
section. There is a few on Long Island to my clubs winlink gateways that aren't populating that
would be helpful."

This plan does two things. First it works out, from the code and from Pat and Winlink, why a club's
local gateways can be missing from the mail window's Gateway list. Then it proposes the smallest
change that lets the operator call any gateway they know about, and that brings back the ones the
list should already show.

## 1. Why a club's gateways do not show

POTACAT's list comes from Pat (`GET /api/rmslist`, `lib/winlink-client.js rmslist`), Pat's list
comes from the Winlink CMS (`POST https://api.winlink.org/gateway/status.json`), and POTACAT then
filters it. A gateway can drop out at each of those steps. Each reason below is followed by its
evidence. They are ranked by how likely each one is for this report.

### 1.1 The mode picked does not list them (likely)

Pat filters the list by mode (`api/api.go rmslistHandler` calls `RMS.IsMode`, `app/rmslist.go`):
- `ardop` keeps only channels whose modes contain "ardop".
- `packet` keeps only "Packet" channels.
- `varahf` keeps "VARA" channels that are not "VARA FM".
- `varafm` keeps only channels whose modes start with "VARA FM".

POTACAT asks for one mode at a time (`main.js winlinkGateways`). The VARA FM mode appears in the
picker only when the operator has turned on "VARA FM (your own)" in Settings > Station > Winlink
(`lib/winlink-modes.js winlinkModesFor`, `o.varaFm.enabled`).

Evidence: Pat's built-in copy of the Winlink list (`internal/cmsapi/gateway_status.json.gz`,
snapshot of late October 2026) has 11 PUBLIC channels in grid FN30 (Long Island and New York City):
- 7 are VARA FM,
- 2 are VARA HF,
- 2 are 1200-baud packet,
- 0 are ARDOP.

An operator using the modes POTACAT ships (ARDOP, packet) sees 2 of the 11. An operator in ARDOP mode
sees none. Across the whole list, VARA FM is 1118 channels against 1383 packet and 446 ARDOP.

### 1.2 POTACAT never refreshes Pat's copy of the list (likely)

Pat keeps the list in one cache file (`rmslist.json` in its data directory, or `rmslist-<codes>.json`
when the service codes are not just PUBLIC). Pat downloads the list only when that file is missing or
when the request says `force-download=true`. There is no age check
(`internal/cmsapi/api.go GetGatewayStatusCached`: `if !forceDownload { os.Open(cacheFile) ... return file }`).

POTACAT sends `force-download` only when the cache cannot be parsed (`main.js winlinkRmslistSafe`).
The mail window's Refresh button (`renderer/winlink-popout.js loadGateways`) asks Pat again but
never forces a download. Nothing in `main.js` or `lib/winlink-*.js` ages the cache out. So an
operator's list is the one Pat downloaded the first time it ran: a gateway that came on the air, moved
or changed frequency after that never appears. And if that first download failed, Pat writes its
built-in snapshot to the cache, and that snapshot stays in use.

### 1.3 The club uses its own service code (possible, and the operator cannot fix it today)

Each Winlink channel has a service code. Winlink describes them on its channel page
(https://winlink.org/RMSChannels, as indexed by search; the page refuses automated fetches):
- PUBLIC: maritime and open amateur use, including emergency gateways open to the public.
- EMCOMM: emergency gateways that are not open to the public.
- Any other code: a group that wants its gateway details kept private. "If your group uses a special
  service code, please contact your group to obtain it. The Winlink Team does not distribute that
  information."

POTACAT always writes `service_codes: ['PUBLIC']` into Pat's config (`lib/winlink-pat.js
buildPatConfig`) and rewrites that config at every start. PR #929, open, adds `MERCURY`.
- Pat passes each code as a `ServiceCodes` parameter to the CMS (`internal/cmsapi/api.go
  GetGatewayStatus`: `params.Add("ServiceCodes", str)`, defaulting to PUBLIC).
- Pat's config documents the field as "List of service codes for rmslist (defaults to PUBLIC)"
  (`cfg/config.go`).
- `pat rmslist` on the command line has no service-code flag (`cli/rmslist.go`: only `--mode`,
  `--band`, `--force-download`, `--sort-distance`, `--sort-link-quality`), so the config is the only
  way to ask for other codes.

Pat's built-in snapshot holds PUBLIC channels only (4807 of 4807). An EMCOMM or club-coded gateway
is never in an operator's list today, and Settings has nowhere to type a code.

Since #924 (merged), each row carries its code (our Pat patch, la5nta/pat#564), and a code other than
PUBLIC shows after the call. That tag starts to matter once a second code is asked for.

### 1.4 The gateway has not reported in the last 48 hours (possible)

Pat asks the CMS for `HistoryHours=48` (`GetGatewayStatusCached` calls
`GetGatewayStatus(ctx, "", 48, ...)`), so only gateways that sent a status report within 48 hours
come back. In the built-in snapshot, the oldest `HoursSinceStatus` is 42. A club gateway that is
switched on only for nets or drills, or one whose RMS software is not reporting, drops out of the
list even with the right service code.

### 1.5 The radio cannot call them (possible, and stated in the list)

POTACAT drops any row the radio cannot call (`lib/winlink-reach.js gatewaysInReach`, used in
`main.js winlinkGateways`):
- not in an amateur band,
- on a band not ticked for the rig (Settings > Radio, Edit the rig, Check all bands),
- outside the rig's range.

An HF-only rig, or a rig whose 2 m and 70 cm are unticked, gets no VHF or UHF gateway. The list's
last line counts these ("N more this radio cannot call"), so the operator can tell. This is
correct for listed gateways, but see 3.2 for typed ones.

### 1.6 The list is cut short (unlikely for local VHF, possible on HF)

There are three caps:
- `lib/winlink-state.js setGateways` keeps 200 rows.
- The mail window draws 120 (`buildGatewayOptions`).
- ECHOCAT Web draws 80 (`renderer/remote.js mailRenderGateways`).

On VHF and UHF the list is nearest first (VOACAP does not rank above 30 MHz), so local gateways are at
the top. On HF with prediction on and the band set to All, Pat ranks by link quality. A nearby NVIS
gateway can rank low at some hours and fall below the cap.

### 1.7 Not a gateway in the CMS list at all (possible, out of reach of any list)

These never appear in the CMS gateway list:
- peer-to-peer stations,
- a club station running Winlink Express as a P2P or Radio-Only hub,
- a gateway that is registered but not set up to report its channels.

A typed entry can still dial such a station (Pat connects by call and frequency). What happens after
the connect then depends on that station. See open question 7.

### 1.8 Ruled out: distance

Neither Pat nor POTACAT has a distance limit. Pat computes distance and bearing only to sort
(`app/rmslist.go`; no filter uses them). POTACAT's caps (1.6) are counts, not distances.

## 2. The design: the smallest thing that just works

Three pieces, in order of payoff. Pieces 1 and 2 fix most cases without the operator typing
anything; piece 3 covers the rest.

### 2.1 Keep the list fresh (no new UI)

- The Refresh button asks Pat with `force-download=true`.
- When the list was last downloaded more than 24 hours ago, the next list request forces a download.
  POTACAT records the time per profile: `winlinkListFetchedAt`, ms, set when a forced request
  succeeds. The first request after this ships counts as stale.
- Requests stay one at a time through `winlinkRmslistSafe`, which already keeps them from
  overlapping. A forced download failing falls back to the cache Pat has (a second, unforced request)
  and says so in the [Winlink] log.

### 2.2 Service codes (one field in Settings)

- Settings > Station > Winlink gets "Other service codes", one text field: codes separated by spaces
  or commas. The hint reads: "Ask your club or group. PUBLIC gateways are always listed."
- Pat's `service_codes` becomes `['PUBLIC', ...mercury (per #929), ...theOperator's]`, upper-cased,
  each matching `/^[A-Z0-9_-]{1,20}$/`, duplicates removed. PUBLIC is always first and cannot be
  removed.
- Pat names its cache after the codes (`rmslist-PUBLIC-EMCOMM.json`), so a change downloads a fresh
  list by itself. `main.js` regenerates Pat's config on save (the existing `winlinkChanged` path),
  then asks Pat to reload.
- Rows with a code other than PUBLIC already show it after the call (#924). Nothing else changes in
  the list.
- If PR #929 changes to "MERCURY only when Mercury is chosen" before this lands, the operator's codes
  are added the same way, beside it.

### 2.3 Add a gateway (the mail window's gateway picker)

My gateways (`lib/winlink-favourites.js`, setting `winlinkFavourites`) already does most of this:
- each entry is saved per profile,
- it rides `winlink-state.favourites` to the mail window, ECHOCAT Web and the phone,
- a saved gateway that Pat did not list is still shown under "Favorites not in this list" and is
  callable,
- Connect, QSY and the return to the dial already handle it.

What is missing is a way to add one that is not in the list. The Mercury tester guide works around
this today by having the tester call `window.api.favourite('add', ...)` from DevTools.

So a typed gateway is a My gateways entry marked as the operator's own. No new store, no new
state field.

**The control.** An "Add a gateway" link sits under the Gateway list (beside Refresh). It opens a
small form in place:

| Field | Shown | Notes |
|---|---|---|
| Call | always | Gateway call with SSID, e.g. `W2XYZ-10`. Upper-cased as typed. |
| Mode | always | The radio modes this station has available (`state.modes`, same labels). Defaults to the mode picked in the window. |
| Frequency | always | What Winlink and club pages print. HF modes: the centre frequency. Packet and VARA FM: the channel. kHz or MHz both accepted (`7101.4`, `7.1014`, `145.05`, `145050`). Below the field, one line shows the dial POTACAT will set. |
| Via | Packet only | Optional digipeaters, up to two, e.g. `W2ABC-1`. |
| Note | always | Optional, up to 60 characters, e.g. "club net Tuesdays". |

- Save adds it to the top of the list, picked, and tunes there (the same `useGateway` path a
  favourite uses).
- In the list it reads `★ W2XYZ-10  Mine  145.050.00 MHz  club net Tuesdays`. The "Mine" tag goes
  where the service-code tag goes.
- A Mine entry that Pat also lists (same call, mode and dial) shows once, in Pat's place, with the
  tag.
- Mine entries sit in their own group, "My own gateways", above the ranked list. No cap in 1.6
  drops them.
- Picking a Mine entry turns the star button into Edit and Remove (two small text buttons; Remove
  asks once).
- Edit reopens the form filled in. Saving it replaces the old entry (`op: 'edit'`, below).

**Copy.** All copy is plain words with no emoji. Errors sit under the field they belong to:
- "That is not a callsign. Use the gateway's call, with -10 or similar if it has one."
- "Enter the frequency, for example 145.05 or 7101.4."
- "This radio cannot transmit on 1296.10.00 MHz." (only when the rig's own range says so; see 3.2)

**Why not Pat's `connect_aliases`.** Pat can hold named aliases (`cfg/config.go`, example
`"LA1B-10": "ax25:///LD5GU/LA1B-10"`). But POTACAT rewrites Pat's config on every start and already
builds every connect URL itself (`lib/winlink-pat.js connectUrl` / `sessionUrl`). Keeping typed
gateways in POTACAT's own settings means one list, the same QSY and the same reach rule as everything
else.

## 3. Details

### 3.1 The stored entry

`winlinkFavourites` entries gain three optional fields. Entries saved before this change are
unaffected.

```
{ call, mode, khz, dialKhz, band, url, savedAt, lastGoodAt,   // as now
  mine: true,          // typed by the operator; shows the Mine tag, editable
  note: 'club net',    // up to 60 printable characters, trimmed
  via: ['W2ABC-1'] }   // packet only, 0 to 2 calls
```

- The key stays `call|mode|khz`, where `khz` is the dial.
- The cap (`MAX = 40`) applies to starred entries only. Mine entries have their own cap of 40, so a
  run of starred sessions never pushes out a typed gateway.
- `normalize` keeps `mine`, `note` and `via` only when they are valid. Otherwise it drops them
  silently and keeps the entry.
- New op `edit` `{ was: {call, mode, dialKhz}, ...entry }`: remove `was`, add the new entry, in one
  save.
- `add` from the star on a listed row never sets `mine`. Starring a Mine entry is a no-op: it is
  already saved.
- Per profile, like today. Not synced to POTACAT Cloud: favourites are not synced now, and this does
  not change that (open question 5).
- No secrets. `settings-secrets.js` gains nothing. A private service code (2.2) is not a credential;
  see open question 4 about keeping it out of support logs.

### 3.2 Validation

- **Call.** `lib/winlink-pat.js _isGatewayCall`: `/^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}(-\d{1,2})?$/i`,
  plus SSID 0 to 15. The same check runs on each Via call. Tactical calls are refused by this rule;
  see open question 6.
- **Frequency.** A number, more than 0, up to 1.5 GHz (the favourites rule). A value below 1000 is
  read as MHz, otherwise as kHz. One parser in `lib/winlink-favourites.js` serves the form, ECHOCAT
  Web and the phone's validation text.
- **Dial.** Computed with Pat's own rule (`app/freq.go Frequency.Dial`):
  - ARDOP, VARA HF and Mercury (VARA's protocol): dial = centre − 1.5 kHz.
  - Packet and VARA FM: dial = channel.

  The form shows the dial before Save. The stored `khz` is the dial, as for every favourite.
- **Band.** No refusal by band. Casey's standing rule (2026-11-12): "Users are allowed to transmit
  outside of the bands without us stopping them. That's not for us to limit." A typed gateway
  therefore skips `gatewayReach`'s two band checks (not in an amateur band; band not ticked for the
  rig). It keeps the range check: a radio that physically cannot transmit there says so, and the
  entry is saved anyway, so a later rig can use it.

  Today's `gatewayReach` refuses outside the amateur bands for listed gateways too (written
  2026-11-11, the day before the rule). That conflict is open question 1. This plan changes only the
  typed path.
- **Mode.** Must be one of the station's available radio modes. Telnet has no gateway to add.

### 3.3 From an entry to Pat's connect URL

`connectUrl` and `sessionUrl` stay the one place URLs are built. The only change is digipeaters for
packet.

| Mode | URL Pat dials | Notes |
|---|---|---|
| ARDOP | `ardop:///W2XYZ?bw=500MAX&freq=7099.9` | `bw` from the operator's ARDOP bandwidth (#663 cap); no row URL to inherit from. Digipeaters refused by Pat for ardop (`wl2k-go transport/url.go`: `digisUnsupported`). |
| VARA HF | `varahf:///W2XYZ?bw=2300&freq=7099.9` | `bw` from `settings.winlinkVaraBw`. |
| Mercury | `varahf:///W2XYZ?freq=...` | Rides Pat's varahf transport pointed at Mercury's port, as now. Only when Mercury is offered. |
| VARA FM | `varafm:///W2XYZ-10?freq=145050` | No bandwidth; narrow or wide is VARA FM's own setting. |
| Packet | `ax25:///W2ABC-1/W2XYZ-10?freq=145050` | Via calls go before the target. wl2k-go parses `scheme:///digi1/.../target` (`transport/url.go ParseURL`), and Pat's AGWPE port dials `url.Target` via `url.Digis` (`transport/ax25/agwpe/port.go DialContext`), which is what Dire Wolf gets. |

Code changes:
- `connectUrl` gains `via` (array). It is used only when the scheme is `ax25`. Each call passes
  `_isGatewayCall`, and there are at most 2.
- `lib/winlink-favourites.js clean`: the stored-URL regex accepts the extra path segments for `ax25`,
  so a saved packet entry keeps its path.
- `sessionUrl`'s same-gateway test compares the target call, the last path segment.

### 3.4 QSY and putting the dial back

Nothing new. A Mine entry goes through the same calls as any favourite:
- picking it calls `winlinkPreviewQsy`, which remembers the dial before the first pick,
- Connect goes through `winlinkStartSession`, which QSYs again in data mode, or FM for packet and
  VARA FM per `lib/packet-rig-mode.js`,
- the dial and mode go back when the mail window closes or the session ends.

No-CAT stations get the existing note ("set the radio to the gateway frequency yourself").

The only change in those paths is the reach call. `winlinkPreviewQsy` and `winlinkStartSession`
learn that a typed entry skips the band checks (3.2). This needs a flag the window cannot forge for a
listed gateway. Main looks the gateway up in `settings.winlinkFavourites` by key and applies the
typed rule only when it finds `mine: true`.

### 3.5 Remote shack (a desktop driving another shack)

The shack holds the list and the session (`lib/winlink-remote-shack.js`). The window's favourite
invoke already maps to the wire message `winlink-favourite`.
- The INVOKES row for `winlink-cmd-favourite` passes the new fields `note`, `via`, `mine`, plus
  `was` for `edit`.
- The shack validates them with the same `lib/winlink-favourites.js` code.
- An older shack ignores the unknown fields and saves a plain favourite. It works, without the tag
  or the path. The window says "The shack is on an older POTACAT: the note and the Mine tag are not
  saved there" when the shack's hello lacks the capability `winlink-mine`.
- Service codes are the shack's Settings. The remote window does not change them.

### 3.6 ECHOCAT Web (`renderer/remote.js`)

Today the web Mail tab's gateway list (`mailRenderGateways`) shows Pat's rows only, with no
favourites at all. Changes:
- Draw My gateways for the current mode first, Mine entries tagged, from `mailState.favourites`. The
  data is already sent.
- An "Add a gateway" button opens the same five fields. It sends `winlink-favourite`
  `{op: 'add', call, mode, dialKhz, via?, note?, mine: true}`.
- Edit and Remove on a Mine row send `{op: 'edit', was, ...}` and `{op: 'remove', ...}`.
- The frequency parser and the dial line come from `lib/winlink-favourites.js`, made dual-mode
  (`window.WinlinkFav`) so remote-server inlines it. This is the existing pattern for
  `lib/winlink-modes.js`.

### 3.7 The phone (handoff, not an edit here)

The phone side goes in a handoff in the ECHOCAT repo:
`docs/handoffs/DESKTOP_TO_ECHOCAT_HANDOFF_<date>_WINLINK_MY_OWN_GATEWAYS.md`. Its exact content:

- Capability: the shack's hello lists `winlink-mine` when it understands the fields below.
- `winlink-state.favourites[]` entries may carry:
  - `mine` (boolean),
  - `note` (string, at most 60 characters),
  - `via` (array of 0 to 2 callsign strings, packet only).

  Existing fields are unchanged: `call, mode, dialKhz, khz, url, band, savedAt, lastGoodAt`.
- `winlink-favourite` (C to S) gains optional fields:
  - `mine` (boolean),
  - `note` (string),
  - `via` (string array),
  - `was` (object `{call, mode, dialKhz}`, required when `op` is `edit`).

  `op` adds `edit`. The reply is unchanged: `winlink-result {op: 'favourite', ok, error?}`, with the
  error text ready to show.
- Gateway list: My gateways for the current mode first, then Pat's rows. A Mine entry shows the
  word `Mine` after the call and the note on the second line.
- Add form, the same five fields:
  - Call, required.
  - Mode: the available radio modes from `winlink-state.modes`.
  - Frequency: required, kHz or MHz; below 1000 is MHz.
  - Via: packet only, up to 2.
  - Note: up to 60 characters.

  The dial line under Frequency is centre − 1.5 kHz for `ardop`, `vara` and `mercury`, and the
  same as Frequency for `packet` and `varafm`.
- Copy, exactly as on the desktop (section 2.3).
- Connect: `winlink-connect {mode, gateway: call, dialKhz}`, as for any favourite. The shack builds
  the URL, including the path.
- The rule for phone parity: same fields, same words, same order (Casey 2026-10-24).

### 3.8 Settings keys

| Key | Scope | Default | What |
|---|---|---|---|
| `winlinkFavourites[].mine/note/via` | profile | absent | 3.1 |
| `winlinkServiceCodes` | profile | `[]` | Codes besides PUBLIC (2.2). Upper-case words, at most 8. |
| `winlinkListFetchedAt` | profile | `0` | When Pat last downloaded the list with force (2.1). |

None go in `GLOBAL_KEYS` and none are secrets. Profile scope matches `winlinkFavourites` (it is not
in `GLOBAL_KEYS`, `main.js` around line 910).

### 3.9 Tests

All of these are plain `node --test` files listed in `scripts/run-tests.js`.

- `test/winlink-history-test.js` (already covers My gateways), new cases:
  - `clean` keeps `mine`, `note` and `via` when valid and drops each when not.
  - Mine entries are never trimmed by starred ones (41 starred plus 3 Mine leaves 3 Mine).
  - `edit` replaces by `was`.
  - The frequency parser: `145.05` gives 145050, `7101.4` gives 7101.4, `7.1014` gives 7101.4,
    `0` and text are refused.
  - The dial rule per mode matches Pat's `Dial`.
- `test/winlink-pat-test.js`:
  - `connectUrl` with `via` for packet gives `ax25:///W2ABC-1/W2XYZ-10?freq=...`.
  - `via` is ignored for ardop and varahf.
  - A bad via call gives `null`.
  - `buildPatConfig` with codes: `['PUBLIC', ...]`, PUBLIC first and kept, bad codes dropped,
    duplicates removed (with or without MERCURY per #929).
- `test/winlink-reach-test.js`:
  - The typed rule. A 2 m entry on an HF-only rig is refused by range only; an entry outside the
    amateur bands on a rig that covers it is allowed.
  - The listed-gateway rule is unchanged until open question 1 is answered.
- A main wiring source test (`test/winlink-main-wiring-test.js`):
  - `winlinkRmslistSafe` is the only caller of `patClient.rmslist`.
  - Refresh passes `forceDownload`.
  - The reach skip in `winlinkPreviewQsy` and `winlinkStartSession` reads `mine` from
    `settings.winlinkFavourites`, never from the request.
- `test/winlink-remote-shack-test.js`: the favourite invoke carries `note`, `via`, `mine` and `was`.
- `lib/echocat-protocol.js` validator: the new optional fields are declared, and
  `docs/echocat-protocol.md` documents them (the guard test compares the two).
- Layout: the Add form and the Mine tag are checked in all themes (classic 3 and the 7 design-system
  ones) before Done, per the theme rule.

## 4. Phases

Each phase is one PR into master, with CI green.

**Phase 1: a fresh list.** Section 2.1.
- Exit check: on a profile whose `rmslist.json` is older than a day, opening the mail window
  downloads once; the [Winlink] log says "gateway list downloaded"; Refresh downloads again; a second
  window open within the day does not.
- Exit check: with the network off, the forced request fails, the cached list still shows, and the
  log says why.

**Phase 2: service codes.** Section 2.2.
- Exit check: typing `EMCOMM` in Settings, saving, and opening the list shows EMCOMM rows tagged
  `EMCOMM`.
- Exit check: clearing the field shows PUBLIC only again.
- Exit check: Pat's `config.json` shows `service_codes` with PUBLIC first in both cases.

**Phase 3: Add a gateway on the desktop.** Sections 2.3 and 3.1 to 3.4. This includes the packet path
and the Mercury tester guide's switch from the DevTools step to the form.
- Exit check: on a radio with CAT, adding a packet gateway with one via call, picking it and
  pressing Connect puts the right dial on the radio. Dire Wolf's log shows the connect request
  addressed to the target via the digipeater, and the dial goes back when the window closes.
- Exit check: Edit and Remove work.
- Exit check: Casey's go is needed before anything transmits on his radio.

**Phase 4: remote shack and ECHOCAT Web.** Sections 3.5 and 3.6, plus the phone handoff (3.7) written
to the ECHOCAT repo.
- Exit check: from ECHOCAT Web against a test shack, adding, editing and removing a Mine gateway
  shows the same entry in the desktop mail window within one state push.
- Exit check: a desktop driving an older shack saves a plain favourite and shows the one-line note.

**Phase 5 (only if Casey answers yes to question 1).** The listed-gateway band checks are aligned with
the no-band-refusal rule.

## 5. Open questions for Casey

1. `lib/winlink-reach.js` refuses any gateway outside the amateur bands, listed or typed. Your
   2026-11-11 rule was "never attempt via a freq they can't reach"; your 2026-11-12 rule was "users
   are allowed to transmit outside of the bands without us stopping them". This plan applies the
   2026-11-12 rule to typed gateways only and keeps the radio-range check. Should listed gateways
   follow too (phase 5), or stay as they are?
2. Should Phase 1's automatic download happen once a day, or only when Refresh is pressed?
   Recommendation: once a day plus Refresh. The cost is one small download from api.winlink.org per
   day per profile.
3. Service codes in Settings (Phase 2): yes or no? Without it, an EMCOMM or club-coded gateway can
   still be typed in by hand (Phase 3), but it never shows in the list.
4. A club's private service code is kept private by Winlink. Should POTACAT keep it out of the
   [Winlink] log and "Report a problem" bundles (logged as "2 other codes" instead of the codes), or
   is it ordinary text?
5. My gateways are per profile and not synced to POTACAT Cloud today. Keep it that way for typed
   gateways?
6. Some EMCOMM groups use tactical calls for their stations. Pat and Winlink dial by callsign, so
   this plan accepts only callsigns with SSID. Is that right?
7. A typed station that is not a CMS gateway (a club's P2P or Radio-Only hub) would connect, and
   messages would go only to that station. Should the form say "Gateways only; peer-to-peer is not
   supported here", or leave it alone?
8. Shall I reply to the operator once Phases 1 and 2 ship? The likely fix for them is VARA FM or
   packet mode plus a fresh list, and possibly their club's code. A reply goes out only on your word.

## Sources

- Pat, la5nta/pat (MIT), master as of 2026-11-22:
  - `app/rmslist.go`: cache name per service code, the mode filter, no distance filter.
  - `api/api.go`: `rmslistHandler` with force-download, mode, band and prefix.
  - `internal/cmsapi/api.go`: `GetGatewayStatus` sends `ServiceCodes` and `HistoryHours` to
    `https://api.winlink.org/gateway/status.json`; `GetGatewayStatusCached` has no age check and
    falls back to the built-in snapshot.
  - `internal/cmsapi/gateway_status.json.gz`: the built-in snapshot.
  - `cli/rmslist.go`: the command-line flags.
  - `cfg/config.go`: `service_codes`, `connect_aliases`.
  - `app/freq.go`: `Dial`.

  https://github.com/la5nta/pat
- wl2k-go, la5nta/wl2k-go (MIT):
  - `transport/url.go`: URL grammar, digipeaters.
  - `transport/ax25/agwpe/port.go`: dials via digipeaters.

  https://github.com/la5nta/wl2k-go
- Winlink channel list and service codes: https://winlink.org/RMSChannels
- POTACAT:
  - `lib/winlink-pat.js`, `lib/winlink-client.js`, `lib/winlink-favourites.js`,
    `lib/winlink-reach.js`, `lib/winlink-modes.js`, `lib/winlink-state.js`,
    `lib/winlink-remote-shack.js`, `lib/echocat-protocol.js`.
  - `renderer/winlink-popout.js`, `renderer/remote.js`.
  - In `main.js`: `winlinkGateways`, `winlinkRmslistSafe`, `winlinkPreviewQsy`,
    `winlinkStartSession`, `winlinkFavourite`.
  - `docs/mercury-phase0-tester-guide.md`; PRs #924 (merged) and #929 (open).
