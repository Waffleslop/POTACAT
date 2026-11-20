# Desktop to ECHOCAT handoff, 2026-11-17: rig groups (#542)

From: POTACAT desktop, GitHub #542 (branch feat/542-rig-groups; plan in
docs/rig-groups-plan.md, build plan in docs/rig-groups-implementation.md).
For: the ECHOCAT app (iOS and Android).
Status: a proposal for review. It waits on Casey's answers to the four questions
in docs/rig-groups-plan.md, and on the cloud handoff
(docs/handoffs/DESKTOP_TO_CLOUD_HANDOFF_2026-11-17_RIG_GROUPS.md).

## What it is

A few friends share their rigs with one another. Each owner can take their own
rig back at any time. Members never bump each other: a busy rig is offered to the
next member who asked, when its user leaves or has been idle for 5 minutes.

For the app, a rig-group rig is a Guest Pass that never runs out. You already
handle almost all of it: the pass connect, `pass-state`, `pass-take-back`, the
owner's controls and the `radio_free` push. This handoff lists only what is new.

## Capability

The shack's hello lists `rig-groups` in `capabilities` when it does everything
below. Send `rig-groups` in the app's hello `capabilities`, beside `pass-state`. A
shack sends the new fields and reasons only to a client that listed it.

## 1. "My group's rigs"

A list screen, reached from wherever the app lists the shacks it can reach.

- Data: `GET /v1/me/rig-groups/rigs` (cloud handoff, section 4). Refresh on open
  and on pull. Do not poll.
- One row per rig: the owner's callsign, the rig or shack name, the group's name,
  and the state:
  - **Free:** POTA green #4ecca3;
  - **In use by K1ABC:** plain text;
  - **Owner operating:** plain text;
  - **Sharing paused:** plain text;
  - **Offline:** grey.
- Tap Connect: redeem the row's `passCode` with the signed-in
  `POST /v1/passes/{code}/redeem` once, keep the session token in secure storage
  for that pass, and connect exactly as for a Guest Pass (`passCode`, `sessionId`).
  - Redeem again only when the shack or Cloud says the session is not valid.
  - `403 not_your_pass` or `410` means the pass is gone: drop the row and refresh.
- Never show the pass code.

## 2. Joining a group

- Link: `https://potacat.com/rig-group/join?code=…`. Also handle
  `potacat://rig-group/join?code=…`.
- Signed in: show "Join Night Owls?" with Join and Cancel. Join calls
  `POST /v1/rig-group-invites/{code}/accept`.
- Not signed in: sign in first, then show the same question.
- Errors, in words:

| Error | Words |
| --- | --- |
| `410 invite_expired` | "This invitation has expired. Ask for a new one." |
| `409 already_member` | "You are already in this group." |
| `409 group_full` | "This group is full." |
| `400 callsign_required` | "Add your callsign to your POTACAT account first." |

## 3. Waiting for a busy rig

A member who connects while another member has the rig is admitted waiting.
`auth-ok` arrives as usual, then `pass-state`:

```json
{ "type": "pass-state", "state": "waiting", "reason": "other-guest", "endsAt": null, "by": "K1ABC", "queuePosition": 0 }
```

New fields, only with the `rig-groups` capability:
- `by`: the callsign of whoever has the rig;
- `queuePosition`: 1 is first in line; 0 or absent means not in line.

`endsAt` is `null` for a rig-group pass, which never ends. Show no countdown.

While waiting, the app may send only `queue-join`, `queue-leave`,
`pass-take-back`, `pass-leave` and `ping`. The shack sends no audio and no rig
state to a waiting member, because a shack serves one listener.

| Reason | Words (the desktop's lib/pass-wording.js) | Buttons |
| --- | --- | --- |
| `other-guest`, not in line | "In use by K1ABC." | **Tell me when it's free** sends `{"type":"queue-join"}` |
| `other-guest`, in line | "In use by K1ABC. You are 2nd in line." | **Stop waiting** sends `{"type":"queue-leave"}` |
| `member-idle` (new) | "The rig is free: K1ABC hasn't used it for 5 minutes." | **Take the rig** sends `{"type":"pass-take-back"}` |
| `rig-free` (new) | "The rig is free." | **Take the rig** sends `{"type":"pass-take-back"}` |
| `sharing-paused` (new) | "The owner has paused sharing for now. Your pass is still good." | Tell me when it's free |
| `owner-has-radio`, `owner-idle` | Unchanged: the owner holds the rig and outranks the line | Unchanged |

- `queue-join` and `queue-leave` take no fields. The shack answers each with a new
  `pass-state`.
- A refused `pass-take-back` (someone else took it, or the holder came back) is
  answered with the current `pass-state`, as today.
- On `pass-state` `on-air`/`none` the member has the rig: show the normal operating
  screen.
- The member stays in line after closing the app, for up to 2 hours. When the rig
  is offered, the `radio_free` push arrives as it does for a Guest Pass today.
  Cloud owns its words. Tapping it opens this rig and connects; the shack then
  sends `member-idle` or `rig-free`.

## 4. Being the holder

Nothing new. The member operates as a Guest Pass guest does: their own callsign on
the air, contacts to their own logbook, and the owner's Take the radio and Give it
back exactly as today.

One difference: when the member has been idle 5 minutes and someone in line takes
the rig, this member is parked, not disconnected. They receive
`pass-state` `waiting`/`other-guest` with `by` set to the new holder. Show the
waiting screen, not "disconnected".

## 5. The owner's side (later)

Managing a group (create, invite, remove, share a rig, Sharing paused) is in the
desktop's Share My Rig dialog first. The app may add it later with the same cloud
calls (cloud handoff, sections 1 and 2). Nothing in sections 1 to 4 depends on
it.

## 6. `auth-ok`

`passSession` gains:
- `kind`: `"rig_group"`, or `"guest"` / absent for an ordinary pass;
- `group`: `{id, name}` for a rig-group pass.

`expiresAt` is `null` for a rig-group pass.

## 7. Done when

- With two phones on one rig-group rig, the second is admitted waiting and sees
  "In use by …".
- Tell me when it's free shows the place in line.
- After the first phone does nothing for 5 minutes, the second gets "The rig is
  free" and Take the rig works. The first is parked, not disconnected.
- With the app closed, the push arrives and opens the rig.
- The owner's Take the radio still wins, and Give it back returns the rig to the
  member who had it.
- An older shack, with no `rig-groups` capability, behaves exactly as today.
