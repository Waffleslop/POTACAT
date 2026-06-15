# Handoff → Mobile: JTCAT "Chase Target" (CQ tag + decode highlight)

**Audience:** iOS/Android (ECHOCAT) agent.
**Status as of desktop:** **shipped** on `feature/chase-target` (merging to `master`). Full wire is live: C2S setter, S2C echo, `auth-ok.settings` seed, per-decode `chaseMatch` flag, and the previously-dropped `jtcat-call-cq {modifier}` is now honored. The ECHOCAT **web** client (served `remote.js`) already implements all of this — use it as the reference; the **native** app needs to mirror it.
**Why this exists:** award chasers (DXCC = entities, WAC = continents, WAS = states) need to (a) call a *directed* CQ — `CQ EU`, `CQ JA`, `CQ FL`, `CQ POTA` — and (b) spot the stations they still need in a busy decode list. This feature gives them one knob that does both.

---

## 1. What a "chase target" is

A single shared preference: **`settings.jtcatChaseTarget`** — a string tag (`''` = none). It drives **two** things at once:

1. **Outgoing CQ tag.** When the op calls CQ, the message becomes `CQ <tag> <call> <grid>` (e.g. `CQ EU K3SBP FN20`).
2. **Incoming decode highlight.** Every decode the desktop sends now carries a boolean **`chaseMatch`** — true if that station matches the chased target. The desktop computes it authoritatively (it owns cty.dat); **mobile just styles the flag — do NOT recompute it.**

It's a **shared, last-writer-wins** preference: the desktop popout and every phone see and edit the same value, and changes propagate both ways.

> ⚠️ **Naming trap (three similarly-named things).** Keep these distinct:
> - **Chase target** (this doc) = who you *call CQ to* + decode highlight. Wire: `jtcat-set-chase-target` / `jtcat-chase-target`.
> - **Auto-CQ mode** = auto-*answer* (you reply to *other* people's CQs / hunting). Wire: `jtcat-auto-cq-mode` / `jtcat-auto-cq-state`.
> - **Full Auto CQ** (ULTRACAT) = call CQ → work answerers → re-arm, forever. Separate handoff: `ultracat-full-auto-cq.md`.

## 2. Wire summary

| direction | message / field | status |
|---|---|---|
| S2C | `auth-ok.settings.jtcatChaseTarget` (string, `''`=none) | **live** — seed the picker at connect |
| S2C | `jtcat-chase-target` `{ tag }` | **live** (cached + replayed on reconnect) |
| C2S | `jtcat-set-chase-target` `{ tag }` | **live** — phone sets the shared target |
| S2C | `jtcat-decode` … `chaseMatch: bool` (per result) | **live** — new field on existing decodes |
| C2S | `jtcat-call-cq` `{ modifier }` | **existing field, now honored** (was dropped before — see §5) |

All additive, behind the existing `jtcat` feature gate — no protocol-version bump. Older desktops never send `jtcat-chase-target` and omit `chaseMatch`/`jtcatChaseTarget`; default to "none / not highlighted" when absent.

## 3. Detecting + syncing the current target

Use **both** signals (same pattern as ULTRACAT):

### (a) Connect-time — `auth-ok.settings.jtcatChaseTarget`
```jsonc
{ "type": "auth-ok",
  "settings": { "myCallsign": "K3SBP", "grid": "FN20jb",
                "jtcatChaseTarget": "EU", /* …rest… */ } }
```
Seed the picker from this on connect/reload.

### (b) Live — S2C `jtcat-chase-target`
Sent whenever anyone changes it (desktop popout, this phone, or another client), **and replayed on (re)connect**.
```jsonc
{ "type": "jtcat-chase-target", "tag": "EU" }
```

**Idempotency rule (important):** when you *receive* `jtcat-chase-target`, update local state + UI **only**. Do **NOT** echo it back with `jtcat-set-chase-target` — that creates a broadcast storm. Only send `jtcat-set-chase-target` in response to a *user action* in your picker.

## 4. The tag universe + the picker

The desktop's source of truth is `renderer/cq-target.js` (a pure module). **Port its tables/logic** rather than inventing your own — the desktop validates again on receive, but your UI should match so the op sees consistent behavior.

**Protocol constraints (WSJT-X Tx6 CQ):** a tag is **≤4 chars** between `CQ` and the call, **UPPERCASE only** (lowercase becomes hash codes; >4 chars won't encode). Validate/clamp before sending.

**Curated quick-picks** (categorized dropdown):
- **Continent / DX:** `DX` (any other continent), `NA SA EU AS AF OC AN`
- **Program:** `POTA SOTA FD QRP`
- **Contest:** `TEST`

**Plus a free-text custom field** for what isn't in the list:
- a **US state** code (`FL`, `CA`, …) or a **DXCC prefix** (`JA`, `VK`, `G`, `I`, …).

**Classification / collision order** (so a typed value is interpreted right): `continent → program → contest → US-state (USPS set) → DXCC prefix`. So `POTA`→program, `FL`→US-state, `JA`→DXCC prefix. Port `classifyTarget` + the USPS state set verbatim.

**Validation** before send (`validateTag`): normalize = uppercase + strip non-A–Z; reject if >4 chars (revert the picker, don't send); `''` is valid = none.

Reference impl to copy: `renderer/remote.js` — search `ft8Chase` (state, `buildFt8ChasePicker`, `reflectFt8ChaseTarget`, `applyFt8ChaseTarget`, the `__custom` option flow, and the `jtcat-chase-target` dispatcher + `auth-ok` seed).

## 5. Calling CQ with the tag (the gap fix)

The phone's CQ button used to send bare `jtcat-call-cq` and the desktop built `CQ <call> <grid>` — **the modifier was silently dropped.** That's fixed: send the chase tag as `modifier`:
```jsonc
{ "type": "jtcat-call-cq", "modifier": "EU" }   // -> desktop TX: "CQ EU K3SBP FN20"
```
If you omit `modifier`, the desktop falls back to the shared `jtcatChaseTarget`. The desktop clamps/normalizes regardless, so an over-long/lowercase value can never reach the air.

## 6. Highlighting decodes

Each `jtcat-decode` result may now have `chaseMatch: true`. Style those rows distinctly (desktop uses a **gold** accent + a `◎` badge, separate from the yellow "Wanted" tint and the new-DXCC/grid/call `D`/`G`/`C` badges). Offer a **"Chase only"** filter that keeps only `chaseMatch` rows (plus always-show: directed-at-me, 73, your QSO partner) — mirror your existing CQ/Wanted filter affordances.

**Reliability tiers** (so you know what to expect — all decided desktop-side):
- **Program/contest** (`POTA`/`SOTA`/`FD`/`QRP`/`TEST`): matches a decode whose CQ tag token equals the target. Reliable.
- **Continent** (`NA…OC`, and `DX` = any non-home continent): matches the decode's resolved continent. Reliable.
- **DXCC prefix** (`JA`, `G`, …): matches the decode's resolved DXCC entity. Reliable.
- **US-state** (`FL`, …): **v1 no-op for incoming highlight** — a state isn't derivable from a modern callsign (cty.dat resolves only "United States"). The *outgoing CQ tag still works fully*; just don't promise incoming highlights for state targets. (Follow-up: a grid→state table.)

## 7. Out of scope (don't build as CQ tags)

Named special events — **13 Colonies, LCTOTA, WWFF, IOTA, ILLW, Museum Ships, Route 66** — are **not** CQ tags. They're worked by hitting the *published callsign* + spotting, not by a custom CQ string (and most exceed 4 chars anyway). If you want an "event mode" later, it belongs on the spot/watchlist path, not this picker. Also note: **"FT2"** in the mode list is a project-internal name, not a real WSJT-X mode.

## 8. Desktop source pointers
- Shared logic to port: `renderer/cq-target.js` (`QUICK_PICKS`, `normalizeTag`, `validateTag`, `classifyTarget`, `cqTagOf`, `matchesDecode`, `buildCqTxMsg`)
- Web-client reference UI: `renderer/remote.js` (`ft8Chase*`), `renderer/remote.html` (`#ft8-chase`, `#ft8-chase-custom`, `#ft8-chase-filter`), `renderer/remote.css` (`.ft8-chase`, `.ft8-badge-chase`)
- Wire: `lib/echocat-protocol.js` (`jtcat-set-chase-target`, `jtcat-chase-target`), `lib/remote-server.js` (`broadcastJtcatChaseTarget` + connect-replay), `main.js` (`applyChaseTarget`, `broadcastChaseTarget`, `buildChaseContext`, `updateRemoteSettings`, the `jtcat-call-cq` handler, decode `chaseMatch` flagging)
- Tests to keep green: `node test/cq-target-test.js` (38), `node test/jtcat-test.js` (162), `node test/echocat-protocol.test.js` (27)

73.

---

## iOS/Android implementation status (2026-06-15) — DONE (mobile side)

Built in potacat-app commit `3011673` (pushed, master). Pure-TS,
OTA-able, no new dep. Backward-compatible and **inert until this
desktop feature merges to master + ships** (older desktops omit the
fields → none/unhighlighted), so it's safe to land ahead of the merge.
NOT yet OTA'd — recommend holding the OTA until the desktop half is
live, then coordinate (or it rides the next native build).

- **Protocol:** registered `jtcat-set-chase-target` (C2S) +
  `jtcat-chase-target` (S2C) in `src/protocol/echocatProtocol.ts`.
  Without them the S2C echo was dropped as an unknown type and the
  C2S setter failed `encode()`. `chaseMatch` + `jtcatChaseTarget`
  ride the existing field-less `jtcat-decode` / `optObject` auth-ok
  passthroughs — no change needed there.
- **`src/utils/cqTarget.ts`:** ported `renderer/cq-target.js` verbatim
  — `QUICK_PICKS`, `US_STATES`, `normalizeTag`, `validateTag`,
  `buildCqTxMsg`, `classifyTarget` (collision order
  continent>program>contest>us-state>dxcc). Deliberately did NOT port
  `matchesDecode`/`cqTagOf` per §1/§6 — desktop owns the match; mobile
  styles `chaseMatch` only. 8 unit tests.
- **`src/state/chaseTarget.ts`:** boot-registered store. Seeds from
  `auth-ok.settings.jtcatChaseTarget`, applies live `jtcat-chase-target`,
  and honors the §3 idempotency rule — the setter is sent ONLY on a
  user action, a received value never echoes back.
- **`src/screens/Ft8Screen.tsx` + `ChaseTargetSheet.tsx`:** CQ button
  sends `modifier` from the tag (§5); gold ◎ badge + row tint on
  `chaseMatch`; "◎ Chase" only-filter (persisted, directed/73 bypass,
  §6); "Target:" pill opens the categorized picker + custom
  US-state/DXCC field + live CQ preview. US-state highlight surfaced
  as the documented v1 no-op (§6) — CQ tag works, decodes not
  highlighted for states.

Distinct from `jtcat-auto-cq-*` (already wired separately) — the §1
naming trap was observed.

Remaining for end-to-end: desktop `feature/chase-target` → master +
ship; then OTA the mobile side (or ship in the next build) and
device-verify the picker UI (sheet layout, the two new filter-row
pills on narrow screens, the gold tint) — that's the only unverified
part; wire + logic are tsc-clean and unit-tested (full mobile suite
299/299).
