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

## Message catalog

Format: each row is `name — direction — purpose`. Directions:
**S→C** (server-to-client), **C→S** (client-to-server), **↔** (both).

### Handshake / auth / connection

| Message | Dir | Purpose |
|---|---|---|
| `hello` | ↔ | Version + capability handshake (new in v1). Server-side `hello` also carries top-level `rigModel` (string, e.g. `"Flex 8600M"`, `"FTDX10"`) so POTACAT-desktop clients can label paired shacks in the Remote Radios panel — empty string when no rig is configured. |
| `auth-mode` | S→C | Tell client which auth mode the server is configured for (`token`, `callsign`, `cloud`). |
| `auth` | C→S | Submit credentials (token / callsign+password / cloud token). |
| `auth-ok` | S→C | Auth succeeded. Bundles initial feature flags and settings. Per-device-token auths also include `expiresAt` (epoch ms or `null` for no-expiry — trusted / account-linked devices), `accountLinked` (bool — pair came in via Cloud-attested flow), and `trusted` (bool — operator marked the device "my own"). Absent for the legacy single-shared-token path and Guest Pass auth. Also carries the shack's CURRENT alternate dials + trust info on every connect: `tsHost`, `cloudHost`, `tsCertPublic` (true = served cert is a Tailscale-issued LE cert, validate normally, no pin; absent/false = self-signed, pin `fingerprint`), and `fingerprint` (SHA-256 colon-hex of the cert being presented NOW — also the no-re-pair recovery for a rotated cert). A client paired cloud-only should ADOPT `tsHost` from here rather than treating the pairing as frozen. |
| `alt-hosts` | S→C | Mid-session update of the same alternate-dial fields `auth-ok` carries (`tsHost`, `cloudHost`, `tsCertPublic`, `fingerprint`) — pushed when the values actually change (operator signs into Tailscale, Cloud Tunnel comes up/down). Sent since v1.8.5; registered 2026-08-03. |
| `auth-fail` | S→C | Auth rejected with `reason`. New reason in v1.9: `"expired"` — paired device's sliding 180-day token elapsed without a reconnect; client should route to the re-pair UI. |
| `kicked` | S→C | Server bumped this client because another connected. Carries `byPlatform`, `byVersion`, `byHost` so the displaced client can render a friendly "another device took over" banner instead of a mystery disconnect. |
| `revoked` | S→C | The shack operator revoked this device's pairing **while it was connected** (Settings → paired devices → Revoke). Carries `reason` (display string). Sent immediately before the server closes the socket with code `4004`. Unlike `kicked`, the device token no longer exists — the client must drop to its unpaired state and must **not** auto-reconnect (a reconnect gets a terminal `auth-fail`; the server can't distinguish revoked from never-paired once the record is deleted). Only the matching per-device pairing is kicked; legacy shared-token and Guest Pass sessions are unaffected (pass revocation has its own `pass-ended` flow). New 2026-06-12. |
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

### Spots and sources

| Message | Dir | Purpose |
|---|---|---|
| `spots` | S→C | Bulk push of current spot list. |
| `sources` | S→C | Which spot sources are currently enabled (POTA, SOTA, etc.). |
| `set-sources` | C→S | Toggle which spot sources to subscribe to. |
| `echo-filters` | S→C | Server-side filter state (band/mode/distance). `data.muteRules` (2026-08-03) additionally carries the desktop-owned per-band region mutes (`[{continent:'AS', band:'40m'}]` — "hide Asia on 40m", other bands unaffected). Apply them in the spot filter AND display active rules — an invisible filter reads as missing spots. |
| `set-echo-filters` | C→S | Update server-side filter state. Does NOT carry muteRules — they are desktop-owned and merged into `echo-filters` at send, so this message can never clobber them. |
| `set-spot-mute-rules` | C→S | Full-list replace of the per-band region mutes from a client editor. Desktop sanitizes (valid continents, deduped, capped 50) and echoes the accepted set inside the next `echo-filters` push. |
| `worked-parks` | S→C | List of park refs the user has worked (drives ATNO badges). |
| `worked-qsos` | S→C | List of recent worked callsigns/refs (drives "worked" highlighting). |

### Rig control / VFO

The `status` message is a kitchen-sink snapshot. The canonical fields are:

| Field | Type | Notes |
|---|---|---|
| `freq` | number | Hz. **Not `frequency`.** |
| `mode` | string | "USB", "LSB", "CW", "PKTUSB", "FREEDV-RADEV1", … |
| `band` | string | "20m", "40m", … (derived from freq) |
| `catConnected` | boolean | true when CAT or SmartSDR is up |
| `txState` | boolean | true while transmitting |
| `rigType` | string | "flex", "yaesu", "icom", "kenwood", "rigctld", "wsjtx" |
| `nb` | boolean | Noise blanker on/off |
| `preamp` | boolean | Preamp on/off. ADDED 2026-08-03 (was missing — the mobile toggle settling on this echo could never learn it was on, so it re-sent `true` forever and couldn't turn it off; N4RDX) |
| `att` | boolean | Attenuator on/off. ADDED 2026-08-03, same fix as `preamp` |
| `atu` | boolean | ATU enabled |
| `vfo` | string | "A" or "B" — READBACK-fed since 2026-08-03 (Kenwood `IF;` / rigctld `v`, polled every cycle), so it now follows front-panel and custom-CAT VFO changes instead of only POTACAT-initiated ones |
| `split` | boolean | rig split on/off, readback-fed (Kenwood `IF;` P12 / rigctld `s`). NEW 2026-08-03 — absent from older desktops. Live split is commanded via `rig-control {action:'set-split', value}`; the similarly-named `set-enable-split` only toggles the spot-tune setting |
| `filterWidth` | number | Hz |
| `rfgain` | number | 0–255 |
| `txpower` | number | TX power *setting* (slider) |
| `smeter` | number | live S-meter (Gap 10) |
| `swr` | number | live SWR (Gap 10) |
| `alc` | number | live ALC (Gap 10) |
| `power` | number | live wattmeter (Gap 10) |
| `capabilities` | object | per-rig feature flags (filter, nb, atu, vfo, rfgain, txpower, power) |
| `vfoLocked` | boolean | VFO lock active |
| `audioState` | string | WebRTC connection state (when ECHOCAT audio bridge is up) |

**`tune` C→S sends `freqKhz` (string), not `frequency` (number)**.
The kHz-as-string format is the legacy wire shape and the desktop
parses it as a float — see Gap 5 in `potacat-app/docs/echocat-protocol-gaps.md`
for the history.

| Message | Dir | Purpose |
|---|---|---|
| `status` | S→C | Full radio status snapshot. See field table above. |
| `tune` | C→S | Tune VFO. Fields: `freqKhz` (string, e.g. `"14250.000"`), `mode` (optional), `bearing` (optional, for rotor). |
| `tune-blocked` | S→C | Tune was rejected (VFO locked, out of band, etc.). |
| `set-mode` | C→S | Change mode without retuning frequency. |
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
| `set-cw-xit` | C→S | Set CW XIT offset (Hz). |
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
| `scan-control` | ↔ | Ask the peer to change ITS scan. Field: `action` (string): `"stop"` (the reported use-case) or `"start"` (optional; uses that side's own filters). Gated like other rig C→S (authenticated active client). NOTE: supersedes the older, unused `scan:state`/`scan:control` (colon) registrations. |
| `rig-control` | C→S | Generic raw-CAT passthrough button (Settings → Rig table). |
| `rig-blocked` | S→C | Rig switch denied (club mode etc.). |
| `rigs` | S→C | List of configured rigs and the active one. |
| `switch-rig` | C→S | Activate a different rig profile. |
| `tgxl-select-antenna` | C→S | TGXL antenna switch select. |
| `toggle-rotor` | C→S | Rotator on/off (legacy). |
| `vfo-set-lock` | C→S | Lock/unlock VFO from changes. |
| `vfo-lock-state` | S→C | Current lock state. |
| `vfo-profiles` | ↔ | VFO Profile list (S→C push, C→S request after edit). |
| `vfo-profiles-update` | C→S | Save/edit/delete a VFO profile. |
| `apply-vfo-profile` | C→S | Apply a stored VFO profile to the rig. |
| `settings-update` | S→C | One or more server-side settings changed; client refreshes UI. |
| `save-settings` | C→S | Persist a settings delta. |

### PTT / audio signaling (WebRTC)

| Message | Dir | Purpose |
|---|---|---|
| `ptt` | C→S | Engage / release transmit. |
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
| `set-activator-park` | C→S | Set the park(s) the operator is activating. |
| `session-contacts` | S→C | List of contacts logged in the current session. |

### Logging (QSO / ADIF)

| Message | Dir | Purpose |
|---|---|---|
| `log-qso` | C→S | Submit a QSO for logging on the desktop. |
| `log-ok` | S→C | Logging succeeded; includes idx in ADIF. |
| `get-all-qsos` | C→S | Request the full QSO log. |
| `all-qsos` | S→C | Full QSO log payload. Chunked when the client hello advertises `chunked-all-qsos`; otherwise one frame capped to the most-recent 2000 records AND 256KB (`truncated: true` when cut). |
| `qso-added` | S→C | Incremental append after a QSO save, sent only to clients advertising `qso-delta` — replaces the full `all-qsos` re-push on every save. `data` = one record in `all-qsos` shape, `total` = new log length; if `total` ≠ local count + 1 the client should resync via `get-all-qsos`. |
| `update-qso` | C→S | Edit a QSO by index. |
| `qso-updated` | S→C | Edit confirmation broadcast. |
| `delete-qso` | C→S | Delete a QSO by index. |
| `qso-deleted` | S→C | Delete confirmation broadcast. |
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
| `directory` | S→C | Directory data (nets, SWL listings) for the Directory view. |
| `donor-callsigns` | S→C | List of donor callsigns to highlight in the UI. |

### JTCAT (FT8 engine)

| Message | Dir | Purpose |
|---|---|---|
| `jtcat-start` | C→S | Start the FT8 engine. |
| `jtcat-stop` | C→S | Stop the FT8 engine. |
| `jtcat-status` | S→C | Engine state (running, mode, slot timing, etc.). |
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
| `jtcat-skip-phase` | C→S | Skip to next QSO phase. |
| `jtcat-log-qso` | C→S | Log the current FT8 QSO. |
| `jtcat-auto-cq-mode` | C→S | Auto-CQ filter (off/POTA/SOTA/all). |
| `jtcat-auto-cq-state` | S→C | Current auto-CQ mode broadcast. |
| `jtcat-decode` | S→C | Single decode result (live feed). |
| `jtcat-decode-batch` | S→C | Batch of decodes (initial backlog). |
| `jtcat-wspr-spots` | S→C | Latest 2-min WSPR spot batch `{ spots[], error? }` — host-enriched (dBm, distance, bearing, DXCC). Replaces the list each cycle; replayed on reconnect. |
| `jtcat-wspr-beacon` | C→S | Drive the WSPR beacon `{ enabled?, txPct?, dBm? }` (partial = leave unchanged). Host clamps power ≤30 dBm (1 W), owns the attended watchdog + TX path. |
| `jtcat-wspr-beacon-state` | S→C | Authoritative beacon on/off `{ enabled }` — client sets its toggle from this (confirm/revert), never optimistically. |
| `jtcat-cycle` | S→C | Cycle boundary tick (for slot indicators). |
| `jtcat-tx-status` | S→C | Currently transmitting? what message? what slot? |
| `jtcat-qso-state` | S→C | Active QSO phase tracker. |
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
| `freedv-start` | C→S | Start the FreeDV engine. |
| `freedv-stop` | C→S | Stop. |
| `freedv-set-mode` | C→S | RADE V1 / 700D / etc. |
| `freedv-set-tx` | C→S | TX enable. |
| `freedv-set-squelch` | C→S | Squelch level. |
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
| `save-cw-macros` | C→S | Persist CW macro set. |

### SSTV

| Message | Dir | Purpose |
|---|---|---|
| `sstv-open` | C→S | Open SSTV view (starts decoder). |
| `sstv-photo` | C→S | TX a photo (mode chosen client-side). |
| `sstv-stop` | C→S | Close SSTV. |
| `sstv-halt-tx` | C→S | Cancel an in-progress TX. |
| `sstv-get-gallery` | C→S | Pull the RX gallery. |
| `sstv-gallery` | S→C | Gallery payload. |
| `sstv-get-compose` | C→S | Get TX compose state. |
| `sstv-compose-state` | S→C | Compose state push. |
| `sstv-rx-image` | S→C | A new RX image is ready. |
| `sstv-rx-progress` | S→C | RX progress (decoded scanlines). |
| `sstv-tx-status` | S→C | TX progress. |
| `sstv-wf-bins` | S→C | Waterfall bins for SSTV view. |

### Cloud (cross-device QSO sync via Cognito)

> **Scope:** These messages exist solely for the in-browser ECHOCAT UI
> (`renderer/remote.html` Settings → Cloud Sync, wired in
> `renderer/remote.js:8132-8289`), which piggybacks on the desktop's
> cloud session over WebSocket. The iOS and Android apps do **not** use
> these — they speak to `api.potacat.com` directly over HTTPS via their
> own `CloudAuth` / `CloudSync` clients. Don't infer from the protocol
> registry that mobile is expected to send them; that path was never
> wired on the native apps and was retired from the mobile protocol
> registry in the 2026-05-27 cleanup. The desktop-side handlers stay in
> place to serve the browser ECHOCAT.

| Message | Dir | Purpose |
|---|---|---|
| `cloud-login` | C→S | Log in to POTACAT cloud account. |
| `cloud-login-result` | S→C | Login result. |
| `cloud-register` | C→S | Sign up. |
| `cloud-register-result` | S→C | Sign-up result. |
| `cloud-logout` | C→S | Log out. |
| `cloud-logout-result` | S→C | Logout confirmation. |
| `cloud-get-status` | C→S | Sync status query. |
| `cloud-status` | S→C | Status response. |
| `cloud-sync-now` | C→S | Force a sync. |
| `cloud-sync-result` | S→C | Sync result. |
| `cloud-bulk-upload` | C→S | Push all local QSOs to cloud. |
| `cloud-upload-result` | S→C | Bulk-upload result. |
| `cloud-verify-subscription` | C→S | Check active subscription tier. |
| `cloud-verify-result` | S→C | Subscription tier response. |
| `cloud-save-bmac-email` | C→S | Save Buy-Me-A-Coffee email for benefit lookup. |
| `cloud-bmac-result` | S→C | BMAC lookup result. |

### KiwiSDR / WebSDR

| Message | Dir | Purpose |
|---|---|---|
| `kiwi-connect` | C→S | Connect to a KiwiSDR / WebSDR station. |
| `kiwi-disconnect` | C→S | Disconnect. |

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
| `save-custom-cat-buttons` | C→S | Save user-defined raw-CAT buttons for the Rig table. | Entries are `{name, command}` plus additive per-type fields (2026-08-19): `type` (`button` default / `toggle` / `slider`), `commandOff` (toggle), `min`/`max`/`value` (slider; the client substitutes `{v}`/`{v2}`/`{v3}`/`{v4}` placeholders and sends the FINAL string via `send-custom-cat` — the server never interprets templates). Clients that predate a field must PRESERVE unknown entry fields on save, not strip them; an older client rendering a toggle as a plain button sends only the On command, which is acceptable degradation. |
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

#### Pairing QR payload

The desktop emits a `potacat://pair?<params>` URL encoded into a QR code
(generated by the `echocat-create-pairing-qr` IPC handler in `main.js`).
The mobile app scans it to bootstrap a paired-device record.

| Param | Required | Meaning |
|---|---|---|
| `host` | yes | LAN WebSocket URL — `wss://<ip-or-tailscale-name>:7300`. The phone connects here first. |
| `token` | yes | One-time pairing token minted by `remoteServer.createPairingToken()`. Short-lived (5 min default; 60 min when shared via messaging). |
| `fp` | yes | SHA-256 fingerprint of the desktop's TLS cert. The phone pins this for the LAN connection. |
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
