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
# https://github.com/ON4QZ/QSSTV, branch main). Idempotent — safe to re-run.
# ---------------------------------------------------------------------------

set -euo pipefail

QSSTV="${1:?QSSTV source path required}"
if [[ ! -d "$QSSTV/src/drmtx/common" ]]; then
  echo "error: '$QSSTV/src/drmtx/common' not found — is this a QSSTV checkout?" >&2
  exit 1
fi

DUMP_DIR="/tmp/qsstv-dump"
GUARD_TAG="POTACAT INSTRUMENTATION"

# Insert `insert` into `file` at position `mode` relative to `marker`.
#   mode=before  → insert at the START of the line containing marker
#   mode=after   → insert at the END of the line containing marker
patch_file() {
  local file="$1" mode="$2" marker="$3" insert="$4"
  if grep -qF "$GUARD_TAG" "$file"; then
    echo "  already patched: $(basename "$file")"
    return 0
  fi
  node -e '
    const fs = require("fs");
    const [fn, mode, marker, insert] = process.argv.slice(1);
    const src = fs.readFileSync(fn, "utf8");
    const idx = src.indexOf(marker);
    if (idx < 0) { console.error("marker not found in " + fn + ": " + JSON.stringify(marker)); process.exit(1); }
    let pos;
    if (mode === "before") pos = src.lastIndexOf("\n", idx - 1) + 1;
    else if (mode === "after") { const nl = src.indexOf("\n", idx); pos = (nl >= 0) ? nl + 1 : src.length; }
    else { console.error("bad mode: " + mode); process.exit(1); }
    fs.writeFileSync(fn, src.slice(0, pos) + insert + src.slice(pos));
  ' "$file" "$mode" "$marker" "$insert"
  echo "  patched: $(basename "$file")"
}

echo "Patching QSSTV at $QSSTV"

# ---------------- FAC.cpp — dump 6-byte FAC block (40 payload + 8 CRC) ----
FAC="$QSSTV/src/drmtx/common/FAC/FAC.cpp"
patch_file "$FAC" after \
  '(*pbiFACData).Enqueue(CRCObject.GetCRC(), 8);' \
'
/* ==== POTACAT INSTRUMENTATION ==== */
{
    static int _potacat_first = 1;
    if (_potacat_first) {
        system("mkdir -p '"$DUMP_DIR"'");
        _potacat_first = 0;
    }
    FILE* _f = fopen("'"$DUMP_DIR"'/fac-block.txt", "a");
    if (_f) {
        fprintf(_f, "frame%d ", Parameter.iFrameIDTransm);
        (*pbiFACData).ResetBitAccess();
        for (int _k = 0; _k < 6; _k++) fprintf(_f, "%02x ", (unsigned) (*pbiFACData).Separate(8));
        fprintf(_f, "\n");
        (*pbiFACData).ResetBitAccess();
        fclose(_f);
    }
}
/* ================================== */
'

# ---------------- DABMOT.cpp — dump MSC data group bytes ----
MOT="$QSSTV/src/drmtx/common/datadecoding/DABMOT.cpp"
patch_file "$MOT" after \
  'vecbiData.Enqueue(CRCObject.GetCRC(), 16);' \
'
/* ==== POTACAT INSTRUMENTATION ==== */
{
    static int _potacat_dg_idx = 0;
    FILE* _f = fopen("'"$DUMP_DIR"'/mot-data-groups.txt", "a");
    if (_f) {
        int _nbytes = iTotLenMOTObj / 8;
        fprintf(_f, "DG%d %s%d len=%d ",
            _potacat_dg_idx++, bHeader ? "H" : "B", iSegNum, _nbytes);
        vecbiData.ResetBitAccess();
        for (int _b = 0; _b < _nbytes; _b++) {
            unsigned by = 0;
            for (int _j = 0; _j < 8; _j++) by = (by << 1) | (vecbiData.Separate(1) & 1);
            fprintf(_f, "%02x ", by);
        }
        fprintf(_f, "\n");
        vecbiData.ResetBitAccess();
        fclose(_f);
    }
}
/* ================================== */
'

# ---------------- ConvEncoder.cpp — dump channel-bit stream ----
CONV="$QSSTV/src/drmtx/common/mlc/ConvEncoder.cpp"
patch_file "$CONV" before \
  '/* Return number of encoded bits */' \
'
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
/* ================================== */
'

# ---------------- OFDMCellMapping.cpp — dump full cell grid per symbol ----
OCM="$QSSTV/src/drmtx/common/ofdmcellmapping/OFDMCellMapping.cpp"
patch_file "$OCM" before \
  '/* Increase symbol-counter and wrap if needed */' \
'
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
/* ================================== */
'

echo
echo "Done. Next:"
echo "  cd $QSSTV && qmake && make -j\$(nproc)"
echo
echo "Then run a TX and check $DUMP_DIR/ for dumps."
