# POTACAT Desktop-to-Desktop Remote Control — Implementation Plan

This document is the design spec for adding **desktop-as-client** support to
POTACAT: the ability for a POTACAT Desktop instance running on a laptop (the
"client") to drive a separate POTACAT Desktop instance running at the shack
(the "shack server") over LAN, Tailscale, or POTACAT Cloud Tunnel.

It assumes the reader has not seen the design conversation. Read the whole
thing before writing code. Status: **design, not started**. Target: ship
Phase 1 as part of v1.9.x.

---

## Why this exists

POTACAT today is a single-host app. The radio is plugged into the computer
running POTACAT, and that's that. You can already reach the shack from a
phone, an iPad, or any web browser via **ECHOCAT** — a WebSocket + WebRTC
bridge served from `lib/remote-server.js`. ECHOCAT is good for casual
operating from the couch or the field.

But ECHOCAT in its current shape doesn't replace the desktop. The full
POTACAT UI — the spot table with nine resizable columns, the Leaflet map,
DXCC tracker, scan, FT8 engine, CW keyer macros, WinKeyer — only lives in
the desktop renderer. If you have a shack computer permanently attached to
the rig and you grab your laptop to operate from the kitchen table, you
either:

- Open ECHOCAT in a browser tab (reduced feature surface), or
- Install POTACAT on the laptop and physically plug it into the rig
  (impossible — the rig is at the shack).

This plan closes that gap. The laptop runs the full POTACAT Desktop app but,
instead of looking for a local radio, it dials the shack instance over
ECHOCAT v1 and proxies all rig interactions across the wire. From the user's
point of view, the laptop *is* their shack.

---

## What's already built that we lean on

This is mostly an integration project, not a from-scratch build. The hard
infrastructure already exists for the mobile app and we reuse it verbatim:

- **`lib/remote-server.js`** — TLS WebSocket server on port 7300 with QR
  pairing, tap-to-pair (`/api/pair-request`), long-lived per-device tokens,
  mDNS advertisement on `_potacat._tcp`, Tailscale-issued Let's Encrypt cert
  auto-renewal. **The shack-side server is essentially done.**
- **`lib/cloud-tunnel.js` + `potacat-cloudlog/routes/cloud-tunnel.js`** —
  Cloudflare-tunnel provisioning that gives the shack a public hostname
  (`<callsign>.potacat.com`) for off-LAN access.
- **ECHOCAT v1 wire protocol** (`docs/echocat-protocol.md`) — JSON-typed
  control envelopes, device-agnostic. Adding desktop as a client doesn't
  change the protocol shape, only its message catalog.
- **Three-leg dial chain** — already implemented in the mobile app
  (`EchocatClient.ts`): LAN → Tailscale → Cloud Tunnel, with cert pinning
  on the first two legs and CA validation on the third.
- **Cloud OAuth + accounts** (`lib/cloud-auth.js`, `lib/cloud-sync.js`) —
  Google sign-in already works on the desktop. Used today for QSO log sync;
  we'll extend it to register devices to an account.

What's *not* built and lives in this plan:

1. A `RemoteBackend` shim in the renderer that replaces `window.api.*` calls
   with ECHOCAT WS messages.
2. UX touchpoints: welcome-screen auto-suggest, "Remote Radios" panel,
   shareable pair-link dialog, presence chip, "someone else tuned" toast.
3. Cloud-attested pairing (`cloud_devices` table + `/devices/*` endpoints +
   `/pair-tokens/verify`).
4. Protocol additions for state mirroring (spots, presence, origin tagging).
5. Tier-based pairing model (owned vs. guest) with no-expiry support.

---

## Personas and scenarios

UX decisions in this doc lean on these. If you're tempted to add complexity,
ask whether any of these personas actually needs it.

### Persona A — Casey (single-op, Cloud-enabled)
Has a Flex 8600M in the shack with a permanent computer running POTACAT.
Also owns a MacBook Air, an iPad, and a Windows desktop in the office.
Signs into POTACAT Cloud on all of them. Wants everything to "just work" —
sign in, see his shack, click, operate. Hates re-pairing.

### Persona B — Brad (Tailscale, no Cloud account)
Privacy-conscious. Runs Tailscale across his shack and laptop. Doesn't want
to sign into Google or pay for Cloud Tunnel. Will tolerate a one-time QR
scan or share link per device. Once paired, expects it to stay paired
forever.

### Persona C — Carla (club station)
She's the POTA chair at a club station. Five regular ops, occasional
visitors. Wants to give the regulars permanent access from their personal
laptops *and* hand a visitor a 24-hour link they can use during a Field
Day weekend.

### Persona D — Dan (kitchen-table laptop)
Has only one computer — a laptop. POTACAT runs on it, plugged directly
into the rig. Doesn't use the remote feature at all today. **The remote
work must not break his world.** When he opens POTACAT, no welcome wizard,
no extra UI, no surprises.

### Persona E — Eli (first-time POTACAT user with existing shack)
Just installed POTACAT on his laptop. The shack PC has been running POTACAT
fine for months. Eli has never plugged this laptop into a rig and never
will. The first-run experience should make connecting to the shack the
*obvious* path, not the side path.

---

## Architecture

One POTACAT binary, two roles, picked per launch and switchable in-app:

```
┌──────────────── POTACAT Desktop (laptop) ──────────────┐
│                                                        │
│  Renderer ─► RigBridge ─┬─ LocalBackend (IPC) ─► main → CAT/Flex
│                         │
│                         └─ RemoteBackend (WSS) ───┐
│                                                   │
└───────────────────────────────────────────────────┼────┘
                                                    │
                                                    │ ECHOCAT v1
                                                    ▼
                          ┌────────── POTACAT Desktop (shack) ──────────┐
                          │                                             │
                          │  main process ─► CAT/Flex ─► Radio          │
                          │       │                                     │
                          │       └─► remote-server.js (WSS :7300)      │
                          │                                             │
                          └─────────────────────────────────────────────┘
```

The `RigBridge` abstraction is what makes this clean. Today, the renderer
talks to its own main process via `window.api.*` IPC calls (preload bridge).
We make that abstraction explicit: a `RigBridge` interface with two
implementations — `LocalBackend` (today's IPC path, unchanged) and
`RemoteBackend` (sends the same calls as ECHOCAT WS messages instead).

Picking which backend is active happens at startup based on
`settings.activeTargetId`:

- `null` → LocalBackend (Persona D — no change in behavior).
- A connection-target ID → RemoteBackend dialing that target.

Switching backends mid-session is supported (the Remote Radios panel lets
you connect to a different shack) and triggers a renderer reload to a known
state.

### The shack instance keeps doing what it does

The shack is unchanged at the architectural level. It runs the full
POTACAT Desktop app with its own renderer (operator can sit at the shack
and use it directly), and `remote-server.js` is its existing
WebSocket+HTTP listener. The new work is mostly:

- Publish more state events over WS (`spots:update`, presence, origin tags).
- Accept account-attested pair tokens via the new cloud path.
- Add the share-link generator UI.

### Feature parity over the wire — phased

Not every feature crosses the wire on day one. Phase 1 ships the smallest
self-respecting "I can operate" surface:

| Feature                  | Phase 1 (MVP)    | Later          |
| ------------------------ | ---------------- | -------------- |
| VFO tune, mode, filter   | ✅                |                |
| S-meter, freq display    | ✅                |                |
| PTT (where supported)    | ✅                |                |
| POTA / SOTA / WWBOTA spots | ✅ (mirrored)   |                |
| Map view                 | ✅ (uses mirrored spots) |         |
| Watchlist                | ✅ (sync both ways) |              |
| Scan                     | ✅ (remote-controlled) |           |
| DX Cluster / RBN spots   |                  | Phase 2        |
| DXCC Tracker             |                  | Phase 2        |
| ECHOCAT audio (listen + PTT) |              | Phase 2        |
| FT8 / JTCAT              |                  | Phase 2        |
| CW keyer / macros        |                  | Phase 2        |
| WinKeyer                 |                  | Phase 2        |
| SSTV                     |                  | Phase 3+       |

Anything not in Phase 1 is **hidden or disabled** in the laptop's UI when
in remote mode, with an inline note ("Coming soon — ECHOCAT audio") rather
than a broken-feeling control.

---

## Authentication model

This is the part that matters most for UX. The wrong model here either
makes Casey re-pair every 30 days or makes Brad feel pressured into a
Cloud account.

### Two trust tiers

|                  | **Owned device**                              | **Guest**                                  |
| ---------------- | --------------------------------------------- | ------------------------------------------ |
| Use case         | Your own laptop / iPad / second computer       | Friend, club member, helper                |
| Pairing method   | Cloud-account auto-pair, *or* "Trust this device" toggle | Share link / QR / tap-to-pair  |
| Expiry           | None (sliding 1-year heartbeat refresh)        | 1h / 24h / 7d / 30d, no extension          |
| Approve modal    | Skipped (pre-authorized by account or trust)   | Shown at shack, *or* skipped if link pre-issued |
| Revocation       | Cloud "My Devices" page or shack-local list    | Same, plus auto-expire                     |
| Token flag       | `accountLinked: true` or `trusted: true`, `expiresAt: null` | `expiresAt: <ts>` |

Share links **stay capped at 30 days max**. We're not weakening that —
we're providing a different mechanism for the "my own devices" case.

### Pairing paths — three of them, ranked by smoothness

#### Path 1: Cloud-account auto-pair (smoothest, recommended default)

For Persona A and anyone willing to sign into a free Cloud account.

One-time setup at the shack:

1. Shack signs into Cloud (Google OAuth — already implemented).
2. Shack registers itself: `POST api.potacat.com/devices` with
   `{deviceId, fingerprint, lanHost, tsHost, cloudHost, rigModel, name,
   type: 'shack'}`. The cloud writes this into a new `cloud_devices`
   table keyed by `accountId`.
3. Shack keeps `cloud_devices.lastSeenAt` fresh every 60 s while online,
   and re-publishes `lanHost` / `tsHost` if they change (DHCP, new
   Tailnet, etc.).

Each new owned device:

1. Sign into the same Cloud account on the laptop.
2. Laptop calls `GET api.potacat.com/devices?type=shack` → instantly sees
   every shack registered to this account. No mDNS sweep, no QR.
3. User picks a shack → laptop calls
   `POST api.potacat.com/devices/{shackId}/authorize` with its Google ID
   token + its own fingerprint.
4. Cloud verifies same `accountId`, mints a one-shot `pairToken`
   (60-second TTL, bound to the laptop's fingerprint), returns it to the
   laptop. Cloud also records "device X may pair to shack Y."
5. Laptop dials the shack (LAN → Tailscale → Cloud) and presents
   `pairToken` in the auth message.
6. Shack calls `POST api.potacat.com/pair-tokens/verify` with the token
   + the fingerprint of the client that just connected. Cloud confirms
   `{accountId, deviceId, ok: true}`.
7. Shack mints a normal long-lived `deviceToken` flagged
   `accountLinked: true, expiresAt: null`, adds the row to
   `pairedDevices[]`, returns it in the `auth-ok` reply.
8. From that moment on it's a normal paired device. The cloud round-trip
   happened *once* per device.

The shack's Approve modal **never fires** for account-linked pairs. This
is the magic-feeling part: install POTACAT on a new laptop, sign in,
your shack is just there.

> **Verification path choice.** The shack verifies the `pairToken` via
> online call to the cloud (option (a) in the design conversation). We
> are not implementing offline JWT verification — too much crypto
> surface area on the shack for the rare offline-pair case, which itself
> doesn't make sense (the laptop just got the token from the cloud, so
> the cloud is reachable).

#### Path 2: Tap-to-pair (mDNS, no account)

For Persona B on his own LAN segment, and the welcome-screen
"we found a shack nearby" flow.

1. Laptop runs a 3-second mDNS sweep for `_potacat._tcp`.
2. Discovered shacks show up as clickable entries with their fingerprint.
3. User clicks Pair → laptop POSTs `/api/pair-request` to the shack
   (over its self-signed TLS, fingerprint-pinned).
4. Shack pops a modal: *"Allow Casey's MacBook to pair? [Approve / Deny]"*
5. On Approve, shack mints a `deviceToken` with `expiresAt: now + 180d`
   (sliding) and returns it.
6. Laptop is now paired as a **guest** by default. Operator can mark
   it **trusted** at the shack to remove the expiry — see Path 3.

#### Path 3: Share-link (QR + URL + email)

Solves three cases simultaneously: same-room QR, "I forgot to pair before
leaving home" email, and "pair my new laptop without standing at the
shack" pre-authorization.

At the shack:

1. Settings → Remote Access → **Share Access**.
2. Operator picks expiry (1h / 24h / 7d / 30d, default 24h).
3. Shack generates a fresh single-use pair token, embeds it in a
   `potacat://pair?h=…&ts=…&cloud=…&t=…&fp=…&n=…&exp=…` URI.
4. Dialog shows three actions:
   - **📋 Copy link** (clipboard).
   - **✉️ Email to me** (opens `mailto:` pre-addressed to the operator's
     Cloud email if signed in, otherwise blank `to:`; subject and body
     pre-filled).
   - **🔳 Show QR** (same data as a scannable code).

At the laptop:

1. User clicks the link in their inbox (or scans the QR, or pastes the
   URI into POTACAT's "Pair from link" field).
2. OS hands `potacat://` to POTACAT Desktop via the Electron protocol
   handler (`app.setAsDefaultProtocolClient('potacat')`, registered at
   first launch). On Windows this writes the registry mapping; on macOS
   Info.plist declares it; on Linux a .desktop file does.
3. If POTACAT isn't running, it launches. If it is, the existing
   instance handles the URL via the `second-instance` event.
4. POTACAT parses the URI, calls `POST <host>/api/pair` with
   `{pairingToken, deviceName: os.hostname(), devicePlatform: 'desktop'}`.
5. Shack validates token (single-use, not yet expired), mints
   `deviceToken`, returns the row. **No Approve modal** — the operator
   pre-authorized at link-creation time.

The share dialog also discloses reachability honestly:

```
Reachable from:
  ✓ Same Wi-Fi network (LAN)
  ✓ Tailscale (k3sbp-shack.tail123.ts.net)
  ✗ Internet (Cloud Tunnel not enabled — sign in to Cloud to enable)
```

So Brad can see at a glance that his Tailscale-only link won't work from
a coffee-shop laptop unless that laptop is also on his Tailnet.

### Promoting a guest pair to "trusted device" (no Cloud account)

For Persona B who refuses Cloud sign-in but still wants no-expiry for his
own laptop, the shack's paired-devices list has an inline toggle:

```
✓ Casey's MacBook (paired 2 days ago)
  192.168.1.51 · MacBook Pro · last seen 12 min ago
  🔒 Trusted device  [ Untrust ]
  Trusted devices never expire. Only enable for hardware you own.
```

Toggling Trusted sets `trusted: true, expiresAt: null` locally. No cloud
involvement. Revocation = untoggle, or delete the row.

This is intentionally a **manual, deliberate** step. We don't auto-promote.
We *do* show a one-time hint after pairing ("Is this your own device? You
can mark it trusted to disable the 180-day expiry") so the user knows the
option exists.

---

## UX touchpoints

### 1. Welcome screen (first-run)

Today's first-run flow goes Grid → Rig → done. We insert a step *before*
the rig picker:

```
┌──────────────────────────────────────────────────────────────┐
│ Welcome to POTACAT                                           │
│                                                              │
│ Do you have a shack computer running POTACAT already?        │
│                                                              │
│   ┌─────────────────────────────────────────┐                │
│   │ 🖥️  We found one on your network:        │                │
│   │     K3SBP-Shack  (Flex 8600M)            │                │
│   │     fingerprint ab:cd:…:ef               │                │
│   │     [ Connect to this shack ]            │                │
│   └─────────────────────────────────────────┘                │
│                                                              │
│   Other ways to connect:                                     │
│   • Sign in with Cloud to find your shacks                   │
│   • Paste a pair link or scan a QR                           │
│                                                              │
│   ─────────  or  ─────────                                   │
│                                                              │
│   [ Set up a local rig instead ]                             │
└──────────────────────────────────────────────────────────────┘
```

Behaviors:

- mDNS sweep starts immediately on this screen, runs for 3 s, repeats
  every 5 s while the screen is visible.
- If discovered, the boxed result shows fingerprint and rig model (from
  the mDNS TXT — we add `rigModel` to the existing TXT record).
- "Sign in with Cloud" opens the existing Google OAuth flow, then
  branches into Path 1.
- "Paste a pair link or scan a QR" opens a sub-dialog (text field + QR
  scanner using the laptop's webcam via `getUserMedia`).
- "Set up a local rig instead" runs today's wizard. Default option for
  Persona D — *but it is not the first option visually*, because for
  Persona E the remote path is the correct one.
- If no mDNS hits and no link is pasted, we still show the "Set up a
  local rig" path; nobody gets stuck.

**Persona D protection:** if `settings.json` already exists with a valid
local rig configured (today's case for every existing user), the welcome
screen never runs. This is purely a first-install screen.

### 2. More → Remote Radios panel

The persistent manager UI. Reachable from the top bar's "More" menu (same
menu that holds Settings).

```
┌─────────────────────────────────────────────────────────────────┐
│ Remote Radios                                       [+ Add new] │
├─────────────────────────────────────────────────────────────────┤
│ ● K3SBP Home Shack          Flex 8600M    LAN          ✏️  🗑️  │
│   Connected · last used 2 min ago                               │
│   🔗 Account-linked · no expiry                                 │
│   [ Disconnect ]                                                │
│                                                                 │
│ ○ Field Day Trailer         FTX-1         Cloud Tunnel  ✏️  🗑️ │
│   Last seen 3 days ago                                          │
│   🔗 Account-linked · no expiry                                 │
│   [ Connect ]                                                   │
│                                                                 │
│ ○ W2XYZ Club Station        IC-7300       Tailscale    ✏️  🗑️  │
│   Trusted device · no expiry                                    │
│   [ Connect ]                                                   │
│                                                                 │
│ ○ Bob's Shack (guest)       Flex 6500     LAN          ✏️  🗑️  │
│   Last seen 2 h ago · 🕓 token expires in 12 days               │
│   [ Re-pair ]                                                   │
│                                                                 │
│ ○ Loaner Pi (offline)       —              Cloud Tunnel ✏️ 🗑️  │
│   Unreachable · last seen 9 days ago                            │
│   [ Retry ]                                                     │
└─────────────────────────────────────────────────────────────────┘
```

Columns and behaviors:

- **Status dot** — green = connected, gray = idle/reachable,
  yellow = unreachable, red = expired/revoked.
- **Pretty name** — editable inline (✏️). Stored on the laptop only;
  the shack does not learn what you renamed it to. Default is the
  shack's mDNS service name at pair time.
- **Rig model** — from `hello.capabilities.rigModel`. Lets the user
  distinguish two Flexes.
- **Reachability badge** — which leg of the dial chain succeeded last
  time: LAN / Tailscale / Cloud Tunnel / Offline.
- **Trust badge line** — `🔗 Account-linked`, `🔒 Trusted device`, or
  `🕓 expires in Nd`. Always present and prominent.
- **Action button** — context-sensitive: Connect / Disconnect /
  Re-pair / Retry.
- **🗑️ Remove** — deletes the local credential. Also fires
  `DELETE /api/devices/{deviceId}` to the shack (best-effort,
  idempotent) so `pairedDevices[]` is cleaned up. For account-linked,
  also fires `DELETE api.potacat.com/devices/{shackId}/pairings/{deviceId}`.
- **[+ Add new]** — opens the same flow as the welcome screen (mDNS
  list + Cloud sign-in + paste-link), minus the "set up a local rig"
  escape hatch.

Only one connection is active at a time on the laptop. Switching shacks
is an explicit click; we do not maintain parallel connections.

### 3. Active connection chip (status bar)

When in remote mode, the status bar shows:

```
🔗 K3SBP Home Shack · LAN · 12ms
```

Clicking opens a popover with:

- The full Remote Radios row (for quick disconnect / switch).
- Connection health: dial leg, RTT, last message age.
- A reminder that "POTACAT serves one client at a time — connecting from
  another device will displace this one."

When in local-rig mode, no chip — same UI as today.

### 4. Displacement banner (single-client semantics for Phase 1)

> **Important architectural constraint.** The existing
> `lib/remote-server.js` is **single-client by design**: when a second
> client authenticates, the current one is kicked via
> `_displaceCurrentClient()` (line 2583), receiving a typed
> `{type:'kicked', reason, byPlatform, byVersion, byHost}` message
> before its WebSocket is closed. Lifting this to support truly
> concurrent clients touches the `_client → _clients[]` rewrite,
> multi-recipient broadcasts, multi-peer WebRTC audio, and PTT
> ownership rules — significant surface area with regression risk to
> the existing mobile/web flows.
>
> Phase 1 **accepts the single-client model** and invests in a polished
> displacement UX. Real concurrent presence + per-client toasts move to
> Phase 2 (see "Lift single-client restriction" in the Phase 2 list).

The new client's auth-ok flow displaces the old one as today. On the
displaced (laptop or phone) side, the existing `kicked` message already
carries enough metadata to render a friendly banner instead of a
mystery disconnect:

```
┌─────────────────────────────────────────────────────────────────┐
│ ⚠  Casey's iPhone took over the rig.                            │
│    Reconnect to take it back — the iPhone will be displaced.    │
│                                       [ Dismiss ]  [ Reconnect ]│
└─────────────────────────────────────────────────────────────────┘
```

Banner copy varies by `byPlatform`:

- iOS / Android → "Your iPhone took over the rig." (with platform icon)
- Desktop → "Another POTACAT desktop took over the rig."
- Browser ECHOCAT → "An ECHOCAT browser tab took over the rig."

The Reconnect button just re-auths — the user accepts that this will
kick the other device. No locking, no negotiation. Single-op users
operating from one device at a time get a clean explanation and a
one-click way to switch back.

State change broadcasts in Phase 1 do **not** carry `originClientId` —
there's no second client to attribute changes to. (Re-introduced in
Phase 2 when multi-client lands.)

### 6. Share Access dialog (already covered in Path 3)

Lives at **Settings → Remote Access** on the shack. Same dialog used both
for fresh shares and for re-issuing a link to a known device.

The same screen also lists **pending unused links** with the device-name
hint (if any) and a "Revoke" button, so a panicky user who fat-fingered an
email recipient can pull the link before it's used.

### 7. Tailscale-only path — explicit UX care

Persona B needs to feel like a first-class citizen. Specific commitments:

- **Tailscale hostname must be in the mDNS TXT and the share link** so the
  laptop can dial it from anywhere on the Tailnet, not just the shack's
  LAN segment.
- The share link's "Reachable from" disclosure makes Cloud Tunnel
  optional — Brad sees `✓ Tailscale` and knows that's enough.
- The Remote Radios panel's status badge says "Tailscale" plainly when
  that's the active leg. No "limited mode" framing — Tailscale is a full
  reachability path.
- No nag screens or upsell modals for Cloud Tunnel. A single sentence in
  the share dialog ("Sign in to Cloud to enable internet access") is the
  full extent of the prompt.
- The "Trust this device" toggle exists specifically so Brad doesn't have
  to re-pair every 180 days without a Cloud account.

### 8. Persona D protection (existing single-host users)

For users who do not enable any remote access feature, **nothing about
their experience changes.** No welcome screen, no More menu addition, no
toasts, no extra Settings tabs surfaced. The Remote Radios menu item only
appears once the user has either:

- Run the welcome flow's remote path, or
- Manually enabled "Allow remote desktop clients" in Settings.

We're adding capability, not noise.

---

## Protocol additions

ECHOCAT v1 stays binary-compatible. We add new message types and extend
existing ones.

### New message types

| Type             | Direction | Purpose                                          |
| ---------------- | --------- | ------------------------------------------------ |
| `spots:update`   | shack → client | Push merged spot list (POTA/SOTA/WWBOTA/cluster/RBN). Throttled to 2 s. |
| `scan:state`     | shack → client | Scan status: enabled, current target, dwell remaining, skip list. |
| `scan:control`   | client → shack | `{action: 'start' | 'stop' | 'skip' | 'unskip', spotId?}` |
| `watchlist:sync` | both      | Watchlist updates flow both ways; last-write-wins. |

Deferred to Phase 2 (require multi-client):

- `clients:list` (shack → client): roster of connected clients.
- `state-change.originClientId` field: which client caused the change.

### Extended messages

- `hello` (shack → client): adds `rigModel` (string, top-level — not in
  the `capabilities` array since it's a value, not a feature flag).
- `auth-ok` (shack → client): adds `expiresAt` (epoch ms or `null` for
  no-expiry), `accountLinked` (bool), `trusted` (bool).

### New HTTP endpoints

On the shack:

- `POST /api/pair-link` → operator-side, generates a share link.
  Body: `{ ttl: 'PT1H' | 'PT24H' | 'P7D' | 'P30D', label?: string }`
  Returns: `{ token, expiresAt, url, qrSvg }`.
- `GET /api/pair-link` → list unused links (for revoke UI).
- `DELETE /api/pair-link/{token}` → revoke.
- `DELETE /api/devices/{deviceId}` → unpair (called by laptop on remove).
- `PATCH /api/devices/{deviceId}` → set `trusted: true | false`.

On the cloud (`potacat-cloudlog`):

- `POST /devices` → register a shack or client.
- `GET /devices` → list devices for the signed-in account.
- `POST /devices/{shackId}/authorize` → mint a `pairToken` for the calling
  device.
- `POST /pair-tokens/verify` → shack-side verification of an account-attested
  token.
- `DELETE /devices/{shackId}/pairings/{deviceId}` → revoke a pairing from
  the account side.

---

## Data model changes

### Laptop side (`settings.json`)

```jsonc
{
  "activeTargetId": "f3a9-...",   // null = local rig (Persona D)
  "connectionTargets": [
    {
      "id": "f3a9-...",            // shack's deviceId
      "name": "K3SBP Home Shack",  // user-editable, laptop-local
      "serviceName": "K3SBP-Shack",// original mDNS name (immutable)
      "rigModel": "Flex 8600M",
      "fingerprint": "ab:cd:...",
      "deviceToken": "...",
      "lanHost": "192.168.1.42",
      "tsHost": "k3sbp-shack.tail123.ts.net",
      "cloudHost": "k3sbp.potacat.com",
      "pairedAt": 1733328000000,
      "expiresAt": null,           // null = no expiry
      "trust": "account",          // "account" | "trusted" | "guest"
      "lastConnectedAt": 1733415600000,
      "lastReachableLeg": "lan"    // "lan" | "tailscale" | "cloud"
    }
  ]
}
```

### Shack side (`settings.json`)

Extend the existing `pairedDevices[]` rows:

```jsonc
{
  "pairedDevices": [
    {
      "deviceId": "...",
      "deviceToken": "...",
      "fingerprint": "...",
      "deviceName": "Casey's MacBook",
      "devicePlatform": "desktop-mac",
      "pairedAt": 1733328000000,
      "expiresAt": null,             // null = no expiry
      "accountLinked": true,         // came in via Cloud Path 1
      "trusted": false,              // shack operator toggled "Trust"
      "lastSeenAt": 1733415600000,
      "lastSeenIp": "192.168.1.51"
    }
  ]
}
```

Also a new top-level:

```jsonc
{
  "pendingPairLinks": [
    {
      "token": "...",
      "label": "Emailed 2026-06-04 14:22",
      "createdAt": 1733415600000,
      "expiresAt": 1733502000000,
      "used": false
    }
  ]
}
```

### Cloud side (`potacat-cloudlog`)

New table `cloud_devices`:

```sql
CREATE TABLE cloud_devices (
  device_id        TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type             TEXT NOT NULL CHECK (type IN ('shack', 'client')),
  name             TEXT NOT NULL,
  platform         TEXT NOT NULL,
  fingerprint      TEXT NOT NULL,
  rig_model        TEXT,
  lan_host         TEXT,           -- last-known, shack-only
  ts_host          TEXT,           -- Tailscale MagicDNS, shack-only
  cloud_host       TEXT,           -- callsign.potacat.com, shack-only
  created_at       INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  revoked_at       INTEGER          -- soft delete
);

CREATE TABLE cloud_pair_tokens (
  token            TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  shack_device_id  TEXT NOT NULL REFERENCES cloud_devices(device_id),
  client_device_id TEXT NOT NULL REFERENCES cloud_devices(device_id),
  client_fingerprint TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  used_at          INTEGER
);
```

---

## Security model

This is a feature where getting auth wrong loses a real radio. Be paranoid.

### Threats considered

1. **Stolen share link in email.** Single-use + 30-day max TTL bounds blast
   radius. Operator can revoke from the pending-links list. Recommended
   TTL surfaced in UI (default 24 h, not 30 d).
2. **MITM on LAN/Tailscale.** TLS with cert fingerprint pinned at the
   laptop. Fingerprint comes from mDNS TXT or QR/URL. A swapped cert
   triggers a refusal-to-connect with an explanatory error, never a
   silent downgrade.
3. **Compromised Cloud account.** Cloud "My Devices" page lists every
   paired device on every shack; revoke individually or "Sign out
   everywhere." Shacks honor revocation on their next sync.
4. **Lost laptop.** Operator revokes from the shack's paired-devices list
   (or the Cloud My Devices page). Laptop's token stops working at the
   next connection attempt.
5. **Replay of a used pair token.** Tokens are marked `used_at` on first
   redemption; subsequent attempts get HTTP 410 Gone.
6. **Token theft from `settings.json`.** `deviceToken` is encrypted via
   Electron `safeStorage` at rest. Already done for cloud sync token;
   same mechanism applies.
7. **Rogue device on home LAN claiming to be the shack.** Fingerprint
   pinning defeats this. The first-time pair flow shows the fingerprint
   to the user; subsequent connects fail if the fingerprint changes
   (cert rotation triggers a re-pair prompt).
8. **Cloud goes down.** Account-linked pairings already issued continue
   working — they use `deviceToken`, not the cloud, on the hot path.
   Only *new* pair requests fail. Shacks keep accepting their
   `pairedDevices[]` regardless of cloud reachability.
9. **Multiple clients fighting over the rig.** Out of scope for v1. Last
   write wins. Toast + presence give the user enough situational
   awareness to resolve it socially. Add a "take exclusive control"
   button in Phase 2 if anyone actually asks.

### Crypto details

- `deviceToken`: 32 bytes from `crypto.randomBytes`, hex-encoded.
- `pairToken` (cloud-attested): same shape, 60-second TTL, single-use,
  fingerprint-bound.
- `pairingToken` (share link): same shape, user-selected TTL up to 30d,
  single-use.
- Fingerprint: SHA-256 of the shack's TLS public key, colon-hex.
- Account JWT verification on cloud is by `kid` against Google's published
  keys (already implemented in `cloud-auth.js`).

---

## Phased delivery

### Phase 1 — MVP (target: v1.9.0, ~3 weeks)

Goal: Casey signs into Cloud on his shack and laptop, sees his shack in
the Remote Radios panel, clicks Connect, and operates. Brad scans a QR
and gets the same outcome. Dan sees no change.

Deliverables:

1. **Protocol additions:** `spots:update`, extended `hello` / `auth-ok`
   envelopes. Updated `docs/echocat-protocol.md`.
2. **`cloud_devices` table** + the five new cloud endpoints. Migration
   in `potacat-cloudlog`.
3. **Shack: account registration + heartbeat.** On Cloud sign-in,
   register; every 60s, refresh `lastSeenAt`.
4. **Shack: `/api/pair-link` and Share Access dialog.** Including
   pending-links list with Revoke.
5. **Shack: `pairedDevices[]` `trusted` toggle UI + "Is this your own
   device?" hint after a successful pair.**
6. **Laptop: welcome-screen step** (mDNS sweep + Cloud sign-in CTA +
   paste-link path). Persona D guard: only shows on truly fresh install.
7. **Laptop: More → Remote Radios panel** with full row UX (rename,
   remove, switch, badges, action buttons).
8. **Laptop: `RemoteBackend`** implementing the rig-control surface
   needed for Phase 1 (tune, mode, freq query, PTT, spots subscription,
   scan control, watchlist sync).
9. **Laptop: feature-gating UI** — hide/disable not-yet-mirrored
   features with inline "Coming soon" notes.
10. **Displacement banner** on the kicked client (uses existing
    `kicked` message metadata).
11. **`potacat://` protocol handler** registered on install (Windows
    registry, macOS Info.plist, Linux .desktop).
12. **180-day sliding expiry** for guest pairings;
    `auth-ok.expiresAt`; T-14d "re-pair soon" nudge.

Out of scope for Phase 1, deliberately:

- Multi-client concurrent connections (single-client model retained)
- Real presence roster + per-client toast attribution
- DX Cluster / RBN streams over the wire
- DXCC Tracker on the laptop
- ECHOCAT audio (listen / PTT) on the laptop
- FT8 / JTCAT on the laptop
- CW keyer / WinKeyer on the laptop
- Conflict locking ("take exclusive control")
- Offline JWT verification

### Phase 2 — Feature parity + multi-client (target: v1.10.x)

The big architectural unlock and the rest of the feature surface:

- **Lift single-client restriction.** Rework `_client → _clients[]`,
  multi-recipient broadcasts, multi-peer WebRTC audio bridge,
  PTT-ownership negotiation. Introduce `clients:list`, presence chip,
  `state-change.originClientId`, "someone else tuned" toast.
- DX Cluster + RBN streaming events.
- DXCC Tracker read-only on laptop; ADIF stays on shack.
- ECHOCAT audio relay — reuse the existing `lib/remote-audio` WebRTC
  bridge with the laptop's renderer as the audio sink. The desktop already
  does this for the iOS app; same code path.
- FT8 / JTCAT — control surface (start, stop, frequency, message
  selection) and decode list over WS. Audio path same as ECHOCAT.
- CW keyer + macros — remote-fire from laptop.
- WinKeyer — pass-through serial bytes; treat the shack as the WinKeyer
  host.

### Phase 3 — Polish + multi-op (target: when someone asks)

- Take-exclusive-control button + soft locking.
- Multi-op profile switching across paired shacks (ties into
  `project_multi_op_profiles.md`).
- Club station mode: multiple Cloud accounts can be authorized to a single
  shack with per-account scopes.
- Offline JWT verification if the shack-without-cloud-reachable-at-pair
  case turns out to matter.

---

## Open questions

These are deferred but should be settled before Phase 2 starts:

1. **Audio relay scaling.** ECHOCAT audio today assumes one phone client
   at a time. If a laptop and a phone both want audio simultaneously, do
   we mix on the desktop, or accept "last listener wins"? Probably the
   latter for v2, but verify in Phase 2 design.
2. **FT8 control conflict.** Two clients both trying to run JTCAT against
   the same shack rig is nonsensical. Phase 2 needs an exclusive-mode
   flag for engine-driven features (FT8, scan-with-PTT, CW macros).
3. **Cloud Tunnel cost.** Account-linked pairing increases Cloud Tunnel
   utilization. Free tier health-check guardrails in `cloud-tunnel.js`
   may need revisiting. Track usage during Phase 1 beta.
4. **Tailscale share-link generation.** If the shack is signed into
   Tailscale but the share-link recipient is not, the email is useless
   unless Cloud Tunnel is up. Should the dialog warn more strongly?
   Currently we just disclose reachability; might need a "this link
   will not work over the internet" inline warning when neither Cloud
   nor a Tailscale-shared device is in play.
5. **Renderer reload on backend switch.** Switching from LocalBackend to
   RemoteBackend mid-session does a full renderer reload to a clean
   state. Acceptable for v1. Worth investigating live swap in Phase 2.

---

## Where to start

For the engineer implementing Phase 1:

1. Read `lib/remote-server.js` end to end. That file is the contract.
2. Read `docs/echocat-protocol.md` and `potacat-app/src/services/EchocatClient.ts`
   for how mobile dials a shack. Desktop dials the same way.
3. Read `lib/cloud-auth.js` and `lib/cloud-sync.js` to understand the
   existing Google OAuth flow. Cloud-attested pairing piggybacks on it.
4. Sketch the `RigBridge` abstraction in `renderer/app.js`. Get
   `LocalBackend` working as a no-op wrapper around today's `window.api`
   calls and prove nothing regresses before touching `RemoteBackend`.
5. Stand up the `cloud_devices` table in a `potacat-cloudlog` feature
   branch; mock the endpoints with hardcoded data to unblock laptop UI
   work in parallel.
6. Write the welcome-screen mDNS path against a real shack on your LAN
   before wiring Cloud sign-in. Tap-to-pair is the cheapest happy path
   to verify end-to-end.
7. Add the "Trust this device" toggle and `auth-ok.expiresAt` next —
   that's the smallest change that delivers the "my own laptop never
   expires" promise.
8. Cloud-attested pairing comes last. By the time you get there,
   everything except the pair-token mint is already working.

When in doubt, copy what the mobile app does. It already solved every
hard problem here.
