# Desktop-to-desktop: the missing pieces

**Status:** spec, 2026-10-21. Supersedes the phase table in `docs/remote-desktop-plan.md` (that plan's "design, not started" line is stale: Phase 1 control shipped in v1.8.6/1.8.7, the audio leg in v1.8.14).

**The report that prompted it** (Ride1226, Discord 2026-10-21): a second POTACAT at work, paired to the shack at home, shows HOLD TO TALK but "the cat controls for my radio back home aren't lighting up". He also looked for docs and found none.

## Build status (2026-10-21, end of the build session)

Committed on master (not pushed, not released): A1-A6 and A8 (remote mode vs link, the shack's rig state and caps, rig list, round trip, PTT from every source, gating, audio devices/volume/key PTT/NO AUDIO, pairing expiry/Re-pair/unpair/Tailscale cert, own-device refusal), B1-B9 (lib/remote-bridge.js; JTCAT, CW + paddle, voice macros, SSTV, scope, JS8, activation push, FT8 hand-over notice), C1-C6 behind `echocatMultiClient`, D5 (one-line dial diagnosis).

Verified live in a two-instance run (scratch shack with a Hamlib Dummy rig + scratch laptop, separate profiles and ports): pairing over pinned WSS, direct audio, the shack's caps/NB/rig list on the laptop, tune and rig-control reaching the shack's radio, JTCAT window driving the shack's FT8 engine with no local capture, a TX-offset round trip, a second device joining without displacing the laptop, the Remote CW refusal, refusal while the shack was down (no local port opened), leaving remote mode cleanly, the JS8 window running the shack's JS8, the SSTV window opening the shack's decoder. Not verified live: any transmission (it would have played through the shack PC's speakers), a received SSTV picture, a JS8 send.

Deliberately not built: per-peer audio (C5 is last-listener-wins with `audio-moved`), Station Setup run on the shack from the laptop (D2), editing the shack's rigs from the laptop (D3), a cloud bandwidth mode (D4; the spectrum is ~6 kB/s), chaining a phone through the laptop.

A7 docs page and the mobile messages are handoffs: potacat-docs `DESKTOP_TO_DOCS_HANDOFF_2026-10-21_REMOTE_DESKTOP.md`, potacat-app `docs/desktop-handoffs/multi-client-and-desktop-to-desktop.md`.

## 1. Where it stands

What the laptop has today, verified in code:

| Built | Where |
|---|---|
| Pairing (mDNS tap-to-pair, Cloud 1-click, paste link, Guest Pass), three-leg dial LAN → Tailscale → Cloud, cert pinning, reconnect/backoff, revoke/kick/pass-ended handling | `lib/remote-client.js`, `main.js` `ensureRemoteClient()` ~5070, `redeemPairLinkUrl` ~26912 |
| Remote Radios dialog, status chip, displacement banner, log-error modal | `renderer/app.js` 6867–7393 |
| Rig audio in and voice PTT out (WebRTC answerer, TURN for double CGNAT) | `renderer/remote-audio-answerer.js`, `remote-audio-client.html`, `startRemoteClientAudio()` ~20746 |
| Tune, set-mode, set-filter and the generic `rig-control` go to the shack | `tune` IPC ~32508, `vfo-set-mode` ~29471, `rig-control` ~33216 |
| Freq, mode, S/SWR/ALC/power and `catConnected` come back | `remoteClient.on('status')` 5149–5178 |
| QSOs the laptop triggers land in the laptop's log with the host's call as STATION_CALLSIGN (Architecture B, `qso-attributed`) | 5203 |

What is missing, and why his controls are dark:

1. **The shack already sends everything, the laptop throws it away.** The shack's `status` snapshot (built ~20470) carries nb, atu, vfo, split, filterWidth, rfgain, squelch, txpower, nr/anf/apf/preamp/att/agc, the dsp levels, `capabilities`, `controls`, `txState`, `rigPowered`, `audioOk`. The laptop reads five fields. The rig popover and the VFO pop-out therefore show the laptop's own (empty) local rig state and local caps: dark buttons, no toggles.
2. **There is no remote mode in the renderer.** Nothing is hidden, disabled or explained. FT8, CW, voice macros, SSTV, VFO lock, TX drive, the VFO pop-out's own PTT, `naked-ptt`: all still act on the local rig, which does not exist. The worst outcome in a remote UI is a control that looks live and does nothing; that is the default today.
3. **"Remote" is only true after auth-ok.** `isRemoteActive()` = `remoteClient.state().authed`. During a reconnect the app believes it is local: a tune goes to `tuneRadio`, the `connectCat` guard drops, and a serial rig on the laptop can be opened mid-blip.
4. **The engines.** FT8/WSPR/PSK/JTTY, CW keyer, SSTV, JS8, FreeDV, the band scope: none crosses the wire from the desktop client, although the shack serves all of them to ECHOCAT Web today (123 S2C and 151 C2S message types in `lib/echocat-protocol.js`; the web client handles ~110 of them).
5. **Only one client at a time.** `remote-server.js` is single-client (`this._client`, 153 sites; `_displaceCurrentClient`). Connecting the laptop kicks the phone and vice versa.
6. **Rough edges in what shipped:** `expiresAt` on a pair-link target stores the link's 24 h TTL, not the device token's expiry, and the `expiresAt`/`trusted` from `auth-ok` are never written back (an owned pairing shows "expires in 23h"). The re-pair flow on `auth-fail` was never wired. `passSession` never reaches the renderer. Remote audio has no output-device picker, no volume, no mic picker, no keyboard PTT. The Remote Radios copy says "Pair another desktop…" where the shack's button is "Pair my device…". No docs page.

## 2. The experience we are building

A ham with a shack PC and a laptop should be able to open POTACAT anywhere, click the shack under Remote Radios, and have **the same POTACAT** they use at home, with the rig a few hundred milliseconds further away. Specifically:

- Every rig control lights up with the shack's real state and real capabilities, and a click moves the radio. Rig switching works (the shack's rig list).
- Audio is there without a button, with a volume slider and device pickers. PTT on a key as well as the mouse.
- FT8 (and the other digital panes), the CW keyer, voice macros, SSTV and the scope open and work. The shack runs the engines; the laptop is the screen and keyboard. Decodes are the shack's decodes, the keying is the shack's keying line, and a logged QSO lands in the laptop's logbook, stamped correctly.
- Anything that needs the radio on this PC says so in one line where the control is. Nothing silently does nothing.
- The phone and the laptop can both be connected. Whoever keys holds the radio until they unkey; a change made from one surface shows up on the other with a who-did-it toast.
- Losing the link looks like losing the link, never like "the radio went away": the chip goes amber, controls dim, the app keeps its remote identity, and reconnection is automatic.
- Spots, map, DX cluster, RBN, DXCC, contests, propagation, the logbook, cloud sync: all native on the laptop, because none of them needs the radio.

## 3. Architecture: the shack is the rig, one bridge, no twins

The temptation is to add an `if (isRemoteActive())` branch to each of the thirty-odd features. That produces a second copy of every feature's wiring, and every future feature needs a twin or it silently breaks remote. The design below is one bridge, table-driven, with two rules.

### Rule 1: split by "does it need the radio on this PC"

| Runs natively on the laptop | Goes over the wire to the shack |
|---|---|
| Spot feeds (POTA/SOTA/WWFF/…, cluster, RBN, PSKReporter), map, filters, watchlist, scan *policy* | Tune/mode/filter, every rig control, VFO/split, PTT, power, ATU, rig switch |
| Logbook, ADIF, cloud sync, LoTW/QRZ/Club Log forwards, Log as | Audio in/out, TX drive, mic gain |
| DXCC, contests, events, propagation, Directory | FT8/FT4/FT2/WSPR/PSK31/JTTY engine + decodes + TX |
| Activator mode UI, park search, re-spot (laptop's own POTA login) | CW keyer (text, macros, paddle), voice macros |
| Settings (laptop's own), bug reports (unified, already built) | SSTV, JS8, FreeDV, band scope, SDR scope |

Scan is the one split feature: the laptop decides where to go, the shack tunes. That is how it already works.

### Rule 2: a remote shack is a `RigController`

Today `cat` is nulled in remote mode and ~150 `cat.*` call sites in main.js each decide what to do. Instead, in remote mode `cat` becomes a `RemoteRigController` (`lib/remote-rig-controller.js`) that implements the `RigController` surface the rest of main.js already calls and emits the same events:

- **Outbound:** `tune`, `setMode`, `setFilterWidth`, `setPtt`, `setPower`, `setNb`, `setAtu`, `setVfo`, `swapVfo`, `setSplit`, `setRfGain`, `setSquelch`, the preamp/att ladders, `setDsp*` → the matching C2S types (`tune`, `set-mode`, `set-filter`, `ptt`, `set-txpower`, `set-nb`, `set-atu`, `set-vfo`, `swap-vfo`, `set-enable-split`, `set-rfgain`, `rig-control {action}` for the rest). The existing dispatcher stays the ONE dispatcher (memory: `rig_control_dispatcher`); it just finds a controller whose methods send frames.
- **Inbound:** the shack's `status` and the discrete `freq`/`mode`/`smeter`/`swr`/`alc`/`power`/`fwd-power`/`tx-meter` frames become the controller's `frequency`/`mode`/`smeter`/`powerMeter`/… events. `broadcastRigState()` then runs unchanged and the renderer's `rig-state` channel carries the shack's state and caps: the popover and the VFO pop-out light up by themselves. `getCapabilities()` returns `status.capabilities`; `connected` mirrors `catConnected`.
- **What it cannot do says so.** `queryRaw`, custom CAT commands and anything codec-specific return a rejected promise with the text `Not available over a remote link` (there is already a `rig-blocked`/`tune-blocked` toast path), never a throw inside an IPC handler (that is the synchronous crash dialog).
- `_transmitting` follows `txState`; `noteTransmitting` is a no-op (the shack holds its own watchdogs).

This is the "RemoteBackend" the June plan named and never built. It replaces the inline `isRemoteActive()` branches at 32508, 29471, 29477 and 33216, which become dead and are removed.

### The engine bridge: `lib/remote-bridge.js`

Every pop-out (JTCAT, CW, SSTV, scope, JS8, voice macros) talks to main over IPC channels that, by design, already mirror the ECHOCAT wire names (`jtcat-decode`, `jtcat-qso-state`, `jtcat-cycle`, `cw-state`, `sstv-rx-image`, `scope-frame`; `test/protocol-demux-parity-test.js` pins the C2S side). So the bridge is a table:

```
C2S: ipc 'jtcat-popout-call-cq' → ws 'jtcat-call-cq'     (name differs)
C2S: ipc 'jtcat-set-tx-freq'    → ws 'jtcat-set-tx-freq' (identity)
S2C: ws 'jtcat-decode-batch'    → renderer 'jtcat-decode' ×N
S2C: ws 'jtcat-qso-state'       → renderer 'jtcat-qso-state-update'
```

In remote mode main.js's engine IPC handlers are registered through the bridge: `bridge.handle('jtcat-start', localFn)` runs `localFn` on a local rig and sends the mapped frame on a remote one; `bridge.onWire('jtcat-decode', rendererChannel)` fans the shack's frame out to the windows that would have received it from the local engine (main window, pop-out, VFO pop-out, and the laptop's own ECHOCAT clients if it is also serving; see §6). The table is the whole contract, the test asserts every pop-out channel has a row or an explicit `local-only` entry with a reason string, and the hello capability list the laptop sends is derived from the table.

Hydration: on `connected`, the shack already replays state at connect for every surface (that is how a phone reconnects mid-QSO). The bridge forwards those replays into the pop-outs' existing `*-status` hydrate channels, so opening the JTCAT window on the laptop shows the shack's running session.

### Engines run on the shack, never on the laptop

Decided here, not left open: the laptop does **not** decode FT8 from the WebRTC audio and does not generate TX audio into the mic track.

- The shack's decoder hears the rig's native audio; the laptop would hear Opus at whatever the link allows. Reports and weak decodes would differ from what the shack sees.
- TX waveforms (GFSK, CW keying, SSTV) through a voice codec are degraded, and every timing path (FT8 slot alignment, CW hold, PTT release) would gain a network's worth of jitter.
- The shack's `radio-owner` arbiter, SWR guard, WSPR power cap, CW hold and PTT failsafes all live where the radio is. Moving an engine to the laptop means re-arming all of them over a link that can drop mid-transmission.

Consequence: a QSO run from the laptop is auto-logged by the shack and forwarded (`qso-attributed`), which is what already ships. `jtcat-log-qso` from the laptop goes through the shack's `logContact` and comes back the same way.

### Exclusive engines and who is in charge

An engine (JTCAT, CW text, SSTV TX, FreeDV TX, Mercury) has one operator. The shack's `radio-owner` already serialises PTT among engines; this adds the **surface**: `engine-owner {engine, owner: 'local'|clientId, since}` in `jtcat-status`/`cw-state`/`sstv-decoder-state`. A laptop that opens FT8 while the shack keyboard is mid-QSO sees "FT8 is being run from the shack (K3SBP, 3 min ago)" and a **Take over** button; take-over is refused while a transmission is in flight (`tx-start` → `tx-end`), exactly like `jtcat-takeover-notice` between the main window and the pop-out today.

## 4. Phases

### Phase A: honest remote mode and rig parity (fixes Ride1226)

Laptop-only. No shack change, no protocol change. Everything it consumes is already sent.

1. **Remote intent ≠ connection state.** `isRemoteActive()` → `settings.activeTargetId != null`. Connection state (`idle|connecting|authing|connected|reconnecting|auth-fail`) is separate and drives the chip. All local-rig guards (`connectCat`, `connect-cat`, serial reconnect, rigctld spawn) key off intent.
2. **`RemoteRigController`** per §3, assigned to `cat` in `ensureRemoteClient()`. Inbound: full `status` → controller events; discrete meter frames; `rigs` + `activeRigId` → the laptop's rig selector shows the shack's rigs and `switch-rig` works; `vfo-lock-state`, `ptt-timeout`/`ptt-force-rx` (the shack's PTT watchdog fired: release the laptop's PTT button and say so), `tx-drive-state`, `tx-meter`, `rig-blocked`, `settings-update` (the shack's `myCallsign`/grid for the VFO header, never written to the laptop's settings).
3. **Outbound parity for the VFO surfaces:** `set-vfo`/`swap-vfo`/split/estop (RemoteClient methods exist, nothing calls them), VFO lock, TX drive, `naked-ptt` and the VFO pop-out PTT → `handleRemotePtt` → controller → `ptt`. Custom CAT buttons: refused with the reason (the shack's own custom buttons are a Phase B item via `save-custom-cat-buttons`/`rig-control`).
4. **Gating with reasons.** A single renderer predicate `remoteFeature(name)` → `{ok}` or `{ok:false, reason}` from a table in `lib/remote-features.js` (shared with main so the log and the UI say the same thing). Every rig-scoped control not yet bridged gets `disabled` + a title + one inline line. Rule: never hide a control whose feature is on (the off switch stays reachable). The More menu items for engines open their pop-out in a "remote: coming in Phase B" state, not a working-looking dead window.
5. **The mode banner.** The chip grows into the status bar's rig pill: `K3SBP's shack · FTDX10 · via Tailscale · 84 ms`. Click: Remote Radios. Round-trip from the ping/pong already running.
6. **Audio:** output device picker, volume, mute, mic picker in Settings > ECHOCAT > "When driving a remote shack"; keyboard PTT (hold Space when the main window has focus, configurable; release on blur, same as the mouse path); the shack's `audio-health` → an inline "no rig audio arriving" line instead of silence; `echoTxGuardMs` honoured on the mic track.
7. **Pairing fixes:** write `auth-ok.expiresAt`/`trusted` back to the row; the pair-link `exp` is never the device expiry; wire the re-pair flow on `auth-fail` (chip → "Re-pair": cloud shacks re-pair in one click, LAN shacks re-open Remote Radios with the paste row focused); `passSession` → the renderer (the Guest Pass banner the phone shows: class, power cap, expiry); honour `tsCertPublic` on the Tailscale leg (SPKI pin, `cert_spki_pin` memory); server-side unpair on Remove (TODO at ~33863); fix the dialog copy.
8. **Docs (handoff, not my edit):** `DESKTOP_TO_DOCS_HANDOFF_2026-10-21_REMOTE_DESKTOP.md` in potacat-docs asking for a `docs.potacat.com` page "Two POTACATs: run your shack from a laptop" (pairing paths, what works, what doesn't yet, the single-client rule until Phase C). The Discord question had no page to point to.
9. **Tests:** `test/remote-rig-controller-test.js` (fake shack: every `status` field → the matching `rig-state` field and cap; every controller method → the expected frame; refused methods reject with the text, never throw); extend `test/remote-desktop-e2e-test.js` with set-vfo/split/ptt/switch-rig round trips; a source guard that no `isRemoteActive()` branch remains in an IPC handler outside the bridge; `test/remote-features-test.js` asserting every rig-scoped control id in `index.html` has a gating row.

### Phase B: engines over the wire

Laptop mostly; the shack gains the `engine-owner` field and a few hydrate gaps.

1. **`lib/remote-bridge.js`** per §3, with the parity test.
2. **JTCAT pop-out remote:** FT8/FT4/FT2/WSPR/PSK31/JTTY. Decodes, cycle bar, QSO state, auto-seq, Hunt/Run (`jtcat-auto-cq-mode`), chase/spot target, RX/TX gain (already desktop-authoritative on the shack: `jtcat-rx-gain-state`/`jtcat-tx-gain-state`), hold TX, tune, spectrum (`jtcat-spectrum-subscribe`, the web client's waterfall feed), mode hop, WSPR beacon and spots, PSK/JTTY panes, event hunt. Multi-slice (`jtcat-start-multi-remote` exists). Local-only with reason: clock sync (`jtcat-sync-clock` is the shack's clock), audio-device pickers, AP/late-start toggles until a C2S exists for them (add `jtcat-set-pref {key,value}` to the shack: one message for the per-profile booleans instead of twelve).
3. **CW:** text, macros (`save-cw-macros`), stop, enable, speed; **paddle** from the laptop's MIDI/keyboard paddle → `paddle` frames with the hold repeat (400 ms `hold:true`, the LZ3AW round-5 contract) so a held contact keeps keying; `cw-available`/`cw-paddle-available` gate the panel. The local `buildPaddleKeyRig()` router is the local half; the remote half is a `paddle` sender.
4. **Voice macros:** `voice-macro-play`, labels/sync; the macro audio stays on the shack.
5. **SSTV pop-out:** decoder state, RX image/progress/FSK ID, gallery, compose, photo TX, halt; pack claims.
6. **Scope pop-out:** `scope-subscribe`/`scope-frame`/`scope-state`/`scope-enable-radio`; the laptop counts as a watcher so the helper only runs while someone looks. Lifts the "reads the radio on this PC" refusal.
7. **JS8:** the full `js8-*` set exists on the shack (threads, mail, heard, send, band). The desktop pop-out becomes the first complete JS8 client; ECHOCAT Web has none.
8. **FreeDV**, **Kiwi/WebSDR** (`kiwi-*`), **TunerGenius** antenna select, **rotor** toggle, custom CAT buttons (`save-custom-cat-buttons` + `rig-control`), **VFO profiles**.
9. **Activator mode on the laptop against the shack rig:** already works for logging (laptop's log, laptop's POTA login for self-spot). Add `set-activator-park` so the shack's on-air badge and ECHOCAT phones see the activation, and consume `activator-state` so two surfaces agree.
10. **Engine ownership** (`engine-owner`, Take over) on shack and laptop.
11. **Tests:** bridge table parity (every pop-out IPC channel mapped or marked local-only with a reason); a fake-shack e2e per engine (start, hydrate, one decode, one TX command, one logged QSO arriving as `qso-attributed`); JTCAT's own suite unchanged (the engine does not move).

### Phase C: two devices at once

Shack. The structural change the plan deferred.

1. `_client` → `_clients` (Map by clientId) in `remote-server.js`; `_sendTo(this._client, …)` sites become `_broadcast` or `_sendTo(origin)`; every echo/hydrate helper takes a `ws`. Mechanical but 153 sites; land behind `settings.echocatMultiClient` (default off for one release) with the displacement path kept as the fallback.
2. **Presence:** `clients:list` S2C (platform, name, leg, since, keyed/engine-owner flags); a presence chip on every surface ("iPhone + laptop connected").
3. **Attribution:** `originClientId` on state broadcasts; "Laptop tuned to 14.074" toast on the other surfaces, suppressed on the origin.
4. **PTT arbitration:** first key-down holds `radio-owner` as `client:<id>`; another client's PTT is refused with `ptt-refused {by}` until key-up; the ECHOCAT failsafes unchanged.
5. **Audio per peer:** the bridge window runs one `RTCPeerConnection` per listening client (it is a renderer; the offerer code is per-connection already); TURN creds are per shack session (Model A) and shared. Mic tracks: only the PTT holder's track is routed to the rig.
6. **Guest Pass + owner together:** the owner's surfaces see the guest banner; the pass enforcement stays per-session.
7. **Mobile handoff** (`potacat-app/docs/desktop-handoffs/multi-client.md`): `clients:list`, `originClientId`, `ptt-refused`, `engine-owner`; the app keeps working unchanged until it adopts them.
8. **Tests:** two fake clients in `test/remote-desktop-e2e-test.js`: both receive a broadcast, PTT refusal, origin suppression, displacement off/on by the flag.

### Phase D: polish

- Live local↔remote swap without the renderer forgetting state (today it flips a flag and clears `cat`; good enough, verify the pop-outs survive).
- Station Setup for a remote shack: the checklist runs on the shack, results shown on the laptop (`request-diagnostic` already crosses).
- Remote rig editing: the shack's rig list is read-only on the laptop in A/B; `save-settings` exists but editing another machine's serial ports from afar needs the Test Connection round trip first.
- Bandwidth mode for the cloud leg: decode batches instead of per-decode frames (the shack has `jtcat-decode-batch`), scope at 5 fps, waterfall off by default over Cloud.
- A "reconnect was 40 s" diagnostic line listing which leg failed and why (`describeSdrError`-style naming for the dial chain).

## 5. UX details that make it feel right

- **One identity, two states.** The app is either "my rig" or "K3SBP's shack". Reconnecting is a state of the shack identity, not a return to local.
- **State before chrome.** On connect the first paint is the shack's VFO, mode, meters and toggles (hydrate is one `status` message); the audio arrives a second later. Never show a dark popover for the second it takes.
- **Every refusal names the fix.** "Band scope needs the radio on this PC. Open it on the shack." "FT8 is being run from the shack keyboard. Take over?" "Custom CAT buttons run on the shack; add them there." Same text in the log.
- **PTT is obvious.** Button, Space, the VFO pop-out's PTT, the ON AIR banner on every window, and the shack's `ptt-timeout` releases the laptop button with a toast (the laptop can't be the thing that leaves a rig keyed).
- **Logging is boring.** A QSO made from the laptop lands in the laptop's log, correctly stamped (owner: own call; guest: host call as STATION_CALLSIGN), syncs to Cloud, forwards to QRZ/LoTW from the laptop's settings. No "which log did that go to".
- **Latency is shown, not felt.** The pill shows the round trip; the VFO uses the optimistic echo (`_freqSuppressTarget`) so a click moves the dial now and the shack's readback corrects it.
- **The phone is never surprised.** Until Phase C, connecting the laptop shows the displacement banner on the phone with "Laptop took over" and a Reconnect; the laptop's chip says "Your iPhone was disconnected". After Phase C, both stay.
- **Docs first-class.** The page in Phase A.8 is linked from the Remote Radios dialog's empty state.

## 6. Interactions and risks

- **A laptop that is also a server.** The laptop may have ECHOCAT enabled for its own phone. In remote mode its own `remoteServer` must not advertise a rig it does not have: `sendCatStatus` reflects the remote controller, and engine fan-out from the bridge reaches its clients like local engine events do. Simplest rule for A/B: a laptop in remote mode refuses its own ECHOCAT clients with a clear `rig-blocked` ("this POTACAT is itself driving a remote shack"); chaining is Phase D at most.
- **Cloud cost.** Engines over the cloud leg add decode traffic (~2–5 kB per FT8 period) and the scope (~3 kB/frame). Fine for Tailscale/LAN; the Phase D bandwidth mode covers Cloud.
- **TURN budget** (1000 MB/day per the cloudlog endpoint) with two audio peers in Phase C. Measure in Phase C beta before lifting the single-listener rule on the cloud leg.
- **Protocol drift.** The bridge table + `protocol-demux-parity-test.js` + a new S2C parity test keep the three clients (phone, web, desktop) honest. A message added to the shack without a row fails CI.
- **`RigController` surface creep.** The remote controller must implement the methods main.js calls, with a test that enumerates `cat.<method>(` in main.js and asserts each exists on `RemoteRigController` (implemented or refusing).
- **Guest Pass on a laptop with engines.** Pass enforcement (privilege class, power cap) already applies on the shack per session; engine TX from a guest obeys it there. Verify in the Phase B e2e with a pass-authenticated fake client.

## 7. Decisions (Casey, 2026-10-21: all yes)

1. **Engines on the shack, never on the laptop.**
2. **Phase order A → B → C**, then D.
3. **Multi-client ships behind `settings.echocatMultiClient` for one release**, default off, displacement kept as the fallback.
4. **A laptop driving a remote shack refuses its own ECHOCAT clients** with `rig-blocked` ("this POTACAT is itself driving a remote shack"); chaining is Phase D at most.
5. **Scope:** A in one desktop release; B over two or three (JTCAT first, then CW + voice, then SSTV/scope/JS8/FreeDV); C its own release with the mobile handoff.

## Build order

A1 remote intent flag + guards · A2 `RemoteRigController` + inbound fan-in + tests · A3 outbound VFO parity + PTT · A4 `remote-features` gating + banner/pill · A5 audio (devices, volume, keyboard PTT, health) · A6 pairing fixes (expiresAt, re-pair, passSession, SPKI, unpair, copy) · A7 docs page · A8 laptop refuses own clients while remote.
B1 `remote-bridge` + parity test · B2 JTCAT · B3 CW + voice macros · B4 SSTV · B5 scope · B6 JS8 · B7 FreeDV/Kiwi/TGXL/rotor/custom CAT/VFO profiles · B8 activator wire · B9 engine-owner + take-over.
C1 `_clients` behind the flag · C2 presence · C3 attribution · C4 PTT arbitration · C5 audio per peer · C6 guest + owner · C7 mobile handoff · C8 tests.

## 8. Boundaries

I build only `potacat-dev`. The docs page (A.8), any cloud/worker change, and every mobile-facing message (`engine-owner`, `clients:list`, `originClientId`, `ptt-refused`, the Take-over flow) are handoff documents: `potacat-app/docs/desktop-handoffs/`, the cloudlog root, potacat-docs. The desktop must work with the other side unchanged.

## 9. Files

Phase A: `lib/remote-rig-controller.js` (new), `lib/remote-features.js` (new), `main.js` (`ensureRemoteClient`, `isRemoteActive`, the four inline branches removed, `handleRemotePtt`), `renderer/app.js` (gating, pill, audio settings, keyboard PTT, re-pair), `renderer/index.html`, `renderer/remote-audio-answerer.js` (device/volume), `lib/remote-client.js` (SPKI pin, tsCertPublic), tests above, potacat-docs page.
Phase B: `lib/remote-bridge.js` (new), the pop-out IPC registrations in `main.js`, `lib/remote-server.js` (`engine-owner`, `jtcat-set-pref`), `test/remote-bridge-parity-test.js`.
Phase C: `lib/remote-server.js`, `renderer/remote-audio.html` (per-peer), `renderer/remote.js` (presence), mobile handoff.
