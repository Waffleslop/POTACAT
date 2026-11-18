# Desktop to Cloud handoff, 2026-11-17: rig groups (#542)

From: POTACAT desktop, GitHub #542 (branch feat/542-rig-groups; plan in
docs/rig-groups-plan.md, build plan in docs/rig-groups-implementation.md).
For: POTACAT Cloud (api.potacat.com).
Status: a proposal for review. It waits on Casey's answers to the four questions
in docs/rig-groups-plan.md. Nothing here is live.

## What it is

A few friends (for example four) share their rigs with one another. Each owner
can take their own rig back at any time. Members never bump each other. A rig is
offered to the next member who asked when its user leaves or has been idle for 5
minutes.

The desktop builds this on Guest Pass. **Cloud issues each member a standing pass
for every rig shared with the group.** The shack checks it exactly as it checks a
Guest Pass today (`GET /v1/passes/{code}` every 60 s, validate-session at
connect). Removing a member cancels their passes, and the shack ends a live
session at its next check.

## 1. Groups, members and invites

Suggested data. Map it onto your schema; the desktop only sees the API.

```
rig_group         id, name, created_by (user), created_at, deleted_at
rig_group_member  group_id, user_id, role ('creator' | 'member'), joined_at, removed_at
rig_group_invite  code (random, at least 8 characters, single use), group_id,
                  invited_by, created_at, expires_at (7 days), accepted_by, accepted_at
```

Endpoints (Bearer JWT; the caller must be a member of the group unless noted):

| Call | Does | Errors |
| --- | --- | --- |
| `POST /v1/rig-groups` `{name}` | Create; the caller becomes the creator | `400 name_required` |
| `GET /v1/rig-groups` | The caller's groups, each with members (`userId`, `callsign`, `role`), shares (section 2) and `limits: {maxRigs, maxMembers}` | |
| `POST /v1/rig-groups/{id}/invites` | `{code, url, expiresAt}`; the url is `https://potacat.com/rig-group/join?code=…` | `409 group_full {limit}` |
| `POST /v1/rig-group-invites/{code}/accept` | Join; any signed-in user with a callsign on the account, not only members | `410 invite_expired`, `409 already_member`, `409 group_full {limit}`, `400 callsign_required` |
| `DELETE /v1/rig-groups/{id}/members/{userId}` | Leave (self), or remove (the creator) | `403 not_allowed` |
| `DELETE /v1/rig-groups/{id}` | The creator deletes the group: every share ends and every pass is cancelled | `403 not_allowed` |

Who may remove whom is question 2 in the plan. The proposal: each member may
leave; the creator may remove anyone; an owner removes a member from their own
rig through the share's exclusions (section 2).

## 2. Shares: a rig in a group

```
rig_group_share   id, group_id, shack_device_id, owner_user_id,
                  status ('active' | 'paused' | 'ended'),
                  max_power_w, allowed_modes,          -- as on a Guest Pass
                  member_classes  jsonb  {user_id: 'tech'|'general'|'extra'},
                  excluded_user_ids uuid[],
                  created_at, ended_at
```

| Call | Does | Errors |
| --- | --- | --- |
| `POST /v1/rig-groups/{id}/shares` `{shackDeviceId, maxPowerW?, allowedModes?, memberClasses?}` | Share the caller's shack into the group | `403 not_your_shack`, `409 group_full {limit}`, `409 shack_not_ready` (section 7), `409 already_shared` |
| `PATCH /v1/rig-groups/{id}/shares/{shareId}` `{status?, maxPowerW?, allowedModes?, memberClasses?, excludedUserIds?}` | The rig's owner only | `403 not_allowed` |
| `DELETE /v1/rig-groups/{id}/shares/{shareId}` | Unshare; the rig's owner, or the group's creator | `403 not_allowed` |

`status: 'paused'` is shown in the members' lists. The shack enforces it locally
and at once, so Cloud need not cancel passes for a pause.

## 3. Standing passes

Keep one pass for each (active share, member), never for the share's owner on
their own rig:

- **Mint** when a share is created (for every member), and when a member joins
  (for every active share). Do it only when `member_classes` holds that member's
  class. With no class, mint nothing; the owner's screen shows "class not set"
  (question 4).
- **Cancel** when the member leaves or is removed, is added to
  `excluded_user_ids`, the share ends, or the group is deleted.
- **Update** in place when the owner changes the member's class, power or modes.
  The shack's 60 s check picks it up.

The pass record, as `GET /v1/passes/{code}`, validate-session and `/redeem` return
it:

```json
{
  "code": "apple pie candle river",
  "kind": "rig_group",
  "group_id": "…", "group_name": "Night Owls", "share_id": "…",
  "owner_callsign": "W7RTA",
  "guest_callsign": "K3SBP",
  "privilege_class": "general",
  "max_power_w": 100,
  "allowed_modes": null,
  "starts_at": "2026-11-17T00:00:00Z",
  "expires_at": null,
  "station_callsign": null,
  "allow_anonymous": false
}
```

- `kind` is new. An ordinary Guest Pass is `"guest"`, or has no `kind` at all.
- `expires_at: null` means no end. **Never send a far-future date instead.** The
  desktop's timer overflows past 24.8 days and would end the pass at once.
- `guest_callsign` is the member's account callsign. The shack puts it on the air
  (lib/pass-enforcement.js `identityFor`).
- Cancelled: answer `410 {error: 'pass_over', reason: 'cancelled'}`, as for a
  cancelled Guest Pass. The desktop already reads that as over, never as a
  network failure (lib/pass-validate.js).
- **Redeem:** only the pass's holder, signed in. Another user gets
  `403 not_your_pass`, and `/redeem-anonymous` gets `400 sign_in_required`.
  Redeeming again on a second device is allowed, as for a Guest Pass.

## 4. "My group's rigs"

`GET /v1/me/rig-groups/rigs` returns every rig shared with the caller, excluding
the caller's own rigs:

```json
{ "rigs": [ {
  "shareId": "…", "groupId": "…", "groupName": "Night Owls",
  "ownerCallsign": "W7RTA", "shackName": "home",
  "passCode": "apple pie candle river",
  "privilegeClass": "general",
  "state": "free",
  "since": "2026-11-17T18:02:11Z"
} ] }
```

- `state` is one of:
  - `offline`: no tunnel health in the last 10 minutes (you already poll it every 5);
  - `paused`: the share's status;
  - otherwise the latest report from section 5: `free`, `in_use` or `owner`.
- Add `holderCallsign` when `in_use`; Cloud knows the holder from the pass
  session. Show callsigns only to members of the same group.
- The app never shows `passCode`. It is used to redeem and connect.

## 5. Rig state from the shack

`POST /v1/shack/rig-status`, with the owner's Bearer JWT, the call the shack
already uses for `/v1/passes`:

```json
{ "shackDeviceId": "…", "state": "in_use", "since": "2026-11-17T18:02:11Z", "capabilities": ["rig-groups"] }
```

- `state` is `free`, `in_use`, `owner` or `paused`.
- The shack sends only on a change, at most once every 30 s, and never retries in
  a loop. Keep the latest value per shack device.
- Answer `200 {}`. A `404` means no route here, and the shack stops sending until
  it restarts.

## 6. "The rig is free" push

The shack already calls `POST /v1/passes/:code/notify` `{kind: 'radio_free'}`
(docs/handoffs/CLOUD_TO_DESKTOP_HANDOFF_2026-11-14_RADIO_FREE_NOTIFY.md). Allow it
for a standing pass when the caller owns the pass's share:

- It goes to the member offered the rig, once per offer.
- Keep the same answers: 200 sent, 429 rate limited (one per pass every 5
  minutes), 409 no session, 410 pass over, 404.
- Cloud owns the words, for example: "W7RTA's rig is free. Tap to take it."

## 7. Only shacks that understand rig groups

A desktop older than this feature would treat `expires_at: null` as already
expiring and end the pass at once. That is safe, but useless. So refuse a share
(`409 shack_not_ready`, "Update POTACAT on that computer first") unless that shack
device has sent a rig-status report (section 5) whose `capabilities` include
`rig-groups`.

The desktop's Share dialog sends its first report before it creates the share.

## 8. Limits

- `maxRigs: 8` and `maxMembers: 12` per group, returned in `GET /v1/rig-groups`
  and enforced with `409 group_full {limit}`. Server settings, so they can rise
  without a release (question 3).
- No more than 3 rigs from one person. Today's 3 shack addresses per membership
  already make that true.

## 9. Questions for Casey before you build

1. Billing: does creating or joining a group need a Cloud subscription, as issuing
   a Guest Pass does (`subscription_required`)? Or only sharing a rig?
2. The four questions in docs/rig-groups-plan.md: idle offer or release, who
   removes, the limits, and per-member class.

## 10. Done when

- A group of three: two owners share a rig each. The third member sees both rigs
  in `GET /v1/me/rig-groups/rigs`, redeems one and connects.
- Removing that member makes the shack's next 60 s check answer 410 cancelled.
- Excluding a member from one rig cancels only that pass.
- A class change shows in the next validate.
- `expires_at` is `null` on every standing pass.
- A share from a shack with no `rig-groups` report is refused `shack_not_ready`.
- `radio_free` for a standing pass reaches the member's phone, once per offer.
