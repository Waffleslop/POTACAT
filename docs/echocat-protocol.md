# ECHOCAT WebSocket Protocol Reference

This is the catalog of every WebSocket message that flows between POTACAT
desktop and an ECHOCAT client (browser today, native mobile app coming).
The schemas of record live in [`lib/echocat-protocol.js`](../lib/echocat-protocol.js).
This document is the human index — what each message means and which feature
uses it.

## Versioning

The current protocol version is **`1`**. See `PROTOCOL_VERSION` in
`lib/echocat-protocol.js`.

A connecting client should send `{type: 'hello', protocolVersion, clientVersion, clientPlatform}`
immediately after the WebSocket opens. The server replies with
`{type: 'hello', protocolVersion, serverVersion, capabilities}`. If the
major version differs by more than 1, either side should close with code
`4001` ("protocol version unsupported"). Within the same major, missing
features should be advertised through the `capabilities` array on the
server `hello`, so the client can hide UI for things the server doesn't
yet support.

**`pttClientId` (optional, added 2026-11-22, #941).** A client may add
`pttClientId` to its `hello`: a random secret it makes once (22-64 characters
`[A-Za-z0-9_-]`; ECHOCAT Web makes 32 hex characters with
`crypto.getRandomValues` per page and keeps it in `sessionStorage`; logic in
`lib/ptt-client-id.js`). When a new connection is admitted with the same id,
authenticated the same way (both the owner, or both the same Guest Pass; and,
when both are paired, the same paired device), while the old connection still
holds PTT, the shack unkeys at once (`ptt` off through the same path a
disconnect uses) and closes the old connection, instead of waiting for the
heartbeat to drop it (about 45 s). This matters with "more than one device" on,
where a reconnect does not otherwise replace the old socket. It only releases;
it never keys. A connection with a different id never releases or takes
another client's PTT (`estop` is unchanged). A client that sends no id behaves
as before. The shack never sends the id to anyone and never logs it, so it
cannot be learned from presence (`clients-list` ids are the shack's own).

The legacy browser web app does **not** send a `hello` — when the server
sees its first message be `auth` instead of `hello`, it falls back to
protocol-version 0 behavior (which is "everything works as it did before
the handshake was added"). This is the v0 ↔ v1 compatibility bridge that
keeps the existing browser path working unchanged. See
`lib/echocat-protocol.js > LEGACY_FIRST_MESSAGE_TYPES` for the allowed
legacy first messages.

> **Live-desktop caveat:** the v1 server hello only fires on a desktop
> running a build that includes commits `62bec7e` + `44c1aac` or later.
> A desktop running an older binary still serves the legacy v0 path
> (no server `hello` is sent). If your client connects and times out
> waiting for the server's `hello`, check that the desktop has been
> restarted onto the new build. Don't assume v1 capabilities just
> because the desktop repo is on v1 — the running process still
> matters. (Gap 4, mobile dev report 2026-05-03.)

## Connection lifecycle

```
client                                 server
  |---- TLS handshake ----------------> |
  |---- WS upgrade -------------------> |
  | <---- {type:'hello', ...} --------- |  (skipped pre-v1; legacy clients see auth-mode first)
  |---- {type:'hello', ...} ----------> |
  | <---- {type:'auth-mode', mode} ---- |
  |---- {type:'auth', ...} -----------> |
  | <---- {type:'auth-ok'|'auth-fail'} -|
  |  ... feature messages flow ...      |
```

### Who may connect (added 2026-11-22)

Checked at the WebSocket upgrade, before the server `hello`
(`RemoteServer._verifyUpgrade`, rules in `lib/echocat-web-gate.js`):

- **Page Origin.** An upgrade that carries an `Origin` header must come from
  this server's own page: the Origin's host must equal the `Host` header (a
  default port on either side is ignored), or the Cloud host. Otherwise the
  upgrade is refused with HTTP 403 and the body `Page origin is not this
  ECHOCAT server`, whatever the auth mode. An upgrade with **no** `Origin`
  (the ECHOCAT app, a POTACAT desktop over Node `ws`) is unaffected. A native
  client that adds an Origin must make it the URL it dialled
  (`https://<host>[:port]`), which is what React Native's own WebSocket does.
  ECHOCAT Web connects to `location.host`, so its Origin always matches.
  Before this, a page from any web site, open in a browser on the LAN, was
  auto-authenticated as the owner.
- **A public address with the Cloud Tunnel off** (a router port-forward of
  7300): local trust stops at the LAN and the tailnet. With an ECHOCAT token
  set and required, the socket gets `auth-mode: token`; with none, the
  upgrade is refused with HTTP 403 (`Internet connection needs an ECHOCAT
  token`) and `GET /` answers 403 with a plain-text explanation. Private
  ranges (10/8, 172.16/12, 192.168/16), loopback, link-local and Tailscale
  (100.64/10) are not public. Over the Cloud Tunnel nothing changes.

LAN, Tailscale and loopback clients keep the local-trust behaviour of a fresh
install: `auth-mode: none` and `auth-ok` with no token, unless the operator
requires one.

## Message catalog

Format: each row is `name — direction — purpose`. Directions:
**S→C** (server-to-client), **C→S** (client-to-server), **↔** (both).

### Handshake / auth / connection

| Message | Dir | Purpose |
|---|---|---|
| `hello` | ↔ | Version + capability handshake (new in v1). Server-side `hello` also carries top-level `rigModel` (string, e.g. `"Flex 8600M"`, `"FTDX10"`) so POTACAT-desktop clients can label paired shacks in the Remote Radios panel — empty string when no rig is configured. |
| `auth-mode` | S→C | Tell client which auth mode the server is configured for (`token`, `callsign`, `cloud`, `none`, `cookie`). `cookie` (2026-09-11, ECHOCAT Web over POTACAT Cloud): the WebSocket upgrade carried a valid `__Host-echocat_device` or `__Host-echocat_pass` cookie and the server has **already** authenticated the socket — `auth-ok` follows immediately with no `auth` message from the client. Sent only when the upgrade's `Origin` matches its `Host` (or the tunnel's `cloudHost`); a cross-site page that makes the browser attach the cookie is refused at the upgrade (403, see "Who may connect"); an upgrade with the cookie but no `Origin` gets `token` and no `auth-ok`. The page was served with `window.__authMode="cookie"` by the same decision (`lib/echocat-web-gate.js` `wsAuthModeFor` / `decideHttpGate`), so a page in cookie mode that receives `auth-mode: token` knows its cookie died (revoked, expired, pass ended) and must sign out and reload rather than show a token box. |
| `auth` | C→S | Submit credentials (token / callsign+password / cloud token). |
| `auth-ok` | S→C | Auth succeeded. Bundles initial feature flags and settings. Per-device-token auths also include `expiresAt` (epoch ms or `null` for no-expiry — trusted / account-linked devices), `accountLinked` (bool — pair came in via Cloud-attested flow), and `trusted` (bool — operator marked the device "my own"). Absent for the legacy single-shared-token path and Guest Pass auth. Also carries the shack's CURRENT alternate dials + trust info on every connect: `tsHost`, `cloudHost`, `tsCertPublic` (true = served cert is a Tailscale-issued LE cert, validate normally, no pin; absent/false = self-signed, pin `fingerprint`), `spki` (SHA-256 lower-hex of the cert's SubjectPublicKeyInfo DER — stable across cert reissues since the keypair persists, cert-pin Phase 2a; a client that stores it verifies future certs by SPKI and survives rotation), and `fingerprint` (SHA-256 colon-hex of the cert being presented NOW — also the no-re-pair recovery for a rotated cert). A client paired cloud-only should ADOPT `tsHost` from here rather than treating the pairing as frozen. |
| `alt-hosts` | S→C | Mid-session update of the same alternate-dial fields `auth-ok` carries (`tsHost`, `cloudHost`, `tsCertPublic`, `fingerprint`, `spki`) — pushed when the values actually change (operator signs into Tailscale, Cloud Tunnel comes up/down). Sent since v1.8.5; registered 2026-08-03. |
| `cloud-state` | S→C | The shack's Cloud state, for its own devices (capability `cloud-state`, 2026-11-21): `signedIn` (bool), `access` (`trial`\|`paid`\|`none`, from the subscription the desktop's Cloud card reads), `trialEndsAt` (ISO 8601, only with `access: 'trial'`), `tunnel` (`on`\|`off`). The same object rides in `auth-ok` as `cloud`; this message follows it whenever it changes (billing state, sign-in or sign-out, tunnel on or off). Never sent to a Guest Pass session. |
| `auth-fail` | S→C | Auth rejected with `reason`. New reason in v1.9: `"expired"` — paired device's sliding 180-day token elapsed without a reconnect; client should route to the re-pair UI. In cookie mode the web client treats any `auth-fail` as a dead cookie (`POST /api/web-signout` then reload to the connect page). Guest Pass refusals also carry `code` (2026-11-14, #541): `rig_in_use` (with `by`: `owner` or `guest`; the pass is fine, ask again in a minute), `pass_check_failed` (the shack could not check the pass with Cloud: rate limit, Cloud down, no network; the pass may be fine, ask again with back-off 30 s, 1, 2, 4 then 5 min; `reason` is "Couldn't check your pass just now. Trying again." and never contains "revoked"), `pass_not_valid` (Cloud says the pass is not valid; `passReason` is `expired`, `cancelled`, `not_started` or `unknown`, and `passAt` is Cloud's time for it when sent; only `not_started` is worth asking again, at `passAt`). Each of these also carries `state` (`over` for pass_not_valid, `reconnecting` for pass_check_failed, `waiting` for rig_in_use), `stateReason` (over: `expired`, `cancelled`, `not_started` or `unknown`; reconnecting: `check-failed`; waiting: `owner` or `other-guest`) and `text`, the words to show as they are. `reason` stays the older human text that older phones read. A Guest Pass refusal with no `code` comes from an older shack and is final. Words for every case: lib/pass-wording.js. A client whose hello lists the capability `pass-state` (2026-11-14, #541 step 2) also gets `passState`: the same object as a `pass-state` message without `type` (`waiting`/`owner-has-radio`, `waiting`/`other-guest`, `reconnecting`/`check-failed`, `over`/`expired`, `cancelled` or `unknown`, `waiting`/`not_started` with `takeAt`). |
| `pass-state` | S→C | Guest Pass state (2026-11-14, #541 step 2; lib/pass-state.js). Sent only to a client whose hello lists the capability `pass-state` (the shack lists it too), on connect (after `auth-ok`) and on every change: `{state, reason, endsAt, takeAt?, message?, device?}`. `state`: `on-air` (reasons `none`, `ends-soon`, `owner-soon`), `waiting` (`owner-has-radio`, `owner-idle`, `other-device`, `other-guest`, `rig-in-use`, `not_started`), `reconnecting` (`check-failed`; `network`, `station-offline` and `station-unavailable` are decided on the guest's own device and never sent), `over` (`expired`, `cancelled`, `unknown`). Only `over` ends the pass; every other state keeps it good. `endsAt` is the pass's end (ISO, `null` when unknown); `takeAt` the owner's take time (`owner-soon`) or the pass's start (`not_started`); `message` the owner's words; `device` the guest's device that is on air (`other-device`: `iPhone or iPad`, `Android phone`, `POTACAT desktop`, `web browser`, or absent). An expired or cancelled pass sends `over` just before `pass-ended`. The owner's controls in Share My Rig (2026-11-14, #200, #541 step 3; lib/pass-owner-controls.js): **Take the radio, Now** sends `waiting`/`owner-has-radio` at once, with `message` when the owner typed one (`pass-paused` is still sent alongside); **Take the radio, In 5 minutes** sends `on-air`/`owner-soon` with `takeAt` (ISO, 5 minutes on) and `message`, the guest keeps operating, and at `takeAt` the state becomes `waiting`/`owner-has-radio` with the same message; the owner can cancel the pending take, which sends plain `on-air`/`none` again; **Give it back** is immediate and sends `on-air`/`none` to the device that was on the air (a device waiting for it stays `waiting`/`other-device`); **Cancel pass** (called Revoke before 2026-11-14) sends `over`/`cancelled`, then `pass-ended` with `reason` `revoked`, unchanged on the wire for older phones. `message` is one line of at most 140 characters, already trimmed by the shack. While a take is pending or the owner holds the radio, `pass-claim` is refused. **The hand-back rule** (2026-11-15, #200, #541 step 4; lib/pass-state.js `offerOwnerIdle` / `canTakeBack`, owner activity in lib/pass-owner-activity.js): the radio stays the owner's while the owner uses it. After 5 minutes with no owner activity (a key-down, CW, tuning, a band or mode change, a JTCAT transmission, Winlink session activity, at the station or from one of the owner's own paired devices, and, while the owner holds the radio, the radio itself reporting transmit for at least 1 second (its CAT TX status, or forward power), so an owner on the hand mic keeps it; spots, decodes, other meter readings, frequency and mode seen only by CAT polling, and `owner-presence` do not count) the guest's device that was on the air is sent `waiting`/`owner-idle` (with the owner's `message`, if any) and may send `pass-take-back`. Any owner activity after that sends `waiting`/`owner-has-radio` again. Nothing switches on its own: there is no automatic hand-back (the older one, which followed an owner device going idle or away, was removed on 2026-11-15), and Give it back stays immediate. A device waiting for another of the guest's devices stays `waiting`/`owner-has-radio`. A client without the `pass-state` flag gets nothing new: it keeps `pass-paused` and waits for Give it back (`pass-resumed`). The older messages (`pass-paused`, `pass-resumed`, `kicked`, `pass-ended`) keep being sent. Words for every state and reason: lib/pass-wording.js `describeState` / `STATE_TABLE`. |
| `pass-claim` | C→S | "Use it here instead" (#541 step 2, capability `pass-state`). A second device on the same pass session (same pass code and session token) from a client with the flag is admitted waiting (`waiting`/`other-device`), not on the air, and sends nothing but `pass-claim`, `pass-leave` and `ping`. `pass-claim` is granted only on that connection while its reason is `other-device`: the two devices swap with no redial, and the other one gets `waiting`/`other-device` naming this one (an older client there is displaced with `kicked`). Refused, with the current `pass-state` sent again, while the owner holds the radio (`owner-has-radio`, `owner-idle`) or a take is pending. When the device on air leaves, the waiting one takes the radio. A client without the flag keeps the older rule: the newest device takes the radio and the other gets `kicked`. |
| `pass-guest-waiting` | S→C | An owner device waits behind a Guest Pass (Guest Pass hopping, 2026-10-27; "Lend my rig", capability `owner-presence`). An owner device that connects while a guest holds the rig gets `auth-ok` with `passGuest`; one that was connected and idle when a guest took the rig gets `pass-guest-waiting`. Both carry `{callsign, passCode, endsAt, connected, lastActiveAt?}` and the device answers with `pass-take-over` (then `pass-take-over-ok`), or gets `pass-guest-gone {reason}` when the guest's session ends. `passCode` (string, 2026-11-22): the guest's pass code, so the phone can match the pass on My passes; these messages only ever go to owner devices. `connected` (boolean, 2026-11-22): the guest's device is connected now (false inside the 60 s reconnect hold after a drop). `lastActiveAt` (epoch ms, 2026-11-22): the guest's last action on the radio, starting at the moment the guest's session began, so a guest who has done nothing reads idle; absent when the shack has no clock for this pass. An action on the radio is the hand-back rule's list (lib/pass-owner-activity.js `fromEchocatMessage`): a PTT key-down, a voice macro, the ATU tune, CW, a tune, VFO, band or rig change, a mode change, a JTCAT, JTTY or PSK transmission, Winlink connect, QSY or retry, an SSTV photo, JS8 sends, FreeDV transmit; never pings, reads, subscriptions or key-ups. Nothing else about what the guest did is sent. While a device waits, the shack sends it a fresh `pass-guest-waiting` only when `connected` changes or when the guest acts after 2 minutes or more without an action (idle to active), never on every action: the phone ages the line itself. Both fields are optional: an older desktop sends neither. Rules: lib/pass-guest-activity.js. |
| `clients-list` | S→C | Presence: every connected device, one copy per device: `{clients: [{id, name, platform, version, since, keyed, audio, guest, you}], multi}`. `you` marks the receiver's own row, `keyed` the device holding PTT, `audio` the device the audio bridge streams to, `guest` a Guest Pass session. On a guest row, the copies sent to the owner's devices also carry `passCode` (the guest's pass code) and `call` (the guest's on-air call, `''` for an anonymous guest) (2026-11-22), so the phone's My passes can mark the pass that is connected now. A guest's copy never carries them, on any row, its own included. An older desktop sends neither: show nothing. Rules: lib/clients-list.js. |
| `pass-take-back` | C→S | "Take the radio" (2026-11-15, #200, #541 step 4, capability `pass-state`). `{}`. Granted only on the connection that is told `waiting`/`owner-idle` (the guest's device that was on the air, after 5 minutes without owner activity): the radio goes back to it at once, as on Give it back (`on-air`/`none`, with `pass-resumed` alongside), and a device waiting for it stays `waiting`/`other-device`. Refused, with the current `pass-state` sent again, in every other case: the owner is using the radio (`owner-has-radio`), a take is pending (`owner-soon`), the guest already has the radio, the device is waiting for another of the guest's devices, or the client did not list `pass-state`. |
| `kicked` | S→C | Server bumped this client because another connected. Carries `byPlatform`, `byVersion`, `byHost` so the displaced client can render a friendly "another device took over" banner instead of a mystery disconnect. |
| `revoked` | S→C | The shack operator revoked this device's pairing **while it was connected** (Settings → paired devices → Revoke). Carries `reason` (display string). Sent immediately before the server closes the socket with code `4004`. Unlike `kicked`, the device token no longer exists — the client must drop to its unpaired state and must **not** auto-reconnect (a reconnect gets a terminal `auth-fail`; the server can't distinguish revoked from never-paired once the record is deleted). Only the matching per-device pairing is kicked; legacy shared-token and Guest Pass sessions are unaffected (pass revocation has its own `pass-ended` flow). New 2026-06-12. |
| `pass-ended` | S→C | The Guest Pass this session was riding on ended (the owner pressed Cancel pass, it expired, or the owner's Cloud entitlement lapsed). Carries `reason` and `code`. `reason` keeps its older values: Cancel pass in Share My Rig (named Revoke before 2026-11-14) is still `revoked` on the wire. The server also purges the pass's web-gate sessions, so a browser reload lands on the connect page (with `?notice=pass-ended`) rather than a dead SPA. Pre-existing message, registered 2026-09-11. |
| `pong` | S→C | Reply to `ping` for connection health checks. |
| `ping` | C→S | Latency / liveness probe. |

#### WebSocket close codes

Application close codes (mirrored in `CLOSE_CODES` in
`lib/echocat-protocol.js` and mobile's `src/protocol/echocatProtocol.ts`
— keep the two in sync):

| Code | Name | Meaning |
|---|---|---|
| `4001` | `PROTOCOL_VERSION_UNSUPPORTED` | Peer's protocol major is too far ahead/behind to talk. |
| `4002` | `HANDSHAKE_INVALID` | Malformed `hello`. |
| `4003` | `AUTH_FAILED_TERMINAL` | Auth rejected and retrying won't help — stop reconnecting. |
| `4004` | `AUTH_REVOKED` | Operator revoked this device's pairing mid-session. Preceded by a `revoked` message. Don't reconnect. Older clients that don't know `4004` ignore the `revoked` message, treat the close as generic, reconnect once, and land on a terminal `auth-fail` — degraded but safe. |

The shack also uses the standard RFC 6455 code `1009` (Message Too Big); see
"Frame size limits" below.

#### Frame size limits

Since 2026-11-23 the shack's WebSocket server limits what a client may send
it (lib/ws-limits.js). These apply to frames the server RECEIVES; what the
server sends is unchanged.

| Limit | Value | What happens |
|---|---|---|
| Any frame, any socket | 16 MiB (16,777,216 bytes, after permessage-deflate inflation) | ws closes the socket with `1009` and an empty reason. Before 2026-11-23 the limit was ws's default, 100 MiB. |
| Any frame before sign-in | 64 KiB (65,536 bytes) | The socket is closed with `1009`, reason `Frame too large before sign-in`, before the frame is parsed. "Signed in" means the shack sent `auth-ok` (or auto-authenticated the socket: a LAN shack with no token is signed in from its first frame). Before sign-in the shack reads only `hello` and `auth`, which are under 1 kB. |
| `sstv-photo` `image` | 4 MiB (4,194,304 characters of the data URL or base64 string) | Not sent and never decoded: the sender gets `sstv-tx-status {state: 'rx' (or 'auto-rx' while Idle Mode SSTV runs), error: "Picture not sent: the picture is too large to send (4 MB at most)."}`. An `image` that is not a non-empty string gets the same message with error "Picture not sent: the picture could not be read.". The socket stays open. |
| `voice-macro-play-audio` `audio` | 4 MiB of base64 (unchanged) | `tune-blocked` "That recording is too long to send (two minutes at most)." |

The largest legitimate client frames measured on 2026-11-23: an `sstv-photo`
at the largest SSTV size (640x496, PD-120/160/180/240) as a lossless RGBA PNG
of noise is 1.69 MB as a data URL (the phone's 320x256 JPEG at quality 0.9 is
40-90 kB); a 30 s phone voice recording at 128 kbit/s AAC is 0.64 MB of
base64; `save-settings` with every SSTV template at the template sync limits
(24 templates, 150 KiB background, 32 KiB thumbnail) is about 4.3 MiB;
`winlink-compose` attachments are refused over 2 MiB, 2.7 MiB as base64.
A client should cap its own sends at these limits and show the reason rather
than send a frame that closes its socket.

### Spots and sources

| Message | Dir | Purpose |
|---|---|---|
| `spots` | S→C | Bulk push of current spot list. |
| `sources` | S→C | Which spot sources are currently enabled (POTA, SOTA, etc.). |
| `set-sources` | C→S | Toggle which spot sources to subscribe to. |
| `echo-filters` | S→C | Server-side filter state (band/mode/distance). `data.muteRules` (2026-08-03) additionally carries the desktop-owned per-band region mutes (`[{continent:'AS', band:'40m'}]` — "hide Asia on 40m", other bands unaffected). Apply them in the spot filter AND display active rules — an invisible filter reads as missing spots. Since #291 (2026-11-15) `data.bandsOff` is the operator's unticked bands (one list for every rig) and `data.bands` is the active rig's bands minus that list (null = All); the desktop re-sends `echo-filters` whenever the shack's rig bands change (a rig switch), so a client re-ticks its band filter from it. Rule: lib/spot-band-filter.js. |
| `set-echo-filters` | C→S | Update server-side filter state. `filters.bands` is the ticked list as the client shows it; the desktop turns it into `bandsOff` against the shack's rig (bands the rig lacks keep their earlier state). Clients need not send `bandsOff`. Does NOT carry muteRules — they are desktop-owned and merged into `echo-filters` at send, so this message can never clobber them. |
| `set-spot-mute-rules` | C→S | Full-list replace of the per-band region mutes from a client editor. Desktop sanitizes (valid continents, deduped, capped 50) and echoes the accepted set inside the next `echo-filters` push. |
| `worked-parks` | S→C | List of park refs the user has worked (drives ATNO badges). |
| `worked-qsos` | S→C | List of recent worked callsigns/refs (drives "worked" highlighting). Sent at connect (chunked when the hello lists `chunked-worked-qsos`). A client without `worked-incremental` is also sent the whole list again after every QSO the shack logs. A client whose hello lists `worked-incremental` (added 2026-11-17, #731) is sent it once per connection and again only after a full-log change (import, edit, delete, reload); after each logged QSO it gets `worked-today` (and `qso-added` if it lists `qso-delta`) and must merge the new QSO into its worked map itself. ECHOCAT Web merges both: `worked-today`, and each `qso-added` record built by lib/worked-entry.js, the rule the full list uses (a same-QSO last entry is replaced, not counted twice). |
| `worked-today` | S→C | Today's (UTC) worked QSOs: `entries` = `[{call, ref, band, mode, date}]`. Sent at connect and after every logged QSO to the active client, never size-capped. Merge into the worked map (skip exact duplicates); a `worked-incremental` client relies on it for each new QSO. |

### Rig control / VFO

The `status` message is a kitchen-sink snapshot. The canonical fields are:

| Field | Type | Notes |
|---|---|---|
| `freq` | number | Hz. **Not `frequency`.** |
| `mode` | string | "USB", "LSB", "CW", "PKTUSB", "FREEDV-RADEV1", … |
| `band` | string | "20m", "40m", … (derived from freq) |
| `modeData` | boolean | Added 2026-11-23. The radio's DATA flag where it reports it apart from the mode (an Icom in USB or LSB with `1A 06` on): `true` = the radio is in USB-D / LSB-D although `mode` says USB / LSB, so show DIGU / DIGL. Sent only with a `mode`, never while transmitting; absent = keep the last value (every other radio names its data mode in `mode`: PKTUSB, DIGU, ...). Older desktops never send it. |
| `catConnected` | boolean | true when CAT or SmartSDR is up |
| `txState` | boolean | true while transmitting |
| `rigType` | string | "flex", "yaesu", "icom", "kenwood", "rigctld", "wsjtx" |
| `nb` | boolean | Noise blanker on/off |
| `preamp` | boolean | Preamp on/off. ADDED 2026-08-03 (was missing — the mobile toggle settling on this echo could never learn it was on, so it re-sent `true` forever and couldn't turn it off; N4RDX) |
| `att` | boolean | Attenuator on/off. ADDED 2026-08-03, same fix as `preamp` |
| `atu` | boolean | ATU enabled |
| `vfo` | string | "A" or "B" — READBACK-fed since 2026-08-03 (Kenwood `IF;` / rigctld `v`, polled every cycle), so it now follows front-panel and custom-CAT VFO changes instead of only POTACAT-initiated ones |
| `split` | boolean | rig split on/off, readback-fed (Kenwood `IF;` P12 / rigctld `s`). NEW 2026-08-03 — absent from older desktops. Live split is commanded via `rig-control {action:'set-split', value}`; the similarly-named `set-enable-split` only toggles the spot-tune setting |
| `capabilities.dataModes` | string[] | Added 2026-11-23. The data sub-modes the radio can be set to, a subset of `["DIGU", "DIGL"]` (lib/data-mode-picker.js): both on Flex, TCI, Hamlib/rigctld (the Xiegu G90 included), DXLab Commander, Icom CI-V (none once the radio has refused the DATA flag), flrig (what the radio lists) and Yaesu / Kenwood / Elecraft text CAT where the model's codes give a real data mode; `["DIGU"]` on a radio with one data code for both sidebands (QMX); `[]` on the FT-817/818/857/897 legacy CAT, a (tr)uSDX and a radio with no CAT. Set them with the existing `set-mode` (`mode: "DIGU"` or `"DIGL"`), as the ECHOCAT app already does; the shack maps them to the radio's own (PKTUSB/PKTLSB, USB/LSB + DATA, MD0C/MD08, MD + DA1, ...). ECHOCAT Web shows DIGU / DIGL buttons in its mode picker only for the entries listed. Absent (older desktops) = not offered. |
| `capabilities.splitUp` | boolean | Added 2026-11-23 (#689). `true` = the shack can do Split up N in one step: `rig-control {action:'split-up', offsetKhz}` with `offsetKhz` 1, 2, 5 or -1 turns split on and sets the TX VFO to the dial + offset (lib/split-up.js). Back to simplex is `set-split` false. Refused (logged, nothing sent) while the VFO is locked or when the TX frequency is outside the radio's range; refused for a Guest Pass like `set-split`. Never on a Flex. Absent (older desktops) = not offered. From the same date `splitFreq` is `false` where the link would decline the TX frequency (Yaesu other than FT-991/991A, Icom firmware that NAKs 25). |
| `filterWidth` | number | Hz |
| `rfgain` | number | 0–255 |
| `txpower` | number | TX power *setting* (slider) |
| `txPowerUnit` | string | Optional, added 2026-11-16 (#195). `'%'` = `txpower` is a drive percentage, not watts (a Zeus or Thetis rig over TCI); label the slider `%` and never show it as watts. Absent = watts, as before. |
| `smeter` | number | live S-meter (Gap 10) |
| `swr` | number | live SWR (Gap 10) |
| `alc` | number | live ALC (Gap 10) |
| `power` | number | live wattmeter (Gap 10) |
| `capabilities` | object | per-rig feature flags (filter, nb, atu, vfo, rfgain, txpower, power, powerOn, powerOff). `powerOn` (optional boolean, added 2026-11-13, #485): `false` = the radio can be switched OFF over CAT but not on (`power` is still `true`); show Power Off alone and no Power On. Absent (every older desktop, every other radio) = on and off both, as `power` says. Sent as `false` for the Yaesu FTX-1 Field and FTX-1 Optima (Yaesu FTX-1 CAT manual rev 2508-C p.23: PS Set has only P1=0, power off). A `power-on` rig-control for such a radio is refused with a `tune-blocked` reason. `powerOff` (optional boolean, added 2026-11-15, #293): `false` = do not offer Power Off: the shack's owner unticked "Show Power Off for this radio" for that rig, or made no choice and the shack cannot switch the radio back on over its connection. From 2026-11-19 (#768) a rig with no choice sends `true` on a direct serial port (Yaesu, Kenwood, Elecraft, Icom CI-V) or a Yaesu SCU-LAN10, and `false` on Hamlib / rigctld and every other connection. The field and its meaning to a client are unchanged. Absent (older desktops) = offered as `power` says. A `power-off` rig-control for such a radio is refused from every surface with a `tune-blocked` reason to a remote asker. |
| `vfoLocked` | boolean | VFO lock active |
| `audioState` | string | WebRTC connection state (when ECHOCAT audio bridge is up) |
| `wsjtxMode` | boolean | ADDED 2026-11-14 (#547). `true` while the shack is in WSJT-X Mode (`settings.enableWsjtx`): POTACAT has left the radio to WSJT-X, so it has no CAT link, spot taps do not tune and POTACAT's own FT8 does not key. Show a "WSJT-X Mode" chip and the explain-only note "The shack is in WSJT-X Mode. WSJT-X has the radio, so tuning and transmitting from here are off. Turn it off at the shack: click CAT in POTACAT's top bar and untick WSJT-X Mode." There is no remote turn-off. Pushed again whenever the mode changes. Absent from older desktops (treat as `false`). |
| `wsjtxHeard` | boolean | ADDED 2026-11-14 (#547). With `wsjtxMode`, `true` when a WSJT-X Heartbeat or Status packet reached the shack's UDP port in the last 60 s; always `false` when `wsjtxMode` is `false`. Pushed again when it changes. |

**`tune` C→S sends `freqKhz` (string), not `frequency` (number)**.
The kHz-as-string format is the legacy wire shape and the desktop
parses it as a float — see Gap 5 in `potacat-app/docs/echocat-protocol-gaps.md`
for the history.

| Message | Dir | Purpose |
|---|---|---|
| `status` | S→C | Full radio status snapshot. See field table above. |
| `tune` | C→S | Tune VFO. Fields: `freqKhz` (string, e.g. `"14250.000"`), `mode` (optional), `bearing` (optional, for rotor), `channelId` (optional, a Channels tap: a channel with the radio's memory number `mem` is recalled on the radio instead; older shacks ignore it and tune `freqKhz`), `pickSideband` (optional boolean, #445, desktop 2026-11-12: send `true` with a band button or a typed frequency and no `mode`; when the radio is in plain voice USB/LSB the shack sends the band's sideband with the tune, LSB below 10 MHz, USB from 10 MHz and on 60 m, the rule spot clicks use; CW, AM, FM, RTTY, every data mode, a radio in DATA, a running FT8/FreeDV/JS8 session and an unknown mode are left alone; leave it out for dial steps, arrows and scope taps; older shacks ignore it). With no radio control (radio not connected, or a no-CAT rig) a shack advertising `sdr-tune-without-rig` listens through an SDR that covers the frequency (connected, or the first listed one it brings up) instead of replying `tune-blocked` (#329, lib/listen-source.js `routeWithoutRig`). |
| `tune-blocked` | S→C | Tune was rejected (VFO locked, out of band, etc.). |
| `rig-reconnect` | C→S | "My radio is back on, retry now." Rate-limited (5 s). The desktop re-dials the active rig unless WSJT-X Mode is on. |
| `rig-reconnect-ack` | S→C | Answer to `rig-reconnect`. Since 2026-11-14 (#547) it carries `ok` (boolean). `{ ok: true }`: reconnecting; the outcome follows in `status` (`catConnected`). `{ ok: false, code: "wsjtx-mode", reason }`: nothing reconnects because WSJT-X Mode is on; `reason` is the display string "WSJT-X Mode is on: WSJT-X has the radio. Untick WSJT-X Mode (click CAT in the top bar) for POTACAT to tune it". Older desktops send `{ type }` alone: treat a missing `ok` as `true`. |
| `set-mode` | C→S | Change mode without retuning frequency. `mode` is a POTACAT mode name; `DIGU` / `DIGL` set the radio's data sub-mode (see `capabilities.dataModes`). |
| `set-vfo` | C→S | Switch VFO A/B. |
| `swap-vfo` | C→S | A↔B swap. |
| `set-filter` | C→S | Set filter width in Hz. |
| `filter-step` | C→S | Bump filter wider/narrower one step. |
| `set-rfgain` | C→S | Set RF gain. |
| `set-txpower` | C→S | Set TX power. |
| `set-nb` | C→S | Toggle noise blanker. |
| `set-atu` | C→S | Toggle ATU. |
| `set-enable-atu` | C→S | Enable/disable ATU subsystem. |
| `set-enable-split` | C→S | Enable/disable split. |
| `set-cw-xit` | C→S | `{value}`: set the CW XIT offset in Hz. |
| `set-cw-filter` | C→S | Default CW filter width. |
| `set-ssb-filter` | C→S | Default SSB filter width. |
| `set-digital-filter` | C→S | Default digital-mode filter width. |
| `set-tune-click` | C→S | Whether tap-to-tune fires on click vs. dbl-click. |
| `set-scan-dwell` | C→S | Scan dwell time per spot. |
| `set-max-age` | C→S | Drop spots older than N minutes. |
| `set-dist-unit` | C→S | mi vs km. |
| `set-refresh-interval` | C→S | Spot refresh cadence. |
| `scan-step` | C→S | Skip / unskip / next during a scan. |
| `scan-state` | ↔ | Scan on/off STATE sync. Field: `scanning` (boolean). Each side announces when ITS own scan engine turns on/off; the receiver mirrors it as the peer's state. On mutual exclusion (one rig) a side that sees the peer's `scanning:true` stops its own engine. Re-sent to a (re)connecting client so a mid-scan reconnect shows the in-progress scan. |
| `scan-control` | ↔ | Ask the peer to change ITS scan. Field: `action` (string): `"stop"` (the reported use-case) or `"start"` (optional; uses that side's own filters). Gated like other rig C→S (authenticated active client). NOTE: supersedes the older, unused `scan:state`/`scan:control` (colon) registrations. **#37, capability `scan-remote-v1` (2026-11-21):** a phone that sees it in the shack's `hello` may send its OWN scan with the start: `filters` {`bands`, `modes`, `regions`, `sources` (string arrays), `newOnly`, `hideWorked` (booleans), `sort` (`age`\|`freq`\|`dist`\|`source`\|`event`)}, `dwellSec` (number, default 7, 1-120) and optional `fromFreqKhz`. The desktop then runs the loop in its main process (it keeps going with the phone locked, the window hidden, or headless), with the phone's filters exactly as the phone's `applyFilters` (shared vectors: echocat `docs/desktop-asks/scan-filter-vectors.json`, desktop `test/fixtures/scan/`) plus the desktop's own mute rules, hidden and skipped spots, and worked today (always). It starts at the spot within 0.05 kHz of `fromFreqKhz`, else within 0.2 kHz of the dial, else the first; dwells once per frequency string; wraps. The run ends on an empty list, the radio tuned by hand (more than 4 kHz off the spot after a 2.5 s settle), any transmit, `stop` from a phone, or the desktop's own Scan button. A phone disconnecting does not end it. `scan-state {scanning}` goes to every client on start, on stop and at connect. A start with no `filters` keeps the old meaning (the desktop's own scan, filters and dwell). |
| `rig-control` | C→S | Generic raw-CAT passthrough button (Settings → Rig table). |
| `rig-blocked` | S→C | Rig switch denied (club mode etc.), or no radio to share. Fields: `reason` (string), `retry` (optional boolean). `retry: false` = a desktop that is itself driving a remote shack; it sends `auth-ok` then this, with no station state, and closes 1008 "no radio here" 750 ms later. Redialling will not help until the desktop leaves remote mode (#301, 2026-11-12). |
| `rigs` | S→C | List of configured rigs and the active one. |
| `switch-rig` | C→S | Activate a different rig profile. |
| `tgxl-select-antenna` | C→S | TGXL antenna switch select. |
| `toggle-rotor` | C→S | Rotator on/off (legacy). |
| `vfo-set-lock` | C→S | Lock/unlock VFO from changes. |
| `vfo-lock-state` | S→C | Current lock state. |
| `vfo-profiles` | ↔ | VFO Profile list (S→C push, C→S request after edit). |
| `vfo-profiles-update` | C→S | Save/edit/delete a VFO profile. |
| `apply-vfo-profile` | C→S | Apply a stored VFO profile to the rig. |
| `settings-update` | S→C | One or more server-side settings changed; client refreshes UI. The settings blob (here, in `auth-ok` and in `pass-resumed`) carries `stationLocation` (object, 2026-11-22, #909): `{grid, state, county}`, the station's grid square, state and county exactly as the shack stamps them on a Guest Pass contact that is not an activation (`county` is `ST,County`, e.g. `PA,Bucks`; any of them `''` when the shack does not know it). A POTACAT desktop on a Guest Pass stamps them, and `APP_POTACAT_GUEST_PASS`, on a contact logged from its own log forms (lib/station-county.js `guestDeskStationFor`); with no `stationLocation` (an older shack) it changes nothing. Additive: ECHOCAT needs nothing, because the shack stamps the contacts a phone logs itself (`log-qso`). The blob also carries `sstvTxPowerW` (number or null, 2026-11-22, #279, capability `sstv-tx-power`): Transmit power for SSTV in watts, null = the radio's current power (the default). The shack sets this level just before every SSTV picture keys, whichever device sent it (`sstv-photo` included), and puts the radio's own power back when the picture ends (finished, `sstv-halt-tx`, an error, the SWR guard); a Guest Pass cap still clamps it, and a radio whose power the shack cannot set is left alone. A device may show it and save it with `save-settings` `{sstvTxPowerW}` (empty, 0 or not a number saves null; refused for a Guest Pass like every save-settings); a change from any surface is followed by `settings-update`. Optional: a client that never shows it changes nothing. |
| `save-settings` | C→S | Persist a settings delta. Since 2026-11-22 only the keys in `lib/device-settings.js` (`DEVICE_WRITABLE_KEYS`) are written: the station (`myCallsign`, `grid`, `licenseClass`), spot filters (`hideOutOfBand`, `potaAgeLimit`, `enableDxe`, `enableDxeSources`, `watchlistGroups`), logging (`respotDefault`, `logCommentTags`), JTCAT/JTTY/PSK (`jtcatUseDataMode`, `jtcatFdExch`, `jttySerial`, `jttyMacroStyle`, `jttyAudioFreq`, `jttyMacros`, `jttyFt8Macros`, `jttyTemplates`, `jttyProfile`, `pskMacros`), SSTV (`sstvTemplates`, `sstvCwId`, `sstvPostProcess`, `sstvTxPowerW`) and the WebSDR list (`kiwiSdrList`, `kiwiSdrLabel1-3`, `kiwiSdrHost1-3`). Any other key is dropped silently (the shack logs its name once); keys ending in `Path` or `Host`, keys starting with `remote` or `cloud`, tokens, passwords and the settings secrets are never written by a device, even if added to the list. A client that needs another setting asks for it to be added. The desktop's own window is not affected. |

### PTT / audio signaling (WebRTC)

| Message | Dir | Purpose |
|---|---|---|
| `ptt` | C→S | Engage / release transmit. A release from a device that does not hold PTT is ignored while another live device holds it; a reconnect that sent the holder's own `pttClientId` in its `hello` releases it first (#941, see the handshake section). |
| `estop` | C→S | Hard stop — release PTT and halt all TX subsystems. |
| `ptt-timeout` | S→C | Server forced PTT release after configured timeout. |
| `ptt-force-rx` | S→C | Server forced PTT release (manual override or safety). |
| `start-audio` | C→S | Phone has the WebRTC audio bridge open and is ready to negotiate. |
| `signal` | ↔ | WebRTC signaling envelope (offer/answer/ICE candidate inside). |
| `sdp` | C→S | Legacy WebRTC SDP delivery (subsumed by `signal`; still in client). |
| `ice` | C→S | Legacy WebRTC ICE candidate (subsumed by `signal`; still in client). |
| `get-audio-devices` | C→S | Enumerate audio devices on the desktop. |
| `set-audio-device` | C→S | Pick which audio device the desktop uses for the bridge. |

### Activator mode (POTA activations)

| Message | Dir | Purpose |
|---|---|---|
| `activator-state` | S→C | Active park, frequency, contacts so far, activation flags. |
| `set-activator-park` | C→S | Set the park(s) the operator is activating. Optional `tuneTo: {freqKhz: number, mode?: string}` (only to a shack listing `activation-ask-tune`): the frequency the device wants for this activation. The shack never tunes on it; it asks (below). |
| `activation-tune-ask` | S→C | `{id, freqKhz, mode, current: {freqKhz, mode} \| null, rigs: [{id, name, active, connected}], activeRigId, guestOnAir, text, expiresInMs}`. Sent only to the device whose `set-activator-park` started the activation, only when its hello `capabilities` include `activation-ask-tune`. `text` is the question, ready to show ("Move the radio to 14.285.00 MHz SSB for this activation? It is on 14.074.00 MHz DIGU now."). `rigs` is empty for a one-radio shack (a yes/no question); with two or more it lists every configured radio and the device asks which (default: the `active` one). `guestOnAir` = a Guest Pass operator is connected (already said in `text`). No answer within `expiresInMs` (120000) = the radio is not moved; dismiss the question then. Added 2026-11-17, GitHub #146. Re-sent on reconnect (2026-11-17): the question belongs to the paired device, not its socket. If that device reconnects (a new socket, same pairing) while the question is still open, the shack sends the same `activation-tune-ask` again, with the same `id` and contents and `expiresInMs` set to the time that is left; an `activation-tune-answer` from the new socket is accepted. Treat a second ask with an `id` already on screen as the same question. |
| `activation-tune-answer` | C→S | `{id, tune: boolean, rigId?}`. `tune: true` moves the radio to the asked frequency and mode; a `rigId` other than the active radio switches to that radio first (as `switch-rig`) and tunes once its link is up. `tune: false` (or no answer) leaves the radio alone. Accepted once, only from the asked device, within `expiresInMs`; a late answer gets `tune-blocked` "That question has expired...". A locked VFO gets the usual `tune-blocked`. Refused for a Guest Pass. |
| `session-contacts` | S→C | List of contacts logged in the current session. |

**An activation start never moves the radio (capability `activation-ask-tune`, 2026-11-17, GitHub #146).**
Casey's rule (2026-11-07): POTACAT never retunes the radio silently for a phone activation; it
asks first, and with more than one radio it asks which. A shack that lists `activation-ask-tune`
in its hello `capabilities` takes the wanted frequency as `set-activator-park.tuneTo` and asks
with `activation-tune-ask`. A device sends `activation-ask-tune` in its own hello `capabilities`
when it can show the question. Older devices:
- An ECHOCAT phone without the capability sent a bare `tune` just before `set-activator-park`.
  The shack holds such a phone's plain tunes (no `channelId`, `bearing` or `pickSideband`) for
  400 ms; a `set-activator-park` from the same device inside that time drops the tune, starts the
  activation, and sends that phone a `tune-blocked` notice in words ("Your activation started.
  POTACAT did not move the radio: it stays on ... To use ..., tune there from the VFO screen.").
  Every other held tune goes through 400 ms late.
- A new device on an older shack (no `activation-ask-tune` in the server hello) must ask on the
  phone itself before it sends a bare `tune`.
- ECHOCAT Web and the desktop-to-desktop client never sent a frequency with a start; unchanged.
Brief: docs/activation-ask-before-tune.md.

### Logging (QSO / ADIF)

| Message | Dir | Purpose |
|---|---|---|
| `log-qso` | C→S | Submit a QSO for logging on the desktop. Idempotent by `uuid` (from 2026-11-17, #733): a `log-qso` whose `uuid` is already in the log (or still being saved) writes nothing and is answered with the first `log-ok` under the new `reqId`, plus `alreadyLogged: true`. A device may resend an unacknowledged `log-qso` with the same `uuid`. Without a `uuid` every `log-qso` is a new QSO. `txPower` (number, watts, optional; 2026-11-22, ECHOCAT #85, capability `log-tx-power`): the power the operator typed, for example `5`, `0.5`, `100`. Logged as `TX_PWR` when it is a number above 0 and at most 10000; absent or anything else (0, a negative, NaN, a string) is ignored and the desktop fills the power as for its own forms (the radio's power, then Default TX Power, then empty; lib/log-tx-power.js). A Guest Pass guest's power is kept as the guest's own. Existing records are never rewritten. A shack without the capability drops the field. `myRig` and `myAntenna` (strings, optional; 2026-11-23, #975): the activation's radio and antenna, logged as `MY_RIG` and `MY_ANTENNA`, trimmed and cut to 64 characters; empty or not a string is ignored. The device's `myRig` wins over the shack's own station rig; with none sent the shack stamps its station rig as before (none in remote mode). Records sent back (`get-all-qsos`) carry `MY_ANTENNA` like any other ADIF field. |
| `log-ok` | S→C | Logging succeeded; includes idx in ADIF. Each `records[]` entry carries the saved fields the record holds, `txPower` (watts, string) among them from 2026-11-22 (#85, capability `log-tx-power`), so a device's copy shows the power the desktop logged, its own fill included. Sent once the records are on disk (from 2026-11-17, #732), before the external-logger and QRZ uploads, respots and SOTA upload. When a respot was asked for, its outcome follows in a second `log-ok` with `followUp: true`, carrying `success`, `callsign`, `reqId`, `uuid`, `records`, `cloudJournal`, `resposted` and `respotError`, never `error`. A device that already handled the first treats it as a respot notice only. `dupe` (boolean, from 2026-11-24, #1041, server capability `qso-sounds`): `true` when the session contact list already held this callsign on this band (the same mark as `dupe` on the session contacts), so a device can play its dupe sound instead of its contact sound; always present on a first `log-ok` from a shack with the capability, absent from older shacks (treat absent as `false`). A save that failed is this message with `success: false` and `error`, as before: that is the device's save-failed sound. |
| `qso-milestone` | S→C | A daily contact milestone was reached: `{milestone, count, mega, message}`. Counted per UTC day over the active operator's logbook, from every log path; each milestone is sent once per UTC day, and none for contacts made before the desktop started. **From 2026-11-24 (#1041, server capability `qso-sounds`)** the milestones are 1, 10, 25, 50, 100 and 250 (they were 10, 25, 50, 100, 150, 200, 250, 500). `message` is the banner text, ready to show: `First contact today` at 1, otherwise `N contacts today` (`10 contacts today`). `mega` is always `false`. 150, 200 and 500 are no longer sent, and the 500 message (`500 QSOs today! You are UNSTOPPABLE!`, `mega: true`) is retired. When several milestones are passed at once, only the highest is sent. The message is sent when the contact is saved (it used to wait for the next full re-read of the log). The fields and their types are unchanged, so an older phone, one without an update, needs nothing: it shows its existing cat pop with the new text at 1, 10, 25, 50, 100 and 250, it no longer shows one at 150 or 200, and it never shows the full-screen 500 celebration. A device that plays sounds decides by itself whether to play one (it logged the contact: its own `log-ok`), following "sound follows the operator": the desktop stays silent for a contact a device logged. The list and the text are lib/qso-sounds.js (`MILESTONES`, `milestoneText`). |
| `get-all-qsos` | C→S | Request the full QSO log. |
| `all-qsos` | S→C | Full QSO log payload. Chunked when the client hello advertises `chunked-all-qsos`; otherwise one frame capped to the most-recent 2000 records AND 256KB (`truncated: true` when cut). |
| `qso-added` | S→C | Incremental append after a QSO save, sent only to clients advertising `qso-delta` — replaces the full `all-qsos` re-push on every save. `data` = one record in `all-qsos` shape, `total` = new log length; if `total` ≠ local count + 1 the client should resync via `get-all-qsos`. |
| `update-qso` | C→S | Edit a QSO by index. Optional `identity` (#988): the record's `APP_POTACAT_UUID`, `CALL`, `QSO_DATE`, `TIME_ON`, `BAND`, `MODE` as received; the shack then edits only that QSO and refuses (`success: false`, `reason: 'not-found'` or `'ambiguous'`) when no single record matches. |
| `qso-updated` | S→C | Edit confirmation broadcast. `idx` is the record's position in the log at the time of the edit. |
| `delete-qso` | C→S | Delete a QSO by index. Optional `identity`, as for `update-qso`. |
| `qso-deleted` | S→C | Delete confirmation broadcast. `success: true` only when the record left the log file; `idx` is the position it was removed from (shift later records down by one). |
| `lookup-call` | C→S | QRZ lookup proxied through the desktop (avoids storing creds on phone). |
| `qrz-lookup` | C→S | Alternate alias used in some paths. |
| `call-lookup` | S→C | Lookup result. |
| `search-parks` | C→S | Park name/ref search. |
| `nearby-parks` | C→S | Distance-sorted parks around `{lat, lon, limit?}` — powers "Parks near me" on the mobile activation-start screen. |
| `nearby-park-results` | S→C | Reply: parks nearest-first, each with `distanceMi` and `bearingDeg`. |
| `park-results` | S→C | Park search results. |
| `get-past-activations` | C→S | History of past activations for a park. |
| `past-activations` | S→C | Past-activation results. |
| `get-activation-map-data` | C→S | Map data for an activation (contacts on map). |
| `activation-map-data` | S→C | Map payload. |

### Worked-parks / directory / donors

| Message | Dir | Purpose |
|---|---|---|
| `directory` | S→C | Directory data for the Directory view: `nets`, `swl`, `userNets`, `landmarks`, `landmarkCategories`, `ncdxf`, `channels` (the chart, on every push), and (#329, capability `favorites`) `landmarkFavorites` / `channelFavorites`: the ids this operator starred, in starred order (lib/favorites.js). |
| `favorite-set` | C→S | Star or unstar: `{kind: "landmark" or "channel", id, on?}` (`on` omitted = toggle). The shack saves it and re-sends `directory` to every client. Refused for a Guest Pass (the owner's settings). Capability `favorites`. |
| `donor-callsigns` | S→C | List of donor callsigns to highlight in the UI. |

### JTCAT (FT8 engine)

| Message | Dir | Purpose |
|---|---|---|
| `jtcat-start` | C→S | Start the FT8 engine. |
| `jtcat-stop` | C→S | Stop the FT8 engine. |
| `jtcat-status` | S→C | Engine state (running, mode, slot timing, etc.). Optional `idleRx` (`wspr` / `psk31` / `jtty`): the engine is the shack's idle receive, nobody's session; the FT8 tab takes it over on open with `jtcat-start` (2026-11-12). |
| `jtcat-set-mode` | C→S | FT8 / FT4 / FT2 / WSPR. |
| `jtcat-set-band` | C→S | Switch band (informs JTCAT of TX freq). |
| `jtcat-set-tx-freq` | C→S | TX audio frequency offset (Hz). |
| `jtcat-set-tx-slot` | C→S | Even / odd / auto slot. |
| `jtcat-rx-gain` | C→S | RX audio gain into the decoder. |
| `jtcat-tx-gain` | C→S | TX audio gain out to the rig. |
| `jtcat-enable-tx` | C→S | Enable TX in the cycle. |
| `jtcat-halt-tx` | C→S | Stop TX immediately. |
| `jtcat-call-cq` | C→S | CQ message (with optional POTA/SOTA modifier). |
| `jtcat-reply` | C→S | Reply to a decoded callsign. |
| `jtcat-cancel-qso` | C→S | Abandon current QSO. |
| `jtcat-set-pref` | C→S | `{ key, value }`: set one per-profile JTCAT preference from the shack's allow-list (lib/remote-bridge.js `JTCAT_PREFS`); a wrong type is ignored. Refused for a Guest Pass. `jtcatCallingTimeMin` (number, ADDED 2026-11-22, #161): minutes the shack's FT8/FT4/FT2 transmit watchdog allows with no QSO progress and no operator action before it stops TX; the shack clamps it to 1-30, default 6. The settings blob (`auth-ok`, `settings-update`) carries it as an optional field, already clamped, and a change from any device is followed by `settings-update`. Optional: a client that never shows it changes nothing, the shack enforces the watchdog for every owner. |
| `jtcat-skip-phase` | C→S | Skip to next QSO phase. Optional `unconfirmed: true` (2026-11-20, #807): send the 73 for the QSO the retry cap stopped unlogged, and nothing else. |
| `jtcat-log-qso` | C→S | Log the current FT8 QSO. |
| `jtcat-auto-cq-mode` | C→S | Hunt filter `{ mode }`: `off` / `pota` / `sota` / `all` / `fd` (Field Day, seasonal) / `event` (Hunt: Event stations — answer CQs from tracked-event stations still needed; offer it only while `jtcat-auto-cq-state.eventHunt.available`). |
| `jtcat-auto-cq-state` | S→C | Current hunt mode `{ mode, fallback, workedCount, eventHunt: { available, events: [{ id, name, badge }] } }`. Broadcast on change AND hydrated at connect (since 1.10.16). `eventHunt` is the shack's decision on whether the `event` mode is on offer (opted-in checklist event within 24 h of its window); a client renders the option from it and keeps the option while `mode === 'event'`. |
| `jtcat-decode` | S→C | Single decode result (live feed). |
| `jtcat-decode-batch` | S→C | Batch of decodes (initial backlog). |
| `jtcat-wspr-spots` | S→C | Latest 2-min WSPR spot batch `{ spots[], error? }` — host-enriched (dBm, distance, bearing, DXCC). Replaces the list each cycle; replayed on reconnect. |
| `jtcat-wspr-beacon` | C→S | Drive the WSPR beacon `{ enabled?, txPct?, dBm?, dBmAuto?, runMin?, runAsked? }` (partial = leave unchanged). The client sends intent only: the host owns the beacon's RF power, the reported dBm, the attended watchdog and the TX path. Reported power (since 2026-11-13, #268): `dBmAuto: true` = report the beacon's own RF power (the default); `dBmAuto: false` with `dBm` = report that fixed value. `dBm` is 0..60 and snapped down to a WSPR value (ending in 0, 3 or 7). A `dBm` alone (no `dBmAuto`, no `enabled`) is a fixed pick. A `dBm` that rides an `enabled` toggle without `dBmAuto` (a client from before Auto) never turns Auto off. |
| `jtcat-wspr-beacon-state` | S→C | Authoritative beacon on/off `{ enabled, runMin?, runAsked?, slotTx?, txPct?, dBm?, dBmAuto?, beaconWatts? }`. The client sets its toggle from this (confirm/revert), never optimistically. Since 2026-11-13 (#268): `dBm` = the value the beacon reports now (Auto: the highest WSPR value not above `beaconWatts`, e.g. 5 W = 37 dBm), `dBmAuto`, `beaconWatts` = the RF power the beacon runs at (1 W, or the level the operator set while armed). Also sent, with `enabled` as it stands, whenever one of these changes (a new pick, or the operator moving the RF power while the beacon is armed); replayed on reconnect. The connect message's `settings.wsprDbm` is likewise the value reported now (it can be above 30) and `settings.wsprDbmAuto` the mode. Show `dBm` as the reported power; offer Auto plus 0..60 dBm (WSPR values) as the choices. |
| `jtcat-cycle` | S→C | Cycle boundary tick (for slot indicators). |
| `jtcat-tx-status` | S→C | Currently transmitting? what message? what slot? `{ state: 'tx' \| 'rx', message?, slot?, txFreq?, durMs?, sliceId? }`. `txFreq` (Hz, optional) is the engine's TX audio offset; on a `state: 'tx'` status it is the offset THAT transmission went out on, stamped at key-down. Clients show it in the df cell of their own TX row in the Activity list, rounded to whole Hz, keeping the value from that status rather than the current slider (#503, desktop 1.14.5; no wire change, the field was already sent). Missing or 0: the cell stays blank. |
| `jtcat-qso-state` | S→C | Active QSO phase tracker. `{ phase: 'error', error, send73? }` = TX stopped; `send73: true` (desktop, 2026-11-20, #807) means the stopped QSO had reports both ways but their RR73 never came, so it is NOT logged; show a Send 73 button that sends `{ type: 'jtcat-skip-phase', unconfirmed: true }`, which puts that QSO's 73 on the air and logs it (within 5 minutes, while no other QSO has started; with `unconfirmed` it never acts on a newer QSO). A QSO is logged only when our RR73/RRR/73 goes out or theirs is received. |
| `jtcat-qso-logged` | S→C | A JTCAT contact was written to the shack's log: `{ callsign, band, mode, grid, rstSent, rstRcvd, parksText, parksNote }`. `parksText` is ready to show: `at US-1111`, `at US-1111 and US-2222`, `at DE-1197, DE-0941 and DE-0034`, or `''` when the contact was not at a park. `parksNote` names the parks read from the activator's own spot comment (JTCAT option `jtcatNferParks`): `US-2222: from their own spot comment`, or `''`. Sent at the moment of the write, not cached or replayed, and **only to a client whose `hello.capabilities` include `jtcat-qso-logged`** (an older client never receives it), and never to a Guest Pass session. Toast when `parksNote` is set: `Logged <callsign> <parksText> (<parksNote>)`; ECHOCAT Web shows nothing new for a contact without a note and never replaces an error toast. Added 2026-11-12. |
| `jtcat-spectrum` | S→C | Waterfall spectrum bins for the popout. |
| `jtcat-waterfall` | C→S | Request the spectrum stream (start/stop). |
| `jtcat-start-multi-remote` | C→S | Multi-slice JTCAT (Flex). |

### Activity ("now") feed + idle-session results

What the station is doing right now, so a client can open INTO the running
activity (idle WSPR, JS8, an SSTV decode worth waiting out) instead of a
stale tab. Gated by the `activity` entry in the server hello's
`capabilities`. All of it is cached server-side **even with no client
connected** — the caches exist precisely for the results accumulated while
nobody was watching — and hydrated on every auth path (paired legacy,
paired hello, Guest Pass), `activity-state` first so the client can route
before content arrives.

| Message | Dir | Purpose |
|---|---|---|
| `activity-state` | S→C | `{activity, auto, since, detail, busy}`. `activity`: `idle`\|`jtcat`\|`js8`\|`psk31`\|`wspr`\|`sstv`\|`freedv` — ONE primary activity (a `secondary` field may grow later). `auto` = idle-triggered (Auto-RX) vs operator-started. `since` = ms epoch the current activity began. `detail` is per-activity (wspr: `{dialMHz, hopping, sessionCount}`; js8: `{submode, unread}`; jtcat: `{mode}`; sstv decoding: `{mode, decoding:true}`; sstv armed: `{armed:true, freqKhz}`). `busy` answers "should I wait": `{tx, decoding, progress?, etaMs?}` — during an SSTV decode, `progress` (0–1) and `etaMs` come from observed line pace. Debounced ~150 ms; pushed on every lifecycle edge (engine start/stop/mode, SSTV vis/line/image, PTT edges, Auto-RX transitions, FreeDV lifecycle). |
| `wspr-session` | S→C | `{startedAt, count, active, spots, today?}` — the WSPR session's ACCUMULATED spots (cap 500, oldest dropped; `count` is the session total). This is what the desktop popout shows after an hour of idle WSPR. `active:false` = the session ended (mode changed away) but its results remain serveable; a new session replaces it on the next decode batch. `today` is the per-UTC-day rollup `{date, decoded, uniqueCalls, bestDxMi, bestDxCall, uploadedWsprnet, sentPskr}` — `uploadedWsprnet` = ACCEPTED by wsprnet.org (request/response); `sentPskr` = SENT to PSKReporter (fire-and-forget UDP, no ack — never render "received"). `jtcat-wspr-spots` (latest 2-minute batch, replace-the-list) is unchanged. |

SSTV additions (existing messages, new behavior): `sstv-tx-status`,
`sstv-rx-progress` (only while `mode:'decoding'`) and the LAST
`sstv-rx-image` are now cached and replayed at connect, so a client opening
mid-decode sees the partial state and one opening between decodes sees the
idle session's last picture.

### JS8 (native HF messaging)

JS8 is decoded and transmitted by POTACAT itself (`lib/js8-engine.js` under
JTCAT — no JS8Call application involved). The phone is a full peer of the
desktop JS8 window: the conversation store lives in MAIN
(`lib/js8call-threads.js`), so unread counts, groups and thread contents are
one truth pushed to every surface. Gated by the `js8` entry in the server
hello's `capabilities`.

| Message | Dir | Purpose |
|---|---|---|
| `js8-start` | C→S | Start JS8 (JTCAT rebuilds onto the JS8 engine). Refused for Guest Pass. |
| `js8-stop` | C→S | Stop JS8 (also turns the heartbeat off). Refused for Guest Pass. |
| `js8-heartbeat` | C→S | `{enabled?, intervalMin?}` — toggle the HB scheduler and/or persist the interval (5–60 min). Enable is session-only on the host with a 30-minute attended watchdog (Part 97); the host may therefore turn it off on its own — watch `js8-state.heartbeat`. Refused for Guest Pass. |
| `js8-send` | C→S | `{text, to?, reqId?}` — transmit. The HOST composes the addressed form from `text`+`to` (callsign or `@GROUP`); the phone never implements addressing. `reqId` echoes back on the result. Refused for Guest Pass. |
| `js8-send-result` | S→C | `{ok, error?, text?, frames?, reqId?}` — verdict for a send (also carries Guest Pass refusals and host-side start errors). `text` is the composed on-air form; `frames` how many 15 s periods it will take. |
| `js8-thread-open` | C→S | `{id}` — open a conversation. Marks it read ON THE HOST (the one unread truth) and answers with `js8-thread`. Allowed for guests (read-only). |
| `js8-thread-closed` | C→S | Release the open-thread claim (stops auto-read of new arrivals). |
| `js8-thread` | S→C | `{thread}` — one conversation's full content: `{id, call, isGroup, hbCount, messages:[{dir:'in'\|'out', text, snr?, offset?, utc}]}`. `thread` is null for an unknown id. |
| `js8-state` | S→C | Engine snapshot: `{running, tx, txQueue, submode, heartbeat, heartbeatMin, station:{call, grid}}`. Cached and hydrated at connect. `txQueue` = frames still waiting for their period. |
| `js8-threads` | S→C | Conversation list push: `{list, unread, changed?, thread?}`. `list` rows: `{id, call, isGroup, unread, lastUtc, lastText, lastDir, hbCount, count}`. When one thread changed, `changed` carries its id and `thread` its full content so an open view updates without a round trip. Cached (list+unread only) and hydrated at connect. |
| `js8-log-prefill` | C↔S | C→S `{id, reqId?}` asks the host to extract a QSO prefill from a conversation (`lib/js8-qso.js`: reports each way from the exchange itself, latest-session times, grid, dial+offset frequency); S→C replies `{id, prefill}` (`prefill: null` + `error` when there is nothing to log). The client submits through the existing `log-qso` channel — this message never writes. Refused for Guest Pass (`js8-send-result {ok:false}`) — it writes the owner's logbook and reads DM content. |
| `js8-heard` | S→C | `{list}` — stations audible now: `{call, snr, utc(ms epoch), grid}`, newest first, cap 40. Cached and hydrated at connect. |

Sequencing at connect: `js8-state` → `js8-threads` → `js8-heard` (state first
so the UI gates its controls before content arrives). Guest Pass may browse
(`js8-thread-open`) but every transmit/lifecycle message answers
`js8-send-result {ok:false}` with a reason.

**Guest Pass privacy (2026-08-09): group nets only — No DMs.** For a pass
session, `js8-threads` (hydration and live) carries only `isGroup: true`
rows, `unread` (and `activity-state.detail.unread`) is recomputed over
those rows, a changed-thread delta the guest cannot see drops both
`changed` and `thread`, `js8-thread-open` on a non-group id is refused,
and a guest's group open is read-only on the host (no mark-read, no
attended-watchdog credit, no open-thread claim; guest `js8-thread-closed`
is ignored). The heard rail and engine state are unfiltered — public RF
and non-private respectively. The predicate is the thread store's own
`isGroupTarget`.

### FreeDV (digital voice)

| Message | Dir | Purpose |
|---|---|---|
| `freedv-start` | C→S | Start the FreeDV engine on the shack (`mode` optional). If FreeDV is off in settings the shack replies with `freedv-status` instead. |
| `freedv-stop` | C→S | Stop. The radio audio returns to the track. |
| `freedv-set-mode` | C→S | RADE V1 / 700D / etc. |
| `freedv-set-tx` | C→S | TX enable: `on` (the server also reads `enabled`). FreeDV cannot transmit yet: `on: true` is refused with `ptt-refused { kind: 'freedv', message }` and `tune-blocked { reason }`. |
| `freedv-set-squelch` | C→S | `{ enabled, threshold }` (dB). |
| `freedv-sync` | S→C | `{ sync, snr }` on every engine change. ECHOCAT Web uses it; the phone uses `freedv-status`. |
| `freedv-status` | S→C | `{ state: 'off'\|'starting'\|'running'\|'unavailable', mode, modes[], rx, tx, sync, snr (float dB or null), reason, reasonCode, callsign, callsignAt }`. After every auth-ok and on change; sync/SNR at most 4 per second (a sync flip or a 1 dB SNR move). `reason` is a sentence to show as is; `reasonCode` (`disabled`, `no-decoder`, `too-slow`, `tx-not-built`) is for placement and tests. `tx` is false and `callsign` null until FreeDV transmit exists. Capability `freedv-remote-rx`: decoded FreeDV speech is on the audio track while FreeDV runs (the raw radio audio is muted), at about the level of SSB receive audio. |
| `set-freedv` | C→S | Master FreeDV on/off toggle. |
| `freedv-enabled` | S→C | Server tells client whether the FreeDV master toggle is on (sent at startup + on changes). |

### CW (paddle / keyer / macros)

| Message | Dir | Purpose |
|---|---|---|
| `cw-available` | S→C | CW subsystem ready. |
| `cw-paddle-available` | S→C | Hardware paddle detected. |
| `cw-config` | C→S | Set WPM, mode, key port. |
| `cw-config-ack` | S→C | Config accepted. |
| `cw-state` | S→C | Keying down/up live. |
| `cw-text` | C→S | Send a CW string. | `live:true` = key-as-I-type append chunk (bypasses the duplicate-send guard).
| `cw-stop` | C→S | Cancel CW transmission. Halts the iambic paddle keyer and aborts any in-flight macro / freeform text on the rig (KY buffer flush, SmartSDR cwx clear, pyserial SIGTERM, DTR-timer clear, CAT 0x17 0xFF). |
| `cw-enable` | C→S | Enable/disable the CW key port. |
| `paddle` | C→S | Phone paddle event (dot/dash/space). |
| `cw-key` | C→S | Timed keying from the client's own keyer (server capability `cw-key-stream`, 1.10.27; lib/cw-key-playout.js replays it a jitter buffer behind). `{at, down, ms?}`: `at` the client's time for the edge (ms, any monotonic origin, one clock per streak); `down` with `ms` an iambic element of that length; `down` without `ms` a straight-key press, its key-up arrives separately; `{down: false, cancel: true}` key up at `at` and drop anything queued after it; `{hold: true}` the straight-key keepalive (every 400 ms while held). **Sidetone and air agree** (2026-11-19, #244; lib/cw-sidetone-commit.js): an element is committed when the client's sidetone starts it. The client may withdraw an element only before that, and then it is neither heard nor sent; it sends each iambic element at its commit, never at the keyer's choice, so a withdrawal never goes on the wire. Once sent, the element is keyed in full. `cancel` therefore means a stop (STOP, a mode change, paddle keying lost): the client silences its tone at once and sends `at` = the point in the element where the tone stopped (an element not yet sounding: just before its start), so the shack cuts its copy at the same place. A cancel that reaches the shack after its own time keys up on arrival when it cuts the element now on the air part-way; a cancel whose `at` is before the start of the element now on the air (a withdrawal from an older client) leaves that element to play out in full. Field names unchanged. |
| `save-cw-macros` | C→S | Persist CW macro set. This is the Hunter (S&P) bank, `settings.cwMacros` (#741). |
| settings `remoteCwMacros` | S→C | The Hunter (S&P) CW bank, `[{label, text}]` up to 25. Unchanged since before #741, so an older phone keeps working. |
| settings `remoteCwBanks` | S→C | #741 (2026-11-23): `{run, sp, esm}`. `run` the Activator (Run) bank, `sp` the Hunter (S&P) bank (the same set as `remoteCwMacros`), each `[{label, text}]`; `esm` true when Enter Sends Message is on at the shack. Keys are positional, as N1MM Logger+ lays them out: F1 CQ, F2 exchange, F3 TU, F4 my call, F5 their call, F7 park-to-park exchange (POTACAT's), F8 AGN (lib/cw-banks.js `ROLE_SLOT`). Read only for now: no message writes the Run bank yet, and ESM itself runs in the desktop window. Variables a client fills before `cw-text`: `{CALL}` (alias `{call}`), `{MYSTATE}`, `{PARK}`, `{RST}` (599 sent as 5NN), `{NR}`, `{MYGRID}`, `{op_firstname}`, `{state}`; `{MYCALL}` and `{greeting}` are filled by the shack; anything else in braces must be dropped, never sent (lib/cw-banks.js `expandVars`). |

### SSTV

| Message | Dir | Purpose |
|---|---|---|
| `sstv-open` | C→S | Open SSTV view (starts decoder). |
| `sstv-photo` | C→S | TX a photo (mode chosen client-side). `{image, mode, freqKhz?}`. `image` is a JPEG or PNG data URL (or bare base64) of at most 4 MiB (4,194,304 characters, 2026-11-23); a larger one is refused with `sstv-tx-status` `error` and never decoded (see "Frame size limits"). `freqKhz` (#357, capability `sstv-send-tune`): the SSTV frequency chosen on the client, a number in kHz. The desktop tunes the radio there BEFORE the picture keys, unless the radio is already within 10 kHz of it. Without `freqKhz` it tunes to the SSTV channel of the radio's band (14.230, 7.171 LSB, 3.845 LSB, 18.161, 21.340, 24.975, 28.680, 50.680) unless the radio is within 10 kHz of an SSTV channel, and to 20 m (day) or 40 m (night) from a band with none. Never to a band the radio is not set up for, never with split on, and never for a Guest Pass picture (the pass is checked where the radio is). Rules: lib/sstv-send.js `sendChannel`. `waitQuiet` (#326, optional boolean, capability `sstv-wait-quiet`): `true` asks the shack to wait for a quiet frequency before this picture keys (see `sstv-tx-status` `waiting`). It can only ask for the wait: absent or `false` leaves the shack's own setting (SSTV window, Sending, "Wait for the frequency to be quiet before sending", off by default) in force, so a Guest Pass client cannot turn the owner's wait off. |
| `sstv-stop` | C→S | Close SSTV. |
| `sstv-halt-tx` | C→S | Cancel an in-progress TX. Since `sstv-wait-quiet` (#326) it also drops a picture that is still waiting for a quiet frequency; nothing is sent. A Guest Pass client cancels only a waiting picture it queued; on anyone else's it gets the same `refused` (`of: 'sstv-halt-tx'`) and the picture keeps waiting. A guest's HALT during a real transmission still stops it. |
| `sstv-send-now` | C→S | #326, capability `sstv-wait-quiet`. `{}`. The picture waiting for a quiet frequency is sent now, busy or not (the operator's own decision; the Send now button). With nothing waiting it does nothing. A Guest Pass client may send it only for a picture that same pass queued; otherwise it is answered with `refused` (`of: 'sstv-send-now'`, text "Not sent or cancelled: that picture was queued by someone else. Only they or the station owner can send it now or cancel it.") and nothing changes. The owner may send any waiting picture. |
| `sstv-get-gallery` | C→S | Pull the RX gallery. |
| `sstv-gallery` | S→C | Gallery payload. |
| `sstv-get-compose` | C→S | Get TX compose state. |
| `sstv-compose-state` | S→C | Compose state push: `{bgDataUrl, texts[], mode}`. Each text: `key, label, x, y, fontSize, bold, italic, color, rotation, visible`, and (#327, capability `sstv-text-styles`) `face` (`""`, `plain` or a lib/sstv-templates.js FONTS id), `fontCss`/`fontWeight` (the face as drawn), `outline`, `shadow`, `spacing` (px at the canvas size sent, scaled with x and fontSize on a 640-wide mode). Rules: lib/sstv-templates.js layerStyle / layerFont. |
| `sstv-rx-image` | S→C | A new RX image is ready. |
| `sstv-rx-progress` | S→C | RX progress (decoded scanlines). |
| `sstv-tx-status` | S→C | TX progress. `{state, durationSec?, freqKhz?, error?}`. `state`: `tx` (with `durationSec`), `rx`, or `auto-rx` (Idle Mode SSTV, with `freqKhz`). `error` (#357, capability `sstv-send-tune`; guest refusals carried it since `sstv-guest-check`): a picture was NOT sent, one plain line saying why ("Picture not sent: 14.105 MHz phone is outside US Extra privileges. ..."). It comes with `rx` or `auto-rx`. Show it on the SSTV status line in place of "Ready" until the next send or the next `sstv-tx-status`; never as a blocking alert. Every picture that is not sent ends in one of these, never in silence. `waiting` (#326, capability `sstv-wait-quiet`): a picture is held until the frequency is quiet, with `{waitedSec, maxWaitSec, quietSec, quietNeedSec, heard}`; `heard` is `busy` (someone is on the frequency), `quiet` (quiet for `quietSec` of `quietNeedSec`, 5 s) or `no-audio` (no receive audio reaches the shack, so it cannot hear; it never sends on a guess). Sent about once a second while it waits. Show "Waiting for the frequency to clear..." with Send now (`sstv-send-now`) and Cancel (`sstv-halt-tx`). It ends in `tx` (sent), or `rx`/`auto-rx` with `error` ("Picture not sent: the frequency stayed busy for 4 minutes." after `maxWaitSec`, 240 s, or "Picture not sent: cancelled while waiting for the frequency to clear."). A client without this capability holds its previous state on an unknown `state`. Rules: lib/sstv-quiet-wait.js. |
| `sstv-wf-bins` | S→C | Waterfall bins for SSTV view. |

### Winlink (email over radio)

The shack holds the mailbox, the Winlink account and the radio session: Pat, the Winlink
client inside POTACAT, runs there, with the modems. A device composes, reads, picks a gateway
and presses Send / Receive; every rule (which modes are offered, which gateways the radio can
call, how a session's end is worded) is decided on the shack and sent as data. Gated by the
`winlink` entry in the server hello's `capabilities`; a shack that handles the account messages also lists
`winlink-account`. Registry: `lib/echocat-protocol.js` (feature `winlink`). Server:
`lib/remote-server.js` (`case 'winlink-list'` onward). Handlers: `winlinkHandleRemote` in
`main.js`.

A POTACAT desktop driving a remote shack (More > Remote Radios) is one of these devices
too, from #299 (2026-11-22): its Winlink Mail window sends the same `winlink-*` messages
and shows the shack's `winlink-state`, `winlink-mailbox`, `winlink-session` and
`winlink-spectrum`, so radio sessions run on the shack's radio. Its hello adds
`mail-folders-v2`. Winlink forms are not on the wire, so that window offers them only on
the shack PC. No new message or field; `lib/remote-bridge.js` and
`lib/winlink-remote-shack.js` hold the mapping.

**Who may send.** The owner's devices only. A Guest Pass session gets
`winlink-refused {reason: 'guest-pass', reqId}` for every C→S message below, is never sent
`winlink-state`, `winlink-mailbox`, `winlink-session` or `winlink-spectrum`, and is not
hydrated.

**Requests and replies.** Every C→S message except `winlink-watch`, `winlink-prompt` and
`winlink-set-mode` may carry `reqId` (string, the first 64 characters are kept). The reply goes
only to the device that asked and repeats the `reqId`. A request has either its own reply
type (named in its row) or `winlink-result {op, ok, error?}`; when the own-type reply cannot
be built, the `winlink-result` with the `op` in the row is sent instead. Only the fields the
registry declares for a type reach the handler. Any request except `winlink-watch` starts Pat
if it is not running yet (the first one can wait up to 15 s).

**Pushes.** `winlink-state`, `winlink-mailbox` and `winlink-session` go to every owner device
when they change, carry no `reqId`, and are cached on the server: a device that connects is
sent the last `winlink-state`, one `winlink-mailbox` per folder already listed, and the last
`winlink-session`.

Folders (`box`): `in`, `out`, `sent`, `archive`, and on a shack that lists `mail-folders-v2`
also `deleted` (see "Folders: Archive, Deleted, Reply all" below). Mode ids: `telnet` (internet), `ardop`,
`packet`, and `vara` / `varafm` when the operator has turned them on at the shack. A client
shows the modes it is sent in `winlink-state.modes` and nothing else.

#### State, mailbox and session (S→C pushes)

| Message | Dir | Purpose |
|---|---|---|
| `winlink-state` | S→C | The one payload every surface renders; fields in the table below. Never carries the password or a message body. Sent coalesced (about 50 ms) after any change, and again with every `winlink-session`. |
| `winlink-mailbox` | S→C | One folder: `{box, messages[], total}`. `messages` = the newest 500, newest first, without bodies; `total` = how many the folder holds. Each message: `mid`, `box`, `from`, `to[]`, `cc[]`, `subject`, `date`, `read` (always true outside `in`), `p2pOnly`, `attachments[{name, size}]`. Pushed to every owner device when a folder changes; also the reply to `winlink-list` (then with `reqId`). |
| `winlink-session` | S→C | `{session}`: the running or last session; fields in the table below. Pushed on every change: progress, PTT, a prompt, the end. |
| `winlink-spectrum` | S→C | The waterfall, about 10 a second, only to owner devices that sent `winlink-watch {on: true}`; a frame is dropped, never queued, for a device whose socket is behind. `bins` = 128 values over 0 to 3000 Hz (0 = noise floor, 255 = +50 dB); `lo`, `hi` = the modem's band as fractions of that width, with `label`; `busy` and `peakDb` = the Busy / Clear verdict, decided on the shack. Optional (#669): `inputDb` = the modem's receive input level, whole dBFS, peak held 0.5 s (null = no audio: show nothing); `inputHot` = true at or above -3 dBFS (show "Input too high"). Rule: `lib/winlink-wf-audio.js` `wireInput`. A shack without them omits both. |
| `winlink-refused` | S→C | `{reason: 'guest-pass', reqId?}`: a Guest Pass session sent a Winlink message. The only reason in use. |

`winlink-state` fields:

| Field | Type | Meaning |
|---|---|---|
| `enabled` | boolean | Winlink is available on this shack. Always `true` from the current desktop. |
| `patStarted` | boolean | Pat is running. `false` = not started yet, not an error: any request starts it. |
| `patReady`, `patError` | boolean, string | Pat answered and can be used; if not, why. |
| `mycall` | string | The station callsign, upper case. |
| `hasPassword` | boolean | A Winlink password is saved on the shack. The password itself is never sent. |
| `noticeAccepted`, `noticeText` | boolean, string | Whether the operator accepted the Winlink notice, and its text. Sending is refused until it is accepted (`winlink-accept-notice`). |
| `mode` | string | The mode in use: the saved choice if it is available, else the first that is. |
| `modes` | array | `[{id, label, available, reason}]`: every mode the shack offers, in display order. `reason` says why an unavailable one is unavailable, in words to show as they are. |
| `unread`, `counts` | integer, object | Unread messages in `in`; `{in, out, sent, archive}` totals, plus `deleted` from a shack with `mail-folders-v2`. |
| `deletedDays` | integer | `mail-folders-v2` only: the Deleted folder removes a message for good this many days after it was deleted: `7`, `30` (the default), `90`, or `0` = never. Set at the shack (the Winlink window's Deleted folder, setting `winlinkDeletedDays`). Its presence is how a client knows the shack keeps a Deleted folder. |
| `session` | object | The same object `winlink-session` carries. |
| `autoCheck` | object | The internet auto-check: `{enabled, min, lastAt, lastResult}`. Never a radio session. |
| `lastGateway` | object or null | The gateway of the last radio session: `{call, mode, dialKhz}`. |
| `lastSession` | object or null | `{at, ok, text}` of the last finished session; kept across a shack restart. |
| `favourites` | array | My gateways: `[{call, mode, dialKhz, khz, url, band, savedAt, lastGoodAt}]`. A gateway the operator typed in (#585, Add a gateway) also has `mine: true` and may have `note` (at most 60 characters), `via` (packet digipeaters, 0 to 2 calls) and `bw` (ARDOP Hz: 200, 500, 1000 or 2000). |
| `templates` | array | The operator's message templates: `[{id, name, to, cc, subject, body}]`. The built-in Position report and POTA spot are not in it. |
| `contacts`, `contactGroups` | array | The address book: `[{id, name, address, kind 'winlink' or 'email', note, lastUsedAt}]` and `[{id, name, members[]}]`. |
| `position` | object or null | `{grid, lat, lon, km}`: the centre of the station's grid and how far off it can be; the Position report form's starting point. `null` with no grid set. |
| `predictionOn`, `predictMs` | boolean, object | Whether gateway lists are ranked by predicted propagation, and how long the last ranking took per mode (`{mode: ms}`), so a surface can say how long the next one will take. |
| `ardopBw`, `modemBw` | integer | The ARDOP bandwidth setting (200, 500, 1000 or 2000 Hz) and the bandwidth of the mode in use. |
| `wf` | object | The shack's waterfall settings: `{speed, shown}`. |
| `audio` | object | How the modem's audio reaches the radio: `{needed, ready, viaPotacat, capture, playback, rigName, cable{configured, state, error, capture, playback}}`, and on a sound-card radio `bridge{state, error}` and `packet{needed, ready, capture, playback}`. Nothing for a device to pick: the shack routes it. |

`session` fields:

| Field | Type | Meaning |
|---|---|---|
| `state` | string | `idle`, `starting`, `connecting`, `connected`, `disconnecting`, `done` or `error`. |
| `mode`, `gateway`, `dialKhz`, `url` | string, string, number or null, string | What is being called. For `telnet`, `gateway` is `CMS (internet)` and `dialKhz` is null. |
| `text` | string | The status line, a whole sentence to show as it is. |
| `direction`, `subject`, `bytes`, `total`, `pct` | | The message moving now: `sending` or `receiving`, its subject, and how far along. |
| `sent`, `received` | integer | Messages finished so far in this session. |
| `ptt` | boolean | The shack's radio is transmitting for this session. |
| `startedAt`, `lastProgressAt` | epoch ms | When the session started and when anything last moved. |
| `capSec`, `remainingSec` | integer, integer or null | The session's time limit (radio sessions only) and the seconds left. |
| `tuned`, `returnTo` | boolean, object or null | Whether the shack tuned the radio for the session, and the dial and mode it goes back to (`{freqHz, mode, from}`). |
| `audio` | object | Levels during a radio session, in dB: `rxDb`, and when they apply `toModemDb`, `fromModemDb`, `trimDb`, `boostDb`, `hot`. |
| `prompt` | object or null | A question only the operator can answer; see the busy prompt below. |
| `error`, `errorKind` | string | Set when `state` is `error`. `error` is a whole sentence to show as it is, never Pat's reply. `errorKind` is one of `login-failed`, `no-answer`, `not-connected`, `dropped` (the link came up, then ended before the exchange finished), `transport-down`, `rig-refused`, `stopped`, `failed`, or a `vara-` kind (`vara-not-answering`, `vara-not-running`, `vara-not-found`, `vara-not-configured`). |
| `outcome` | object or null | How the session ended, worded once on the shack for every surface (`lib/winlink-outcome.js`): `{kind, word, title, detail, next, retry}`. `word` is `Finished`, `Link dropped`, `No answer`, `Not connected`, `Stopped` or `Failed`; `title` says what happened, `detail` what moved and what is still in the Outbox, `next` what to do; `retry` = trying the same gateway again is a sensible next step. The automatic retry adds `retryState` (`counting`, `waiting-clear`, `starting`, `cancelled`, `skipped`; absent when none was considered), `retryInS` (seconds left while `counting`, else 0) and `retryText` (the sentence to show as it is); while `counting` or `waiting-clear` a client shows Try now and Cancel (`winlink-retry`) in place of Try again and OK. `session.autoRetry` marks the retry session itself. `text` (state `done`) and `error` (state `error`) are the same sentences joined. The Outbox sentence can arrive a moment after the end, in a second push. |
| `result` | object or null | After a good radio session: `{call, mode, khz, dialKhz, url, band, sent, received, saved}`, for a card that offers to save the gateway to My gateways (`saved` = already there). |

**The busy prompt.** When the modem hears the channel in use, Pat waits for it to clear and
the session carries `prompt: {id, kind: 'busy-channel', message, at, limitSec: 300,
waitedSec}`. The device shows how long it has waited and offers two answers with
`winlink-prompt {id, value}`: `continue` (call now; the operator has listened and decides) or
`abort`. Any other value is ignored for a busy prompt. `prompt` goes back to `null` when it
is answered, when the channel clears, or when Pat gives up after `limitSec`. Other prompt
kinds from Pat (an account-activation message to accept) use the same two messages, and
`value` is passed to Pat as sent. Pat's password prompt is answered by the shack from the
saved password and is not shown.

#### Mail

| Message | Dir | Purpose |
|---|---|---|
| `winlink-list` | C→S | `{box}`: refresh one folder from Pat. Reply: `winlink-mailbox`. An unknown `box` is read as `in`. |
| `winlink-read` | C→S | `{box, mid}`: one message with its body. Reply: `winlink-message`, else `winlink-result {op: 'read'}`. Reading an unread message in `in` marks it read on the shack; a `winlink-mailbox` and a `winlink-state` push follow. |
| `winlink-message` | S→C | `{box, mid, message}`: the message as in `winlink-mailbox`, plus `body`, and `sentRoute` when the shack kept one (see below). To the asker only. |
| `winlink-attachment-get` | C→S | `{box, mid, name}`: one attachment. Reply: `winlink-attachment`, else `winlink-result {op: 'attachment'}`. An attachment over 2 MB is refused with an error. |
| `winlink-attachment` | S→C | `{box, mid, name, size, dataBase64}`. To the asker only. |
| `winlink-delete` | C→S | `{box, mid}`: delete a message. On a shack with `mail-folders-v2` this MOVES it to `deleted` (from `in`, `out`, `sent` or `archive`; from `out` it is no longer sent), and in `deleted` it removes it for good. An older shack removes it for good. Reply: `winlink-result {op: 'delete'}`; the folders are pushed again. |
| `winlink-move` | C→S | `mail-folders-v2` only. `{box, mid, to}`: move one message. Allowed: `in` or `sent` to `archive` (Archive); `archive` to `in` or `sent` (Move to Inbox / Move to Sent); `in`, `out`, `sent` or `archive` to `deleted` (the same as `winlink-delete`); `deleted` to `in`, `out`, `sent` or `archive` (Restore; `to` empty = the folder it was deleted from). Anything else is refused with an `error`. Reply: `winlink-result {op: 'move'}`; both folders are pushed again. An older shack drops the type and never replies. |
| `winlink-compose` | C→S | `{to, subject, cc?, body?, p2p?, attachments?}`: put a message in the Outbox; it goes out on the next session. `attachments` = `[{name, dataBase64}]`, the first 10 are taken. Refused until the notice is accepted. A message to the POTA spot address is split into one message per line of its body. Reply: `winlink-result {op: 'compose'}`. |
| `winlink-template` | C→S | `{op, id?, name?, to?, cc?, subject?, body?}`: `op` `save` (a new template, or the one with `id`) or `delete` (`id`). Reply: `winlink-result {op: 'template'}`; the list follows in `winlink-state.templates`. |
| `winlink-contact` | C→S | `{op, id?, name?, address?, note?}`: `op` `save` or `delete`, as for templates. Reply: `winlink-result {op: 'contact'}`; the list follows in `winlink-state.contacts`. |
| `winlink-contact-group` | C→S | `{op, id?, name?, members?}`: the same for a group of addresses. Reply: `winlink-result {op: 'contact-group'}`; the list follows in `winlink-state.contactGroups`. |
| `winlink-posreport` | C→S | `{lat?, lon?, comment?}`: queue a Winlink position report in the Outbox. Without `lat` and `lon` the shack uses the centre of its grid, and refuses if no grid is set. Reply: `winlink-result {op: 'posreport'}`. |
| `winlink-pota-spot-get` | C→S | Ask for the POTA spot form, filled in by the shack. Reply: `winlink-pota-spot`. A shack that predates the message does not answer; the device then builds the line itself. |
| `winlink-pota-spot` | S→C | `{to, subject, call, parks[], freqKhz, mode, comment, body, missing[], hint}`: the spot message ready to send with `winlink-compose`. `parks` = the live activation's POTA references; `freqKhz` and `mode` = where the radio was before Winlink moved it; `missing` names what the shack could not fill in, and `hint` says it in words. To the asker only. |

#### Folders: Archive, Deleted, Reply all (#462, #475)

A shack that lists `mail-folders-v2` in its hello's `capabilities` keeps a fifth folder,
`deleted`, and answers `winlink-move`. A client that lists `mail-folders-v2` in its own hello is
pushed `winlink-mailbox {box: 'deleted'}` (in hydration and on every change); an older client is
never sent that folder. Any client may ask for it with `winlink-list {box: 'deleted'}`.

- **Where it lives.** Inside Pat's mailbox directory for the station (`<mbox>/<MYCALL>/deleted/`),
  beside Pat's four. Delete saves the message as Pat gives it (body included) to
  `deleted/<mid>.json` with `fromBox` and `deletedAt`, then Pat moves `<mid>.b2f` there. The folder
  is listed and read from those copies, so it works while Pat is stopped. Restore is Pat's move back
  (a message restored to `out` is put back by the shack with the same rename: Pat's API cannot move
  into the Outbox).
- **`winlink-mailbox {box: 'deleted'}` rows** are the message as in any folder, plus `fromBox` (the
  folder it was deleted from) and `deletedAt` (ISO time). `winlink-message` for a deleted message
  carries the same two fields and the body. `winlink-attachment-get` does not work in `deleted`
  (Pat cannot read that folder): restore the message first.
- **Emptying.** At Winlink start and once a day, the shack removes for good every message deleted
  more than `winlink-state.deletedDays` days ago (`0` = never).
- **Reply all** is a client action, not a message: `winlink-compose` with `to` = the sender and `cc`
  = every address in the original To and Cc except the station's own (the bare call and
  `call@winlink.org`, any case, any SSID) and except the sender, each once
  (`lib/winlink-mail-actions.js` `replyAll`). It is a separate button beside Reply, never the
  default. It works with any shack.
- **Words** (`lib/winlink-mail-actions.js`): buttons `Reply`, `Reply all`, `Forward`, `Archive`,
  `Move to Inbox` / `Move to Sent` (in Archive: Sent when the station sent it, else Inbox), `Delete`
  (`Delete (do not send)` in the Outbox), and in Deleted `Restore to <folder>` and `Delete for good`,
  which asks once on the button itself: `Delete for good? It cannot be brought back.`

#### How a sent message went out (`message.sentRoute`, #442, added 2026-11-13)

Pat records nothing about how a message left. When a session ends, the shack gives each message
that was in the Outbox when the session started, is gone from it, and is now in Sent one record,
kept by message id (`lib/winlink-sent-routes.js`). Archive and Deleted keep the id, so they keep it.

- **Where.** `winlink-message.message.sentRoute`, for `box` `sent`, `archive` and `deleted` only,
  and only when the shack kept a record. Messages sent before 2026-11-13 (POTACAT before this
  change), or sent by another program, have none: show nothing, never a guess. Never on `in` or
  `out`, never in `winlink-mailbox` rows.
- **Fields.** `{mode, transport, sentAt, gateway?, dialKhz?}`. `mode`: `telnet`, `ardop`, `packet`,
  `vara`, `varafm`, `mercury`. `transport`: `internet` (telnet) or `radio`. `sentAt`: ISO time the
  session ended (the message left during it). `gateway` (upper case, with SSID) and `dialKhz` (the
  dial, kHz) on radio routes only, each when known.
- **Words** (`lib/winlink-mail-actions.js` `sentRouteLine`), one line in the reader:
  `Sent 13 Nov 2026 at 14:32 UTC via W5ABC on 7.102 MHz (ARDOP).` or
  `Sent 13 Nov 2026 at 14:32 UTC over the internet.` Mode words: ARDOP, Packet, VARA HF, VARA FM,
  Mercury. The dial is in MHz with at least three decimals (145.050 MHz, 10.1455 MHz).
- Additive: an older client ignores the field; an older shack never sends it.

#### Gateways and sessions

| Message | Dir | Purpose |
|---|---|---|
| `winlink-gateways-get` | C→S | `{mode, band?, refresh?}`: the gateway list for a mode. Reply: `winlink-gateways`, else `winlink-result {op: 'gateways'}`. With ranking on, an HF list can take up to two minutes. `refresh: true` (optional, from 2026-11-22) is a Refresh button: the shack downloads a fresh list from Winlink first. Without it the shack still downloads one by itself when its list is over 24 hours old or the service codes changed. When the download fails the reply carries the list the shack had, plus an optional `listNote` string saying so (older shacks ignore `refresh` and never send `listNote`). |
| `winlink-gateways` | S→C | `{mode, band, list[], predicted, note, leftOut}`. Each row: `call`, `grid`, `distKm`, `bearing`, `modes`, `freqKhz`, `dialKhz`, `band`, `url`, `quality` (0 to 100, or null with no prediction), `qualityWord`; optional `serviceCode` (the Winlink service code, '' when unknown) and `serviceTag` (that code when it is not PUBLIC, shown after the call); optional `ownModem` (from 2026-11-22): the service code of a gateway Winlink lists under this mode that really runs a community modem a standard one cannot connect to (DATA2G, MODEM73, VARDEFM, IONHF). Those rows come after all the others, grouped by code; a client shows them under "Needs its own modem (service code X)" and still lets the operator connect. Older shacks never send it. The order is the shack's: by predicted link quality when `predicted`, else nearest first; `note` says which, in words. Only gateways the radio can call are listed; `leftOut` counts the rest. To the asker only. |
| `winlink-history-get` | C→S | Every gateway the operator has called. Reply: `winlink-history`, else `winlink-result {op: 'history'}`. |
| `winlink-history` | S→C | `{gateways[]}`, newest first, at most 300, one row per gateway, mode and dial: `call`, `mode`, `dialKhz`, `band`, `tries`, `good`, `lastAt`, `lastGoodAt`, `lastResult`, `lastOk`, `saved` (in My gateways). To the asker only. |
| `winlink-favourite` | C→S | `{op, call, mode, dialKhz, url?, mine?, note?, via?, bw?, was?}`: `op` `add`, `remove` or `edit` a gateway in My gateways. A gateway typed in (#585) sends `mine: true` with its `note`, `via` and `bw`; `edit` also sends `was: {call, mode, dialKhz}`, the entry it replaces. Fields that are not valid are dropped and the entry is kept. Reply: `winlink-result {op: 'favourite'}`; the list follows in `winlink-state.favourites`. |
| `winlink-set-mode` | C→S | `{mode}`: save the mode to use. No reply; a `winlink-state` push follows. A mode the shack does not know is ignored. |
| `winlink-qsy` | C→S | `{dialKhz, mode?, gateway?}`: a gateway was picked, not yet called: tune the shack's radio there so the waterfall shows that frequency. Refused while a session runs, while another part of POTACAT has the radio, or for a frequency the radio cannot reach. The dial from before the first pick is remembered. `gateway` (#585) is the picked call: a gateway the operator typed in (a `mine` entry in the shack's My gateways) is checked against the radio's range only, never the bands. Reply: `winlink-result {op: 'qsy'}`. |
| `winlink-qsy-restore` | C→S | The device is leaving its Mail tab: put the dial back where it was before the first `winlink-qsy`. Nothing happens if nothing moved; during a session the radio goes back when the session ends; while another Mail view is open (the desktop's mail window or another device's Mail tab) the radio stays until the last one closes. Reply: `winlink-result {op: 'qsy-restore'}`. |
| `winlink-mail-view` | C→S | `{open}`: this device's Mail tab is open (`true`) or closed (`false`). Send `true` when the tab opens and again after each `auth-ok` while it is open; send `false` when it closes, then `winlink-qsy-restore` as today. Capability `winlink-mail-view`. No reply. See "Staying on the gateway" below. |
| `winlink-connect` | C→S | `{mode, gateway?, dialKhz?, url?}`: start a session, the same as Send / Receive at the shack. `telnet` needs only `mode`. `url` is the gateway row's own `url` from `winlink-gateways` (it carries the bandwidth) and is checked against `gateway` and `mode`. Refused, with the reason as `error`, until the notice is accepted and a password is saved, while a session runs, for a mode that is not available (its `reason`), and for a frequency the radio cannot reach. Reply: `winlink-result {op: 'connect'}` as soon as the session has started (`ok: true`) or was refused; everything after that, the end included, arrives as `winlink-session` pushes. |
| `winlink-abort` | C→S | Stop the running session. Reply: `winlink-result {op: 'abort'}`. |
| `winlink-retry` | C→S | `{op, reqId?}`, `op` = `cancel` or `now`: act on the automatic retry after a dropped link (Cancel, or Try now). Reply: `winlink-result {op: 'retry'}`. Refused for a Guest Pass. |
| `winlink-prompt` | C→S | `{id, value}`: answer `session.prompt` (the busy prompt above). No reply; a `winlink-session` push follows. |
| `winlink-watch` | C→S | `{on}`: subscribe this device to `winlink-spectrum`, or stop. No reply. The shack computes the spectrum only while a device watches; a closed socket ends the subscription. |
| `winlink-result` | S→C | `{op, ok, error?, reqId?}`: the outcome of a request, to the asker only. `error` is a sentence to show. `op` is one of `read`, `attachment`, `delete`, `move`, `compose`, `template`, `contact`, `contact-group`, `posreport`, `gateways`, `history`, `favourite`, `qsy`, `qsy-restore`, `connect`, `abort`, `retry`, `accept-notice`, `account-check`, `set-password`, `register`, `recovery-email`. |

#### Staying on the gateway

After a radio session (finished or failed) the radio stays on the gateway's frequency while a Mail
view is open, so the operator can look at the band; it goes back to the dial from before the first
gateway pick when the last view closes. A Mail view is the desktop's mail window or a device's Mail
tab: a shack that lists `winlink-mail-view` in its hello's `capabilities` counts each device that
sent `winlink-mail-view {open: true}`, by its connection. With no view open, a session goes back
1.5 s after it ends, as before.

- A device leaving its Mail tab sends `winlink-mail-view {open: false}` and `winlink-qsy-restore`.
  The radio goes back only if no other view is open.
- A closed socket counts as closed. If that device was the only view and a return is pending, the
  shack waits 30 s (`GONE_GRACE_MS` in `lib/winlink-mail-views.js`) for it to reconnect and say
  `{open: true}` again before the radio goes back.
- A Guest Pass is refused (no Mail tab). A shack without the capability does not count devices: do
  not send the message to it; the radio goes back after a session as before.

#### My own gateways (#585, added 2026-11-22)

A gateway the operator types in ("Add a gateway") is a My gateways entry with `mine: true`. The
desktop mail window, ECHOCAT Web and the phone show the same form, the same words and the same
list. The rules live in `lib/winlink-my-gateways.js`.

**Capability.** A shack that lists `winlink-mine` in its hello's `capabilities`:
- checks and stores `mine`, `note`, `via` and `bw` from `winlink-favourite`;
- answers `op: 'edit'` (with `was`);
- sends the fields back in `winlink-state.favourites`.

An older shack's registry does not declare those fields, so its demux drops them and it saves a
plain favourite (call, mode, dial): the gateway works, without the Mine tag, the note or the path.
`edit` is unknown there. A client whose shack lacks `winlink-mine` still sends the message and shows
one line on its Add form: "The shack is on an older POTACAT: it saves this as a plain favorite,
without the Mine tag or the note. Update POTACAT on the shack to keep them."

**Fields** (`winlink-favourite`, C→S, and each `winlink-state.favourites[]` entry):

| Field | Type | Rule |
|---|---|---|
| `call` | string | A callsign with an optional `-SSID` from 0 to 15 (`W2XYZ-10`), upper case. |
| `mode` | string | `ardop`, `vara`, `varafm`, `packet` or `mercury`, one the shack has available. |
| `dialKhz` | number | The radio dial in kHz, up to 1,500,000. For `ardop`, `vara` and `mercury` it is the center frequency minus 1.5 kHz; for `packet` and `varafm` it is the channel frequency. |
| `mine` | boolean | `true` for a typed gateway. |
| `note` | string | Up to 60 characters, printable, trimmed. |
| `via` | string array | Packet only: 0 to 2 digipeater calls, in order. |
| `bw` | number | ARDOP only: 200, 500, 1000 or 2000 Hz. Absent or 0 is the operator's own setting, which always caps it. |
| `was` | object | `edit` only: `{call, mode, dialKhz}` of the entry it replaces. |

- **Limits.** Mine entries are capped at 40 per profile, separately from the 40 starred gateways.
- **Checking.** The shack checks a Mine entry before saving it and refuses with the form's words
  (`winlink-result {op: 'favourite', ok: false, error}`):
  - "That is not a callsign. Use the gateway's call, with -10 or similar if it has one."
  - "Enter the frequency, for example 145.05 or 7101.4."
  - "Via takes up to two digipeater calls, for example W2ABC-1."
  - "Keep the note to 60 characters or fewer."
- **Band rule.** A typed gateway skips the band checks and keeps only the radio-range check. The
  shack decides that from its own saved entry, looked up by the `gateway` call on `winlink-qsy` and
  `winlink-connect`. It never reads `mine` from a request.
- **Connecting.** Send `winlink-connect {mode, gateway, dialKhz}` with no `url`. The shack builds
  the URL with the entry's via path and bandwidth.
- **Guest Pass.** Refused, as every `winlink-*` message is. The owner's gateways are not shown to a
  guest and cannot be changed by one.

Examples:

```json
{"type":"winlink-favourite","op":"add","call":"K4SPB","mode":"ardop","dialKhz":7099.9,"mine":true,"note":"club net Tuesdays","bw":500,"reqId":"fav1"}
{"type":"winlink-favourite","op":"add","call":"W2XYZ-10","mode":"packet","dialKhz":145050,"mine":true,"via":["W2ABC-1"],"reqId":"fav2"}
{"type":"winlink-favourite","op":"edit","call":"K4SPB","mode":"ardop","dialKhz":7099.9,"mine":true,"note":"club net Thursdays","bw":500,"was":{"call":"K4SPB","mode":"ardop","dialKhz":7099.9},"reqId":"fav3"}
{"type":"winlink-favourite","op":"remove","call":"K4SPB","mode":"ardop","dialKhz":7099.9,"reqId":"fav4"}
{"type":"winlink-result","op":"favourite","ok":true,"reqId":"fav1"}
```

ECHOCAT Web (`renderer/remote.js`) shows "My own gateways" above Pat's rows on the Send / Receive
screen, each row tagged `Mine`, with "Add a gateway" under the list and Edit and Remove for a picked
Mine row. Remove asks once ("Remove K4SPB? Click again"). After a save the shack answers, then the
page picks the gateway and sends `winlink-qsy` with its call, as a pick does. Nothing transmits.

#### Account

A shack that handles these lists `winlink-account` in its hello's `capabilities`
(`winlink-accept-notice` needs only `winlink`). The password is never sent to a device on any
message.

| Message | Dir | Purpose |
|---|---|---|
| `winlink-accept-notice` | C→S | The operator read and accepted the Winlink notice (`winlink-state.noticeText`). Reply: `winlink-result {op: 'accept-notice'}`; a `winlink-state` push follows. |
| `winlink-account-check` | C→S | Does a Winlink account exist for the station's callsign? Reply: `winlink-account`, else `winlink-result {op: 'account-check'}`. |
| `winlink-account` | S→C | `{callsign, exists}`. To the asker only. |
| `winlink-set-password` | C→S | `{password}`: the password of an existing account. Saved on the shack; Pat restarts with it. Refused while a session runs. Reply: `winlink-result {op: 'set-password'}`; `winlink-state.hasPassword` follows. |
| `winlink-register` | C→S | `{password, recoveryEmail?}`: create the Winlink account for the station's callsign. Reply: `winlink-result {op: 'register'}`; `winlink-state.hasPassword` follows. |
| `winlink-recovery-email-get` | C→S | Read the account's password-recovery address. Reply: `winlink-recovery-email`, else `winlink-result {op: 'recovery-email'}`. |
| `winlink-recovery-email-set` | C→S | `{email}`: change it. Reply: `winlink-result {op: 'recovery-email'}`. |
| `winlink-recovery-email` | S→C | `{email}`. To the asker only. |

#### The Flex pan on the Winlink channel (added 2026-11-15)

A shack that lists `scope-winlink-view` in its hello's `capabilities` centres a Flex panadapter on
the Winlink modem's channel, so a Mail tab that draws the shack's scope shows the signal in the
middle.

| Message | Dir | Purpose |
|---|---|---|
| `scope-digital-view` | C→S | `{on, view?}`. `view: 'winlink'`: while this device's Mail tab shows the shack's scope (it must also be subscribed with `scope-subscribe`), ask for the Winlink view; `{on: false, view: 'winlink'}` ends it. No `view` (or any other value) is the JTCAT view, as before. Each view is asked and ended on its own, per device; a closed socket ends both. No reply. |

- **The view.** Centred on the modem's channel at its RF position: the centre of
  `lib/winlink-spectrum.js` `markerBand` (1500 Hz audio for ARDOP, VARA HF and Mercury), above the
  dial on USB/DIGU, below it on LSB/DIGL. On DIGU/DIGL the slice's `digu_offset` / `digl_offset`
  moves it to where the signal really is (DIGU: dial + audio - offset; DIGL: dial - audio +
  offset). 6000 Hz wide, never narrower than the radio's `min_bw`. No view on FM.
- **When.** While a Winlink radio session runs (the shack does this by itself, whatever any device
  asks), or while a device asks for it. A running session wins over the JTCAT view; a device's ask
  comes after the JTCAT view.
- **What a device sees.** The usual `scope-state`, with `centerOffsetHz` (where the pan really is,
  Hz from the dial) and `decodeWindow` `{lo, hi}` (the modem's channel, Hz from the dial, negative
  below it), exactly as for the JTCAT view. Draw the channel marks from `decodeWindow`.
- **The end.** When the session ends and no device asks, the pan goes back to the operator's own
  zoom, centred on the dial, as the JTCAT view does.
- Flex Direct only; other scopes ignore the ask.

### APRS (phase 6, added 2026-11-18)

APRS on a client through the desktop: the station list and map of the desktop's
More > APRS window, "Listen on my radio", the receive-only iGate switch and the
**internet** beacon. Rules: `lib/aprs-echocat.js`; tests:
`test/aprs-echocat-test.js`, `test/aprs-echocat-wire-test.js`.

**Capability.** The shack's `hello` lists `aprs`. A client that lists `aprs` in
its own `hello` gets `aprs-state` (on connect and on every change) and, while it
is subscribed, `aprs-stations`. A client that does not list it gets neither, and
its APRS requests are ignored, so an older phone sees no change. The radio
beacon (phase 7) is not on the wire.

A POTACAT desktop driving a remote shack (More > Remote Radios) lists `aprs`
too, from #868 (2026-11-21): its APRS window's listen switch and band picker
send `aprs-listen`, it subscribes while that window is open (and unsubscribes
when it closes, so the shack stops listening the desktop started), and it shows
the shack's `aprs-state.listen` and the `aprs-stations` rows with `rf` (the ones
the shack's radio heard). No new message or field; `lib/remote-bridge.js` and
`lib/aprs-remote-shack.js` hold the mapping.

| Message | Dir | Purpose |
|---|---|---|
| `aprs-subscribe` | C→S | `{on: boolean, rangeKm?: number}`. Start or stop watching. On `on: true` the shack sends this device a snapshot (`aprs-stations` `op: 'snapshot'`), then deltas. The APRS-IS feed runs while the desktop's APRS window is open **or** any device is subscribed, and stops after the last device leaves (unsubscribe or disconnect) with the window closed. `rangeKm` sets the feed's radius (clamped 10 to 1000 km, not saved) only while the desktop window is closed; with the window open the window's range holds. Send it when the APRS view (or the Map's APRS layer) comes on screen and `on: false` when it leaves. A Guest Pass may subscribe. |
| `aprs-listen` | C→S | `{on: boolean, band?: '2m' \| '30m'}`. The window's "Listen on my radio" switch and band chips, through the same functions (`aprsListenSetBand`, then `aprsListenSet`), so the same gates and refusal sentences apply (they come back in `aprs-state.listen.sentence`). Counts as the operator using the radio (an APRS idle session ends, as at the window). Listening a device turned on stops when that device leaves, unless the desktop APRS window is open (then closing the window stops it, as before). A Guest Pass may listen on the radio it is operating; listening a guest turned on never gates to APRS-IS. |
| `aprs-igate` | C→S | `{on: boolean}`. The desktop setting "Report what I hear to APRS-IS (iGate)" (`settings.aprsIgate`), saved as Settings saves it. It gates only while the radio listens. **Refused to a Guest Pass** (on or off): `refused` with `of: 'aprs-igate'` and the text "APRS beacons and the iGate go out under the owner's callsign, so they are not part of a Guest Pass." (`lib/pass-wording.js`, kind `callsign`). |
| `aprs-beacon-is` | C→S | `{}`. The window's "Beacon now": one position beacon over **APRS-IS only** (CALL-10, the desktop's beacon settings, approximate position by default). Nothing is transmitted on the air. Same refusals as the window (no callsign, placeholder callsign, no position, APRS-IS not verified), shown in `aprs-state.beacon.sentence`. The beacon timer stays a desktop-window feature. **Refused to a Guest Pass** with the same `refused` text as `aprs-igate`. |
| `aprs-beacon-rf` | C→S | `{band?}` (2026-11-21, Casey's go). ONE position beacon **over the radio**: the window's "Beacon now (radio)" run, with the same gate (lib/aprs-rf-gate.js), config swap and transmit cap; the press counts as the APRS window being open. With Listen on, it goes out on the listening band. With Listen off, the desktop sets the radio up for the beacon (it starts listening on `band`, or the chosen band, which tunes, sets the mode and filter), sends, then stops listening so the radio goes back where it was. Nothing repeats and there is no timer. Refusals: `refused {of: 'aprs-beacon-rf', reason, text}` to that device only (`busy`, `not-ready`, `setup`, `not-sent`, with the gate's own sentence). **Refused to a Guest Pass.** |
| `aprs-find` | C→S | `{call: string}` (2026-11-21, Casey's go). Follow ONE call on APRS-IS **beyond** `rangeKm`: the desktop adds a budlist term (`b/CALL`) to its read-only APRS-IS filter, next to the range filter, and sends `#filter` on the live connection. `K5ABC` (no SSID) follows K5ABC and every SSID of it (`b/K5ABC/K5ABC-*`); `K5ABC-9` follows that station only. Rows for the call arrive in `aprs-stations` like any other (whatever the distance) and are not aged out while the find is on; a row already held goes out again in the next delta so the phone can centre on it. APRS-IS does not replay history, so a call silent since the desktop connected appears when it next sends. One call per device: a new `aprs-find` replaces that device's old one. `{call: ''}` stops; unsubscribing (`aprs-subscribe {on: false}`) or disconnecting stops it too. The callsign must be 3 to 7 letters and digits (at least one of each) with an optional `-SSID` of 1 or 2 characters; nothing else reaches the filter. At most 10 calls across every device. Refusals, to that device only: `refused {of: 'aprs-find', reason, text}` with `reason` `bad-call`, `not-subscribed` (send `aprs-subscribe {on: true}` first) or `full`. Read only: nothing transmits and nothing goes out under the owner's callsign, so **a Guest Pass may find**, as it may subscribe. |
| `aprs-view` | C→S | `{n, s, e, w}` (2026-11-22, Casey's go; `lib/aprs-view.js`). **Map view**: the internet stations follow the phone's map. Degrees of the map's visible area, sent once per settled pan or zoom; `w > e` means the box crosses the antimeridian. `{}` (no fields) stops; unsubscribing (`aprs-subscribe {on: false}`) or disconnecting stops it too. The same box again is ignored. The desktop adds an area term `a/latN/lonW/latS/lonE` to its read-only APRS-IS filter (two terms across the antimeridian) and sends `#filter` on the live connection. The box is capped to about 4000 km on its longest side (width measured on the box's widest parallel), centre kept; `aprs-state.feed.area` says what this device got. **Several devices**: one area per device, each capped on its own (a union of two phones far apart would be one huge box the cap would centre over neither), at most 4 devices. **The range term**: it stays beside the areas while the desktop's APRS window is open or any subscribed device has no view, so the window's range and a phone on miles keep working; when every subscribed device is on Map view and the window is closed, the areas take its place. Budlist terms (`aprs-find`, heard you) and the message filter stay either way. Every row the desktop holds goes to every subscribed device, so stations inside the box arrive whatever `rangeKm` is; rows that leave the box age out as usual. Checked strictly: all four must be finite JSON numbers, latitude within ±90, longitude within ±180, `n > s`, some width; nothing else reaches the filter. Refusals, to that device only: `refused {of: 'aprs-view', reason, text}` with `reason` `bad-view`, `not-subscribed` (send `aprs-subscribe {on: true}` first) or `full` (4 other devices are on Map view). Read only, nothing transmits: **a Guest Pass may send it**, as it may subscribe. |
| `aprs-state` | S→C | Coalesced to at most one every 500 ms. Fields below. |
| `aprs-state.beacon.rf` | (field) | The radio beacon for the phone's confirm (2026-11-21): `{ready, setup, sentence, band, mhz, modeLabel, powerW, airSeconds, sending, lastAt, lastResult, lastSentence}`. `setup: true` = Listen is off and the desktop will set the radio up for the press. `sentence` says why `ready` is false. `lastResult` is `confirmed` (the radio reported transmit), `unconfirmed` (keyed, no readback from this radio) or `not-sent`. `airSeconds` is known only while listening. The top-level `mayBeaconRf` is true for an owner device when `rf.ready`. Heard you (2026-11-22): `rf.heard: {until, count, lastAt}`. `until` is the epoch ms the internet watch after the last confirmed radio beacon ends (0 when closed); `count` is how many stations heard the last beacon; `lastAt` is the newest report (0 = none). "Not heard yet" while `until` is in the future and `count` is 0. |
| `aprs-stations` | S→C | Station rows; only to a subscribed `aprs` client. `op: 'snapshot'`: `{stations: Row[], chunk, totalChunks, total}`, byte-bounded chunks (200 KB, like `worked-qsos`), always at least one (an empty store sends one empty chunk); replace the list once the last chunk (`chunk + 1 === totalChunks`) is in. `op: 'delta'`: `{add: Row[], update: Row[], gone: key[], total}`, batched every 1.5 s, never empty. Treat `add` and `update` as upserts by `key`. `gone`: not heard for 60 minutes, or a killed object or item. |

`aprs-state`:

```
{
  type: 'aprs-state',
  feed:   { state: 'off'|'stopped'|'connecting'|'connected'|'waiting'|'refused'|'no-grid', server, km, anonymous, subscribers,
            area: { n, s, e, w, capped } | null },   // Map view (2026-11-22): this device's own area as asked of APRS-IS; capped: cut to 4000 km a side ("Zoom in for more")
  listen: { on, state: 'off'|'starting'|'listening'|'paused'|'refused', band, bands: ['2m','30m'],
            modeLabel, mhz, heard, lastAt, sentence, note },
  igate:  { on, active, call, link: 'stopped'|'connecting'|'connected'|'verified'|'unverified'|'waiting',
            gated, lastAt, lastFrom, sentence, paused },   // paused: "iGate paused: a guest has the radio" while a Guest Pass runs, else ''
  beacon: { call, lastAt, lastPacket, sending, sentence, backAt, timerOn, nextAt,
            position: { lat, lon, source: 'map'|'grid', approx } | null },   // never more exact than the packet: whole minutes unless approx is false
  refusal: string,      // the one sentence to show: listen (refused or paused), else beacon, else iGate; '' = none
  mayBeacon: boolean,   // false on a Guest Pass: hide the beacon button
  mayIgate: boolean     // false on a Guest Pass: hide the iGate switch
}
```

`sentence` and `note` are the desktop window's words, shown as they are. When the radio
moves off the APRS frequency or mode while listening (a spot click, a phone tune, the VFO knob),
listening pauses with `on: false, state: 'refused'` and `sentence` "Paused: your radio moved. Your
radio is on 14.317 MHz USB. Turn listening on to go back to 30 m." (following the radio as it moves);
`aprs-listen {on: true}` is the normal start and tunes back to APRS. No new field. Times
are epoch ms (0 = never). `listen.bands` is what this rig can listen on (empty =
none); `listen.band` is the band it listens on, or would start on. `beacon.backAt
>= beacon.lastAt` means the beacon came back over APRS-IS.

Row (one station or object):

```
{ key, call, label, type: 'position'|'object'|'item'|..., lat, lon,
  symbol,          // APRS table + code, 2 characters, e.g. '/>'
  cls,             // 'car'|'house'|'digi'|'igate'|'weather'|'hiker'|'boat'|'aircraft'|'other' (lib/aprs-symbols.js)
  course, speed,   // degrees and knots, or null
  altitude, comment, status,
  lastHeard,       // epoch ms, any source
  isHeard,         // epoch ms APRS-IS last reported it, or null
  heardByMe,       // the shack's radio heard it
  rf: { kind: 'direct'|'digi', digi, lastHeard, packets, band, bands } | null,
  distanceKm, bearing,    // from the shack's grid, or null
  heardMe: { at, by: 'igate'|'digi', beacons, lastBeaconAt } | null }
```

**Heard you** (2026-11-22, `lib/aprs-heard-you.js`). After every radio beacon the
radio reported transmitting (the window's button, `aprs-beacon-rf`, a timer), the
desktop keeps its read-only APRS-IS feed up for 15 minutes from that beacon, even
with the APRS window closed and no device subscribed (each new beacon restarts
the 15 minutes; switching APRS-IS off in the window ends it). It adds the
beacon's source call (with SSID, exactly as sent, e.g. `b/K3SBP-1`) to the feed's
budlist. When the beacon comes back from APRS-IS, the call after `qAR`, `qAO`,
`qAr` or `qAo` is an iGate that heard it (`by: 'igate'`; `qAC`/`qAS`/`qAX`/`qAI`/`qAZ`
do not count, nor does this shack's own login), and each path call marked `*`
before the q construct is a digipeater that heard it (`by: 'digi'`; aliases such
as WIDE1 and calls with no digit are skipped). A packet from the beacon call that
the shack's own radio heard via a digipeater names that digipeater too. Each such
station is budlisted (exact call) so its next position beacon arrives; until then
its row has `lat`/`lon` null. `heardMe.at` is the last time it heard a beacon of
mine, `beacons` how many of my beacons it heard, `lastBeaconAt` the beacon it heard
last. A row with `heardMe` goes to every subscribed device whatever its `rangeKm`
(the feed asks for it by call) and is kept 60 minutes after `heardMe.at`; then
`heardMe` goes back to null (sent as an update) and the row follows the normal
rules. APRS-IS drops duplicates, so each beacon names the first iGate in plus any
digipeaters; several beacons collect more. Budlist terms for this are capped at 10
(the beacon call plus the 9 most recent reporters), **alongside** the 10 `aprs-find`
calls, not inside them. Owner and guest alike; read only, nothing transmits.

`rf.band` (2026-11-21): the band the shack's radio was listening on when it last
heard this station, `'2m'` or `'30m'`; `''` when not known (a packet the desktop
could not tag), so infer from `aprs-state.listen.band` only then. `rf.bands`:
every band the radio heard it on while the shack has held the row, shortest
wavelength first (`['2m', '30m']`), for a "Both" filter. Rows heard only on
APRS-IS have `rf: null`. Older desktops send neither field.

`key` is the callsign, or `obj:<NAME>` for an object or item. Draw `cls` with
the desktop's icon set (renderer/aprs-icons.js: a round badge per class, car,
boat and aircraft turned to `course`). Idle Mode's `aprs` choice stays on
`set-idle-rx` (capability `idle-mode`).

### Cloud (the shack's POTACAT Cloud account)

> **Scope (updated 2026-11-21):** the browser ECHOCAT (`renderer/remote.html`
> Settings > Cloud Sync) and the ECHOCAT phone apps both use these. They act on
> the account the desktop is signed in to, through the desktop's own session:
> signing up from a phone (`cloud-register`) starts the desktop's trial and turns
> on its Cloud Sync, and a payment started on the phone (`cloud-stripe-checkout`)
> pays for that account. The phone apps also talk to `api.potacat.com` directly
> for the phone's own sign-in. A Guest Pass session gets none of them (each is
> refused with `guest_pass` or at the wall).

| Message | Dir | Purpose |
|---|---|---|
| `cloud-login` | C→S | Log in to POTACAT cloud account. |
| `cloud-login-result` | S→C | Login result. |
| `cloud-register` | C→S | Sign up. |
| `cloud-register-result` | S→C | Sign-up result. |
| `cloud-logout` | C→S | Log out. |
| `cloud-tunnel-enable` | C→S | (capability `cloud-tunnel-enable`, 2026-11-21) An owner device turns the shack's Cloud Tunnel ON. Only while the account is signed in and has Cloud access (trial or paid); it also clears the desktop's remembered "turned off by hand". Refused to a Guest Pass (`guest_pass`). Turning the tunnel off is not offered to a device. |
| `cloud-tunnel-result` | S→C | `{ok, error?, message?}`: `ok:true` when the tunnel is on (or already was); `error` is `guest_pass`, `signed_out`, `no_access` or `not_ready`, with `message` in plain words. The tunnel's new state also arrives as `cloud-state` where that is supported. |
| `cloud-logout-result` | S→C | Logout confirmation. |
| `cloud-get-status` | C→S | Sync status query. |
| `cloud-status` | S→C | Status response. Also pushed unasked, as `{ loggedIn: false }`, to owner clients (never Guest Pass clients) when POTACAT Cloud signs the shack out because it was removed from the account (`device_revoked`, 2026-11-20). |
| `cloud-sync-now` | C→S | Force a sync. |
| `cloud-sync-result` | S→C | Sync result. |
| `cloud-bulk-upload` | C→S | Push all local QSOs to cloud. |
| `cloud-upload-result` | S→C | Bulk-upload result. |
| `cloud-verify-subscription` | C→S | Check active subscription tier. |
| `cloud-verify-result` | S→C | Subscription tier response. |
| `cloud-save-bmac-email` | C→S | Save Buy-Me-A-Coffee email for benefit lookup. |
| `cloud-bmac-result` | S→C | BMAC lookup result. |
| `cloud-stripe-checkout` | C→S | `{plan: 'monthly'\|'yearly'}`: a Stripe checkout URL for the desktop's account. The client opens it itself; the desktop watches for the payment and pushes `cloud-billing-state` when it lands. Capability `cloud-billing`. |
| `cloud-stripe-portal` | C→S | The Stripe customer portal URL for the desktop's account. |
| `cloud-stripe-result` | S→C | `{kind: 'checkout'\|'portal', url?, plan?, error?, message?}`. |
| `cloud-billing-state` | S→C | `{subscription?, reason?, localQsos?}`: pushed when the account's billing changes (a payment landed, a trial ended). |
| `cloud-checkout-state` | S→C | `{phase, plan?, stripeConfigured?}`: where a checkout the desktop is watching stands. |

### KiwiSDR / WebSDR

| Message | Dir | Purpose |
|---|---|---|
| `kiwi-connect` | C→S | Connect to an SDR: a KiwiSDR, a WebSDR station or an rtl_tcp server. `{host?, id?, password?}`; no `host` = the station's first listed SDR. |
| `kiwi-disconnect` | C→S | Disconnect. |
| `kiwi-tune` | C→S | `{freqKhz, mode?}`: tune the connected SDR (`freqKhz` may be a string, as for `tune`). Ignored when no SDR is connected. |
| `refused` | S→C | `{reason: 'guest-pass', of, text, reqId?}`: the shack will not do that for this Guest Pass session. Show `text` as it is; `of` is the message type, for the client's own use, never for display. |

**Guest Pass (2026-11-14, #543).** A pass session may send all three SDR
messages, for the SDRs the owner has already set up at the station (the
entries in `kiwiSdrList` and the `kiwiSdrHost1..3` slot keys of the settings
the guest receives). A `kiwi-connect` must name one of them: by the entry's
`id` when it has one, or by its exact host and port (scheme, trailing slash,
an inline `password@` and letter case are ignored; no port is 8073), or send
no `host` for the first one. The shack connects with the owner's own entry,
never the guest's string or `password`. Any other host or port is answered
with `refused`, `of: 'kiwi-connect'`, `text: "On a Guest Pass you can use the
station's own SDRs, not add a new one."`. A guest never edits the list: a
`save-settings` carrying any SDR key (`kiwiSdrList`, `kiwiSdrHost`,
`kiwiSdrHost1..3`, `kiwiSdrLabel1..3`) is not saved, is answered with
`settings-update` (the owner's settings as they are) and then the same
`refused` text with `of: 'save-settings'`. Rule: lib/guest-sdr.js. Before
2026-11-14 the shack refused all three SDR messages for a pass session.

(KiwiSDR audio/state events are sent over the existing audio channel and
the broader `status` message; no dedicated S→C envelope today.)

### Voice macros / settings

| Message | Dir | Purpose |
|---|---|---|
| `voice-macro-sync` | ↔ | Voice-macro recording. C→S: phone uploads. S→C: desktop pushes existing recordings to a new client. Fields: `idx`, `label`, `audio` (base64 WebM). |
| `voice-macro-delete` | C→S | Remove a stored recording. |
| `voice-macro-labels` | S→C | Five-slot label array for voice-macro buttons (sent on connect + on changes). |
| `save-echo-pref` | C→S | Persist an ECHOCAT-only preference (no settings.json round-trip). |
| `jtcat-psk-rx` | S→C | PSK31 RX character batch {chars, freqHz, snrDb, metric}; hydration replays carry `replay:true`. Registered 2026-08-20 from observed frames. |
| `jtcat-psk-send` | C→S | PSK31 one-shot transmit; `text` goes verbatim (varicode is case-sensitive). |
| `jtcat-psk-set-sql` | C→S | PSK31 squelch 10-90; routed through the popout's clamp+persist handler. |
| `freq-other` | S→C | Other-VFO (TX) frequency while split is on; 0 = hide. Cached + hydrated. |
| `fwd-power` | S→C | Measured forward watts during TX (Flex TX bridge); decays to 0 after TX. Distinct from `power` (setting) and `tx-meter` (TX audio peak). |
| `solar-data` | S→C | Solar blob (sfi/kIndex/aIndex + bands/kpHistory/alerts) — same payload as the desktop Conditions panel. Cached + hydrated. |
| `save-custom-cat-buttons` | C→S | Save user-defined raw-CAT buttons for the Rig table. | Entries are `{name, command}` plus additive per-type fields (2026-08-19): `type` (`button` default / `toggle` / `slider`), `commandOff` (toggle), `min`/`max`/`value` (slider; the client substitutes `{v}`/`{v2}`/`{v3}`/`{v4}` placeholders and sends the FINAL string via `send-custom-cat` — the server never interprets templates). Clients that predate a field must PRESERVE unknown entry fields on save, not strip them; an older client rendering a toggle as a plain button sends only the On command, which is acceptable degradation. **#164 (2026-11-22, additive):** up to 25 entries (the desktop caps a save at 25 and no longer pads the list to five; `customCatButtons` in `settings-update` carries exactly the saved entries). Optional per-entry `rigs` (string array of rig ids, the `id` values of the `rigs` message's `data`): absent or empty = the button shows for every radio; otherwise it shows only while `activeRigId` (from the `rigs` message) is in the list. Clients show only programmed entries (a `name` or a `command`) that pass that filter, save the WHOLE list (every radio's buttons, never only the visible ones), and keep `rigs` and every other unknown field on save. Entries saved before #164 have no `rigs` and show everywhere. |
| `colorblind-mode` | S→C | Server says colorblind mode is on (affects accent colors). |
| `cluster-state` | S→C | DX-cluster connection state for the cluster badge. |
| `qrz-names` | S→C | `{CALLSIGN: 'First Last'}` map after a batch QRZ lookup — drives the spot-row Name column. |

### Diagnostics (Unified Bug Report)

Canonical contract: `status/brief-bug-report-{desktop,mobile}.md`.

| Message | Dir | Purpose |
|---|---|---|
| `request-diagnostic` | ↔ | "Report a Bug" on either side asks the other for a diagnostic snapshot. Fields: `requestId` (string, echoed in the reply), `redact` (optional bool — when true the reply is safe to paste into a PUBLIC report). |
| `diagnostic-snapshot` | ↔ | Reply carrying the SAME `requestId`. Fields: `source` (`"desktop"`/`"mobile"`), `appVersion`, `platform` (object `{os, osVersion, deviceModel}`), `timestamp` (ISO 8601 string), `sections` (object — see below), and `error` (string, present instead of `sections` on refusal/failure). |

Both types are **bidirectional** (`Dir.BOTH`) — either side can be requester
or responder. `sections` is an untyped any-bag so it can evolve in lockstep
with the mobile `BugReportAssembler` without a protocol-version bump. Desktop
sections: `account`, `connection`, `pairedDevices`, `rig`, `tailscale`,
`cloudTunnel`, `logLines` (`string[]`); mobile adds `network` and omits the
desktop-only ones. Every field except `requestId` is optional: a refused or
failed gather returns `error` and no `sections` so the requester never sits
on its 5s timeout. When `redact:true`, the responder masks email, IPs (to
/24, loopback preserved), and JWT/Bearer/long-token strings in `logLines`.
Both sides advertise `diagnostic-snapshot` in their `hello.capabilities` so
the requester short-circuits to NOT REACHABLE against an old peer instead of
waiting on the timeout. **Security deviation (desktop):** a Guest Pass
session is refused (`error: "not-authorized"`) rather than handed the host's
diagnostics.

### Pairing (new in v1, see Phase 0 plan)

| Message | Dir | Purpose |
|---|---|---|
| *(none yet — pairing happens via HTTP `POST /api/pair`, not WebSocket)* | | |

#### HTTP PTT shortcut (`/api/ptt/on`, `/off`, `/toggle`)

For Apple Shortcuts, Stream Deck HTTP actions and similar native callers, on
the LAN and the tailnet only (over the Cloud Tunnel it is the 503 stub). Any
method; `?token=` is required only when the operator requires a token; the
reply is `{ptt: true|false}`. Since 2026-11-22:

- The reply carries **no** `Access-Control-Allow-Origin`, so another web page
  cannot read it.
- A request with an `Origin` header that is not this server, or with a
  `Sec-Fetch-Site` header other than `same-origin` or `none`, is refused with
  403 and nothing keys. Native callers send neither header; a URL typed into
  a browser or opened from a bookmark sends `Sec-Fetch-Site: none`. A request
  started by another web page (an image, a form, a script) is refused.
- From a public address with the Cloud Tunnel off it is refused unless a
  token is set (see "Who may connect").

Since 2026-11-23 (lib/ptt-api-gate.js), when the server is in its plain-HTTP
fallback (it could not create its TLS certificate at start and the Cloud
Tunnel is off). Browsers send no `Sec-Fetch-*` to an `http://` URL and an
image request carries no `Origin`, so the rule above cannot see a web page
there:

- A call that would key the radio (`on`, or `toggle` while receiving) is
  refused with 403 and nothing keys, unless "Require a password" is on and
  the right `?token=` is given. The reply is
  `{error: "PTT over plain HTTP is refused: ..."}` and says to restart
  POTACAT or use the password; POTACAT logs it once a minute.
- Releasing is never refused by this rule: `off`, and `toggle` while
  transmitting, unkey as before (with the token when the password is on,
  as on HTTPS). Unkeying is the safe direction.
- Over HTTPS nothing changed.

Each successful call writes `pttApiLastUsed` (ISO time) and
`pttApiLastRoute` (`https` or `http`) to `ptt-api-usage.json` in POTACAT's
user-data folder, at most once a minute. It is local only: not in the
settings object, so never exported, sent to a device, device-writable or
sent to POTACAT Cloud.

#### ECHOCAT Web over POTACAT Cloud (HTTP, 2026-09-11)

A browser on the public tunnel (`https://<callsign>.potacat.com`) never
sees a token box. Anonymous `GET /` is a **constant** static connect
page (no version, callsign, or renderer source — the e696ad5 leak rule
still holds; every other tunnel path stays the 503 stub). It links to
`https://login.potacat.com/?station=<host>` (owner) or
`?guest=1&station=<host>` (Guest Pass), and the sign-in page bounces the
browser back with a URL **fragment** (never sent to Cloudflare or the
desktop's log): `#pair=<pairToken>` or `#pass=<code>.<sessionId>`. The
connect page strips the fragment (`history.replaceState`) and posts it:

| Endpoint | Body | Result |
|---|---|---|
| `POST /api/pair-account` | `{pairToken, web:true}` | Same cloud attestation as the mobile app's pair (`verify-pair-token` in main.js, `account_mismatch` enforced by the cloud), but the paired device is `platform:'web'`, named from the User-Agent ("Browser on Chrome (Windows)"), never expires, and the device token goes into an HttpOnly cookie **`__Host-echocat_device`** (`Secure; SameSite=Strict; Path=/; Max-Age=1y`). The JSON reply carries `ok:true` and **omits `deviceToken`** — the page never holds it. Without `web:true` the reply is unchanged (mobile/desktop clients still get `deviceToken`). Requires `Origin` = our host. |
| `POST /api/pass-gate` | `{passCode, sessionId}` | Runs the desktop's existing pass validator (cloud `validate-session`); on success sets **`__Host-echocat_pass`** = `<code>.<sessionId>` with `Max-Age = min(expires_at − now, 7 d)` and replies `{ok, ownerCallsign, expiresAt}`. 404 `pass_invalid`, 410 `pass_invalid` (already expired), 503 `owner_station_offline` / `pass_validate_failed`, 403 `origin`. Requires `Origin` = our host; JSON only (no form encoding, so no login-CSRF). |
| `POST /api/web-signout` | *(none)* | Clears both cookies; for an owner session also **revokes the browser's paired-device row**. `{ok:true}`. Requires `Origin`. The web client calls this on any cookie/WS disagreement before reloading, so it can never reload-loop. |

With a valid cookie, `GET /` serves the SPA with `window.__authMode="cookie"`
and the WebSocket upgrade (cookie attached by the browser) is
pre-authenticated exactly like the device-token branch — `auth-mode:
cookie` then `auth-ok` (`accountLinked:true` for owners; `passSession`
for guests). Revoking the browser in Settings › ECHOCAT › My devices
closes its socket (`revoked`, 4004) and its next `GET /` is the connect
page again with a clearing `Set-Cookie`. Tunnel-sourced POSTs to
`/api/pair`, `/api/pair-account`, `/api/pass-gate` are rate-limited per
`cf-connecting-ip` (`FailureRateLimiter`, same tiers as the cloud's
`rateLimitPasses`).

#### Pairing QR payload

The desktop emits a `potacat://pair?<params>` URL encoded into a QR code
(generated by the `echocat-create-pairing-qr` IPC handler in `main.js`).
The mobile app scans it to bootstrap a paired-device record.

| Param | Required | Meaning |
|---|---|---|
| `host` | yes | LAN WebSocket URL — `wss://<ip-or-tailscale-name>:7300`. The phone connects here first. |
| `token` | yes | One-time pairing token minted by `remoteServer.createPairingToken()`. Short-lived (5 min default; 60 min when shared via messaging). |
| `fp` | yes | SHA-256 fingerprint of the desktop's TLS cert. The phone pins this for the LAN connection. |
| `spki` | **optional** *(added 2026-08-28, cert-pin Phase 2a)* | SHA-256 (lower-hex) of the cert's SubjectPublicKeyInfo DER. Stable across cert reissues (the desktop persists its keypair); changes only on a genuine key reset. Phones that store it at pair time verify by SPKI and never hit the rotated-fingerprint re-pair path. Absent on desktops older than 1.10.13. |
| `name` | yes | `os.hostname()` of the desktop — shown in the phone's paired-device list. |
| `cloudHost` | **optional** *(added 2026-06-01 for POTACAT Cloud)* | The CF-tunneled hostname, e.g. `k3sbp.potacat.com` (the pattern is `<callsign>.potacat.com`; always returned by the cloud /provision endpoint, never constructed client-side). Present only when the desktop has POTACAT Cloud enabled and the tunnel is provisioned (file `userData/cloud-tunnel.json` exists with `enabled:true`). Phone uses LAN first; falls back to `wss://<cloudHost>` over CA-signed TLS (skip pinning on this hostname only — LAN keeps pinning). Absent ⇒ LAN-only pairing. |

Mobile parsing: treat `cloudHost` as optional and forward-compatible. New
fields may appear in future builds — existing fields will never change
meaning.

## Cross-references

- Server → client send sites: `lib/remote-server.js` — search `_sendTo(`,
  `broadcast*`, `this._client.send`.
- Server → client message constructors and lifecycle:
  `lib/remote-server.js` lines 597–1736 cover the bulk.
- Client → server send sites: `renderer/remote.js` — search
  `ws.send(JSON.stringify({type:`.
- Client inbound dispatcher: `renderer/remote.js` — search
  `function handleMessage` / the big `switch (msg.type)`.
- Schemas of record: [`lib/echocat-protocol.js`](../lib/echocat-protocol.js).
- Protocol tests: [`test/echocat-protocol.test.js`](../test/echocat-protocol.test.js).
- Headless smoke client: [`scripts/echocat-cli.js`](../scripts/echocat-cli.js).

## Known oddities / cleanup candidates

These are documented for the next protocol pass — none block v1.

- `qrz-lookup` and `lookup-call` are siblings; one is the inbound C→S
  alias and one is the S→C result, but the names look symmetric. Worth
  renaming the result to `lookup-call-result` in v2.
- `sdp` and `ice` (C→S) predate the unified `signal` envelope. Already
  redundant; keep accepting them for legacy clients but stop sending
  them from new clients.
- `vfo-profiles` is bidirectional (push of profile list S→C; the new
  list after edit C→S). Renaming the C→S form to `vfo-profiles-set`
  would be cleaner; left as-is for compatibility.
- `toggle-rotor` is a stub; no rotator integration exists yet. Either
  delete or build the feature in v2.
- The `status` message is a kitchen-sink snapshot. Splitting it into
  topical messages (`vfo-status`, `rig-meters`, `rig-flags`) would
  reduce wire chatter, but bumps the protocol version.
