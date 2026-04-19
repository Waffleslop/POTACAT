# HamDRM interop test kit

Five-tier test strategy for `lib/hamdrm/`. Each tier stands alone; run them
in order, and stop as soon as you hit a failure — the failing tier tells
you exactly what's broken.

| Tier | What it proves | Cost | Tooling here |
|-----:|----------------|------|--------------|
| **1** | End-to-end audio interop (WAV decodes in QSSTV / Dream / EasyPal) | ~1 h | `encode-wav.js` |
| **2** | Byte-exact match at every pipeline layer | ~½ day | `qsstv-instrumentation.sh`, `diff-dumps.js` |
| **3** | On-air RF confirmation | hours | manual |
| **4** | Corner cases (sizes, labels, extensions) | already wired | `test-corners.js` |
| **5** | Performance | already wired | timings in corner tests |

---

## Tier 1 — Does a reference decoder accept our WAV?

**Generate a WAV:**

```bash
node scripts/hamdrm-interop/encode-wav.js potacat-logo.jpg \
  --label K3SBP \
  --out /tmp/potacat.wav
```

The output is 48 kHz / 16-bit / mono. The spectrum occupies 6 083–8 417 Hz
audio, which corresponds to the RF passband 14.239 MHz ± 1.2 kHz when the
rig is tuned to **14.233 MHz USB**.

**Decoder A — QSSTV (Linux, GPL, closest to our port):**

```bash
git clone https://github.com/ON4QZ/QSSTV && cd QSSTV
sudo apt install qtbase5-dev libfftw3-dev libhamlib-dev libpulse-dev \
                 libasound2-dev libopenjp2-7-dev libv4l-dev
qmake && make -j
./qsstv
# In the GUI: switch to the DRM tab → Input → From File → /tmp/potacat.wav
```

If QSSTV shows the decoded image (or a partial image if the payload isn't
real JPEG bytes), we're wire-compatible with QSSTV.

**Decoder B — Dream (conservative reference):**

Dream is the original DRM decoder from TU Darmstadt. Most distros have a
package; otherwise build from https://sourceforge.net/projects/drm/.

```bash
dream -I /tmp/potacat.wav    # or use the GUI
```

Dream is stricter than QSSTV — if Dream decodes, QSSTV will too.

**Decoder C — EasyPal (Windows, closed-source, the real ham user base):**

Run under Wine if you're on Linux/Mac. Get the binary from the EasyPal
groups.io files section or the WASSTV site. In the EasyPal menu: *File →
Decode From WAV…*

---

## Tier 2 — Byte-exact layer diff against QSSTV

Tier 1 is pass/fail; if it fails, you get no diagnostic. Tier 2 pinpoints
*which layer* deviates.

**Step 1 — Generate our JS port's dumps:**

```bash
node scripts/hamdrm-interop/encode-wav.js potacat-logo.jpg \
  --label K3SBP \
  --dump-dir /tmp/js-dump \
  --out /tmp/potacat.wav
```

Our dump directory will contain:

| File | Layer | Format |
|------|-------|--------|
| `fac-block.txt` | FAC 48-bit uncoded block | hex bytes, one frame per line |
| `fac-channel-bits.txt` | FAC 90-bit post-conv+puncture | 0/1 string, one line per frame |
| `msc-payload-bytes.txt` | MSC input bytes per frame | hex bytes, one line per frame |
| `msc-channel-bits.txt` | MSC post-conv+puncture+bit-interleave | 0/1 string, one line per frame |
| `mot-data-groups.txt` | every MOT data group emitted (header + body) | `DG<n> <tag> len=<N> <hex bytes>` |
| `grid-cells.txt` | final 57-cell-per-symbol grid | `sym<n> re im re im …` (pre-OFDM) |
| `pilot-cells.txt` | pilot values across the 45×57 grid | `re,im re,im …` per row |
| `cell-map.txt` | cell-type tag map (CM_* bitmap) | ints per cell |
| `symbol0-samples.f32` | first symbol's PCM (pre-normalisation) | raw float32 |
| `constants.txt` | derived sizes (iN_mux, mscByteBudget, …) | key=value |

**Step 2 — Patch and rebuild QSSTV:**

```bash
git clone https://github.com/ON4QZ/QSSTV
cd QSSTV
bash /path/to/potacat/scripts/hamdrm-interop/qsstv-instrumentation.sh .
qmake && make -j
```

The patch script adds `fprintf` dumps to matching points in QSSTV source,
all writing to `/tmp/qsstv-dump/` in the same text/binary formats as our JS
dumps. Re-running the script is idempotent.

**Step 3 — Run QSSTV with the same input:**

Start QSSTV, go to the DRM TX tab, set:
- Operator label: `K3SBP`
- Load image: `potacat-logo.jpg`
- Spectrum occupancy: **SO_1**
- Protection: **Protection A**
- Interleaver: **Short**
- MSC mode: **4-QAM**

Press TX briefly (a few seconds is enough — we just need the first
superframe to populate the dumps).

**Step 4 — Diff:**

```bash
node scripts/hamdrm-interop/diff-dumps.js /tmp/js-dump /tmp/qsstv-dump -v
```

Output looks like:

```
  MATCH   fac-block.txt: 3 lines identical
  MATCH   fac-channel-bits.txt: 3 lines identical
  MATCH   mot-data-groups.txt: 210 lines identical
  DIFFER  grid-cells.txt: max |err| = 1.2e-02 (tol 0.0001, 45 lines, worst line 7)
  ...
```

**Interpreting mismatches:**

- `fac-block.txt differs` → FAC bit packing in `hamdrm-fac.js`. Compare bytes
  to find which field (identity / mode / label / CRC) deviates.
- `fac-channel-bits.txt differs, fac-block matches` → puncturing in
  `hamdrm-mlc.js`. Most likely the tailbit row pick
  (`genPuncPatTable` → `iTailbitPattern`) or branch order in `PP_BRANCH_ORDER`.
- `mot-data-groups.txt differs` → segment header or MOT group wrap in
  `hamdrm-mot.js`. Check bytesAvailable, TransportID, CRC-16.
- `msc-channel-bits.txt differs, msc-payload matches` → bit interleaver
  PRBS seed or the MSC puncturing chain.
- `grid-cells.txt differs, all input layers match` → QAM4 mapping or cell
  placement in `hamdrm-frame.js` / `hamdrm-cells.js`.
- `symbol0-samples.f32 differs, grid-cells matches` → IFFT, cyclic prefix,
  or normalisation. Our IFFT should match QSSTV's to within ~1e-4 tolerance.

---

## Tier 3 — On-air

Only after Tiers 1 and 2 are green.

1. **Loopback**: route the WAV out through the rig's audio input (or a
   SmartSDR virtual cable), monitor with QSSTV on the same machine, no
   RF. Confirm decode.
2. **Local RF**: transmit into a dummy load or 40 dB attenuator, receive
   on a second rig, decode with QSSTV. Confirms the signal survives the
   rig's SSB chain.
3. **Open air**: post on 14.233 MHz USB, label yourself as test,
   ask on the EasyPal groups.io or HamDRM net for a confirmation.

---

## Tier 4 — Corners

```bash
node scripts/hamdrm-interop/test-corners.js
```

Sweeps payload sizes, labels, file extensions, repetition counts. Catches
size-math bugs that Tier 1 can miss for common inputs.

---

## Tier 5 — Performance

Already part of `test-corners.js`. Expect ~100× real-time on a modern CPU
(e.g. 20 KB payload → ~120 s audio encodes in under 1 s wall clock).

If you need faster: the 1152-point IFFT is the hot loop
(`lib/hamdrm/hamdrm-fft.js`). It's pure JS today — a WASM port would give
another 3-5× headroom for mobile/ECHOCAT use.

---

## When something fails

Failures are interpreted by tier:

- **Tier 1 red**: run Tier 2 to locate the layer.
- **Tier 2 red at layer X**: fix the corresponding module
  (`lib/hamdrm/hamdrm-<layer>.js`), re-run Tier 2 until green, then
  re-run Tier 1.
- **Tier 3 red**: almost always a rig / audio-path problem, not the
  encoder. Check sample rate (must be 48 kHz), USB vs LSB, SSB filter
  width (need 3.0 kHz on the Flex), and that ALC isn't crushing the
  signal.
- **Tier 4 red**: regression in size or edge-case handling; usually
  `hamdrm-mot.js` or `hamdrm-encoder.js`.
