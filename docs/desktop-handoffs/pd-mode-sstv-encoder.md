# PD-mode SSTV encoder support

Status: open
Filed: 2026-05-06
Repo for changes: d:/projects/potacat-dev

## Context

The iOS SSTV mode picker advertises Martin / Scottie / Robot (already supported) plus PD90, PD120, PD160, PD180, PD240. Selecting any PD mode currently shows an alert "Mode pending desktop support" and reverts to the previous selection — the iOS UI is wire-ready but the desktop encoder doesn't accept those mode strings yet.

PD modes (Martin Bruchanov) are popular for ISS commemorative SSTV events (the ARISS calendar runs PD120) and high-resolution QSL cards generally. Adding them brings the desktop in line with what hams actually receive on common SSTV frequencies.

## What the iOS app already does

- `src/utils/sstvModes.ts` lists each PD mode with `supported: false`. UI surfaces them with a "(desktop pending)" suffix.
- `src/screens/SstvComposeScreen.tsx` blocks selection and shows an Alert directing the user to Martin/Scottie/Robot for now.
- The compose canvas captures at 320×256 by default; PD120 and PD180/240 are 640×496 native — desktop encoder should resize the captured JPEG up if the source dimensions don't match the mode's native resolution.

After this lands on desktop, iOS just flips `supported: true` for each PD mode in `sstvModes.ts` and bumps the `MIRRORED_FROM` comment in `src/protocol/echocatProtocol.ts`. No protocol additions needed; the existing `sstv-photo { image, mode }` envelope passes the mode string through unchanged.

## What needs to change on desktop

### 1. Mode catalog — `lib/sstv-modes.js`

Add definitions for each PD mode. Reference resolutions and durations:

| Mode  | Width | Height | Duration |
|-------|-------|--------|----------|
| PD90  | 320   | 256    | ~90 s    |
| PD120 | 640   | 496    | ~126 s   |
| PD160 | 512   | 400    | ~161 s   |
| PD180 | 640   | 496    | ~187 s   |
| PD240 | 640   | 496    | ~248 s   |

VIS codes (decimal): PD50=93, PD90=99, PD120=95, PD160=98, PD180=96, PD240=97.

### 2. Encoder — `lib/sstv-engine.js`

PD modes use a YCbCr (luminance + averaged chroma) line format:
- 20 ms 1200 Hz sync pulse
- 2.08 ms porch at 1500 Hz
- Y for line N
- averaged Cr of lines N + N+1
- averaged Cb of lines N + N+1
- Y for line N+1

Two image lines per "scanline" group, hence the name "Pasokon Display." Spec reference: Martin Bruchanov's "PD-modes specification" PDF.

### 3. Photo handler — `lib/remote-server.js` / `main.js`

The `sstv-photo` handler already passes the `mode` string through to the engine. Verify nothing rejects unknown modes upstream. If the captured image is at 320×256 but the mode is 640×496, resize using whatever path Martin/Scottie use (likely `sharp` or a similar lib).

### 4. Optional — VIS recognition on RX

If the desktop's auto-detect VIS demodulator picks up PD VIS codes already, no change. If not, extend the lookup table so received PD transmissions decode automatically.

## Test path

1. Apply this change.
2. On iOS, flip `SSTV_MODES` PD entries to `supported: true`, bump MIRRORED_FROM, build.
3. On the new iOS build: SSTV → Compose → tap PD120 in the mode picker. Should accept without alert.
4. Build a card, tap Send.
5. Receiving station should decode at 640×496 PD120.
6. Verify TX duration estimate (`formatDuration(126)`) matches actual on-air time within ~2s.
7. Repeat with PD90 (smaller, faster) and PD240 (largest, slowest) to confirm the encoder handles both ends of the resolution range.

## Reference

- Spec: search "Martin Bruchanov PD modes SSTV" — original PDF.
- iOS mode catalog: `D:\Projects\potacat-app\src\utils\sstvModes.ts`
- iOS compose flow: `D:\Projects\potacat-app\src\screens\SstvComposeScreen.tsx`
- Protocol mirror: `D:\Projects\potacat-app\src\protocol\echocatProtocol.ts`
