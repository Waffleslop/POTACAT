# Memory channel picker — scope (2026-10-21, not built)

**Ask (an IC-7610 owner bringing an IC-7000 in from the mobile as a second radio):** select the radio's memory channels from POTACAT/ECHOCAT, in particular programmed repeaters with their tone and offset, "as a simple channel selection remotely".

**Today:** nothing reads or recalls memories. POTACAT drives VFO frequency and mode only. The IC-7000 entry (`lib/rig-models.js`, CI-V 0x70, added at KZ4ZX's request 2026-08-26) is radio-unvalidated. The workaround that works now: custom CAT buttons with raw CI-V frames (desktop VFO window, ECHOCAT Web, the app): `FE FE 70 E0 08 00 05 FD` recalls memory 5, `FE FE 70 E0 08 A0 01 FD` selects bank A, `FE FE 70 E0 07 00 FD` returns to VFO A.

## What to build

A **Memories** list on every surface: channel number, name, frequency, mode, and for FM channels the duplex direction, offset and tone, read from the radio; tap = recall. A **VFO** button to leave memory mode. Read-only: POTACAT never writes a memory (programming belongs to the radio's own software; a wrong write is unrecoverable from a phone).

### Protocol support (phase 1 = Icom CI-V + rigctld)

| rig | list | recall | back to VFO |
|---|---|---|---|
| Icom CI-V (IC-7000, 7300, 7610, 705, 9700…) | `1A 00 <ch BCD 2 bytes>` memory-contents read; reply carries select flag, frequency (5 B BCD), mode, filter, data, duplex/tone flags, tone freq, TSQL freq, DTCS, and the name (ASCII). Byte layout is **per model** (the IC-7000 reply is shorter than the 7300's) — table in `lib/codecs/civ-codec.js`, verified against the model's CI-V reference, never guessed. Empty channel = NAK (`FA`). | `08 <ch BCD>` (bank first with `08 A0 <bank>` on banked rigs) | `07 00` (VFO A) / `07 01` |
| rigctld (any hamlib rig with memories) | `h <ch>` get_channel → hamlib's channel struct text (freq, mode, width, tx_freq, rptr_shift, rptr_offs, ctcss_tone, channel_desc…) | `E <ch>` set_mem + `V MEM` | `V VFOA` |
| Kenwood / Yaesu native | later: `MR`/`MC` (Kenwood `MR0xxx;` reply fields, Yaesu `MR`/`MC`) | `MC`/`MR` | `VM`/`FR0` |

The reads are one `RigController.queryRaw()` per channel (exists; rigctld + Kenwood match replies by prefix, CI-V needs the `1A 00` reply matcher added). A full list is 100–500 reads at ~20–50 ms each: read on demand (first open, Refresh), cache per rig in `settings` (`rig.memoryCache {readAt, channels}`), never on connect.

### Desktop

- `lib/rig-memories.js` (pure): `parseCivMemory(model, bytes)`, `parseRigctldChannel(text)`, `memoryRange(model)` (IC-7000: 5 banks × 99 + call/scan-edge channels; 7300: 99 + P1/P2; rigctld: `dump_caps` mem list), `recallFrames(model, ch)`, `describeChannel(c)` ("146.940 FM −600 kHz T100.0").
- main.js: `rig-memories-read` (progress events while reading), `rig-memory-recall`, `rig-memory-vfo`; the state `memoryMode`/`memoryCh` in the rig-state broadcast, taken from the poll (CI-V `04`? no — memory/VFO state is not in the normal poll; read `1A 00` of the current channel on recall and after a `07`/`08` the operator pressed on the radio is invisible — show "memory N" only when POTACAT did the recall, say so in the UI).
- **The tune path must leave memory mode first**: a spot click while in memory mode would tune the VFO the radio is not listening to. `tuneRadio` sends `07 00` (or `V VFOA`) when `memoryMode` is set, then tunes.
- The NEVER_MODES guard in `sendCatMode` already refuses memory names as modes; the mode poll keeps working in memory mode.
- VFO window: a Memories section (list + Refresh + VFO); Rig menu tab.

### ECHOCAT

- Capability `rig-memories`; S2C `rig-memories {rigId, readAt, channels:[{ch, bank?, name, freqHz, mode, duplex?, offsetHz?, tone?, tsql?}], reading:{done,total}?}` hydrated at connect from the cache; C2S `rig-memories-read`, `rig-memory-recall {ch}`, `rig-memory-vfo`; status gains `memoryCh` (null = VFO). Guest Pass: recall allowed (it is a tune), read allowed, nothing writes.
- Web: Memories widget in the VFO tab. Mobile: handoff doc.

### Validation

- CI-V reply layouts: IC-7300 (Casey can borrow one? the 7610 is in-house: its `1A 00` layout from the 7610 reference, radiomanual.info mirror), IC-7000 from the 7000 reference; a capture fixture per model in `test/fixtures/civ-memory/` and `test/rig-memories-test.js`. The bundled rigctld Dummy rig has memories (`E`/`h` work with `-m 1`) for the rigctld path end to end.
- The IC-7000 owner is the first real 7000: ask for a `session.log` after the first read.

### Effort

Pure parsers + tests 1 day; main/VFO/web 1 day; CI-V layouts per model as references are checked; mobile is a handoff. Phase 1: IC-7000 + IC-7300/7610 + rigctld. Phase 2: Kenwood/Yaesu native, Flex (no memories in the API: skip).

### Not in scope

Writing memories, scanning memories, tone/offset on the VFO itself (that is a different feature: FM repeater settings on a VFO, `set-repeater-shift`/`set-ctcss`, which hamlib exposes and CI-V has as `0F`/`16 42`/`1B 00`), bank renames.
