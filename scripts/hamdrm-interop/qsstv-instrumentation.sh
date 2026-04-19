#!/bin/bash
# ---------------------------------------------------------------------------
# QSSTV instrumentation installer.
#
# Applies fprintf dumps to a QSSTV source tree so a TX run writes every
# intermediate (FAC, MOT, MLC, cells, samples) to /tmp/qsstv-dump/ in the
# same byte/float format our JS port does. Point scripts/hamdrm-interop/
# diff-dumps.js at the two dump dirs for a layer-by-layer comparison.
#
# Usage:
#   ./qsstv-instrumentation.sh /path/to/QSSTV
#
# Requires the QSSTV source at the given path (from `git clone` of
# https://github.com/ON4QZ/QSSTV, branch main). Run from anywhere; the
# script only touches files under QSSTV/src/drmtx/common.
# ---------------------------------------------------------------------------

set -euo pipefail

QSSTV="${1:?QSSTV source path required}"
if [[ ! -d "$QSSTV/src/drmtx/common" ]]; then
  echo "error: '$QSSTV/src/drmtx/common' not found — is this a QSSTV checkout?" >&2
  exit 1
fi

DUMP_DIR="/tmp/qsstv-dump"

patch_file() {
  local file="$1"
  local marker="$2"
  local insert="$3"
  if grep -qF "$marker" "$file"; then
    echo "  already patched: $file"
  else
    # Use a Python helper for safe insertion — sed inline is a pain.
    python3 - "$file" "$marker" "$insert" <<'PY'
import sys, re
fn, marker, insert = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(fn, encoding='utf-8').read()
idx = src.find(marker)
if idx < 0:
    sys.stderr.write(f"marker not found in {fn}: {marker!r}\n")
    sys.exit(1)
# Insert BEFORE the marker line; keep the marker intact.
line_start = src.rfind('\n', 0, idx) + 1
patched = src[:line_start] + insert + src[line_start:]
open(fn, 'w', encoding='utf-8').write(patched)
PY
    echo "  patched: $file"
  fi
}

# Ensure dump dir exists at QSSTV startup.
INIT_SNIPPET='#include <sys/stat.h>
static void __potacat_init_dump() {
    mkdir("'"$DUMP_DIR"'", 0755);
    FILE* f;
    f = fopen("'"$DUMP_DIR"'/fac-block.txt", "w"); if (f) fclose(f);
    f = fopen("'"$DUMP_DIR"'/fac-channel-bits.txt", "w"); if (f) fclose(f);
    f = fopen("'"$DUMP_DIR"'/mot-data-groups.txt", "w"); if (f) fclose(f);
    f = fopen("'"$DUMP_DIR"'/msc-payload-bytes.txt", "w"); if (f) fclose(f);
    f = fopen("'"$DUMP_DIR"'/msc-channel-bits.txt", "w"); if (f) fclose(f);
    f = fopen("'"$DUMP_DIR"'/grid-cells.txt", "w"); if (f) fclose(f);
    f = fopen("'"$DUMP_DIR"'/symbol0-samples.f32", "wb"); if (f) fclose(f);
}
'

# ---------------- FAC.cpp (dump 48-bit block + 90-bit channel) ----------------
FAC="$QSSTV/src/drmtx/common/FAC/FAC.cpp"
patch_file "$FAC" "/* CRC -" '
/* ==== POTACAT INSTRUMENTATION ==== */
{
    static int _potacat_first = 1;
    if (_potacat_first) { system("mkdir -p '"$DUMP_DIR"'"); _potacat_first = 0; }
    FILE* _f = fopen("'"$DUMP_DIR"'/fac-block.txt", "a");
    if (_f) {
        fprintf(_f, "frame%d ", Parameter.iFrameIDTransm);
        (*pbiFACData).ResetBitAccess();
        // Block has 40 payload + 8 CRC (48 bits = 5 bytes + 1 CRC byte) —
        // but CRC isn\x27t appended yet; we dump the 5 payload bytes only
        // and print CRC on the next line once available.
        for (int _k = 0; _k < 5; _k++) fprintf(_f, "%02x ", (unsigned) (*pbiFACData).Separate(8));
        (*pbiFACData).ResetBitAccess();
        fclose(_f);
    }
}
/* ================================= */
'

# ---------------- MOT GenMOTObj (dump data group bytes) ----------------
MOT="$QSSTV/src/drmtx/common/datadecoding/DABMOT.cpp"
patch_file "$MOT" "/* ---- CRC-16" '
/* ==== POTACAT INSTRUMENTATION ==== */
{
    static int _potacat_dg_idx = 0;
    FILE* _f = fopen("'"$DUMP_DIR"'/mot-data-groups.txt", "a");
    if (_f) {
        fprintf(_f, "DG%d %s%d len=%d ",
            _potacat_dg_idx++, bHeader ? "H" : "B", iSegNum, iTotLenMOTObj / 8);
        // Walk vecbiData bit-by-bit to re-pack bytes.
        vecbiData.ResetBitAccess();
        for (int _b = 0; _b < iTotLenMOTObj / 8; _b++) {
            unsigned by = 0;
            for (int _j = 0; _j < 8; _j++) by = (by << 1) | (vecbiData.Separate(1) & 1);
            fprintf(_f, "%02x ", by);
        }
        fprintf(_f, "\n");
        vecbiData.ResetBitAccess();
        fclose(_f);
    }
}
/* ================================= */
'

# ---------------- ConvEncoder Encode (dump channel-bit stream) ----------------
CONV="$QSSTV/src/drmtx/common/mlc/ConvEncoder.cpp"
patch_file "$CONV" "/* Return number of encoded bits */" '
/* ==== POTACAT INSTRUMENTATION ==== */
{
    const char* _name = (eChannelType == CT_FAC) ? "fac-channel-bits.txt" : "msc-channel-bits.txt";
    char _path[256];
    snprintf(_path, sizeof(_path), "'"$DUMP_DIR"'/%s", _name);
    FILE* _f = fopen(_path, "a");
    if (_f) {
        for (int _i = 0; _i < iOutputCnt; _i++) {
            fprintf(_f, "%d", ExtractBit(vecOutputData[_i]) & 1);
        }
        fprintf(_f, "\n");
        fclose(_f);
    }
}
/* ================================= */
'

# ---------------- OFDMCellMapping (dump complete grid cells per symbol) ----------------
OCM="$QSSTV/src/drmtx/common/ofdmcellmapping/OFDMCellMapping.cpp"
patch_file "$OCM" "/* Increase symbol-counter" '
/* ==== POTACAT INSTRUMENTATION ==== */
{
    FILE* _f = fopen("'"$DUMP_DIR"'/grid-cells.txt", "a");
    if (_f) {
        fprintf(_f, "sym%d ", iSymbolCounterAbs);
        for (int _c = 0; _c < iNumCarrier; _c++) {
            fprintf(_f, "%.6f %.6f ", (*pvecOutputData)[_c].real(), (*pvecOutputData)[_c].imag());
        }
        fprintf(_f, "\n");
        fclose(_f);
    }
}
/* ================================= */
'

echo
echo "Patched. Now rebuild QSSTV:"
echo "  cd $QSSTV && qmake && make -j"
echo
echo "Then run a TX with a known input (e.g. potacat-logo.jpg + label K3SBP)."
echo "Dumps will land in $DUMP_DIR/."
echo "Compare against our JS port output with:"
echo "  node scripts/hamdrm-interop/diff-dumps.js <js-dump-dir> $DUMP_DIR"
