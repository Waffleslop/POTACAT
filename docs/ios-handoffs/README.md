# iOS App Handoffs

This directory holds open requests for the iOS POTACAT app (React Native, repo `potacat-app`). Each file is a self-contained briefing the iOS Claude can act on without session history.

## Convention

- One markdown file per request, named after the feature (`psk31-rtty-modes.md`, `cert-pinning-module.md`, etc.)
- Top of each file: status (open / in-progress / shipped), filed date, and the iOS repo path.
- Body explains: context, what the desktop side already does/sends, what needs to change in the iOS app, test path, and links to relevant desktop commits.
- When a handoff is shipped on the iOS side, mark status `shipped` (don't delete — useful as a record of cross-app coordination).

## Open

- [audio-restart-button.md](audio-restart-button.md) — Add a "Restart audio" button (and optional auto-banner) that fires the `restart-audio` WS message; recovers the iOS audio bridge from RDP-induced silence without leaving the phone.
- [jtcat-qso-waiting-phase.md](jtcat-qso-waiting-phase.md) — Render the new JTCAT `waiting` QSO phase: when the called station answers someone else the desktop now holds + auto-re-arms instead of aborting; the iOS app needs to show the "⏸ … waiting to reply" flag and hold the tracker at the reply step.

## Shipped

- [psk31-rtty-modes.md](psk31-rtty-modes.md) — Add PSK31 (new) and RTTY (partial) to spot filters, log sheet, mode picker. Shipped 2026-05-06.
