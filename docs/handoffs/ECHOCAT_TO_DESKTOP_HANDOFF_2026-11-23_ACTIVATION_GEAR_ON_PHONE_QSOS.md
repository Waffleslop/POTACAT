# ECHOCAT to DESKTOP handoff, 2026-11-23: rig and antenna on phone-logged activation contacts

From: the ECHOCAT session. Casey asked for this handoff on 2026-11-23 ("handoff and give to triage").
It replaces the July 2026 desktop ask in echocat docs/desktop-asks/activation-gear-adif.md, which
was put on hold and never built.

## The problem

During an activation the phone sends the operator's rig and antenna on every `log-qso`, but the
desktop log never gets them:

- **The phone sends them.** echocat src/components/LogQuickSheet.tsx and src/components/QsoLogForm.tsx
  add `myRig` (the activation's radio) and `myAntenna` (its antenna) to the `log-qso` payload, beside
  `myGridsquare`. A comment there says desktops pass unknown fields through, but they don't.
- **The handler drops them.** main.js `remoteServer.on('log-qso', ...)` (about line 32205 on master)
  builds `entry` from named fields only. It copies `myGridsquare`, so the session grid arrives, but
  not `myRig` or `myAntenna`.
- **The rig gets replaced.** `logContact` (about line 19365) then sets
  `myRig = entry.myRig || (isRemoteMode() ? '' : stationSetupRigById()?.name)`. A phone-logged
  activation contact therefore gets the desktop's own station rig, or nothing, instead of the radio
  the operator is activating with.
- **Antenna is never written.** lib/adif-writer.js writes `MY_RIG` (line 70) but has no
  `MY_ANTENNA` field, so the desktop never writes an antenna for any contact.

The phone's own copy and the cloud copy already carry MY_RIG and MY_ANTENNA, so the desktop log
and the phone/cloud log disagree for every activation contact logged from the phone.

## Asks

1. In the `log-qso` handler, copy `myRig` and `myAntenna` from `data` onto `entry` when they are
   non-empty strings. Trim them and cap them at about 64 characters each, like the other free-text
   fields.
2. In `logContact`, keep the current rule (`entry.myRig ||` ...): with ask 1 in place, the phone's
   rig wins when it sends one, and the desktop rig still fills it otherwise.
3. In lib/adif-writer.js, write `MY_ANTENNA` from `qso.myAntenna`, next to `MY_RIG`. It is a
   standard ADIF field. Read it back where MY_RIG is read (the records sent to the phone and to
   the cloud), so a round trip keeps it.
4. Optional, for the desktop's own activations: if the desktop holds activation gear of its own,
   stamp it the same way. Desktop's call.

No new capability is needed: the phone already sends the fields, and a desktop that ignores them
behaves as today.

## Test

- Start an activation on the phone with a radio and an antenna set in its gear step.
- Log a contact from the phone.
- The desktop's ADIF record has `MY_RIG` set to the phone's radio and `MY_ANTENNA` set to the
  phone's antenna.
- A contact logged with no activation running still gets the desktop's station rig.
