# Settings secrets live in ONE registry

Recorded 2026-03-01 (date is when the note was written, taken from the text or the nearest release). Moved verbatim from the desktop CLAUDE.md on 2026-11-09; the original is archived in the potacat workspace at docs/history/CLAUDE-desktop-2026-11-09.md.

**Settings secrets live in ONE registry** — `lib/settings-secrets.js` (`SECRET_KEYS`, `MACHINE_CREDENTIAL_ARRAYS`, `stripSecrets()`/`restoreSecrets()`). Any new stored credential (passwords, tokens, API keys — including nested ones like `rigs[].catTarget.password` and `clusterNodes[].password`) MUST be added there, never as an ad-hoc `delete` in export-settings — the old 3-key blocklist rotted and shipped exports with live passwords/bearer tokens. Import re-grafts this machine's secrets by rig/node id. Storage at rest is deliberately plaintext (same-user malware defeats OS-keychain crypto anyway; headless Pi has no keyring); `safeStorage` encryption is a possible tier-2 follow-up.
