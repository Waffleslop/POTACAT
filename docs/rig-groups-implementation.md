# Rig groups (#542): implementation plan

The design and the questions for Casey are in docs/rig-groups-plan.md. This file is
the build plan for the desktop, with the cloud and ECHOCAT work in two handoffs:

- docs/handoffs/DESKTOP_TO_CLOUD_HANDOFF_2026-11-17_RIG_GROUPS.md
- docs/handoffs/DESKTOP_TO_ECHOCAT_HANDOFF_2026-11-17_RIG_GROUPS.md

Nothing here starts until Casey answers the four questions in the plan. Where an
answer would change a step, the step says so.

## Words

- **Member:** a person in a rig group.
- **Holder:** the member whose pass is loaded in `PassEnforcement` on this shack
  (on the air, or paused by the owner).
- **Waiting member:** a member connected to this shack whose pass is checked but
  not loaded. They get `pass-state` and nothing else: no audio, because a shack
  serves one listener, and no rig control.
- **Standing pass:** a Guest Pass with `kind: 'rig_group'` and no end date, issued by
  Cloud to one member for one shared rig.
- **Queue:** the members who pressed "Tell me when it's free", in the order they
  pressed it.

## How it fits today's code

Today one pass at a time is loaded, and a second guest is refused in main.js
(`setPassAuthCallback`, the `rig_in_use` / `by: 'guest'` throw). That rule stays
for ordinary Guest Passes. A **rig-group** pass from the **same group** as the
holder is admitted waiting instead. The new rules live in one pure module,
`lib/rig-group-turns.js`, as AGENTS.md requires ("main.js is glue only").

| Today (Guest Pass) | Rig groups |
| --- | --- |
| One guest; a second is refused (`rig_in_use`, `by: guest`) | A second member of the same group is admitted waiting (`waiting`/`other-guest`) |
| The owner's 5-minute idle offer goes to the paused guest | Unchanged. A new member idle offer goes to the first in the queue |
| `pass-take-back` takes the radio back from an idle owner | Also takes the rig from an idle holder, or a free rig, when offered |
| Ending a pass closes the guest's socket | A new end reason, `yielded`, parks the old holder waiting instead |
| A pass always has an end date | A standing pass has none (`expires_at: null`) |
| `radio_free` push to the paused guest | Also to the first member in the queue |

## Slices (one PR each, in order)

Slices 1 to 3 need no cloud: tests use a fake validator that returns
`kind: 'rig_group'` profiles. Slices 4 to 6 need the cloud handoff to have landed.

### Slice 1. `lib/rig-group-turns.js` (pure) and its test

The one place that decides whose turn it is. No timers and no sockets: the clock
is passed in, like `lib/pass-state.js`.

State, one object per shack:

```js
{
  groupId,                 // the holder's group; null when no rig-group pass is loaded
  holder: { code, call, lastActiveAt } | null,
  queue: [ { code, call, joinedAt } ],   // in order
  offer: { code, reason: 'member-idle' | 'rig-free', at } | null,
}
```

Functions, each returning a new state plus what changed (`{ state, events }`):

- `admit(state, profile)` decides `'load' | 'wait' | 'refuse'`. Load when nothing is
  loaded. Wait when the holder is a rig-group pass of the same `group_id`. Refuse
  otherwise, which keeps today's behaviour.
- `join(state, code, call, now)` and `leave(state, code)` change the queue.
  Joining twice keeps the first place.
- `noteHolderActive(state, now)` updates `lastActiveAt` and withdraws a
  `member-idle` offer.
- `idleDue(state, now, idleMs)` and `offerIdle(state, now)` make the member idle
  offer. They fire only when the queue is not empty, and offer the first in line.
- `holderGone(state, now)` is called when the holder leaves or their 60 s hold
  ends. With a queue, the result is offer `rig-free` to the first in line; without
  one, nobody holds the rig.
- `canTake(state, code)` is true only for the member who holds the offer.
- `take(state, code, now)` makes them the holder, removes them from the queue and
  puts the old holder (if still connected) back as a waiting member, not queued.
- `expireQueue(state, now, maxAgeMs)` drops entries older than
  `QUEUE_MAX_AGE_MS` (2 hours) so a forgotten entry does not fire a push the next
  day.
- `offerTimeout(state, now)` (question for Casey): an offer nobody takes passes to
  the next in line after `OFFER_MS` (5 minutes). It is off until Casey agrees.

Constants: `MEMBER_IDLE_MS = 5 * 60 * 1000`, `QUEUE_MAX_AGE_MS`, `OFFER_MS`.

Test: `test/rig-group-turns-test.js`, added to `scripts/run-tests.js`. It covers:
- admit: same group waits, another group or a plain Guest Pass is refused;
- queue order, duplicate joins, leaving;
- no offer with an empty queue;
- the offer after 5 idle minutes goes only to the first in line;
- holder activity withdraws a `member-idle` offer, but not a `rig-free` one;
- the holder leaving gives a `rig-free` offer;
- take swaps holder and waiter;
- old entries expire.

If Casey answers question 1 with "release": `offerIdle` becomes `releaseIdle`. The
idle holder is parked as waiting at once and the first in line is offered a free
rig. The rest is unchanged.

### Slice 2. `pass-state` and wording

`lib/pass-state.js`:

- Add three reasons to `REASONS.waiting`:
  - `member-idle`: the holder has been idle 5 minutes and the rig is offered to you;
  - `rig-free`: the holder left and the rig is offered to you;
  - `sharing-paused`: the owner has paused sharing.
- `build()` gains two optional fields, sent only to clients with the `rig-groups`
  capability:
  - `by`: the holder's callsign;
  - `queuePosition`: 1 is first; 0 or absent means not queued.
- `forConnection(f)` gains rig-group facts. They are read only when the owner does
  not hold the radio, because the owner's hold outranks everything:
  - `f.waitingMember`: this connection is a waiting member;
  - `f.offered`: `'member-idle'` or `'rig-free'` when this connection holds the
    offer;
  - `f.holderCall`, `f.queuePosition`, `f.sharingPaused`.
- `canTakeBack(f)` is also true when `f.offered` is set and no take is pending.
- New constant `RIG_GROUPS_CAPABILITY = 'rig-groups'`.

`lib/pass-wording.js`: three `STATE_TABLE` rows, in the table's existing style:

- `waiting/member-idle`: "The rig is free: K1ABC hasn't used it for 5 minutes."
  Button: Take the rig.
- `waiting/rig-free`: "The rig is free." Button: Take the rig.
- `waiting/sharing-paused`: "The owner has paused sharing for now. Your pass is
  still good."
- `waiting/other-guest` gains a line when `by` is set: "In use by K1ABC. You are
  2nd in line." Button: Tell me when it's free, or Stop waiting when queued.

Tests: a new block in `test/guest-pass-state-step2-test.js`, or a new
`test/rig-group-state-test.js` added to the list. It checks:
- every new reason builds;
- `by` and `queuePosition` are sent only with the capability;
- the owner's hold outranks every rig-group reason;
- `canTakeBack` holds only for the offered member;
- every reason has a wording row (the existing table test should catch a missing
  one).

### Slice 3. The shack: waiting members, the queue, the handoff

**`lib/remote-server.js`**

- Hello `capabilities` gains `'rig-groups'` (line 3292 list).
- `_authenticatePass`: the pass-auth callback can now resolve with
  `{ wait: true }`. In that case:
  - set `ws._passSession` with `waitingMember: true`;
  - set `ws._passParked = true` and do not call `_admitClient`;
  - send `auth-ok`, then `pass-state` `waiting`/`other-guest` with `by` and
    `queuePosition`.

  This is the same shape as the standby device that `pass-claim` already uses
  (around line 5735).
- Before the wall, in the hopping block that answers `pass-leave` and
  `pass-take-back` (around line 3795):
  - `queue-join {}` and `queue-leave {}` from a waiting member, only with the
    `rig-groups` capability. They call `RigGroupTurns.join/leave`, then
    `broadcastPassState()`.
  - `pass-take-back` from a waiting member: when `RigGroupTurns.canTake`, emit
    `'rig-group-take'` `{ fromCode, toCode, toSession }` and let main do the
    handoff. Otherwise send the current `pass-state` again, as today.
- Holder activity: in the demux, a rig-group holder's message in an activity set
  calls `noteHolderActive`:
  - `tune`, `ptt` (down), `set-mode`, `jtcat-call-cq`, `jtcat-reply`,
    `jtcat-enable-tx`;
  - CW keying, `sstv-photo`, `jtcat-psk-send`, `jtcat-jtty-send`.

  Keep the set next to the guest wall in `lib/guest-pass-authority.js` as
  `HOLDER_ACTIVITY_TYPES`, so a new message type is a decision there.
  Transmissions the shack starts on its own (Auto CQ, a running Winlink session)
  are reported by main through `noteRigGroupActivity(kind)` at the call sites
  `lib/pass-owner-activity.js` already lists.
- An idle timer like `_armOwnerIdle`: `_armMemberIdle` and `_memberIdleCheck`
  call `RigGroupTurns.offerIdle`. On an offer:
  - send `pass-state` to the offered member;
  - emit `'rig-group-offered'` `{ code, call, reason, offeredAt }`, so main can
    ask Cloud for the push.
- `_passFacts(ws)` adds `waitingMember`, `offered`, `holderCall`, `queuePosition`
  and `sharingPaused` from the turns state.
- `parkHolder(code)`: the old holder's socket becomes a waiting member, through a
  new `_parkMember` built like `_standbyGuest`, and is not closed.
- `getPassOwnerControls()` also returns `{ holderCall, queue: [{call, joinedAt}] }`
  for Share My Rig.
- Sharing paused: `setRigGroupSharingPaused(bool)`. While it is on, a rig-group
  pass that is not the holder is admitted waiting with `sharing-paused`. Turning it
  off offers `rig-free` to the first in the queue when nobody holds the rig.

**`lib/pass-enforcement.js`**

- A pass with `expires_at: null` has no end:
  - `loadPass` skips the "already expired" check;
  - `_scheduleExpiry` sets no timers;
  - `getSessionStatus().expiresAt` is `null`.

  Today a `null` end becomes `NaN`, which reads as already expiring and ends the
  pass at once. An end date years away overflows `setTimeout` (24.8 days) and
  fires at once. Add a test for both.
- `endPass('yielded')`: the same lease end as `left` (stop transmitters, restore
  the owner's identity). main must not close the old holder's socket for this
  reason.
- `getSessionStatus()` passes through `kind`, `group_id` and `share_id` from the
  profile.

**`main.js` (glue only)**

- `setPassAuthCallback` (around line 42981): before the `rig_in_use` throw, ask
  `RigGroupTurns.admit(turns, profile)`. On `'wait'` resolve `{ wait: true }`; on
  `'refuse'` throw as today.
- `rs.on('rig-group-take', ...)`:
  1. `passLeaseStopTransmitters('yielded')`;
  2. `passEnforcement.endPass('yielded')`, then wait for idle as the supersede
     path already does;
  3. `passEnforcement.loadPass(toCode, toSession)`;
  4. `remoteServer.parkHolder(fromCode)`, then `remoteServer.putMemberOnAir(toCode)`.

  If `loadPass` fails, for example because Cloud says the pass was cancelled, the
  old holder keeps the rig. Reload their pass and log it.
- The `pass-ended` handler (around line 42890): for reason `yielded`, skip
  `broadcastPassEnded` and the disconnect.
- `rs.on('rig-group-offered', s => radioFreeNotifier.notify({ code: s.code, ... }))`:
  the existing notifier, once per offer.
- Holder gone: where `pass-guest-left` and the 60 s hold end the pass, call
  `remoteServer.rigGroupHolderGone()` so the first in the queue is offered
  `rig-free`.
- Every new listener goes inside `onRemoteServer(fn)`.

**Tests**

`test/rig-group-shack-test.js`, added to the list. It drives `RemoteServer` with a
fake validator and a fake pass-auth callback, like `test/guest-pass-hopping-test.js`
and `test/guest-pass-handback-test.js`, and covers:
- a second member of the same group is admitted waiting;
- a member of another group, or a plain Guest Pass, is still refused `rig_in_use`;
- `queue-join` order and positions in `pass-state`;
- the idle offer goes to the first in the queue only;
- `pass-take-back` hands the rig over and parks the old holder, whose socket stays
  open;
- the owner's Take the radio always wins, and the queue waits behind it;
- Give it back returns the rig to the holder who was paused, not to the queue;
- a cancelled standing pass (validator 410) ends a live session at the next 60 s
  check;
- a pass with no end date stays active, and an end years away does not fire at
  once.

`test/guest-pass-authority-test.js` must place `queue-join` and `queue-leave` in
the "answered before the wall" list, or it fails, as it should.

### Slice 4. Report the rig's state to Cloud

So "My group's rigs" can show free / in use / offline.

- `lib/rig-group-status.js` (pure, with the request injected, like
  `lib/pass-radio-free-notify.js`). It sends `POST /v1/shack/rig-status`
  `{ state: 'free' | 'in_use' | 'owner' | 'paused', since }`:
  - only when the state changes;
  - at most once every 30 s, with the latest state winning;
  - never retried in a loop, and never throwing.
  - It sends no callsign. Cloud already knows the holder from the pass session.
- main sends it from the same events that already drive pass-state (load, end,
  pause, resume, sharing paused), only when this shack has a rig-group share.
  It also sends one report, with `capabilities: ['rig-groups']`, right before
  slice 5's share call, because Cloud refuses a share from a shack it has never
  heard report.
- Test: `test/rig-group-status-test.js`, covering de-duplication, the 30 s limit,
  failures being swallowed, and nothing sent without a share.

### Slice 5. Share My Rig: rig groups for the owner

**IPC in `lib/cloud-ipc.js`**, next to `passes-issue`. Each wraps
`sync._authedRequest` and returns `{ error, message }` on failure, like
`passes-issue`:

| Handler | Cloud call |
| --- | --- |
| `rig-groups-list` | `GET /v1/rig-groups` |
| `rig-groups-create` | `POST /v1/rig-groups` |
| `rig-groups-invite` | `POST /v1/rig-groups/:id/invites` |
| `rig-groups-remove-member` | `DELETE /v1/rig-groups/:id/members/:userId` |
| `rig-groups-share` | `POST /v1/rig-groups/:id/shares`, with this shack's `cloudDeviceId` |
| `rig-groups-update-share` | `PATCH /v1/rig-groups/:id/shares/:shareId` (`status`, `memberClasses`, `excludedUserIds`) |
| `rig-groups-unshare` | `DELETE /v1/rig-groups/:id/shares/:shareId` |

**`preload.js`** exposes them.

**`renderer/index.html` and `renderer/app.js`** add a "Rig group" section to the
Share My Rig dialog (around line 4441), in the dialog's existing style:
- the group's name and members, with Remove for each one this owner may remove;
- Invite a friend, which copies the link;
- Share this rig with the group, with a class per member, using the same class
  control as the pass form (`_shareRigUpdateClassDetail`);
- a Sharing paused switch, which calls `setRigGroupSharingPaused` through a new
  IPC and `rig-groups-update-share` with `status: 'paused'`;
- the live region: "In use by K1ABC · 2 waiting", from
  `getPassOwnerControls()`.

The dialog appears only when the user is signed in to Cloud and the shack has a
Cloud address (the existing `_shareRigUpdateReachNotice` check).

Rules: text an 80-year-old can read, POTACAT colours, no new chrome. Errors from
Cloud are shown as Cloud words them, like `passes-issue`.

### Slice 6. POTACAT as a member: "My group's rigs"

- IPC `rig-groups-my-rigs`: `GET /v1/me/rig-groups/rigs`.
- In the remote-connect screen, a "My group's rigs" list shows each rig's owner,
  name and state (free / in use / offline) and a Connect button.
- Connect calls a new `redeemStandingPass(code)`, factored out of
  `redeemGuestPass` (main.js around line 41622). It always uses the signed-in
  `/redeem`, never the anonymous one. It upserts a `kind:'pass'` connection target
  with `group: { id, name }`.
- `lib/remote-client.js`:
  - add `'rig-groups'` to the hello `capabilities` (line 384);
  - add `queueJoin()` and `queueLeave()`;
  - surface `by` and `queuePosition` on `'pass-state'`.
- The waiting screen in the renderer uses `PassWording` for the new reasons:
  - Tell me when it's free (`queueJoin`);
  - Stop waiting (`queueLeave`);
  - Take the rig (`passTakeBack`, which already exists).
- Before storing a standing pass's session token in `connectionTargets`, check
  how `kind:'pass'` targets keep `sessionId` today. If it is written to disk in
  the clear, declare it in `lib/settings-secrets.js` in this slice
  (test/settings-secrets-test.js).

### Slice 7. ECHOCAT Web

ECHOCAT Web (`renderer/remote.js` and `remote.css`, served by remote-server)
already handles Guest Pass waiting states. It needs:
- the three new reasons;
- `by` and `queuePosition`;
- the two buttons, sending `queue-join` and `queue-leave`;
- `rig-groups` in its hello capabilities.

The words come from `PassWording`, which is inlined, so no new strings belong in
remote.js.

### Slice 8. Protocol document

`docs/echocat-protocol.md`, in the same PR as slice 3, as the wire contract
requires:
- the `rig-groups` capability;
- the three new `pass-state` reasons and the `by` and `queuePosition` fields;
- the `queue-join` and `queue-leave` rows;
- `pass-take-back` granted to an offered member;
- `auth-ok.passSession.kind` and `group`.

## What does not change

- An ordinary Guest Pass works exactly as today. Every guest-pass test passes
  unchanged.
- The owner's controls (#200) and the hand-back rule.
- Logging. A member's contacts go through `logContact` and `lib/pass-qso-outbox.js`
  under their pass, as a guest's do.
- License enforcement in `lib/privileges.js` through `PassEnforcement`.

## Order and hand-offs

```
Slice 1 ─► Slice 2 ─► Slice 3 ─► Slice 4
                         │
            (cloud handoff lands)
                         ▼
                    Slice 5 ─► Slice 6 ─► Slice 7
Slice 8 ships inside slice 3.
```

Send both handoffs when slice 3's PR opens, so the cloud and the app are built in
parallel with slices 4 to 7. The shack never mints passes. Cloud checks that the
shack's desktop advertises `rig-groups` before it lets a rig be shared (see the
cloud handoff), so an older desktop can never be handed a standing pass it would
expire at once.

## Risks

- **The handoff between members** is a lease end and a lease start. The callsign
  switch must hold on every transmit path (`passLeaseStopTransmitters`, the lease
  tests). Slice 3's test drives two members through a handoff and checks the
  on-air call each time.
- **Activity detection** misses a transmission the shack starts on its own. The
  idle offer is then wrong, but harmless: the holder only loses the rig if
  someone takes it and they come back. The owner-activity list is the model.
- **A queue in memory** is lost when the shack restarts. Members then simply ask
  again. A persistent queue waits for the cloud wait queue in Phase 2 of the design.
