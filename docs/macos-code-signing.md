# macOS code signing + notarization — activation checklist

**Status (checked 2026-11-23): active.** The secrets below are set, and the
v1.14.7 release run signed both macOS builds (x64 and arm64) with the Developer
ID Application certificate, notarized them with Apple and stapled the ticket.
The checklist is kept for reference (certificate renewal, a new machine, forks).
Windows and Linux builds are not signed; see `CODE_SIGNING.md`.

The desktop build is wired for Developer ID signing, notarization,
and auto-update (commit that added `scripts/notarize.js`, `build/entitlements.mac.plist`,
the `mac` block in `package.json`, and the mac jobs in `.github/workflows/release.yml`).
Without the five GitHub secrets below (a fork, a local build), CI produces
unsigned/ad-hoc DMGs, and `macBuildIsSigned()` in `main.js`
keeps mac auto-update off. With them, each tagged
release signs + notarizes automatically and Mac auto-update is on.

Nothing here changes the release routine: you still just push a `vX.Y.Z` tag.

Bundle identifier for the Mac app is **`com.potacat`** (not the Windows
`com.waffleslop.potacat`, and never `co.cmox.*` — that's the ECHOCAT iOS app).

---

## One-time setup (all on your side — needs your Apple ID)

You already have the Apple Developer Program (team **J693SF7JDR**, via ECHOCAT),
so there's no new membership to buy.

### 1. Create a "Developer ID Application" certificate
- developer.apple.com → Certificates → **+** → **Developer ID Application**.
- Follow the CSR flow (Keychain Access → Certificate Assistant → Request a
  Certificate from a Certificate Authority), upload the CSR, download the cert.
- Double-click to import into your login keychain.
- **This is a different cert type from the iOS distribution cert** — you need
  this specific one for direct-download (non-App-Store) Mac apps.

### 2. Export it as a .p12
- Keychain Access → find "Developer ID Application: … (J693SF7JDR)" → right-click
  → **Export** → `.p12` → set a strong password (you'll store it as a secret).

### 3. Base64-encode the .p12 (that's what CI consumes)
```bash
base64 -i DeveloperID.p12 | pbcopy      # macOS — now in your clipboard
```

### 4. Create an app-specific password for notarization
- appleid.apple.com → Sign-In and Security → **App-Specific Passwords** → **+**
  → name it e.g. "POTACAT notarize". Copy the generated password.

### 5. Add five GitHub repository secrets
Repo → Settings → Secrets and variables → Actions → **New repository secret**:

| Secret name | Value |
|---|---|
| `MAC_CSC_LINK` | the base64 string from step 3 |
| `MAC_CSC_KEY_PASSWORD` | the .p12 export password from step 2 |
| `APPLE_ID` | your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password from step 4 |
| `APPLE_TEAM_ID` | `J693SF7JDR` |

---

## Activating it

Push a normal version tag (`git tag v1.11.0 && git push origin v1.11.0`). The
mac jobs will now:
1. import the cert (`CSC_LINK`) and sign with Developer ID,
2. `scripts/notarize.js` submits to Apple and staples the ticket,
3. produce a signed **dmg** (fresh installs) + **zip** (auto-update feed) and
   `latest-mac.yml`, all attached to the release.

CI time goes up a few minutes per mac job (notarization is a round-trip to
Apple). If a secret is missing or wrong, `scripts/notarize.js` logs
`[notarize] skipped …` and the build falls back to unsigned — it won't fail
the release, so check the log if a build you expected to be signed isn't.

## The one manual step for existing Mac users

Auto-update is signed→signed only: a user on an **unsigned** 1.10.x build
cannot auto-update to the first **signed** build (Squirrel.Mac won't swap an
ad-hoc app). They install that first signed DMG by hand, once. Every signed
release after that auto-updates. Worth a line in the release notes for the
first signed version.

## Verifying a build is actually signed + notarized
```bash
codesign -dv --verbose=4 /Applications/POTACAT.app     # Authority=Developer ID Application: … (J693SF7JDR)
spctl -a -vvv -t install /Applications/POTACAT.app      # source=Notarized Developer ID  →  accepted
xcrun stapler validate /Applications/POTACAT.app        # The validate action worked!
```
`macBuildIsSigned()` in `main.js` checks the same `Authority=Developer ID Application`
line to decide whether to enable auto-update, so if `codesign` shows it, the
app will offer updates.
