# Mobile Handoff — SWR Guard: high-SWR notifications + TX-blocked state

**Audience:** ECHOCAT mobile (iOS / Android) team
**Scope:** Mirror the desktop's SWR guard on the mobile device — persistent
"TX blocked" state, high-SWR notifications, and the operator override. The
desktop guard itself shipped 2026-07-17 (`d68d540`); the small desktop wire
additions listed in "Desktop work required" are NOT yet built — coordinate
before shipping.
**Origin:** K3SBP measured a real 46:1 SWR pre-ATU while his Flex 8600
transmitted anyway — Flex radios protect themselves by folding back power but
never refuse to key. POTACAT now aborts and blocks TX on a sustained bad
match; a remote operator on a mobile device must see and control that state.

---

## Status + amendments — 2026-07-18 review (mobile built)

**Mobile's half is BUILT and committed** (potacat-app: registry entries,
`state/swrGuard.ts` mirror with transition-gated notify rules,
`SwrGuardBanner` in the AppShell banner stack on every tab, Run ATU via the
existing `rig-control atu-tune`, destructive-confirmed Override) — inert
until the desktop ships the items below, lights up automatically after.
Verified claims: guard core is real (`d68d540`; `_swrTripped` latch,
3-frame debounce, 30 s ATU suppression, `main.js:1185-1219` + gate at 8206);
the four wire items are genuinely absent; `atu-tune` already exists on both
sides (`main.js:23126`, mobile `RigControlsBody.tsx:104`).

**One claim in this doc was FALSE and changed the mobile scope:** "shipped
apps already render tune-blocked as error toasts" — on mobile the handler
was a `useEffect` inside SpotsScreen, and screens unmount on tab switch, so
trip/refusal notices only showed while sitting on the SPOTS tab. An operator
PTTing from the VFO/FT8 screen saw NOTHING; the v0 baseline was silence.
Fixed as part of the mobile build (handler moved to module scope).

Amendments for whoever builds the desktop items (mobile already conforms):

1. **Disconnect behavior:** the phone resets its mirror on disconnect and
   relies on the auth-ok hydration to restore a still-tripped latch — so the
   hydration in desktop item 1 is REQUIRED for correctness, not polish.
2. **Double-notification rule:** on a trip the desktop sends BOTH the legacy
   `tune-blocked` and the new `swr-guard`. Mobile absorbs SWR-flavored
   `tune-blocked` into a light toast while tripped (the banner owns the
   state); the full alert fires once on the trip transition. Desktop keeps
   sending both (older clients need `tune-blocked`).
3. **Fifth desktop item:** `swrGuardMax` (and `swrGuard` on/off) must be
   ADDED to the auth-ok settings whitelist (`updateRemoteSettings`,
   main.js ~9330) — the payload is a hand-whitelist (the kiwiSdrList
   lesson); "rides the settings payload" doesn't happen for free.
4. **Backgrounded-notification honesty:** the phone's OS notification fires
   only while its JS runs (live audio session — the typical remote-PTT
   case — or Android foreground service). A fully-suspended app learns at
   next launch via hydration. True push via the relay is a separate later
   item; do not promise it in release notes.

Mobile deferred (post-field-test polish, deliberately not in v1):
disabled-styling on the PTT button itself while tripped, and the red
at/above-limit zone on the SWR meter. The every-tab banner + absorbed
refusal toasts cover the operator story meanwhile.

---

## The feature in one paragraph

The desktop watches the Flex's own TX bridge meter (a true VSWR ratio,
raw/128, streamed only while transmitting). If the ratio stays above the
configured limit (default 3.0) for 3 consecutive frames, the desktop aborts
the transmission — FT8 mid-cycle, Tune carrier, Run mode, or voice PTT — and
**latches**: every TX path refuses until the match has plausibly changed (ATU
tune runs, band changes) or the operator explicitly overrides. An ATU tune
never trips the guard (its own carrier sweeps the bad match by design; the
guard is suppressed for 30 s around it). SWR is only measurable DURING TX, so
there is deliberately no pre-TX prediction from stale readings.

## Architecture: desktop detects, mobile mirrors + notifies + overrides

Same strategy as every JTCAT feature: **the mobile app never evaluates SWR
values or decides to trip/clear.** Detection, debounce, abort, latch, and
clear conditions all live in desktop main. Mobile's jobs:

1. **Mirror**: render a persistent "TX blocked — high SWR" state from the
   guard-state broadcasts (a banner/pill, not just a transient toast).
2. **Notify**: surface the trip loudly — in-app alert, and a local OS
   notification when the app is backgrounded (a remote operator may not be
   looking at the app when their antenna system fails).
3. **Override / fix**: offer "Run ATU" (existing `rig-control` atu action —
   fixing the match is the RIGHT action) and "Override — TX anyway" (new C2S,
   confirmation required) from the blocked state.

## What already works today (zero mobile changes)

- **Trip + refused-PTT notices** arrive as `tune-blocked` S2C messages, which
  shipped apps already render as error toasts. This is the v0 baseline: a
  mobile operator today DOES see "TX aborted — SWR 46.0:1 exceeded the 3.0:1
  limit…" and "PTT blocked — SWR guard tripped…" — transiently.
- **Live SWR** streams as `swr-ratio` S2C (`{ value }`) during TX, with a
  final `value: 0` decay frame ~10 s after TX ends; the status snapshot
  carries `swrRatio` for mid-session connects. Use this for the meter UI.

What's missing is **state**: a toast evaporates, so an app opened (or
reconnected) mid-latch has no way to know TX is blocked. That's the new work.

## Wire contract (proposed additions)

Registry entries required on BOTH sides (`lib/echocat-protocol.js` desktop,
`src/protocol/echocatProtocol.ts` mobile) — the `apply-vfo-profile` lesson:
mobile's `encode()` validator rejects unregistered C2S, so drift bricks the
feature silently phone-side only.

### S2C — guard state (new)

```json
{ "type": "swr-guard",
  "tripped": true,
  "swr": 46.0,            // ratio at trip time (tripped only)
  "limit": 3.0,           // configured swrGuardMax
  "band": "20m",          // band it tripped on (tripped only)
  "reason": "ATU tune" }  // cleared only: "ATU tune" | "band change" |
                          //   "operator override"
```

Sent on every trip and clear, and **hydrated once on auth-ok when currently
tripped** (adoption, never a toast — the spot-target rule: replayed state is
rendered silently; only live transitions notify).

### C2S — override (new)

```json
{ "type": "swr-guard-override" }
```

Desktop mirrors its existing `swr-guard-override` IPC → `clearSwrTrip
('operator override')` → `swr-guard` cleared broadcast comes back.

### Capability gate

Add `'swr-guard'` to the server-hello `capabilities` array in the same desktop
change. Older desktops silently drop unknown C2S (no `default` in the
remote-server switch), so the app must gate the override button and the
stateful banner on the capability — the v0 `tune-blocked` toasts still work
against any desktop.

## UX requirements

- **Blocked state**: persistent red banner/pill wherever TX affordances live
  (VFO PTT, FT8 screen, voice macros): "TX blocked — SWR 46.0:1 (limit
  3.0:1)". Buttons: "Run ATU" (sends the existing `rig-control` ATU action)
  and "Override" (confirmation sheet: "Transmit anyway into a bad match? The
  radio will fold back power." — destructive style).
- **Trip notification**: in-app alert always; local OS notification when
  backgrounded ("TX aborted — high SWR on 20m. Open ECHOCAT to fix."). Never
  notify for the hydration replay.
- **Clear**: banner drops; small toast "TX re-enabled — SWR guard reset (ATU
  tune)". The `reason` string is display-ready.
- **Meter**: the existing SWR readout should show a red zone at/above
  `limit` (the limit arrives in the guard state; also `swrGuardMax` rides the
  settings payload).
- PTT button while tripped: disabled-styled with the blocked message — don't
  let the user mash a button that the desktop will refuse anyway.
- No emojis in any copy. The guard is Flex-only today — the capability + a
  never-tripped state mean non-Flex rigs simply never show any of this.

## Desktop work required before mobile ships (not yet built)

1. S2C `swr-guard` broadcast on trip/clear (in `tripSwrGuard` /
   `clearSwrTrip`, main.js) + hydration on auth-ok when tripped.
2. Remote handler for C2S `swr-guard-override` (mirror of the local IPC).
3. `'swr-guard'` added to hello capabilities (`lib/remote-server.js`, the
   capabilities array).
4. Registry entries for both messages in `lib/echocat-protocol.js`.

All four are small; the detection/latch machinery they expose already shipped.

## Desktop references

- Guard core: `main.js` — search `_swrTripped`, `tripSwrGuard`,
  `clearSwrTrip`, `noteAtuTuneStarted`, `swrGuardMax`.
- Detector: `smartSdr.on('swr-ratio')` handler (3-frame debounce, ATU
  suppression window).
- TX gates: jtcat `tx-start` handler, `startJtcatTune`, `handleRemotePtt`.
- Meter provenance (why the number is trustworthy): `lib/smartsdr.js`
  `_parseMeterPacket` — radio's own `src=TX-` SWR meter, raw Int16 / 128.
- Settings: `swrGuard` / `swrGuardMax` (rig editor, Flex section; ride the
  settings payload to the phone).
