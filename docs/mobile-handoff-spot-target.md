# Mobile Handoff — Spot Target: tap a digital spot, work it in FT8

**Audience:** ECHOCAT mobile (iOS / Android) team
**Scope:** Strategy + wire contract for bringing Spot Target to the mobile app.
The desktop feature is built (2026-07-17); the remote-owner desktop work listed
in "Desktop work required" is NOT yet built — coordinate before shipping.
**Origin:** K3SBP — clicking an FT8/FT4 POTA spot in the desktop Table view now
arms JTCAT to auto-call that activator. Mobile should get the same one-tap flow.

---

## Status + contract amendments — 2026-07-17 review (mobile built)

**Mobile's half is BUILT and committed** (potacat-app `spotTarget` state +
`SpotTargetBanner` + spot-tap arming + both registry entries), gated so it is
**inert against today's desktop** and lights up automatically when the desktop
work below ships. Four amendments to the contract, from verifying this doc
against both codebases — desktop agent, build against these:

1. **Capability gate (was missing from this doc).** Older desktops silently
   drop unknown C2S types (no `default` in the remote-server switch), so a
   phone tap would arm nothing with zero feedback. Add **`'spot-target'` to the
   server-hello capabilities array** (`lib/remote-server.js:2252`, currently
   `['diagnostic-snapshot']`) in the same change that adds the remote handlers.
   Mobile already parses hello capabilities and only shows the affordance when
   present — no version sniffing.
2. **Every kill path must broadcast `cleared` — including popout-close.** The
   popout `closed` handler drops the target with a direct `jtcatSpotTarget =
   null` (`main.js:21022`), which under this contract would strand a phone
   banner forever (an armed target on a quiet band sends no refreshes, so the
   phone cannot tell "patient" from "silently dropped"). Work item 4 below is
   amended: route ALL drops through `clearSpotTarget()` so remotes always get
   the cleared push. Also **verify engine-stop actually clears the target** —
   the ownership rules list it as a kill condition, but `stopJtcat()` shows no
   spot-target clear on inspection; if that's real it strands the popout banner
   today too.
3. **Hydration is adoption, never a toast.** The S2C mixes state with event
   semantics (engaged/cleared carry toasts). The auth-ok hydration replays
   current state — the phone adopts the first push per session silently and
   toasts only on live transitions (already implemented mobile-side; the
   desktop must not rely on a broadcast being toast-safe).
4. **Schemas, pinned:** C2S `set` = `{ target: f.object }` with desktop-side
   sanitization on ingest (the sanitizeVfoProfiles posture — never act on a
   client blob verbatim); `clear`/`call-now` = no fields; S2C = any-bag. Note
   `target.freqKhz` is a NUMBER (kHz) while `tune.freqKhz` is a STRING — same
   name, two types; keep both registries explicit about it (mobile's entry
   already carries the warning comment).

---

## The feature in one paragraph

Tapping a digital-mode (FT8/FT4/FT2) spot arms a **Spot Target**: the desktop's
FT8 engine watches the decode stream for that callsign and automatically calls
`THEIRCALL MYCALL GRID` at a polite opening — the target's own CQ, or the
target sending RR73/RRR/73 to someone else (tail-ending). It never calls blind:
**odd/even slot parity and audio df are unknowable from a spot**, so the fire
always rides a real decode, which supplies slot, df, and SNR. A banner shows
the waiting state, with **Call now** (manual fire, enabled only once the target
has been heard at least once — mid-QSO decodes don't auto-trigger but they do
reveal parity) and **Cancel**. If Hold TX Frequency is on, the dial still QSYs
but the operator's TX audio offset is preserved, with a notice saying so.

## Architecture strategy: desktop owns everything

This is the core of the mobile strategy — **the mobile app never classifies
decodes, never times slots, and never decides when to call.** All of that lives
in the desktop main process (single `jtcatSpotTarget` state + a watcher in the
decode handler). Mobile's job is exactly two things:

1. **Affordance**: tapping a digital-mode spot in the app's spot list sends one
   message to arm the target (plus clear / call-now taps).
2. **Mirror**: render the target banner from the desktop's state broadcasts.

This mirrors how the rest of JTCAT-on-mobile works (decodes, QSO state, and
auto-seq all stream from the desktop) and means the trigger policy, dupe
handling, Skip Grid, Field Day, Hound, logging, and hunted-park attribution are
inherited with zero mobile logic.

## Wire contract (proposed — mirrors the desktop IPC 1:1)

All new messages must be added to BOTH protocol registries
(`lib/echocat-protocol.js` desktop, `src/protocol/echocatProtocol.ts` mobile) —
remember the `apply-vfo-profile` lesson: the mobile `encode()` validator
rejects any C2S whose schema doesn't match, so a registry drift bricks the
feature silently on the phone side only.

### C2S (mobile → desktop)

```json
{ "type": "jtcat-spot-target-set",
  "target": { "call": "W1ABC", "mode": "FT8", "freqKhz": 14074,
              "band": "20m", "reference": "US-1234", "parkName": "..." } }
{ "type": "jtcat-spot-target-clear" }
{ "type": "jtcat-spot-target-call-now" }
```

Desktop validates (FT-family mode, callsign shape, not own call) and replaces
any prior target — **one target at a time, last set wins**, regardless of which
surface set it.

### S2C (desktop → mobile)

```json
{ "type": "jtcat-spot-target",
  "call": "W1ABC", "mode": "FT8", "freqKhz": 14074,
  "status": "armed" | "engaged" | "cleared",
  "reason": "user" | "expired" | "qsy" | "worked",      // cleared only
  "trigger": "cq" | "tail" | "manual",                  // engaged only
  "holdTx": true,                                        // engaged only
  "heard": { "agoSec": 32, "slot": "odd" } | null,       // armed refresh
  "notice": "..." }                                      // occasional info line
```

Sent on arm, on every heard-refresh (max once per 15 s FT8 cycle), on engage,
on clear, and once on connect/`auth-ok` when a target exists (so a
reconnecting client hydrates the banner).

## UX requirements (parity with the desktop banner)

- Spot list: digital-mode spots (FT8/FT4/FT2) get the tap-to-target flow; the
  tap also tunes, exactly like today's spot tap.
- Banner states:
  - armed: "Spot target W1ABC — waiting for their CQ or QSO end", plus
    "last heard 32s ago (odd slot)" when `heard` present.
  - engaged: "Spot target W1ABC — calling" + toast ("Heard W1ABC — calling",
    or "Calling W1ABC now" for manual). When `holdTx`, add the sub-line
    "Hold TX on — calling on your held offset, not their frequency".
  - cleared: hide banner; toast per reason (worked / expired after 10 min /
    band-or-mode change). `user` clears silently.
- **Call now** disabled until `heard` is non-null, with helper text
  "Not heard yet — odd/even slot unknown". This gating is a teaching moment —
  keep it, don't allow a blind call.
- No emojis anywhere in copy.

## Ownership and takeover rules (strategy decisions)

- **The target belongs to the session, not the surface.** Opening FT8 on the
  mobile app closes the desktop popout (existing one-platform-at-a-time
  takeover) — the target must SURVIVE that takeover in both directions and
  keep watching under the new owner. Only explicit clear, TTL, QSY-away,
  worked, or engine stop kill it.
- Fire gating on desktop is owner-aware: with a mobile-owned session the fire
  builds the remote QSO (same path a decode-row tap from the app uses today),
  so the app's QSO tracker shows the ladder exactly as if the user had tapped.
- Deferral: the target never fires while any QSO is active or Run mode owns TX.

## Desktop work required before mobile ships (not yet built)

Today's implementation is popout-only. To support mobile, the desktop needs:

1. Broadcast `jtcat-spot-target` to remote clients (currently popout-window
   IPC only) + hydrate on auth-ok.
2. Remote handlers for the three C2S messages (trivial mirrors of the
   existing `ipcMain` handlers at the Spot Target IPC block in main.js).
3. Owner-aware fire: when the session is remote-owned, fire through the remote
   reply path (build `remoteJtcatQso`) instead of `jtcat-popout-reply`.
4. Popout-close must NOT clear the target when a remote client owns the
   session (today it clears unconditionally — correct for popout-only, wrong
   once mobile participates in the takeover model).

## Desktop references

- Target state + IPC + watcher: `main.js` (search `jtcatSpotTarget`,
  `broadcastSpotTarget`, `clearSpotTarget`, "Spot Target watcher").
- Trigger classifier (pure, the policy source of truth):
  `renderer/jtcat-parser.js` `classifySpotTargetTrigger` + its 21-case suite in
  `test/jtcat-parser-test.js`.
- Banner UX to mirror: `renderer/jtcat-popout.html` `#jp-spot-target-banner`,
  `renderer/jtcat-popout.js` (search `onJtcatSpotTarget`).
- Spot-tap arming: `renderer/app.js` (search `jtcatSpotTargetSet`).
- Takeover model background: `main.js` `remoteServer.on('jtcat-start')`
  (closes the popout; sends the takeover toast).
