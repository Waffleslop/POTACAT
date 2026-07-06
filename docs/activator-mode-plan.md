# Activator Mode — World-Class Plan (Desktop + iOS/Android)

*Drafted 2026-07-05 from: PoLo (Ham2K Portable Logger) feature research, a full audit of the
current desktop + mobile activator implementations, and the 6/29–7/4 user thread
(K3SBP, N5SKT, W7RTA, N7BBQ, N3VD, N5WBL, twilliams, NA7C).*

## North Star

PoLo is the app to beat because it makes **field logging frictionless**: one smart entry
field, exchange chips, worked-before badges, call stacking for pileups, multi-network
self-spotting, offline-first, and per-operation ADIF export. We will match that bar —
and then win on the one thing PoLo can never do: **POTACAT is connected to the radio.**
Band/mode/freq come from CAT, tapping a P2P spot tunes the rig, QSY auto-re-spots,
CW macros and FT8 log straight into the activation. The pitch: *"PoLo logs what you did.
POTACAT drives the activation."*

Casey's framing: don't "take PoLo and make it better" — take POTACAT and make it
activator-friendly.

## What users asked for (thread requirements)

| Ask | Who | Where it lands |
|---|---|---|
| Add hunter-mode QSOs to an activation after the fact | twilliams, N5WBL | Phase 1 |
| Reopen a stopped activation for a straggler | N5WBL | Phase 1 |
| Comma-separated parks AND calls everywhere | N5SKT, N5WBL | Phase 0/1 |
| Park # validation at entry | N5SKT | Phase 0 |
| One-button log submission: POTA + QRZ/LoTW/Clublog + email | N5SKT | Phase 1 |
| Tablet layout: log + spots independently scrollable | N5SKT | Phase 1/2 |
| Hunt parks while activating (P2P), buttery smooth | N5SKT | Phase 1/2 |
| Configurable columns (P2P ref column) | N5WBL | Phase 1 |
| Second-op shadow view (kid logging on iPad lags behind) | N5WBL | Phase 3 |
| Multi-program activation (POTA+WWFF+LLOTA+Tiles) from mobile | N7BBQ | Phase 2 |
| ECHOCAT standalone activation — no desktop at all | N7BBQ | Phase 2 |
| "Start activation" on mobile does nothing | N3VD | Phase 0 |
| P2P without park # (CW just sends "P2P") — don't force the ref | N7BBQ | Phase 1 (ref optional) |
| "Parks near me" — one tap to pick the park, no memorizing refs | K3SBP | Phase 1/2 |
| Nearby-parks list with driving distance to encourage a 2fer/rove | K3SBP | Phase 2 |

Note (W7RTA): there is **no POTA upload API** today; the v3 API (WD4DAN is a dev on it)
is "next year-ish". Plan for it, don't depend on it.

## Current-state audit (what's actually there)

### Desktop (potacat-dev) — surprisingly far along
- Multi-park n-fer (≤6), cross-program X-Refs (SOTA/WWFF/LLOTA/WWBOTA), full
  myParks × theirParks ADIF cross-product, POTA-rule dupe check, inline edit/delete,
  per-park or combined ADIF export named `CALL@PARK-YYYYMMDD.adi`, resume past
  activations, hunter QSOs auto-tagged into a live activation (gated on
  `activationActive`, not `appMode` — correct design).
- "Upload to POTA" = stage file + open pota.app/#/upload (correct, given no API).

### Desktop — confirmed bugs/gaps
1. **`all-qsos` legacy path has no byte cap** — auto-pushed on *every QSO save*
   (main.js:4748-4757); legacy clients get 2000 *records* (~9.6MB single frame) →
   iOS WS 1009/1006 kill. `worked-qsos` has a 256KB byte cap; `all-qsos` doesn't.
   This is N3VD's bug-report smoking gun. Chunked path exists but build 59 mobile
   doesn't advertise `chunked-all-qsos` (fix landed 2026-07-02, after build 59).
2. **Cross-program P2P mislabeled**: `theirPark` hardcodes `sig='POTA'`
   (app.js:22570, 22581) — a WWFF/SOTA hunter's ref logs as `SIG=POTA`. Wrong credit.
3. **No auto-respot on QSY** (tuneActivatorFreq only tunes) and no spot on activation
   start; self-spot is manual, POTA-only, hardcoded comment ignoring respot templates.
4. **No park validation**: loose regex, no local parks-DB existence check, no
   auto `US-` prefix on the activator park input.
5. **`resumeActivation` hardcodes `mySig:'POTA'`** (app.js:21423, 21437) — corrupts
   resumed non-POTA activations.
6. **`stopActivation` is a no-op** beyond killing the timer — no summary, no export
   prompt, no QRT spot.
7. **Two session-contact stores**: renderer `activatorContacts` vs remote-server
   `_sessionContacts` — desktop-logged QSOs never reach the phone's session list.
8. No explicit `start-activation`/`stop-activation` protocol messages; mobile can
   start (via `set-activator-park`) but can never stop.
9. SOTA/WWBOTA cross-refs never self-spot; WWBOTA lacks a dedicated ADIF ref field.
10. Counter counts raw contacts, not POTA's unique-callsign validity count.

### Mobile (potacat-app) — a stub
- `ActScreen.tsx` sends `set-activator-park` and **nothing else** — no ack, no
  navigation, no state change. That IS "nothing happens" (N3VD). Single park,
  single program (POTA/SOTA/Other).
- Nothing consumes `session-contacts` — there is no activation log view at all.
- **Good news**: `LocalQsoStore` + cloud sync (`/v1/sync/push|pull`, debounced,
  LWW conflicts) + `LogQuickSheet` (spot-tap logging with local record + desktop
  `log-qso`) + chunked `all-qsos` already exist. Standalone mode has a foundation.

### PoLo capabilities to match (research summary)
- Operations model: create op → attach activities (POTA/SOTA/WWFF/GMA/FD/WFD…);
  operation **templates** ("repeat last setup in a few taps"); GPS **nearest-park**;
  multi-op with per-operator logs; **rove** support (BREAK command relocates mid-op).
- Entry UX: one smart field — callsign plus inline commands; **call stacking** for
  pileups; callsign notes; worked-before ("N QSOs" badge) + name/QTH preview;
  dupe warnings; exchange chips (time, band·mode, P2P park, notes).
- Spotting: one button fans out to **all networks in the op** (POTA+WWFF+GMA);
  `SPOTME/QSY/QRT` typed commands; **auto-spot every ~10 min**; spot-tap prefills
  a QSO slot.
- Offline-first with cached data files; Ham2K LoFi sync (has real user complaints:
  emptied logs, corrupted times, GPS misses — reliability is attackable).
- Export: per-op ADIF/Cabrillo, export templates, email to POTA coordinator
  (N5SKT hates its iOS mail-attach failures — another attackable weakness).
- Free/open source; huge goodwill. We don't win on price; we win on the radio.

---

## Phase 0 — Stop the bleeding (patch release, days)

1. **Byte-cap the legacy `all-qsos` path** exactly like `_sendWorkedQsosCapped`
   (256KB, newest-first, `truncated:true`) and stop auto-pushing the full log on
   every QSO save — push an incremental `qso-added` delta message instead
   (full snapshot only on `get-all-qsos`). Kills the 1006/1009 loop for all old builds.
2. **Mobile start-activation feedback**: on `set-activator-park`, desktop replies
   with `activator-state`; ActScreen must show *something* — success toast +
   navigate to (interim) session view, or an error if no ack in 3s. Ship in next
   OTA/build alongside `chunked-all-qsos`.
3. **Fix cross-program P2P SIG** (carry the hunter park's real program through
   `hunterParkRefs` → ADIF `SIG`).
4. **Fix `resumeActivation` POTA hardcode** (use `activation.sig`).
5. **Park entry validation**: auto-prefix (`1234` → `US-1234`), local parks-DB
   existence check with name confirmation inline, comma-parse on the activator
   input (already parses — add validation feedback per ref).

## Phase 1 — Desktop: activation as a first-class object (1–2 weeks)

**Architecture keystone:** move the activation session into a single main-process
store — `lib/activation-session.js` — owning: `{ id, refs:[{program,ref,name}],
grid, startedAt, state:'active'|'paused'|'stopped', contacts:[…] }`. Renderer and
ECHOCAT both become views of it. This dissolves gap #7 and makes every Phase 2
mobile feature a protocol mirror instead of a re-implementation. New protocol
messages: `start-activation`, `stop-activation`, `activation-session` (full sync),
`session-contact-added/updated/deleted` (deltas). Keep `set-activator-park`
accepted for old clients.

1. **Multi-program first-class**: an activation is a *set* of {program, ref} — POTA
   no longer the mandatory primary. WWFF-only, SOTA-primary, POTA+WWFF+LLOTA+Tiles
   all valid. Cross-product ADIF already handles it; lift the POTA hardcodes.
2. **Self-spot engine** (`lib/self-spot.js`):
   - Spot on activation start (opt-in), **auto re-spot on QSY** (CAT freq change,
     debounced ~15s, only while active), optional 10-min keepalive re-spot,
     **QRT spot on stop**.
   - Fan out to every network in the activation that has a public endpoint
     (POTA, WWFF, LLOTA, WWBOTA, GMA cluster) — one button, like PoLo.
   - Use `respotTemplate` presets; kill the hardcoded comment.
3. **Entry-speed parity**:
   - Worked-before badge with lifetime QSO count + name/state preview (we have the
     whole ADIF log — richer than PoLo's).
   - **Call stacking**: pileup capture — type partials, Enter stacks, tap to pop
     into the entry row.
   - Comma-separated calls (exists) and parks (exists) — keep, document.
   - P2P ref optional (N7BBQ: CW ops just send "P2P"); a bare P2P flag logs
     `SIG=POTA` with empty `SIG_INFO` allowed, POTA backend matches it.
4. **Add to activation** (twilliams/N5WBL): in the log dialog + past-activation
   browser, multi-select QSOs → "Add to activation…" → retags `MY_SIG*` via
   `updateQsosByMatch`. Also: "Reopen" on the just-stopped activation summary
   (continueActivation already exists — surface it).
5. **Stop flow**: stop → **activation summary panel** — QSO count vs POTA's
   unique-call validity rule, per-band/mode breakdown, P2P count, duration →
   checklist: export per-park ADIF ✓ stage for pota.app upload ✓ push to
   QRZ/Clublog (existing logbook forwarders) ✓ LoTW via TQSL (docs/tqsl-lotw-plan.md)
   ✓ **email draft to regional coordinator** (mailto: with attachment staged
   beside it; beat PoLo's flaky iOS attach by writing the file first and revealing it).
6. **Layout** (N5SKT tablet ergonomics): activator view becomes two independently
   scrollable panes — session log | live spots (filtered, P2P-tap prefills hunter
   park + tunes rig). Configurable columns incl. "Their park" (N5WBL), persisted
   like hunter table widths.
7. Fix #9/#10: SOTA (sotawatch API) + WWBOTA cross-ref self-spots; validity
   counter = unique calls per UTC day.
8. **"Parks near me" on the park input** — a 📍 button beside the activator park
   field lists the closest parks one-tap-selectable (location source: OS
   geolocation → QTH grid fallback), with a "Nearby" strip surfacing 2fer overlap
   candidates to add as n-fer refs. Full spec in Phase 2 items 8–9; the desktop
   version ships first since the parks DB, haversine, and the input all exist.

## Phase 2 — Mobile: real Activator Mode + standalone (3–5 weeks)

**Connected mode (desktop paired) — the "second screen that drives the rig":**
1. Replace ActScreen stub with a **setup sheet**: program toggles (POTA/WWFF/SOTA/
   LLOTA/WWBOTA/Tiles — multi-select, N7BBQ), per-program ref fields with
   validation, comma multi-park, recent/template activations ("same as last time"),
   and **"Parks near me" as the default entry path** (see Location-aware park
   selection below) — typing a ref by hand becomes the fallback, not the norm.
2. **Activation screen** (tabs, PoLo-proven shape): INFO | QSOs | SPOTS.
   - QSOs tab: session log (mirrors `activation-session` deltas — desktop and
     phone finally agree), entry row with big callsign field, RST chips,
     time/band·mode chips **live from CAT**, worked-before badge, dupe warn,
     call stacking.
   - SPOTS tab: existing spots feed filtered for activator use; tapping a spot
     **tunes the radio** and prefills a P2P entry. PoLo cannot do this.
   - INFO tab: validity progress ring, rate, per-band counts, self-spot button
     (+ auto-respot status), QRT.
3. Self-spot + QSY re-spot controls on the VFO screen while activating.

**Standalone mode (N7BBQ — no desktop):**
4. The same activation screen backed by `LocalQsoStore` instead of the WS:
   local activation session persisted on-device; QSOs recorded locally
   (store + sync infra already shipped); band/mode set manually (chips) since
   there's no CAT.
5. **Direct self-spotting from the phone** to api.pota.app / WWFF / WWBOTA
   (unauthenticated POSTs — same endpoints desktop uses), with an **offline queue**:
   no signal → spot queued, fired on connectivity restore (and QSO sync likewise).
6. **ADIF export + share sheet from the phone**: per-park `CALL@PARK-YYYYMMDD.adi`,
   share to Mail/Files/Drive. Merges to desktop log via existing cloud sync when
   re-paired — no duplicate records (UUIDs already in ADIF via APP_POTACAT_UUID).
7. Offline parks pack: on activation start with connectivity, cache the
   user's region's parks; GPS nearest works offline thereafter.

**Location-aware park selection (K3SBP):**
8. **"Parks near me" — one tap, zero memorization.** The activation setup sheet
   opens on a GPS-sorted list of the closest parks (name, ref, distance/bearing,
   "worked before" and "you've activated this" badges from the log). One tap
   selects it; done. Data: the parks DB already carries lat/lon and we have
   haversine (lib/grid.js) — this is a sort, not a service. Same list offline via
   the parks pack (item 7). PoLo has GPS-nearest with known reliability gripes —
   ours must degrade gracefully: GPS denied/flaky → fall back to last-known
   location, then grid-square center, and say which one it's using.
   - Desktop gets the same feature with its own location source: geolocation when
     the OS provides it, else the QTH grid / a park picked on the map — useful for
     the truck-dock laptop activator who doesn't want to type refs either.
   - Disambiguation matters at trailheads: when two refs are within ~1km (park +
     trail + heritage site), show all of them ranked, not just the top hit.
9. **Nearby-parks 2fer/rove nudge.** Once a park is selected, a "Nearby" strip
   shows what else is close:
   - **Overlap candidates (2fer):** refs whose point/boundary sits within a tight
     radius (~2km) of the chosen park — trails, rivers, and heritage areas that
     overlap it. One tap **adds the ref to the current activation** (n-fer slot,
     ≤6), pre-validating the multi-park ADIF cross-product we already emit.
   - **Drive-to candidates (rove):** the next parks out to ~25mi with straight-line
     distance and bearing ("US-1616 · 7.4 mi NW"); tap opens it in the map view /
     hands off to Apple/Google Maps for directions. Pairs with Phase 3 rove
     support ("Change park" keeps the session running at the next stop).
   - Distance honors the user's `distUnit` (mi/km). No routing API dependency in
     v1 — straight-line is honest enough to prompt "there's a 2fer 400m away";
     a routing/drive-time upgrade can come later behind the same UI.

## Phase 3 — Differentiators (beat PoLo, not match it)

1. **Rig-native activation**: CW keyer macros with auto-exchange fill (CQ →
   caller decoded → tap-to-log), voice memory keying for SSB runs, JTCAT FT8
   QSOs logging into the live activation (per-QSO park tagging already exists
   via onWsjtxActivatorQso — extend to JTCAT).
2. **Live reach map**: PSKReporter/RBN overlay ("where am I being heard") on the
   INFO tab — infra exists (pskr-map-spots already pushed to mobile).
3. **Second-op companion** (N5WBL's son): a guest-pass session that follows the
   activation read-only or co-logs into the same session with OPERATOR attribution
   (guest-pass + qso-attributed plumbing already exists; per-op logbooks are the
   ECHOCAT per-op logging memory item).
4. **Rove support**: "Change park" mid-session (PoLo's BREAK) — closes current
   refs, starts new ones, keeps the screen and the run rate.
5. **POTA API v3 readiness**: isolate submission behind `lib/pota-submit.js` with
   a `stage-and-open` backend today and an `api-upload` backend the day WD4DAN's
   API ships. First app with true one-button submission wins the announcement.

## Sequencing & risk

- Phase 0 is a patch (1.9.6): all-qsos cap + delta, P2P SIG fix, resume fix,
  validation, mobile ack. Ship fast — N3VD and N5WBL are actively testing.
- Phase 1 before Phase 2: the shared `activation-session` store is the contract
  the mobile UI binds to; building mobile first would bake in a second stub.
- Phase 2 standalone reuses connected-mode components with a local backend —
  design components store-agnostic (props take a session interface, not the WS).
- PoLo's weak flanks to press: sync reliability (their forums: emptied logs,
  corrupted times), iOS email-attach failures, and zero radio integration.
- Don't build: POTA upload via "backend HTML voodoo" (W7RTA's objection) — wait
  for the real API.

## Sources

- https://polo.ham2k.com/docs/ (features, first-operation, spotting)
- https://www.onallbands.com/ham-radio-operating-insights-ham2k-portable-logger-polo/
- https://www.n1clc.com/2025/06/ham2k-polo-rockn-logging-for-portable.html
- https://whiteriverradio.com/unleash-your-pota-power-with-powerful-ham2k-logger/
- https://forums.ham2k.com/t/sync-service-emptied-my-log/1638
- https://forums.ham2k.com/t/log-times-corrupted/1271
- Desktop audit: renderer/app.js, main.js, lib/remote-server.js, lib/echocat-protocol.js, lib/adif-writer.js
- Mobile audit: potacat-app/src/screens/ActScreen.tsx, src/state/qsoLog.ts, src/services/QsoSync.ts, src/components/LogQuickSheet.tsx
