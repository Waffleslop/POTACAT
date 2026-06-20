# Building the bundled `wsprd` (GPLv3) — runbook

This is the actionable procedure to vendor and build the WSPR decoder so the
Apache-side bridge (`lib/wspr-decoder.js`) can invoke it. The decoder stays a
**separate executable** (mere aggregation) — see `README.md` for why that keeps
POTACAT Apache-2.0. Everything in POTACAT that *consumes* this binary is already
built and tested; this is the last piece.

## 1. Vendor the source

`wsprd` ships inside WSJT-X (`lib/wsprd/`). Pin a version, copy the sources into
`third_party/wsprd/src/`, and record it:

```bash
# from a WSJT-X source checkout (pin the tag you used in VERSION.txt)
cp wsjtx/lib/wsprd/*.c  wsjtx/lib/wsprd/*.h  third_party/wsprd/src/
echo "WSJT-X 2.7.0  (commit <sha>)" > third_party/wsprd/VERSION.txt
cp wsjtx/COPYING third_party/wsprd/LICENSE      # GPLv3 text (compliance)
```

Typical file set (verify against the pinned version — names drift):
`wsprd.c wsprd_utils.c wsprsim_utils.c tab.c fano.c jelinek.c nhash.c
metric_tables.c` plus their headers. `wsprd` depends on an FFT — upstream uses
**FFTW3 (single precision, `fftw3f`)**.

> GPLv3 compliance: keeping `src/` + `LICENSE` + `VERSION.txt` here satisfies the
> "offer the corresponding source" obligation for the binary we ship. Done once.

## 2. Build per platform

The produced binary must be **self-contained** (static FFT) so users install
nothing. Output to `third_party/wsprd/build/wsprd[.exe]` for dev runs;
`resolveWsprdPath()` in `lib/wspr-decoder.js` looks there.

### Linux (x86_64 and arm64) — **build on ubuntu-22.04**
glibc 2.35; never 24.04 (breaks Raspberry Pi OS Bookworm — same rule as our
native addons).
```bash
sudo apt-get install -y libfftw3-dev
gcc -O3 -o build/wsprd src/*.c -lfftw3f -lm        # dynamic fftw
# or static-link fftw for a dependency-free binary:
gcc -O3 -o build/wsprd src/*.c -Wl,-Bstatic -lfftw3f -Wl,-Bdynamic -lm
```
arm64: same on an arm64 runner, or cross-compile with `aarch64-linux-gnu-gcc`.

### macOS (x86_64 + arm64)
```bash
brew install fftw
clang -O3 -o build/wsprd src/*.c -lfftw3f -lm
# universal: build each arch with -arch x86_64 / -arch arm64, then `lipo -create`.
```

### Windows
```bash
# MSYS2/MinGW (matches our other native tooling) with a static fftw3f:
gcc -O3 -o build/wsprd.exe src/*.c -lfftw3f -lm -static
```

### Optional: drop the FFTW dependency entirely
To avoid the FFTW cross-build/packaging hassle, swap `wsprd`'s FFTW calls for
the **`kiss_fft` already vendored under `lib/ft8_native/ft8_lib/`** (BSD, no
external lib). This is a small, self-contained patch in `src/` (record it as a
local patch for GPL compliance). Recommended if FFTW becomes a CI headache.

## 3. CI (release workflow)

Add a matrix job (windows-latest, macos-latest, **ubuntu-22.04** x64+arm64) that
runs the build above and uploads `wsprd[.exe]` as an artifact, then have the
electron-builder job place each into `resources/bin/` per platform.

## 4. Package with electron-builder

Ship the platform binary via `extraResources` so it lands at
`resources/bin/wsprd[.exe]` (where `resolveWsprdPath()` looks in packaged
builds). Add to `package.json` build config **once the binary exists** (a
missing `from` path can fail packaging):
```jsonc
"extraResources": [
  { "from": "third_party/wsprd/build/${os}/wsprd", "to": "bin/wsprd" }
]
```
(Adjust per-OS filename/dir to match the CI artifact layout.)

## 5. Validate — the two gates this unlocks

1. **Decode (RX):** run POTACAT, select WSPR, confirm `lib/wspr-decoder.js`
   spawns the binary and `wspr-spots` events carry real decodes.
2. **Encoder loopback (the PENDING test):** feed the clean-room encoder's audio
   to the freshly built `wsprd` and confirm it recovers `K1ABC FN42 37`. This is
   the bit-exact on-air validation for the encoder's sync-vector / conv
   constants. When it passes, flip `SYNC_VECTOR_VERIFIED = true` in
   `lib/wspr/encode.js` and un-`TODO` the loopback case in
   `test/wspr-encode-test.js`.
