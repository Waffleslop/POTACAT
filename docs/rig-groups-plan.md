# Rig groups: friends share their rigs (#542)

Casey, 2026-11-14 (#542): "A small group of operators (for example four) share
their rigs with one another and can hop onto each other's rigs. Each member can
take their own rig back from anyone at any time so they can operate."

This is the plan for review. Nothing here is built. It builds #542 on what Guest
Pass already does, and it ends with four questions for Casey.

## The idea in one line

**A rig group is a Guest Pass that does not run out.** The cloud gives each
member a standing pass for every rig shared with the group. Each shack admits
members through the pass check it already runs, and the Guest Pass states and
owner controls do the rest.

## What #542 asks for, and the answer

| #542 | How |
| --- | --- |
| Each member owns their rig and is a guest on the others'. | A standing pass per member per shared rig. The member's own callsign, class and logbook, by the rules in docs/share-my-rig-lease-plan.md. |
| The owner always wins on their own rig. | Take the radio, Give it back and Cancel pass (#200), unchanged. |
| Members do not bump each other. A rig is freed when its user leaves or has been idle for 5 minutes. | New: the member idle offer. It follows the owner hand-back rule (#200 step 4): after 5 minutes with no activity the first waiting member is told and may take the rig. Nothing switches on its own (see question 1). |
| The next member who asked to be told is notified. | New: `queue-join` puts a member in a short queue held by the shack. The offer goes out as `pass-state`, plus Cloud's `radio_free` push when the member's app is closed. |
| "My group's rigs" shows each rig as free, in use or offline. | New cloud endpoint and client list. Offline comes from the tunnel check that already runs every 5 minutes, so the list adds no polling. |
| Access lasts until the owner removes a member. | Removing a member cancels their standing passes. The shack's 60-second re-check gets a 404 and ends a live session, as a cancelled Guest Pass does today. |

## What exists today (master, 2026-11-17)

- `lib/pass-enforcement.js`: class, power and mode gates at key-down, a 60 s
  cloud re-check, and the `paused` state for the owner's take-over.
- `lib/pass-state.js` and `lib/pass-wording.js`: `pass-state` with four states
  and a reason, including `waiting`/`other-guest` and `waiting`/`rig-in-use`
  (#541).
- `lib/pass-owner-controls.js`: Take the radio (now or in 5 minutes), Give it
  back, Cancel pass (#200).
- `lib/pass-owner-activity.js`: the one list of what counts as the owner using
  the radio.
- `lib/pass-radio-free-notify.js`: `POST /v1/passes/:code/notify`
  `{kind: radio_free}`, once per offer.
- `lib/guest-pass-authority.js`: the default-deny message list for guests, held
  to a decision for every message type by its test.
- `lib/pass-qso-outbox.js`: a guest's contacts go to the guest's cloud logbook.
- `lib/cloud-shacks.js`: a limit the server sets, with a client fallback
  (`SHACK_LIMIT = 3`). Rig-group limits follow the same pattern.
- `lib/remote-server.js` `_authenticatePass`: one guest at a time. A second
  guest is refused with `auth-fail` code `rig_in_use` (`by: guest`).

## What changes

### Shack (this repository)

1. **Admit a second member waiting** instead of refusing them. They get
   `pass-state` `waiting`/`other-guest` and may send only `queue-join`,
   `pass-take-back`, `pass-leave` and `ping`, like the waiting device that
   `pass-claim` already allows.
2. **`queue-join`** (C→S, behind a new hello capability `rig-groups`). It puts the
   member in a queue for that rig, in memory. Leaving or disconnecting takes
   them out.
3. **The member idle offer.** When the member holding the rig has done nothing
   for 5 minutes, the first member in the queue gets `waiting`/`member-idle`
   (a new reason) and the `radio_free` push, and may send `pass-take-back`. The
   idle member then gets `waiting`/`other-guest`. When the holder leaves, the
   first member in the queue is offered the rig at once. "Activity" is the
   kinds in `lib/pass-owner-activity.js`, applied to whoever holds the rig.
4. **A message list for the rig-group member role** in
   `lib/guest-pass-authority.js`. It starts from the guest list and adds
   `queue-join`.
5. **Sharing paused.** The owner can stop sharing for a while. A member who
   connects meanwhile is told `waiting`/`sharing-paused` (a new reason).
6. **Wording** for the new reasons in `lib/pass-wording.js`, in the same table
   as the rest.

Tests extend the guest-pass tests: two members on one rig, take-back after the
idle offer, queue order, the owner's take always winning, and removal ending a
live session within 60 s. Items 1 to 3 can be tested with two Guest Passes on
one rig, before the cloud has rig groups.

### Cloud (a DESKTOP_TO_CLOUD handoff)

- Rig groups: create, invite, accept, leave, and remove a member.
- Share, pause and unshare a rig into a group; an owner can also remove one
  member from their own rig.
- Standing passes: one per member per shared rig, with no end date, the class
  the sharing owner chose for that friend, and the member's own callsign.
  Cancelled on removal, unsharing or exclusion.
- `GET /v1/me/rig-groups`: each rig with its owner, shack address, last-seen
  time and the member's pass code (the app never shows the code).
- Limits set by the server: 8 radios and 12 people per group by default.
- `radio_free` push for a member's standing pass.

### ECHOCAT (a handoff to the ECHOCAT repository)

- "My group's rigs", connect, and Tell me when it's free.
- The new reasons and `queue-join` rows in docs/echocat-protocol.md.

### Desktop screens

- Share My Rig gains "Share with my rig group", group management (create,
  invite, remove) and the Sharing paused switch.
- "My group's rigs" in the desktop's remote mode, which can already drive
  another shack.

## Limits

- **8 radios and 12 people per group**, set by the server so they can rise
  without a release.
- **3 radios from one person**, which today's 3 shack addresses per membership
  already enforce.
- **Why:** a shack serves one listener today, so 12 friends sharing 8 rigs
  seldom find every rig busy; eight rows fit on a phone in large type; and
  cloud cost grows with live sessions, not with group size.

## Order of work, one PR each

The build plan, slice by slice with files and tests, is
docs/rig-groups-implementation.md. The cloud and app work are in
docs/handoffs/DESKTOP_TO_CLOUD_HANDOFF_2026-11-17_RIG_GROUPS.md and
docs/handoffs/DESKTOP_TO_ECHOCAT_HANDOFF_2026-11-17_RIG_GROUPS.md.

1. This plan.
2. `lib/rig-group-turns.js`: the queue and the member idle offer, pure.
3. `pass-state` reasons and wording.
4. Shack: waiting members, `queue-join`, the handoff between members, standing
   passes with no end date, and the protocol rows.
5. The shack reports the rig's state to Cloud.
6. Share My Rig: rig groups for the owner (needs the cloud work).
7. POTACAT as a member: "My group's rigs".
8. ECHOCAT Web.

Not in this plan: metered time, schedules, reservations and volunteer credits
(#661). They come later and reuse the same pieces.

## Questions for Casey

1. **Idle member: offer or release?** #542 says a rig "is freed" after 5 idle
   minutes. The hand-back rule of 2026-11-15 says nothing switches on its own.
   This plan offers the rig to the next member and lets them take it. Is that
   right, or should the idle member be released?
2. **Who removes a member?** Proposed: each owner from their own rig, and the
   person who made the group from the group.
3. **Limits:** 8 radios and 12 people per group?
4. **Class:** the sharing owner picks each friend's class when sharing, as the
   Share My Rig form does today. Enough until there is a licence lookup?
