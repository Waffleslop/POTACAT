# Code Signing Policy

## Status (2026-11-23)

| Platform | Signed? |
|----------|---------|
| macOS (Intel and Apple Silicon) | Yes. Signed with an Apple Developer ID and notarized by Apple, in the GitHub Actions release workflow. |
| Windows | Not code-signed yet. |
| Linux | Not signed. |

### Windows and SignPath

We are applying to the [SignPath Foundation](https://signpath.org)'s free code signing for
open-source projects. Once approved, Windows releases will be signed via
[SignPath.io](https://signpath.io) from the same CI pipeline that builds them. Until then, Windows
shows "Windows protected your PC" on the first launch; click **More info**, then **Run anyway**.

## Team Roles

| Role | Member |
|------|--------|
| Author | Casey Stanton ([@Waffleslop](https://github.com/Waffleslop)) |
| Reviewer | Casey Stanton ([@Waffleslop](https://github.com/Waffleslop)) |
| Approver | Casey Stanton ([@Waffleslop](https://github.com/Waffleslop)) |

All team members use multi-factor authentication for GitHub and Apple Developer access, and will
for SignPath.

## Build Process

Releases are built from this repository by GitHub Actions with electron-builder
(`.github/workflows/release.yml`) when a `vX.Y.Z` tag is pushed. The macOS jobs sign with the
Developer ID certificate and notarize with Apple using repository secrets; the Windows and Linux
jobs produce unsigned builds. SHA-256 checksums for every file are published with each release.

## Privacy

POTACAT sends anonymous usage statistics to telemetry.potacat.com. It is **on by default for new
installs**: the welcome screen shows it as a ticked box you can untick, and nothing is sent while
the welcome screen is open. An install from before this default that never made a choice stays off.
Turn it off at any time in Settings ("Share anonymous usage statistics").

What is sent:

- on launch and on quit: a random ID (not tied to you), the app version, the operating system,
  the session length, and whether the session was active;
- a count ping when a QSO is logged or a spot is re-posted, carrying only the program
  (POTA, SOTA, WWFF, LLOTA, WWBOTA or GMA) when there is one.

No callsign, grid or location, contact details or log contents are sent.

Full privacy policy: [potacat.com/privacy-terms.html](https://potacat.com/privacy-terms.html)
