# Handoff → Mobile: ULTRACAT mode + JTCAT Full Auto CQ

**Audience:** iOS/Android (ECHOCAT) agent.
**Status as of desktop:** detection contract **shipped**, and as of 2026-07-17 the *control* path is **live too** — `jtcat-full-auto-cq` C2S works, `owner: 'remote'` re-arms/stalls/watchdogs correctly (see §5, now historical). Desktop naming note: the popout controls were renamed 2026-07-16 — the auto-answer dropdown is now **"Hunt"**, Full Auto CQ's button is **"Run"**. Wire fields are unchanged.
**Why this exists:** the desktop grew a hidden "ULTRACAT" tier that unlocks new JTCAT auto-sequencing. Mobile should be able to (a) detect when the paired desktop is ULTRACAT-unlocked and mirror the controls, and (b) eventually drive them.

---

## 1. What ULTRACAT is

ULTRACAT is a **hidden, opt-in tier** (a *The Net* easter egg). On desktop you unlock it with **CTRL/CMD + SHIFT + click the π** in Settings; it persists as the machine-scoped setting `ultracat` (bool). It gates two JTCAT features:

1. **Full Auto CQ** — a "run" mode: call CQ → work whoever answers → automatically re-arm CQ → repeat, indefinitely.
2. **Configurable retry limit** — stop retrying a stalled QSO after *N* cycles, then resume CQ.

When `ultracat` is **false**, none of these controls are shown. When **true**, the JTCAT popout reveals an **Auto CQ** toggle + a **max-attempts** field.

> ⚠️ **Naming trap.** JTCAT already had an **"Auto-CQ" dropdown that is actually auto-*answer*** (it replies to *other* stations' CQs — hunting). That is the existing `jtcat-auto-cq-mode` / `jtcat-auto-cq-state` wire pair. **Full Auto CQ is the opposite** (we *call* CQ and work answerers). Keep them distinct in the mobile UI. They are mutually exclusive on desktop.

## 2. JTCAT additions (behavior to mirror)

- **Full Auto CQ run loop:** start → build `CQ [MOD] MYCALL MYGRID` and TX. On a caller, the normal `cq → cq-report → cq-rr73 → done` sequence runs; on `done` it re-arms a fresh CQ. Worked calls are tracked in a session set (dupe-skip is a *known TODO*, not yet enforced in the cq reply selector).
- **Configurable per-phase TX cap** *(CONTRACT CHANGED 2026-07-10 — KQ4MHD stuck-QSO fix)*: setting `jtcatMaxQsoAttempts` (1–60, default **12**) = max transmissions of the same message per phase. **EVERY non-advancing decode cycle increments the counter — being heard no longer resets it** (the old heard-reset let a partner repeating a non-advancing message hang the QSO forever). On reaching the cap: if signal reports were exchanged both ways (`canCloseoutQso`) → **closeout** (log the QSO + send one final courtesy 73); else in run mode → **abandon the QSO and resume CQ**; otherwise → halt TX with a notice. The **CQ phase never aborts in run mode** (CQ forever). The tries input is no longer ULTRACAT-gated on desktop — it's public UI.
- **Retry policy is a pure function** you should replicate verbatim: `decideRetryOutcome({phase, txRetries, maxCq, maxQso, runMode, closeoutEligible}) → {retries, action}` where `action ∈ 'continue' | 'abort' | 'rearm' | 'closeout'` (`closeout` is checked before `rearm`, so run mode logs before moving on). Companions: `canCloseoutQso(q)` (reply-side `r+report`, `report && sentReport`, not hound/FD) and `closeoutStalledQso()`. Source: `lib/jtcat-state-machine.js` (unit-tested in `test/jtcat-test.js`). Desktop constants: `maxCq = 15`, `maxQso = jtcatMaxQsoAttempts`.
- **Attended-operator watchdog (REQUIRED to replicate):** run mode auto-stops after **30 minutes** without QSO progress. This is not a nicety — see §6 (Part 97). Do **not** ship a phone "leave it running" mode without the same guardrail.

Desktop entry points for reference: `startFullAutoCq` / `rearmCq` / `stopFullAutoCq` / `jtcatFullAutoCqWatchdog` in `main.js`.

## 3. How mobile checks if the desktop is in ULTRACAT mode  ← the answer

Two complementary signals. **Use both:** the settings blob for guaranteed connect-time state, the message for live changes.

### (a) Connect-time — `auth-ok.settings`
The `auth-ok` payload's `settings` object now carries:

| field | type | meaning |
|---|---|---|
| `ultracat` | bool | desktop is ULTRACAT-unlocked → **reveal the matching mobile controls** |
| `jtcatMaxQsoAttempts` | number | current per-QSO retry ceiling (seed your max-attempts control) |

```jsonc
// auth-ok (excerpt)
{ "type": "auth-ok",
  "serverVersion": "1.8.x",
  "settings": { "myCallsign": "K3SBP", "grid": "FN20jb",
                "ultracat": true, "jtcatMaxQsoAttempts": 12, /* …rest… */ } }
```

### (b) Live — S2C `jtcat-ultracat-state`
Sent whenever ULTRACAT is toggled (unlock/revoke) or Full Auto CQ starts/stops, **and replayed on (re)connect** so a phone that joins mid-run learns the state immediately.

```jsonc
{ "type": "jtcat-ultracat-state",
  "ultracat":      true,        // unlocked?  → show/hide ULTRACAT UI
  "fullAutoCq":    true,        // run mode currently active? → show the run indicator
  "owner":         "popout",    // who started it: "popout" | "remote" | null
  "maxQsoAttempts": 12 }
```

**Recommended mobile logic:** reveal the ULTRACAT controls iff `ultracat === true` (from either signal); show the Full Auto CQ "running" indicator iff `fullAutoCq === true`. The phone does **not** need its own π unlock gesture — it simply mirrors the desktop's unlock state. (If you want an independent phone-side unlock later, that's a separate decision; for now, follow the desktop.)

> Both `jtcat-ultracat-state` and the two `settings` fields are additive and behind the existing `jtcat` feature gate — no protocol-version bump. Older desktops simply never send `ultracat:true`, so the controls stay hidden. Default everything to "locked / not running" when absent.

## 4. Wire summary

| direction | message / field | status |
|---|---|---|
| S2C | `auth-ok.settings.ultracat`, `.jtcatMaxQsoAttempts` | **live** |
| S2C | `jtcat-ultracat-state` `{ultracat, fullAutoCq, owner, maxQsoAttempts}` | **live** (replayed on connect) |
| S2C | `jtcat-auto-cq-state` `{mode,…}` | existing — this is **auto-answer**, not Full Auto CQ |
| C2S | `jtcat-call-cq` `{modifier}` | existing — single manual CQ |
| C2S | `jtcat-auto-cq-mode` `{mode}` | existing — auto-**answer** on/off |
| C2S | `jtcat-full-auto-cq` `{on, modifier}` | **live** (2026-07-17) |

## 5. Controlling Full Auto CQ from the phone — LIVE (2026-07-17)

The `remote` owner path is wired on desktop:

- **C2S:** `jtcat-full-auto-cq` `{ on: bool, modifier?: string }` → `startFullAutoCq('remote', modifier)` / `stopFullAutoCq('stopped from phone')`. The ULTRACAT unlock is guarded desktop-side; a locked desktop refuses and re-broadcasts `jtcat-ultracat-state` so an optimistic phone toggle reconciles to "not running". Watch that broadcast for your source of truth rather than assuming the send succeeded.
- **Stop is unconditional** — `on:false` stops even a popout-owned run (any client silencing TX is always allowed). Feel free to offer a stop button whenever `fullAutoCq === true`, regardless of `owner`.
- Remote-owned runs re-arm after each completed/stalled QSO and are covered by the same 30-min attended watchdog; QSO progress rides the existing remote JTCAT session messages.
- The phone should **gate the start control on `ultracat === true`** and treat Hunt (`jtcat-auto-cq-mode`) and Run as mutually exclusive in its UI: the desktop enforces run→hunt-off (starting Run zeroes Hunt), but not the reverse — when the user picks a Hunt mode while a run is active, send `jtcat-full-auto-cq {on:false}` first (this mirrors the desktop popout UX).

## 6. Compliance — read before building a "leave it running" UI

This is US FCC **Part 97** territory and the reason the watchdog is mandatory, not optional:

- **Attended** (operator present, able to stop it) = local/remote control. Auto-sequencing CQ this way is fine — same footing as WSJT-X auto-seq.
- **Unattended** auto-CQ on the FT8 calling frequencies (14.074 etc.) becomes **automatic control**, which is **not** permitted there: those dial frequencies aren't in the §97.221(b) automatic-control sub-bands, and *calling* CQ isn't "responding to interrogation," so the §97.221(c) exception doesn't apply either.
- Therefore: **mirror the 30-minute attended watchdog**, frame the feature as operator-assist (not "set and forget"), and don't market a hands-off mode. Other jurisdictions differ — this guidance is US; gate accordingly if you localize.

## 7. Desktop source pointers
- Retry policy: `lib/jtcat-state-machine.js` → `decideRetryOutcome()`
- Run loop + watchdog: `main.js` → `startFullAutoCq` / `rearmCq` / `stopFullAutoCq` / `jtcatFullAutoCqWatchdog` / `JTCAT_FULL_AUTO_CQ_WATCHDOG_MS`
- Wire: `lib/echocat-protocol.js` (`jtcat-ultracat-state`), `lib/remote-server.js` (`broadcastJtcatUltracatState`, connect-replay), `main.js` (`updateRemoteSettings`, `broadcastFullAutoCqState`)
- Tests to keep green: `node test/jtcat-test.js` (160), `node test/echocat-protocol.test.js` (27)

73.
