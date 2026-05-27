# WebSDR.org audio through WebRTC track-swap

Status: shipped (verified 2026-05-26 — wiring already in place since `da62b46`, 2026-05-01)
Filed: 2026-05-06
Repo for changes: d:/projects/potacat-dev

## Resolution

The premise of this handoff is incorrect — both clients share the same
audio path. `ipcMain.on('kiwi-connect', ...)` at `main.js:14185-14299`
instantiates either `WebSdrClient` (lib/websdr.js) or `KiwiSdrClient`
(lib/kiwisdr.js) based on port (8073 → Kiwi, anything else → WebSDR),
and both emit `'connected'` / `'audio'` (Float32Array pcm, sampleRate)
/ `'disconnected'`. The same handler then forwards to:

- `remoteAudioWin.webContents.send('kiwi-active', true/false)` on
  connect/disconnect, which triggers `audioSender.replaceTrack()` in
  `renderer/remote-audio.html:467-490`.
- `remoteAudioWin.webContents.send('kiwi-audio-frame', { pcm, sampleRate })`
  on every audio frame, queued through the `kiwiCtx` AudioContext at
  `renderer/remote-audio.html:492-518`.

The "kiwi" naming is historical — the path serves both SDR families.
The real WebSDR.org client (PA3FWM byte-tagged protocol) landed in
`da62b46` on 2026-05-01, five days before this handoff was filed.

If WebSDR audio still appears silent on the phone, the regression is
elsewhere (PCM decoding in `lib/websdr.js`, AudioContext resample at
the 7350 Hz default sample rate, etc.) — not the routing. Reopen with
a concrete repro before scoping further desktop work.

## Context

After Gap 20a (commit `d3fccf1`), KiwiSDR audio routes through the existing WebRTC track via `RTCRtpSender.replaceTrack()` when `kiwiActive` is true. iOS users get KiwiSDR audio through the same speaker path as rig audio — perfect.

However, **WebSDR.org goes through a different desktop code path** that doesn't engage the track swap. Casey reported earlier that WebSDR audio is silent on phone while KiwiSDR works. The two SDR services have different audio decoders on the desktop side.

## What the iOS app already does

- The iOS app plays whatever audio comes through the WebRTC peer connection. There's no per-source routing on the iOS side.
- The SDR pill in the VFO screen sends `kiwi-connect` with the active host (per the unified `kiwiSlots` settings the iOS Settings now manages bidirectionally).

No iOS changes needed.

## What needs to change on desktop

### 1. Locate the WebSDR.org audio path

KiwiSDR audio in `renderer/remote.js` engages `replaceTrack()` when the kiwi connection sends decoded PCM. WebSDR.org audio likely lives in a sibling file or branch — search for `websdr` (case-insensitive) in:

- `renderer/remote.js`
- `lib/remote-server.js`
- `preload-remote-audio.js`

The audio probably arrives as PCM frames over a different message type (or different host port — KiwiSDR is 8073, WebSDR.org typically 8901+).

### 2. Unify the routing

Wherever WebSDR PCM frames are decoded, pipe them through the same `MediaStreamTrack` that Gap 20a's fix uses. The track-swap pattern from `d3fccf1`:

```js
// Pseudo-code matching the existing kiwiActive flow.
function onWebsdrPcmFrame(pcmFrame) {
  if (websdrActive) {
    decodedPcmTrack.appendBuffer(pcmFrame); // or whatever the equivalent is
    if (rtpSender.track !== decodedPcmTrack) {
      rtpSender.replaceTrack(decodedPcmTrack);
    }
  }
}
```

The mobile already has the listener for `kiwi-status` events, which is what tells it "audio source has changed." If WebSDR uses a separate event type, consider harmonizing — either rename `kiwi-*` to `sdr-*` (breaks back-compat) or have WebSDR emit `kiwi-status` with a `subtype: 'websdr'` field (doesn't break anything).

### 3. Verify on Twente

Twente WebSDR (`websdr.ewi.utwente.nl:8901`) is the canonical reference station. After the change, connecting iOS to a station configured with that host should produce live audio through the iOS speaker.

## Test path

1. Apply this change.
2. On iOS Settings → SDR Receivers, configure Slot 1 with label "Twente" + host `websdr.ewi.utwente.nl:8901`. Save & sync.
3. Mark Slot 1 active.
4. VFO tab → tap the 🛰 SDR pill. Status should go yellow (Connecting…) then green (Twente).
5. iOS speaker should produce WebSDR audio. Tune via the freq picker to confirm the SDR is responsive.

## Reference

- Gap 20a (KiwiSDR fix): commit `d3fccf1`.
- iOS SDR slot config: `D:\Projects\potacat-app\src\components\SdrSettingsSection.tsx`.
- iOS SDR connect: `D:\Projects\potacat-app\src\state\kiwi.ts` `kiwiConnectActive()`.
- Mentioned earlier in coordination as "WebSDR.org audio routing fix on desktop side (filed for desktop Claude)."
