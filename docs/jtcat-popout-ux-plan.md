# JTCAT Popout UX plan — five user reports (2026-07-11)

Source: single user feedback batch via Casey. Ordered by recommended
execution: the real bug first, then the trivial fix, then the two UI
features, then the docs/UX answer.

## 1. JTCAT QSOs missing from the activation log (BUG — do first)

**Report**: "JTCAT contacts do not populate in the activation log when in
activator mode and is active."

**Root cause (confirmed)**: `jtcatAutoLog` (main.js:5838) fully handles
activator-mode ADIF — park cross-product, cross-program refs, P2P — so the
QSOs land in the **logbook** correctly. But the **activation session list**
(Act screen + phone session view) is populated only by
`remoteServer.addSessionContact(...)`, which exactly one path calls: the
phone `log-qso` handler (main.js:11414). Auto-logged FT8 QSOs never join
the session.

**Fix shape**:
- Extract a helper `addActivationSessionContact(qsoData)` from the log-qso
  handler's contact-building block (callsign/time/freq/mode/band/RSTs +
  same-call-same-band dupe flag) and call it from BOTH the log-qso handler
  and `jtcatAutoLog` — primary record only (skip the cross-product /
  cross-ref copies: one physical QSO = one session contact).
- Gate on `settings.appMode === 'activator'` (session contacts outside an
  activation are noise).
- Audit the other auto-log origins for the same gap while in there:
  `wsjtx-bridge` (WSJT-X log ingest) — almost certainly identical hole.
- Broadcast `session-contacts` after adding, so the phone list and the Act
  screen update live (the existing addSessionContact path already does).

**Verify**: activator mode on, work an FT8 station via JTCAT → the QSO
appears in the Act screen contact list with the right serial, and on the
phone's session view; a second same-band QSO with the same call flags DUPE.

## 2. Red-on-red directed rows (trivial CSS fix)

**Report**: "When CQ is answered, row highlights red. The characters are
red too. Makes it difficult to read."

**Confirmed**: `.jp-row.jp-directed` = `background: rgba(180,30,30,0.35)`
AND `.jp-msg { color:#ff6b7a }` — red-on-red, genuinely low contrast.

**Fix**: keep red as the accent, not the ink — message text goes near-white
(`#ffe2e6` / `--text-primary` + bold), background drops to
`rgba(180,30,30,0.22)`, add the 3px left border accent the other row types
already use (`jp-chase`, `jp-spotted` pattern) so the row still shouts
without the text drowning. Verify with the popout fixture-screenshot
technique against a busy decode list.

## 3. Timer countdown readability (small feature)

**Report**: "Timer countdown difficult to read. Use status bar possibly?"

**Today**: `#jp-countdown` is a small span crowded into the header next to
Sync. **Plan**: a slim bottom status strip for the popout (the user's own
suggestion) carrying:
- The countdown, larger + `tabular-nums` so it doesn't jitter.
- A WSJT-X-style thin **cycle progress bar** filling across the strip —
  color-keyed RX (green) vs TX (red) so period phase is readable from
  across the shack without reading digits at all.
- Relocate the Sync indicator there too (it's status, not a control), which
  also frees header space. Existing countdown driver (jtcat-popout.js:1266)
  already ticks at the right cadence — this is presentation only.

## 4. Internal pane resize (small feature)

**Report**: "Need ability to resize windows within JTCAT."

**Today**: `.jp-main` is a fixed 50/50 flex row — Band Activity pane vs
map/waterfall pane — no user control. **Plan**: a draggable vertical
splitter between the panes, following the main window's `#split-splitter`
(table/map) pattern: drag to resize, ratio persisted per popout in
localStorage (`jtcat-popout-split-pct`), double-click resets 50/50. If the
waterfall row's height draws the same complaint later, the same pattern
stacks — not built speculatively.

## 5. Time sync question (answer + small UX polish)

**Report**: "Does Time sync with computer using JTCAT? How about when using
ECHOCAT?"

**The answer (for the user / FAQ)**: JTCAT decodes ride the **computer's
clock** — POTACAT never adjusts it. It *monitors* it: a real NTP check
drives the `Sync` indicator (drift shown in seconds; >1.5s ≈ decodes start
failing), with "Time settings…" / "Sync now" buttons on Windows. **ECHOCAT
changes nothing**: all decoding runs on the desktop, so only the desktop's
clock matters — the phone's clock is irrelevant even mid-QSO from the phone.

**Plan**:
- Expand the `jp-sync` tooltip to say exactly the above (one sentence each
  for "we monitor, we don't set" and "phone clock doesn't matter").
- Mobile addendum (existing events/JTCAT parity work item): surface the
  desktop's sync state on the phone FT8 screen — the phone user currently
  has no way to see the shack clock has drifted, and it's the #1 cause of
  "good audio, zero decodes".

## Execution order + estimates

| # | Item | Size |
|---|------|------|
| 1 | Activation-log bug | ~2h incl. wsjtx-bridge audit + verify |
| 2 | Red-on-red CSS | ~15 min |
| 3 | Countdown status strip | ~1h |
| 4 | Pane splitter | ~1h |
| 5 | Sync tooltip + mobile addendum | ~20 min |
