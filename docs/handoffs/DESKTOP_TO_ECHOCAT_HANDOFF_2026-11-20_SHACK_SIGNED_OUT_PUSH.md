# Desktop to ECHOCAT: the shack pushes `cloud-status` when Cloud signs it out (2026-11-20)

From: desktop, branch `feat/cloud-device-revoked-signs-out` (not released yet).
Background: POTACAT Cloud now signs a device out when it is removed from the account
(cloud handoff CLOUD_TO_DESKTOP_HANDOFF_2026-11-20_DEVICE_REMOVE_SIGNS_OUT: every call
answers `401 {"error":"device_revoked","message":"..."}`).

## What changes on the wire
- No new message type and no new field.
- When the desktop gets `device_revoked` it signs itself out of Cloud and pushes, unasked,
  to every owner client (never to Guest Pass clients):
  `{ "type": "cloud-status", "loggedIn": false }`
  This is the same message a `cloud-get-status` answers when the shack is signed out.
- The POTACAT Tunnel stops on that computer at the same moment, so the next `alt-hosts`
  push carries `cloudHost: ""` (unchanged behaviour for a tunnel turned off).

## What the app should do
1. Accept `cloud-status` when it did not ask for it, and repaint the shack's Cloud section
   as signed out (ECHOCAT Web already does: `handleCloudMessage` shows the login form).
2. Nothing else is required. The phone's own Cloud session is separate: if the PHONE was
   the device removed, the phone gets `device_revoked` from Cloud directly.

Wire contract row updated: docs/echocat-protocol.md, `cloud-status`.
