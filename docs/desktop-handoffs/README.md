# Desktop Handoffs

This directory holds open requests for the POTACAT desktop (this repo, Electron). Each file is a self-contained briefing the desktop Claude can act on without session history.

## Convention

- One markdown file per request, named after the feature (`jtcat-replay-on-reconnect.md`, `pd-mode-sstv-encoder.md`, etc.)
- Top of each file: status (open / in-progress / shipped), filed date, and the desktop repo path.
- Body explains: context, what the iOS app already does/sends, what needs to change on desktop, test path, and links to relevant iOS commits.
- When a handoff is shipped on the desktop side, mark status `shipped` (don't delete — useful as a record of cross-app coordination).

This folder is the mirror of `docs/ios-handoffs/`. The iOS app at `D:\Projects\potacat-app` files requests here for desktop work; desktop files requests there for iOS work.

## Open

- [jtcat-auto-cq-both-slots.md](jtcat-auto-cq-both-slots.md) — Auto-CQ transmits on both even and odd slots back-to-back without ever listening for replies. Should alternate TX/RX in the standard FT8 pattern. **HIGH priority — blocks usable auto-CQ.**
- [relay-call-incoming-push.md](relay-call-incoming-push.md) — Desktop calls Cloudflare Worker `/push` endpoint when a CQ is heard / FT8 decode of operator's call lands / operator pings phone. Wakes iOS from suspend via PushKit. **HIGH priority — required for Phase 2D end-to-end.**
- [pd-mode-sstv-encoder.md](pd-mode-sstv-encoder.md) — Accept PD90/120/160/180/240 mode strings in `sstv-photo` and route to a PD encoder. iOS UI advertises these modes already.
- [sstv-auto-toggle-handler.md](sstv-auto-toggle-handler.md) — Add a handler for `sstv-set-auto-enabled` so the iOS Auto-SSTV banner toggle actually flips state remotely. (Gap 14.)
- [heartbeat-timeout-investigation.md](heartbeat-timeout-investigation.md) — Investigate why the heartbeat timeout kills the JTCAT engine when a phone backgrounds, and consider decoupling engine lifetime from client presence.
- [waterfall-phase2.md](waterfall-phase2.md) — Unified waterfall project, **resume point**. Phase 1 (the WebGL `Waterfall` component) shipped; Phase 2 = audio-FFT adapter + main-view integration + click-to-tune + spot overlay. Canonical plan: `docs/waterfall-plan.md`.
- [oom-flex-audio.md](oom-flex-audio.md) — Recurring OOM crash: POTACAT exits at ~1.7 GB after ~50 min of Flex Direct audio. Not root-caused. Suspect: a renderer buffering audio frames unbounded. **HIGH priority — crashes the app.**

## Shipped

- [jtcat-replay-on-reconnect.md](jtcat-replay-on-reconnect.md) — Cached-state replay on auth (decode buffer + status snapshots). Buffer now clears on engine stop so stale decodes don't reappear on a later reconnect.
- [websdr-audio-routing.md](websdr-audio-routing.md) — Wiring was already in place since `da62b46` (2026-05-01); WebSDR and KiwiSDR share the same `kiwi-active` / `kiwi-audio-frame` path into the WebRTC track-swap. Handoff doc was based on outdated info.
- [sstv-cw-id.md](sstv-cw-id.md) — `generateMorseSamples()` + `encode-complete` hook in startSstv append Morse callsign at 800 Hz / 20 WPM with accurate `durationSec` updates. Final fix: include `sstvCwId` in the remote-settings push so mobile sees the persisted toggle on reconnect.
