# Desktop to ECHOCAT: VARA 1 January 2027 notice (2026-11-22)

Casey's request 2026-11-22: warn when VARA is older than HF 4.9.1 / FM 4.4.1, so operators
update before 1 January 2027. Desktop PR: feat/925-vara-2027-update-notice.

## What changed on the wire
`winlink-state` carries one new field, additive (older phones ignore it):

```
varaNotice: { hf: string | null, fm: string | null }
```

Each is the full sentence to show, or null. The shack fills it after it reads the version VARA
gives on its command port (`VERSION` -> `VERSION VARA HF v4.8.9`). A VARA that does not answer
with a version gives null: no guess.

Exact texts (built by desktop lib/vara-version.js; show them as sent, do not rebuild):
- Before 1 January 2027: `Your VARA HF is version 4.8.9. VARA HF before 4.9.1 stops working on 1 January 2027. Update VARA from its author's site, rosmodem.wordpress.com.`
- From 1 January 2027: `Your VARA HF (version 4.8.9) is too old to work since 1 January 2027. Update VARA from its author's site, rosmodem.wordpress.com.`
- VARA FM: the same with `VARA FM` and `4.4.1`.

## What the phone should do
- In the Mail screen's mode area, when VARA HF is the picked mode show `varaNotice.hf`; for VARA FM
  show `varaNotice.fm`. Put it before any other mode caveat. ECHOCAT Web does exactly this
  (renderer/remote.js, the `mail-mode-caveat` line).
- Plain text; no link needed. It never blocks Connect.
