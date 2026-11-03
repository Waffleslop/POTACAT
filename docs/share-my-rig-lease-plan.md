# Share My Rig: lending the station, end to end

Casey, 2026-10-27: "share my rig with another ham and have him control the rig, log
QSOs into his logbook, and operate as HIM. No sign of me. When he calls CQ on FT8 it
should be his call. Winlink, JS8, JTTY, everything, as if he owned the rig. But only
during his token window."

This is the plan. Nothing here is built yet except the first step of identity
(`onAirCall()`), which this plan absorbs.

## The idea in one line

**A Guest Pass is a lease.** While it runs, the station IS the guest's: their
callsign on the air, their logbook, their mail, their choices. The owner is parked.
When it ends, everything the guest started stops, the guest is disconnected, and the
owner's station comes back exactly as it was.

Two people, two roles, one rule each:

- **Station licensee (the owner, Casey).** Decides *who*, *when*, *how much* (class,
  power, modes) and can end it at any moment. Never has to type a callsign.
- **Control operator (the guest).** Signs in with their own POTACAT Cloud account.
  Their verified callsign becomes the station's call for the lease. They never see
  the owner's identity on anything they send.

## Part 97, briefly

When a licensed operator controls someone else's station they may identify with
their own call; the station then operates under the control operator's privileges
(§97.105(b), §97.119). The station licensee stays responsible (§97.103(a)). So:

- On the air: the guest's call, always. The grid is the STATION's grid (the radio is
  at the owner's QTH): `CQ K3SBP DN13`, never `CQ W7RTA`.
- In the guest's log: `STATION_CALLSIGN` = guest, `OPERATOR` = guest,
  `MY_GRIDSQUARE` = station grid. One private app field,
  `APP_POTACAT_STATION_LICENSEE` = owner's call, in the guest's record only, because
  the licensee carries the responsibility and the guest's log is the only record.
  (Casey: strike this if you want literally no trace.)
- An anonymous guest (no account) has no verified licence. See decision 1.

## What exists today (verified 2026-10-27)

- Pass = `{ privilege_class, max_power_w, allowed_modes, starts_at, expires_at,
  station_callsign, operator_callsign, control_operator_callsign, allow_anonymous }`
  (cloudlog `routes/passes.js:299`). Both issuing forms pre-fill station and
  control-op with the OWNER's call (`renderer/app.js:6969`, app
  `PassGenerateScreen.tsx:89`). The cloud never returns the guest's account
  callsign to the desktop (redeem `:624-737`, validate-session `:559-606`).
- Enforcement (`lib/pass-enforcement.js`): tune is free; transmit, power and SSTV
  are gated by class/modes/power; expiry timer, 60 s cloud re-check, 60 s grace
  after the guest disconnects. CW text is NOT gated (`main.js:21824`).
- The desktop refuses a guest: Winlink (every message), JS8 TX/heartbeat/mail, JTTY
  send (silently), rig presets, TX EQ/drive, settings, watchlist, cluster nodes,
  idle mode, SSTV packs/auto. NOT refused: voice-macro sync/delete/play (the owner's
  recordings), WSPR beacon arming, PSK31 send.
- Identity leaks during a lease: WSPR beacon, PSKReporter receiver call, JS8
  station + the owner's heartbeat, Mercury, cluster login/re-spots, SSTV
  filenames, the owner's activation refs stamped onto guest QSOs
  (`liveActivationMyRefs` in `logContact`).
- Logging: a phone guest's QSO goes `qso-attributed` → phone → cloud under the
  guest's JWT + session token. A browser guest's QSO is DROPPED (`remote.js` never
  declares `qso-attributed`). A retry after the session ends gets 410.
- End of pass: `broadcastPassEnded` sends `pass-ended` and purges browser cookies
  but never closes the socket or clears `ws._passSession`; nothing stops a Run/Hunt
  loop, WSPR, CW, SSTV or a held PTT; PassEnforcement drops to idle so the same
  connection continues with no limits under the owner's call.

## Design

### 1. One identity, one lease object (desktop)

`lib/station-lease.js` (pure, tested) owns the state machine; main.js keeps ONE
instance and every call site asks it:

```
lease.identity()  → { call, grid, source: 'owner' | 'guest', guestUserId, sessionToken, code }
lease.state       → idle | active | expiring | ending
```

`onAirCall()` (built today) becomes `lease.identity().call`. Every place the station
identifies or reports reads it: FT8/FT4/FT2 (CQ, replies, auto-seq, Hunt, Run, AP
decode, "to me"), JTTY, PSK31, JS8 station, SSTV CW ID and call, CW `{MYCALL}`,
WSPR beacon call, PSKReporter receiver call, Mercury call, POTA/WWFF/WWBOTA spotter,
DX cluster login, SSTV filenames/sidecar. `settings.myCallsign` is read only for
things that stay the owner's (profile file, cloud sign-in, QRZ/LoTW/Club Log keys).
A source-guard test fails on any new transmit path that reads `settings.myCallsign`.

### 2. The guest's call comes from their account (cloud handoff)

- `redeem`, `redeem-anonymous` and `validate-session` return `guest_callsign` (from
  `users.callsign`; null for anonymous) and `guest_user_id`.
- The three callsign fields on the pass stay in the schema for old clients but the
  forms stop sending them (desktop `renderer/app.js` Share My Rig; phone handoff).
- Resolution order on the desktop: guest account callsign → (legacy) pass
  `station_callsign` → owner. Old passes keep working.

### 3. The issuing form, simplified (desktop + phone handoff)

Share My Rig asks only: **When** (now + length, or a schedule), **Class** (the
ceiling you allow), **Power cap**, **Modes**, **Allow without sign-in**. The three
callsign boxes and the §97.119 paragraph go. New copy: "Your friend signs in with
their POTACAT Cloud account and operates under their own callsign. Their QSOs go to
their logbook. Your station comes back to you when the pass ends." One optional
field: "Only for" callsign (the cloud refuses any other account at redeem).

### 4. The owner is parked for the lease (desktop)

At lease start, before the guest gets `auth-ok`:
- stop the owner's automatic transmitters and remember nothing to restore (an
  automatic transmitter must be attended): JS8 heartbeat/auto-reply off, WSPR
  beacon disarmed, Run/Hunt off, JTCAT engine kept running but idle;
- JS8: a fresh `Js8Threads` for the guest's call; the owner's inbox is not sent;
- the owner's voice recordings, activation (`liveActivationMyRefs` → []), watchlist,
  SSTV templates and presets are out of reach (refuse `voice-macro-*`,
  `set-activator-park`; already refused: the rest);
- DX cluster: reconnect under the guest's call so an outbound spot is theirs
  (one reconnect each way; the backoff rules are untouched);
- Winlink: see 6.
- The owner's window shows one banner: "Lent to K3SBP until 21:00 · transmitting
  as K3SBP · End now". Their own ECHOCAT devices are told the station is lent.

### 5. Every mode opens to the guest (desktop)

Remove the guest refusals for JS8 (start/stop/send/heartbeat/offset/thread open),
JTTY (send/profile), rig presets APPLY (not edit), TX drive/EQ, WSPR arm. Keep
refusing anything that edits the owner's saved state. Every transmit path, CW text
included, goes through `interceptCatCommand({type:'tx_enable', mode, freqHz})`.
Privilege class is the pass's; modes are the pass's list.

### 6. Winlink as the guest (desktop; Pat already supports it)

- The guest's device sends `winlink-lease-login { password }` once; the password
  lives in memory for the lease, never in settings.json.
- `winlinkPaths()` resolves to `<userData>/lease/<code>/winlink/` while leased; Pat
  is written a config for the guest's call and relaunched; modems get the guest's
  mycall (`buildArdopArgs`, Dire Wolf config).
- Mailbox pushes go to the guest's device only. At lease end Pat is relaunched on
  the owner's config and the lease directory is deleted (mail stays on the Winlink
  CMS; the guest reads it from their own station later).
- Winlink gateways over RF count as transmit: same class/mode/power gate.

### 7. One logging path for every guest surface (desktop + cloud handoff)

Today the phone pushes guest QSOs itself and the browser cannot. Instead the DESKTOP
logs every guest QSO (auto-logged, hand-logged on phone or browser, JTTY, JS8) to
the guest's cloud logbook:

- cloud: `POST /v1/passes/:code/sessions/:session_token/qsos` accepted from the
  owner's station (the desktop already proves the session via validate-session);
  rows land in the guest's logbook with `pass_session_id`; dedupe by uuid; works for
  anonymous guests too (their synthetic user has a logbook; the share page offers
  "download your log" after the session).
- desktop: `saveQsoRecord` under a lease writes NOTHING locally and journals
  nothing for the owner; it posts to that route and answers `log-ok` to the device
  as it does for the owner. A failed post is queued in memory for the lease and
  retried; at lease end anything still unsent is written to
  `<userData>/lease/<code>/unsent.adi`, shown to the owner once ("3 of W7RTA's
  QSOs could not reach their logbook; file kept here"), never merged into the
  owner's log.
- phone handoff: stop the phone's own push for pass sessions; it keeps its local
  copy from `log-ok`.
- `qso-attributed` stays for older apps, stamped with the guest identity.

### 8. The lease ends hard (desktop)

On expiry, revoke, owner's End, 60 s guest absence, or the cloud's 404:
1. `lease.state = 'ending'`: every `tx_enable` is refused from this instant;
2. stop what is running: `stopFullAutoCq`, `setJtcatHuntMode('off')`, abort any
   JTCAT TX in flight, WSPR disarm, CW abort (`cw-stop` path), SSTV halt, Mercury
   abort, Winlink session abort, PTT off on CAT and SmartSDR;
3. `remoteServer.endLease(code)`: `pass-ended` to each guest socket, then CLOSE it
   and clear `_passSession`; purge browser cookie sessions (exists);
4. restore: identity → owner, JS8 threads → owner's, cluster re-login, Pat →
   owner's config, lease directory deleted;
5. one log line and a toast for the owner; the guest's device shows its existing
   "pass ended" screen.
A test drives a fake guest through start → Run → expiry and asserts no key-down
after the end and a closed socket.

### 9. Scheduled passes and the window

`starts_at` is honoured by the cloud at redeem; the desktop also refuses a session
whose pass has not started (already a 404) and ends it at `expires_at` with its own
clock, adopting any shorter time the cloud reports (exists).

## Phases

| # | What | Where | Size |
|---|------|-------|------|
| A | Hard end (8), CW gate, voice-macro/activation refusals, WSPR refusal until identity lands | desktop | 1 day, ship first |
| B | `station-lease.js` identity everywhere (1, 4); cloud returns `guest_callsign` (2); forms simplified (3) | desktop + cloud + phone handoffs | 2 days desktop, small cloud, small phone |
| C | Modes open: JS8, JTTY, presets apply, WSPR under guest (5) | desktop | 1 day |
| D | One logging path (7) | cloud route + desktop + phone handoff | 1 day desktop, 1 day cloud |
| E | Winlink as the guest (6) | desktop + phone handoff (password prompt, mail tab for guests) | 2 days |

A ships alone. B–D can ship together as one release; E after.

## Decisions for Casey

1. **Anonymous guests.** No verified licence. Options: (a) transmit as the OWNER
   with the owner as control operator, which is what "Field Day visitor, club net
   rotation" on the form implies; (b) listen and log only, no transmit, until they
   sign in. Recommendation: (b). (a) puts the owner's call on the air under
   someone the owner may never have met, and contradicts "no sign of me".
2. **The private licensee field** in the guest's log record (keep or strike).
3. **Winlink now or after.** Recommendation: A, then B+C+D in one release, then E.

## Owed to other sessions once approved

- echocat: the station-call rule built today is replaced by account identity; the
  forms drop the callsign boxes; the phone stops pushing pass-session QSOs itself
  (D); Winlink password prompt + guest mail tab (E).
- cloud: `guest_callsign` on redeem/validate-session; "only for" callsign; the
  session QSO route; anonymous log download.
