# Rig-Scoped UI — Plan

**Trigger:** An IC-7300 user opened audio settings and saw Flex DAX / Flex Direct options.
**Goal:** Once a user defines their rig, everything they see is relevant to *that rig*. Vendor-named
controls must consult the rig's family the same way the rig-control popover already consults `caps`.

## Current state (audit 2026-07-03)

What's already right:
- The rig editor's per-type config sub-panels (`#flex-config`, `#icom-config`, `#icom-network-config`,
  `#k4network-config`, `#hamlib-config`, `#rigctldnet-config`, …) are correctly shown/hidden by the
  selected radio-type via `updateRadioSubPanels()` (app.js:1826).
- The rig control popover is fully `caps`-gated from `lib/rig-models.js` (app.js:19270-19353) —
  ATU/preamp/NR/FTX-1 rows etc. This is the model to emulate.
- The main-window JTCAT slice selector is gated on isFlex (app.js:1695).

The gaps (ungated vendor-specific surfaces):

| # | Surface | Where | Relevant to |
|---|---------|-------|-------------|
| 1 | **Audio source dropdown** offers `smartsdr` ("Flex Direct — VITA-49") and `icom-network` (RS-BA1) to every rig; the `dax` option's label says "DAX" to non-Flex users | index.html:1483-1487 `#set-audio-source` | the reported bug |
| 2 | JTCAT popout **"Multi" multi-slice** button + panel (Slice A-D, DAX RX channel pickers) | jtcat-popout.html:235, jtcat-popout.js:1289-1381 | Flex only |
| 3 | ECHOCAT mobile multi-slice start path | remote.js:6462-6478 | Flex only |
| 4 | **"Mute Flex CW sidetone while WinKeyer is keying"** checkbox | index.html:2612 `#set-mute-flex-cw-sidetone-wk` | Flex only |
| 5 | **TunerGenius 1x3** + **Antenna Genius** accessory opt-ins | index.html:2148-2153 | Flex ecosystem only |
| 6 | ECHOCAT "Audio & PTT" help text names DAX/SmartSDR for everyone | index.html:2698 | cosmetic |

Structural problems underneath:
- **No shared "what family is this rig" helper.** The Flex test (`catTarget.type === 'tcp' &&
  port ∈ 5002-5005`) is copy-pasted at app.js:1693, 1875, 13899, 20493 and describeRigTarget.
- **`audioSource` is a global setting, but it's rig-shaped.** It lives in the rig editor UI and the
  CLAUDE/ECHOCAT help text even says "set per-rig", yet it saves globally on change (app.js:4292) and
  **switching the active rig does not touch it** (app.js:1415-1423 copies remoteAudioInput/Output +
  cwKeyPort only). A Flex+Icom multi-rig user who switches rigs keeps the wrong audio path — silent
  JTCAT/SSTV until they notice. The K3SBP 2026-06-17 broken-TX incident (comment at app.js:7566) is
  the same class of error this plan removes.
- Vestige: `settings.audioSource === 'k4-network'` is checked in main.js:7864/7870 but no UI ever
  sets that value (K4 audio actually keys off `catTarget.type === 'k4-network'`).

## Phase 0 — single source of truth: `lib/rig-family.js`

New pure CJS module (same pattern as `lib/rig-controls.js` — shared by renderer, main, tests):

```js
rigFamily(rigOrCatTarget) // → 'flex' | 'icom-network' | 'icom' | 'k4' | 'serial' | 'hamlib' | 'rigctld' | 'generic' | 'none'
```
- Decided from `catTarget.type`, with the legacy heuristic folded in once: `tcp` + port 5002-5005
  (host localhost/empty) → flex; `rig.flexApiHost` set → flex. `icom`/`civ-tcp` → icom.
  Tiebreak/refine with `lib/rig-models.js` brand when `rig.model` is set (a "FLEX-8600" model on any
  transport is still family flex).
- `audioSourcesFor(family)` → ordered `[{value, label}]`:
  - flex → `[{smartsdr, 'Flex Direct — VITA-49, no DAX program'}, {dax, 'Local audio device (DAX)'}]`
  - icom-network → `[{icom-network, 'Icom Network audio (RS-BA1)'}, {dax, 'Local audio device (USB soundcard)'}]`
  - k4 → `[{dax, 'Local audio device'}]` (network RX/TX audio rides the K4 CAT connection
    automatically — keyed off catTarget.type in main, not audioSource)
  - everything else → `[{dax, 'Local audio device (USB soundcard)'}]`
  - `defaultAudioSourceFor(family)` = first entry.
- Replace the 4 duplicated port-range checks with `rigFamily(...) === 'flex'`.
- Test: `test/rig-family-test.js` — every catTarget type, the legacy tcp heuristics, model-brand
  override, and the audioSourcesFor table.

## Phase 1 — the reported bug: audio source, filtered + per-rig

**1a. Filter the dropdown by the radio-type selected in the rig editor.**
In `updateRadioSubPanels()` (app.js:1826), rebuild `#set-audio-source` options from
`audioSourcesFor(family(selected radio-type))`:
- IC-7300 (serial/icom/civ-tcp) user sees exactly one option → hide the entire select+label and the
  DAX-mention help text; the Audio Devices pickers are the whole story. Nothing Flex-flavored on
  screen (the fix for the report).
- Flex user sees Flex Direct + Local (DAX); RS-BA1 user sees Icom Network + Local.
- On type change, if the current value is no longer offered, snap to `defaultAudioSourceFor` —
  this kills the "switched radio-type, kept smartsdr, TX dead" failure mode too.
- Same filtering applied to the welcome wizard path (it already auto-sets smartsdr for Flex,
  app.js:20492-20496 — keep, but write it per-rig, see 1b).

**1b. Make `audioSource` per-rig (`rig.audioSource`), mirror to global on activation.**
- Rig save (rigSaveBtn, app.js:2490) stores `rig.audioSource`; openRigEditor restores it (falling
  back to `defaultAudioSourceFor(family)`).
- Rig activation (cat popover click app.js:1415, plus the settings-dialog activation path at
  app.js:14433 and any headless/remote rig-switch path) copies `audioSource: rig.audioSource ||
  default` into settings alongside remoteAudioInput/Output — main.js keeps reading
  `settings.audioSource` everywhere, so **zero churn in the ~60 main.js call sites**.
- Remove the immediate global save on dropdown change (app.js:4292-4296) — it now belongs to the
  rig-save flow; keep `syncRigAudioDeviceBypass()` on change.
- **Migration (in main.js settings load, so headless benefits):** for each rig without
  `audioSource`: if the global value is valid for the rig's family, inherit it; else family default.
  Never rewrite the global for the active rig — Casey's SmartSDR-less 8600 must stay `smartsdr`.
- Verify on save-settings that main reacts to an audioSource flip (start/stop SmartSDR audio,
  RS-BA1 transport) the same way it does today when the user changes the dropdown — implementation
  checkpoint, not new code if the existing save-settings handler already covers it.

## Phase 2 — gate the remaining Flex-only surfaces on the active rig

Rule of thumb: gate on **active rig's family** for operating surfaces; gate on **any defined rig**
for accessories/configuration a user may set up before switching; **never hide a control whose
feature is currently enabled** (they need the off switch).

- **JTCAT popout Multi button (#2):** hide unless active rig family is flex. The popout learns the
  family via its existing settings snapshot (add `rigFamily` to what main pushes; also to
  `updateRemoteSettings()` main.js:8282 so ECHOCAT mobile (#3) hides its multi-slice UI).
- **WinKeyer Flex-sidetone mute (#4):** show only when a Flex rig exists in rigs[] (it's a
  cross-feature interaction; a WinKeyer user with no Flex never needs it). Stay visible if checked.
- **TunerGenius / Antenna Genius (#5):** show the opt-in checkboxes only when a Flex rig is defined
  OR the feature is already enabled.
- **ECHOCAT Audio & PTT help text (#6):** make the wording family-aware (or neutral: "Audio devices
  are set per-rig under Settings → Radio").
- **TCI spot-push: explicitly NOT gated.** TCI targets an external SDR app (Thetis/ExpertSDR) whose
  rig may be connected through any CAT transport — rig type can't tell us whether they own one.
- Cleanup: drop the dead `audioSource === 'k4-network'` checks in main.js:7864/7870 (K4 audio keys
  off catTarget.type) or route k4 through the family default properly.

## Phase 3 — keep it true

- CLAUDE.md note + convention: any control whose label names a vendor/protocol (DAX, SmartSDR,
  RS-BA1, CI-V, WinKeyer-Flex interactions) must be gated via `rigFamily()`/`caps` — same rule as
  the existing "ONE rig-control dispatcher" invariant.
- `test/rig-family-test.js` in the standard test set; grep-level parity check (like
  rig-controls' registry test) asserting the audio-source dropdown options are built from
  `audioSourcesFor`, not hard-coded, is nice-to-have.

## Risks / notes

- **Multi-rig switchers are the win and the risk.** Activation now flips audioSource — that *fixes*
  the latent silent-audio bug, but test: Flex→Icom-network→Flex switching with JTCAT running, and
  ECHOCAT connected during a switch.
- **Profiles:** rigs[] scope under multi-op profiles is still TBD (memory note); migration runs
  per-profile settings file.
- **Don't regress Casey's rig:** Flex 8600M, audioSource must remain `smartsdr` after migration.
- **Headless:** migration lives in main.js settings load, not the renderer.
- Phase 1 ships alone (one PR — it is the user-visible fix); Phase 2 follows.
