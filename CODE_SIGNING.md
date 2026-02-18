# Code Signing Policy

## Certificate

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

All official POTA CAT releases are signed using a certificate issued by the SignPath Foundation. The signing process verifies that binaries are built directly from the source code in this repository via an automated CI/CD pipeline.

## Team Roles

| Role | Member |
|------|--------|
| Author | Casey Stanton ([@Waffleslop](https://github.com/Waffleslop)) |
| Reviewer | Casey Stanton ([@Waffleslop](https://github.com/Waffleslop)) |
| Approver | Casey Stanton ([@Waffleslop](https://github.com/Waffleslop)) |

All team members use multi-factor authentication for GitHub and SignPath access.

## Build Process

Releases are built using GitHub Actions with electron-builder. Each release requires manual approval in the SignPath dashboard before the signing certificate is applied.

## Privacy

POTA CAT includes optional, opt-in telemetry that collects only a random anonymous ID, app version, OS, and session duration. No callsign, location, IP address, or identifying information is collected. Telemetry is off by default and can be disabled at any time in Settings.

Full privacy policy: [potacat.com/privacy-terms.html](https://potacat.com/privacy-terms.html)
