# Desktop to ECHOCAT: Guest Pass contacts carry the station's location (#822)

Date: 2026-11-20. Desktop PR: fix/822-guest-pass-station-location (not released yet).

## What changed on the desktop

A Guest Pass contact is made at the station that lends the radio, so the shack now
stamps that station's location on the guest's contact before it leaves the shack:

- `qso.myGridsquare`: the station's grid (settings.grid). It REPLACES any grid the
  guest's device sent with `log-qso`, because that grid is where the guest is, not
  where the radio is.
- `qso.myState`: the station's state (its own home state, or the park's on an activation).
- `qso.myCounty`: the station's county, ADIF MY_CNTY shape `"PA,Bucks"`.

On an activation (mySigInfo set) only blanks are filled, from the park, as the
shack logs its own activation contacts. A station with no grid or home state set
sends those fields empty.

The fields ride inside the existing `qso` object of `qso-attributed` (already
`f.object`, no schema change, no new message, no capability). The guest's cloud
logbook record that the shack files itself (`pass-qso-cloud`) carries the same
values as MY_GRIDSQUARE / MY_STATE / MY_CNTY.

## What the app should do

1. `src/services/QsoAttributedHandler.ts` `buildAdifFromInbound`: map
   `qso.myState` to `MY_STATE` and `qso.myCounty` to `MY_CNTY` the way
   `myGridsquare` is mapped today, so the display copy matches the cloud row.
2. Never fill MY_STATE / MY_CNTY / MY_GRIDSQUARE on a Guest Pass contact from the
   phone's own location or the account's home: the contact was not made there.
   When the shack sent none (a desktop from before this change), leave them blank.

Nothing breaks if the app does neither: the cloud row (filed by the shack) is right;
only the app's local display copy lacks state and county.
