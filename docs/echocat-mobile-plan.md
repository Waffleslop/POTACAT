# ECHOCAT Native Mobile App — Implementation Plan

This document is a hand-off spec for an engineer (or another Claude Code session)
who is starting fresh on the ECHOCAT iOS + Android native app project. It assumes
you have not seen the previous design conversation. Read all of it before
writing code.

> **Status (2026-05-02):** Phase 0 is **shipped** on the POTACAT desktop
> (commits `62bec7e`, `44c1aac` on master). The desktop now speaks the v1
> protocol, advertises itself via mDNS, and exposes a QR-pair flow. **The
> mobile-app dev (probably you, reading this) starts at Phase 1 in a
> separate repo** — see "Where to start" at the bottom of this document.

## Project context

**POTACAT** is an Electron desktop app for hunting POTA (Parks on the Air)
activators with a FlexRadio or any rig with CAT control. It also acts as a
"radio server" — its **ECHOCAT** subsystem exposes the radio over a WebSocket
+ WebRTC bridge so a phone (or another machine) can:

- See live POTA / SOTA / WWFF / cluster spots and a map
- View and tune the VFO, change mode, adjust filter / RF gain / TX power
- Listen to the rig and PTT through the phone mic (full-duplex SSB)
- Listen to a remote KiwiSDR / WebSDR routed through the desktop
- Run JTCAT (the desktop's WSJT-X-equivalent FT8 engine) from the phone
- Log QSOs into the desktop's ADIF log
- Operate POTA activations remotely (multi-park, n-fer, etc.)

Today, ECHOCAT is reached via a **browser URL**: the desktop serves a single-
page web app over HTTPS at `https://<desktop-ip>:7300/` and the user opens it
in mobile Safari / Chrome. This works but has hard browser limitations
(background audio, push, Bluetooth, cert friction). The goal is to ship a
**native iOS + Android app** that does the same job better.

This is a solo-ish project (one developer + AI assistance). The plan is
sized accordingly — phased delivery, no unnecessary heroics.

## Repository orientation

POTACAT lives at <https://github.com/Waffleslop/POTACAT>. Relevant files:

- `main.js` — Electron main process. Owns the radio CAT connection, the
  ECHOCAT remote server lifecycle, push of state to phones.
- `lib/remote-server.js` — the WebSocket + HTTP server that phones connect
  to. ~1500 LOC. **The most important file for this project.**
- `lib/cloud-sync.js` / `lib/cloud-auth.js` / `lib/cloud-ipc.js` — the cloud
  Cognito integration used for cross-device QSO log sync. Already wired up;
  reuse for app auth where it makes sense.
- `renderer/remote.js` — the current browser-based ECHOCAT phone UI. ~9000
  LOC of vanilla JS. **All of this logic needs to be available in some form
  to the native app**, but most of it is rendering and will be rewritten in
  React Native components. The protocol-handling parts must be lifted into
  a shared module — see Phase 0.
- `renderer/remote.html` — the phone HTML shell.
- `preload-remote-audio.js` + `renderer/remote-audio.html` — hidden Electron
  BrowserWindow on the desktop side that runs the WebRTC audio bridge.
  Phone-side WebRTC code is currently embedded in `renderer/remote.js`
  (look for `kiwiAudioCtx`, `localAudioStream`, `pc = new RTCPeerConnection`
  blocks). Both sides will keep using `wrtc` / browser WebRTC API; only the
  signaling shim changes.
- `potacat-echocat.crt` — self-signed TLS cert shipped with the repo. Phones
  currently have to install + trust it via iOS Settings → General → Profile.
  **Eliminating this UX hazard is one of the biggest wins of going native.**
- `lib/jtcat-manager.js` + `lib/ft8-engine.js` — JTCAT engine. Phone already
  controls this via the WS protocol; no protocol changes needed for v1.

CLAUDE.md at the repo root gives more architectural context — read it: d:\projects\potacat-dev\

## Why native, briefly (for the project pitch / readme)

The browser URL works for a desk operator who keeps Safari foregrounded. It
falls over for the actual ECHOCAT use case — operating from the field /
couch / car with the phone in your pocket. Native gives you:

- **Background audio + VoIP push** — keep the rig audio flowing with the
  screen off and the app backgrounded. iOS suspends WebSocket + WebAudio
  aggressively in browser; native sidesteps this.
- **Reliable push notifications** — watchlist hits, new ATNOs, club net
  reminders. Mobile Safari's PWA push is unreliable.
- **Bluetooth HFP audio** — full two-way voice over Bluetooth headsets.
  Browser is stuck with one-way A2DP and ~200ms latency.
- **Web Bluetooth on iOS** — doesn't exist in Safari. The companion
  `potacat-speakermic` BLE PTT button only works for Android Chrome users
  today; native fixes that.
- **No cert dance** — pin the desktop's cert internally on first pair,
  never bother the user.
- **mDNS auto-discovery** — phone finds the desktop on the LAN by name.
- **Lock-screen / Dynamic Island / widgets** — VFO frequency, PTT button,
  watch complications. Browser can't do any of this.
- **App Store discoverability** — hams search the App Store, not URLs.

Costs: $99/year Apple Developer, $25 one-time Google, two store listings to
maintain, native binary version skew with the desktop protocol (mitigated
by Phase 0 versioning).

## Tech stack

**React Native + Expo (managed workflow with prebuild)** is the chosen
stack. Rationale:

- POTACAT is all JS; this team writes JS faster than anything else.
- One codebase, ~90% shared between iOS and Android.
- Expo EAS Build handles store builds without Xcode/Android Studio CI hell.
- The ~10% native code (audio session config, foreground service, hardware
  PTT) is small Swift / Kotlin modules dropped in via `expo-modules-core`
  or `expo-modules-autolinking`.

**Specifically chosen libraries** (lock these in early — switching costs
are real):

- `react-native` 0.74+ (or whatever ships with the latest Expo SDK).
- `expo` (managed workflow) + `expo-dev-client` (so we can run our custom
  native modules in dev).
- `@livekit/react-native-webrtc` — actively maintained WebRTC fork, the
  default `react-native-webrtc` package has been spotty.
- `react-native-zeroconf` — mDNS browse for `_potacat._tcp.local`.
- `react-native-keychain` — token + cert fingerprint pinning.
- `react-native-mmkv` — fast persistent KV for spots cache, settings.
- `expo-notifications` — APNs/FCM token registration. Push fan-out is
  custom (see Phase 3).
- `expo-camera` (or `expo-barcode-scanner`) — QR pairing scan.
- `react-native-leaflet-view` or a `react-native-maps` overlay — for the
  map view. Investigate which is less janky on iOS; Leaflet matches the
  desktop app's existing OSM tile setup.
- For audio session config, foreground service, hardware PTT: write
  custom Expo modules (Swift + Kotlin). No off-the-shelf package does
  this correctly for ham use.

**Explicitly rejected:**

- Flutter — Dart relearn cost with no clear win.
- Capacitor / wrapping the existing web view — doesn't solve the
  background audio problem, which is the entire point.
- Twin native (Swift + Kotlin from scratch) — overengineering for solo.

## Phased delivery

The phases are sized so each one ends with a usable, shippable artifact. Do
not skip Phase 0; everything else compounds on it.

---

### Phase 0 — Protocol hygiene — ✅ SHIPPED (2026-05-02)

Phase 0 was completed in two commits on the POTACAT desktop repo:

- `62bec7e` — ECHOCAT protocol module + audit + headless CLI (foundation)
- `44c1aac` — Wire ECHOCAT v1 protocol: hello handshake, mDNS, QR pairing

**What landed (everything below already works on master):**

1. **`lib/echocat-protocol.js`** — schema-of-record module. Pure JS, no
   Node-only deps, RN-importable. Exports `PROTOCOL_VERSION` (= 1),
   `CLOSE_CODES`, the `MESSAGES` registry (162 types catalogued), a
   hand-rolled validator, `parse()` / `encode()`, `buildClientHello()` /
   `buildServerHello()`, and `checkCompatibility()`. **Mobile app
   should import this verbatim** (see Protocol-sharing strategy below).

2. **`docs/echocat-protocol.md`** — human-readable catalog of every
   message type, grouped by feature (handshake, spots, rig, ptt,
   activator, logging, JTCAT, FreeDV, CW, SSTV, cloud, KiwiSDR). One-
   line purpose + direction (S→C / C→S / both) per row. **Required
   reading for the mobile-app developer.**

3. **`test/echocat-protocol.test.js`** — 27 unit tests, all passing.
   Exercises every validator branch + builders + compatibility edges.

4. **`scripts/echocat-cli.js`** — headless smoke client. Connects, does
   the v1 handshake, optionally auths with `--token`, dumps incoming
   messages. Run this against a live POTACAT desktop to verify the
   protocol path works before writing a line of RN code:
   ```bash
   node scripts/echocat-cli.js wss://localhost:7300 --insecure
   ```

5. **Hello handshake** wired into both `lib/remote-server.js` and
   `renderer/remote.js`. Server sends `{type:'hello', protocolVersion,
   serverVersion, capabilities}` as the very first frame. Clients send
   the same shape on connect with `clientVersion` + `clientPlatform`.
   Version skew handling: ±1 major OK; >1 major → close with WS code
   4001. Legacy browser ECHOCAT (which leads with `auth`, not `hello`)
   keeps working unchanged.

6. **mDNS / Bonjour** advertisement via `bonjour-service`. Service type
   `_potacat._tcp` on the configured port. TXT record carries
   `version`, `name` (hostname), `fingerprint` (SHA-256 of TLS cert),
   `proto=echocat`. Mobile app should browse for this to auto-discover
   desktops on the LAN.

7. **`POST /api/pair`** HTTP endpoint. Phone POSTs
   `{pairingToken, deviceName, devicePlatform}` (pairing token comes
   from a QR generated on the desktop, 5-minute TTL, single-use).
   Server returns `{deviceToken, deviceId, fingerprint,
   protocolVersion, serverVersion}`. The phone stores `deviceToken`
   and uses it as `{type:'auth', token: deviceToken}` for all future
   WebSocket connections.

8. **Per-device long-lived tokens** in `settings.pairedDevices` on the
   desktop, alongside the existing single-shared-token auth path. Auth
   path now accepts either. Server fires `paired-devices-changed`
   when tokens are minted/revoked; main.js persists.

9. **QR-pair UI** in Settings → ECHOCAT. "Show pairing QR" button →
   generates QR encoding `potacat://pair?host=<wss-url>&token=<token>&fp=<cert-sha256-fp>&name=<hostname>`,
   countdown timer, paired-device list with per-device Revoke buttons.

10. **`--print-cert-fingerprint` CLI flag** on POTACAT desktop. Reads
    the active TLS cert, prints its SHA-256, exits. Useful for
    headless / SSH-only desktops where the QR UI isn't available.

**Acceptance criteria — all met:**
- ✅ `lib/echocat-protocol.js` exists, tests pass, is the single source
  of truth for message shapes.
- ✅ `docs/echocat-protocol.md` documents every message type.
- ✅ Browser ECHOCAT still works unchanged (every change additive).
- ✅ `scripts/echocat-cli.js` connects + handshakes against a running
  desktop end-to-end.

**Caveat for the mobile-app dev:** the protocol registry tolerates
extra fields and many older messages have only loose schemas (the
`fields` block is omitted or partial). This was deliberate — Phase 0
prioritized non-breaking extraction over field-by-field tightening.
Tighten incrementally in Phase 1 as you exercise each message from
the app side. Touch nothing on the desktop side without bumping the
protocol version.

---

### Phase 1 — Read-only mobile app (~2-3 weeks)

Ship a TestFlight + Play Internal build that does **everything except
audio and PTT.** This is 80% of daily-use value at 30% of the engineering
risk and validates the architecture cheaply.

**App project layout** (new repo: `potacat-mobile`, separate from
POTACAT desktop — keep them decoupled, link via the shared
`echocat-protocol` module published as a private npm package or
git submodule):

```
potacat-mobile/
  app.json
  eas.json
  package.json
  src/
    App.tsx
    navigation/
      RootNavigator.tsx       — bottom tabs
    screens/
      PairingScreen.tsx       — QR scan + mDNS list + manual entry
      SpotsScreen.tsx
      MapScreen.tsx
      VfoScreen.tsx           — read-only freq/mode/S-meter, tap-to-tune
      LogbookScreen.tsx       — recent QSOs from desktop
      SettingsScreen.tsx
    services/
      EchocatClient.ts        — wraps echocat-protocol, manages WS lifecycle
      DeviceList.ts           — mDNS browse + manual list
      Storage.ts              — Keychain + MMKV
    components/
      SpotRow.tsx
      VfoDial.tsx
      ...
    state/
      useSpots.ts             — Zustand or Jotai (small)
      useRadio.ts
      useConnection.ts
  ios/  (generated by `expo prebuild`, committed)
  android/ (same)
  __tests__/
```

**Deliverables:**

1. **Pairing flow.** QR scan first (camera). mDNS list as fallback ("I
   can see POTACAT on Casey's MacBook Pro — pair?"). Manual host:port +
   pairing-token entry as last resort.
2. **Connection management.** Auto-reconnect with exponential backoff.
   Show clear "disconnected / reconnecting / live" status in the header.
3. **Spots screen.** Mirrors the table view. Tap a spot → tune. Filter
   by source (POTA/SOTA/WWFF/Cluster). Pull-to-refresh.
4. **Map screen.** Leaflet (matches desktop's OSM tiles + dark theme),
   activator markers, NEW-park badges, home QTH marker. Tap-to-tune.
5. **VFO screen.** Big legible frequency, mode, band. S-meter. Mode
   switch buttons. RF gain / TX power sliders (one-way for now —
   slider sends the change to desktop, no audio yet).
6. **Logbook screen.** Recent N QSOs. Read-only. (Editing logbook
   from phone is a Phase-3 feature, scoped out for v1.)
7. **Settings.** Paired devices, dark/light, font scale.
8. **CI: EAS Build configured.** `eas build --profile preview` produces
   a TestFlight + Play Internal build. Document the secrets in
   `docs/echocat-mobile-release.md`.

**Phase 1 acceptance:**
- App installs cleanly on iOS 16+ and Android 10+.
- Pair → see live spots → tune the rig → switch modes — all via the LAN.
- App handles desktop going to sleep / network drop / app backgrounding
  gracefully (reconnects when foregrounded; UI shows clear connection
  state; no crashes).
- Five testers running it for a week without major issues.

---

### Phase 2 — Audio + PTT (~3-4 weeks)

The hard part. Where most of the engineering effort lives.

**Deliverables:**

1. **WebRTC voice path.**
   - Use `@livekit/react-native-webrtc`.
   - Reuse the existing desktop WebRTC offer/answer / ICE signaling
     verbatim (it's in `lib/remote-server.js` — search for
     `signal-from-client`). Only the renderer side moves to RN.
   - The hidden desktop audio bridge (`renderer/remote-audio.html`)
     stays exactly as-is. The phone is the only thing changing.

2. **iOS audio session config (custom Swift module).**
   - Create `modules/expo-echocat-audio/ios/EchocatAudio.swift`.
   - Call site in JS: `await EchocatAudio.startSession({ allowBluetooth: true })`.
   - Sets `AVAudioSession.Category.playAndRecord`, `.mode = .voiceChat`,
     `.options = [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker]`.
   - Activates the session and registers route-change handlers so the
     UI can show "now using AirPods" / "now using built-in mic".
   - On stop, deactivate cleanly so other apps regain audio focus.

3. **Android audio + foreground service (custom Kotlin module).**
   - `modules/expo-echocat-audio/android/EchocatAudio.kt`.
   - Sets `AudioManager.MODE_IN_COMMUNICATION` for low-latency two-way.
   - Foreground service with `MediaSession` so Android doesn't kill it.
   - Notification: "POTACAT — connected to desktop, listening on 14.250
     USB" with a Disconnect action.
   - Bluetooth HFP routing via `setBluetoothScoOn(true)` after SCO link
     established (this is fiddly; budget time).

4. **VoIP push (iOS PushKit).**
   - Reason: iOS suspends backgrounded apps within ~30s of silence.
     For a true full-duplex voice path we want the OS to treat ECHOCAT
     audio sessions like phone calls. PushKit is for VoIP apps —
     ECHOCAT genuinely is one architecturally, so this is legitimate
     and Apple has approved similar ham apps (e.g. EchoLink).
   - When the desktop sends a "TX active" or "audio session start"
     event, it triggers a VoIP push via the relay. The app wakes with
     full audio session privileges.
   - Implementation: `PKPushRegistry`, `PKPushPayload`. Custom Swift
     code; no off-the-shelf RN package handles this cleanly.

5. **PTT controls.**
   - On-screen big PTT button (already in remote.js).
   - Lock-screen widget (iOS WidgetKit + iOS 16 Lock Screen widgets;
     Android `RemoteViews` quick-tile).
   - Hardware PTT options:
     - Headset center button → `MediaSession` integration (works on
       both platforms).
     - Bluetooth Classic / BLE PTT button → existing
       `potacat-speakermic` BLE protocol (Phase 4, but stub the
       integration point now).
     - Lightning / USB-C accessories — defer.

6. **Push-to-talk latency target: <120ms button-press to RF.**
   - 50ms WebRTC encode + send.
   - 30ms desktop receive + route to USB CODEC.
   - 30ms rig PTT response.
   - Plus 10ms slack. Anything over 200ms is unusable for SSB ragchew.
   - Add a perf test that measures round-trip in a synthetic loop.

**Phase 2 acceptance:**
- Two-way SSB QSO from the phone in your pocket while walking around.
- Bluetooth headset (AirPods + a generic Android HFP headset) both
  work cleanly.
- Audio survives 5+ minutes of background with the screen locked.
- PTT latency under 200ms measured.
- No audio routing weirdness when a phone call comes in (audio session
  yields cleanly, restores after).

---

### Phase 3 — Push notifications + polish (~1-2 weeks)

**Deliverables:**

1. **Cloud relay** for APNs/FCM fan-out.
   - Cloudflare Worker (free tier is fine for this volume).
   - Endpoints:
     - `POST /register` — app registers its device token + a per-user
       subscriber ID minted by the desktop at pair time. Stores in KV.
     - `POST /push` — desktop POSTs an event, relay looks up the
       subscriber's tokens and forwards to APNs / FCM with the right
       payload.
   - Apple auth key + FCM key live in Worker secrets.
   - **Privacy-conscious design:** the relay sees only opaque
     subscriber IDs, payload titles, and routing — no QSO content,
     callsigns, or grid squares. Stronger spec: end-to-end encrypt the
     payload with a key shared at pair time, relay forwards ciphertext.
2. **Push triggers (configurable on the desktop):**
   - New ATNO spotted (per current strict-ATNO logic).
   - Watchlist callsign on air.
   - Cluster spot on a chosen band/mode.
   - Activator at a specific park (e.g. for park-chasers).
   - Club net imminent.
3. **Lock-screen widgets.**
   - iOS: current VFO frequency, paired-desktop status, PTT button.
   - Android: same as quick tile + home-screen widget.
4. **Watch app (stretch).** Apple Watch complication showing VFO +
   PTT. Android: Wear OS tile. Probably defer to v1.1 unless trivially
   cheap on top of the iOS widget code.
5. **Store submission.**
   - App Store Connect listing: title, description, keywords, screenshots
     for 6.7" + 6.1" iPhones + 12.9" iPad.
   - Google Play Console: same set for Android.
   - Privacy nutrition labels: data collected = device token, paired
     desktop fingerprint, subscriber ID. NO location, NO contacts, NO
     QSO content (the relay never sees it).
   - Age rating: 4+ on iOS, Everyone on Google.
   - Apple-specific: ham radio apps tend to need a written explanation
     of "why does this app need always-on audio / VoIP push." Have a
     paragraph ready.

**Phase 3 acceptance:**
- App in TestFlight external testing + Google Play Open Testing.
- Push notifications arrive for at least three trigger types.
- Submitted to App Store Review.

---

### Phase 4 — Bluetooth speakermic (post-v1)

Wire the existing `potacat-speakermic` project into the native app
properly. iOS finally works (Web Bluetooth doesn't exist there).
Probably ~1 week. Defer until v1 ships and we know what users actually
want.

---

## Open decisions for the user (Casey)

**Resolved (2026-05-02):**

1. ~~**Repo strategy.**~~ ✅ **Separate repo.** Mobile app lives in its
   own directory (e.g. `d:\projects\potacat-app`). Shared
   `echocat-protocol.js` is **copied + hand-synced** during Phase 1
   (the protocol is stable enough; sync drift will be small). When
   it gets more dynamic, switch to a git submodule or a private npm
   package. POTACAT desktop stays at `d:\projects\potacat-dev`.

**Still open — answer before Phase 2:**

2. **Cloud relay hosting.** Cloudflare Workers ($0 / month at this
   scale) vs your existing AWS Cognito infra. Recommend Cloudflare for
   simplicity unless there's a specific reason to consolidate.

3. **App Store team.** Are you going to publish under your individual
   Apple Developer account or set up a "POTACAT" organization? Org
   account is more work but cleaner if you ever bring in another dev.

4. **Pricing.** Free? $4.99 one-time? Subscription? POTACAT desktop is
   free; the app should probably be free too, with the cloud relay
   funded by donations / patreon. Worth a separate decision.

5. **Auth model.** Pairing token only (LAN-first), or also support
   logging into the existing POTACAT cloud account so the same user
   can roam between multiple desktops? V1 should be pairing-only;
   cloud-account integration is post-v1.

## Out of scope for v1

Explicitly NOT in this plan, to keep scope honest:

- iPad / tablet-optimized layouts beyond "it works in portrait at iPad
  size." A real iPad layout is a future thing.
- Wear OS / Apple Watch beyond the simple widgets.
- Standalone activator-mode operating UI (the desktop is the
  activator workstation; the phone is the chase / monitor / passenger
  device).
- ADIF import/export from the phone — the phone is a thin client; the
  desktop owns the log.
- Per-user multi-tenant — one phone : many desktops. V1 is one phone :
  one desktop at a time. Multi-desktop pairing is post-v1.
- Local rig control (i.e. the app talking direct serial / Bluetooth to
  a rig without POTACAT desktop in the loop). Scope explosion. Maybe
  ever, maybe never.

## Risks and mitigations

- **Apple App Review hostility.** Mitigation: lead the submission with
  a clear "this is a remote rig control app for licensed amateur radio
  operators, FCC license required to actually transmit" framing. Have a
  test account with a paired desktop reviewer can use. Reference
  EchoLink, RT Systems Pro Audio Cable, etc. as precedents.
- **WebRTC + iOS background suspension edge cases.** Mitigation: VoIP
  push, plus a watchdog that kills + reopens the WebRTC peer connection
  if audio packets stop flowing for >2s.
- **Protocol version skew.** Mitigation: Phase 0 versioning + capability
  negotiation. Bump the minor version on additive changes; bump major
  only when truly necessary.
- **Single dev burnout.** Mitigation: phased delivery, each phase
  shippable on its own. Phase 1 alone (read-only) is genuinely useful
  even if Phase 2 takes longer than expected.

## Effort estimate (solo, part-time, with AI assistance)

- Phase 0: 1 week
- Phase 1: 2-3 weeks
- Phase 2: 3-4 weeks
- Phase 3: 1-2 weeks
- **Total to first store-submitted v1: 7-10 weeks**

## Where to start (Phase 1 — beginning today)

You are starting in a fresh repo (`d:\projects\potacat-app` or wherever
the user has set you up). The POTACAT desktop is at `d:\projects\potacat-dev`
and Phase 0 is already shipped on its master branch (commits `62bec7e`,
`44c1aac`). Your job is Phase 1 — the read-only iOS + Android app.

### Required reading (do this first, in order)

1. **`d:\projects\potacat-dev\docs\echocat-mobile-plan.md`** — this
   document, cover to cover. Pay special attention to Phase 1, the
   tech-stack lock-ins, and "Out of scope for v1."
2. **`d:\projects\potacat-dev\docs\echocat-protocol.md`** — the message
   catalog. You'll be implementing client-side handlers for most of
   the S→C messages, and senders for a subset of the C→S messages.
3. **`d:\projects\potacat-dev\lib\echocat-protocol.js`** — the schema-
   of-record. **Copy this file into your repo** (see Protocol-sharing
   strategy below). Do not modify it on the desktop side without
   coordinating with the desktop maintainer.
4. **`d:\projects\potacat-dev\scripts\echocat-cli.js`** — the headless
   reference client. Read it; it shows the exact handshake sequence
   your RN app must implement. Your `EchocatClient.ts` is essentially
   a typed-React-Native version of this script's logic.
5. **`d:\projects\potacat-dev\lib\remote-server.js`** — for protocol
   questions. Don't read end-to-end; grep for specific message types
   when you need to confirm exact field shapes.

### Protocol-sharing strategy

For Phase 1, **copy `lib/echocat-protocol.js` into the mobile repo**
as `src/protocol/echocatProtocol.ts`, port it to TypeScript (give the
registry, validators, and builders proper types), and keep it in
sync manually when the desktop version changes. The protocol is
stable at v1; expect maybe 5-10 minor shape tightenings over six
months — easy to mirror by hand.

When the protocol becomes more dynamic (e.g. v2 lands), promote the
shared module to a real package: either a git submodule pointing at a
standalone repo, or a private npm package. Don't pay that complexity
tax during Phase 1.

### First-day checklist

In the mobile repo:

1. `npm create expo-app@latest -- --template blank-typescript`. Use
   the latest Expo SDK that ships with React Native ≥ 0.74.
2. Install: `expo-dev-client`, `react-native-zeroconf`, `react-native-keychain`,
   `react-native-mmkv`, `expo-camera`, `react-navigation` (bottom-tabs
   + native-stack), and a state lib (Zustand recommended).
3. Run Phase 0's headless CLI against your local POTACAT desktop to
   confirm the protocol path works:
   ```bash
   cd d:\projects\potacat-dev
   node scripts/echocat-cli.js wss://localhost:7300 --insecure
   ```
   You should see the server `hello`, `auth-mode`, and `auth-ok`
   reported. If that fails, fix it before writing app code.
4. Build the protocol layer first: port `echocat-protocol.js` to TS
   and write your `EchocatClient.ts`. Get a Node-side test passing
   (run it via `ts-node`) that connects to the desktop, exchanges
   `hello`, authenticates with a paired-device token, and prints the
   first `spots` message. **This is the Phase 1 equivalent of the
   Phase 0 acceptance test — do not move on until it works.**
5. Build the pairing screen next. QR scan → POST to `/api/pair` →
   store the returned `deviceToken` + `fingerprint` in Keychain.
   Manual host:port entry as a fallback.
6. mDNS browse for `_potacat._tcp` to populate a desktop list on the
   pairing screen.
7. Then the SpotsScreen, MapScreen, VfoScreen, LogbookScreen, and
   SettingsScreen as described in the Phase 1 deliverables.

### Things you should NOT do in Phase 1

- Do **not** add audio, PTT, or any WebRTC code. That's Phase 2.
- Do **not** modify anything in the POTACAT desktop repo. If you
  discover a protocol bug or need a new server-side capability, file
  a note for the desktop maintainer. Phase-1 work should be additive
  on the app side only.
- Do **not** publish to the App Store / Play Store. Phase 1 ships to
  TestFlight + Play Internal only.
- Do **not** reach for native modules unless you've exhausted the JS
  options. The first native code we'll write is in Phase 2 (audio).

### When you finish Phase 1

- Update this document's Phase 1 section with what shipped, just like
  the Phase 0 section above. Same format: SHIPPED date, commit SHAs,
  bullets of what landed, acceptance check, caveats.
- Open the Phase 2 plan with the user. Audio is the hard part; don't
  start it without a fresh planning conversation.

Good luck.
