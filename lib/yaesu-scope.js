'use strict';

// The FT-710's own band scope, read over the USB cable it already uses.
//
// The radio exposes its spectrum through an FTDI FT4222 USB→SPI bridge on the
// main board. A small native helper (helpers/yaesu-scope/) opens that bridge
// and writes ALIGNED 4096-byte scope frames to stdout; everything that knows
// what the bytes MEAN lives here, in JavaScript, where it is unit-tested
// against fixtures and can be corrected without recompiling a binary. A
// capture from an operator's radio is literally `helper > capture.bin`, and
// replaying it is feeding the same bytes to YaesuScopeStream.
//
// Frame layout (VLSC write-up, mirrored from wfview; VERIFY against a real
// capture before trusting any offset):
//
//   0    .. 849    WF1 — 850 spectrum bins, main receiver
//   850  .. 1699   WF2 — 850 bins, second receiver (FT-710 has one; zeros)
//   2900 .. 3049   150 bytes of metadata (contents undocumented)
//   ...  .. 4095   sync padding: the four-byte pattern FF 01 EE 01, repeated
//
// Every spectrum byte is INVERTED on the wire: level = ~b & 0xFF.
//
// What the helper's stdout carries per frame:
//
//   'Y' 'S'  version(u8)  kind(u8)  seq(u32 LE)   then 4096 bytes
//
// kind 0 = live bridge, 1 = --synth (a generated test signal, no radio).
//
// CAT-side facts, from the FT-710 CAT Operation Reference Manual (2306-C),
// NOT from the write-ups — one of which named EX040101 as "enable scope
// output", and menu 04-01-01 on this radio is MY CALL:
//
//   EX030126;        read SCU-LAN10 (OPERATION SETTING > GENERAL > 26): 0 off, 1 on
//   EX0301261;       set it on — this is the switch that makes the bridge speak
//   SS05;  → SS05P3  span:  0=1k 1=2k 2=5k 3=10k 4=20k 5=50k 6=100k 7=200k 8=500k 9=1M
//   SS06;  → SS06P3  mode:  0/3/4 CENTER · 1/6/7 CURSOR · 2/9/A FIX
//   SS00;  → SS00P3  speed: 0..4 running, 5 = STOP (the picture freezes)

const { EventEmitter } = require('events');

const FRAME_BYTES = 4096;
const BINS = 850;
const WF1_OFFSET = 0;
const WF2_OFFSET = 850;
const META_OFFSET = 2900;
const META_BYTES = 150;
const SYNC = Buffer.from([0xff, 0x01, 0xee, 0x01]);
const HEADER_BYTES = 8;
const HEADER_MAGIC0 = 0x59; // 'Y'
const HEADER_MAGIC1 = 0x53; // 'S'
const HEADER_VERSION = 1;

const ScopeAxis = require('./scope-axis');
const { SPAN_HZ_BY_CODE, MODE_BY_CODE, SPEED_BY_CODE } = ScopeAxis;

// ─── The bytes ───────────────────────────────────────────────────────────────

/** True when a 4096-byte payload ends on the sync pattern (wfview's own test). */
function isFrameAligned(payload) {
  if (!payload || payload.length !== FRAME_BYTES) return false;
  return payload.subarray(FRAME_BYTES - 4).equals(SYNC);
}

/**
 * Decode one aligned scope frame.
 * @param {Buffer} payload - exactly 4096 bytes
 * @returns {{wf1: Uint8Array, wf2: Uint8Array, meta: Buffer, aligned: boolean}}
 */
function parseScopeFrame(payload) {
  if (!payload || payload.length !== FRAME_BYTES) {
    throw new Error(`scope frame must be ${FRAME_BYTES} bytes, got ${payload ? payload.length : 'nothing'}`);
  }
  const wf1 = new Uint8Array(BINS);
  const wf2 = new Uint8Array(BINS);
  for (let i = 0; i < BINS; i++) {
    wf1[i] = (~payload[WF1_OFFSET + i]) & 0xff;
    wf2[i] = (~payload[WF2_OFFSET + i]) & 0xff;
  }
  return {
    wf1,
    wf2,
    meta: Buffer.from(payload.subarray(META_OFFSET, META_OFFSET + META_BYTES)),
    aligned: isFrameAligned(payload),
  };
}

/**
 * Build a frame the way the radio would — the inverse of parseScopeFrame.
 * Tests and simulators use it; it is what makes the parser's contract
 * checkable without a radio in the room.
 * @param {{wf1?: ArrayLike<number>, wf2?: ArrayLike<number>, meta?: Buffer}} parts - LEVELS (not inverted)
 */
function buildScopeFrame(parts = {}) {
  const buf = Buffer.alloc(FRAME_BYTES, 0);
  const put = (src, off) => {
    for (let i = 0; i < BINS; i++) buf[off + i] = (~((src && src[i]) || 0)) & 0xff;
  };
  put(parts.wf1, WF1_OFFSET);
  put(parts.wf2, WF2_OFFSET);
  // Unused bytes between WF2 and the metadata are inverted zeros on the
  // wire too — leaving them 0 would look like a full-scale run of 0xFF once
  // inverted, which no radio produces.
  for (let i = WF2_OFFSET + BINS; i < META_OFFSET; i++) buf[i] = 0xff;
  if (parts.meta) Buffer.from(parts.meta).copy(buf, META_OFFSET, 0, META_BYTES);
  // Phase the pattern to the frame END, not to where the padding starts:
  // 3050 is not a multiple of four, and what the receiver checks is that the
  // last four bytes read FF 01 EE 01 exactly.
  for (let i = META_OFFSET + META_BYTES; i < FRAME_BYTES; i++) buf[i] = SYNC[i & 3];
  return buf;
}

/** Wrap a payload in the helper's stdout header. */
function frameHeader({ seq = 0, kind = 0 } = {}) {
  const h = Buffer.alloc(HEADER_BYTES);
  h[0] = HEADER_MAGIC0;
  h[1] = HEADER_MAGIC1;
  h[2] = HEADER_VERSION;
  h[3] = kind & 0xff;
  h.writeUInt32LE(seq >>> 0, 4);
  return h;
}

/**
 * Incremental reader for the helper's stdout. Feed it whatever chunks arrive;
 * it emits 'frame' with the decoded frame and its header, and recovers from a
 * torn stream by scanning forward to the next header. Frames that do not end
 * on the sync pattern are still emitted (flagged aligned:false) so the
 * diagnostics can count them; the drawing code decides whether to show them.
 *
 * Events: 'frame' ({seq, kind, wf1, wf2, meta, aligned}), 'resync' (bytes skipped)
 */
class YaesuScopeStream extends EventEmitter {
  constructor() {
    super();
    this._buf = Buffer.alloc(0);
    this.frames = 0;
    this.misaligned = 0;
    this.skipped = 0;
  }

  feed(chunk) {
    if (!chunk || !chunk.length) return;
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : Buffer.from(chunk);
    for (;;) {
      if (this._buf.length < HEADER_BYTES) return;
      if (this._buf[0] !== HEADER_MAGIC0 || this._buf[1] !== HEADER_MAGIC1 || this._buf[2] !== HEADER_VERSION) {
        const next = this._findHeader(1);
        const drop = next === -1 ? Math.max(0, this._buf.length - 2) : next;
        if (drop > 0) {
          this.skipped += drop;
          this.emit('resync', drop);
          this._buf = this._buf.subarray(drop);
        }
        if (next === -1) return;
        continue;
      }
      if (this._buf.length < HEADER_BYTES + FRAME_BYTES) return;
      const kind = this._buf[3];
      const seq = this._buf.readUInt32LE(4);
      const payload = this._buf.subarray(HEADER_BYTES, HEADER_BYTES + FRAME_BYTES);
      const frame = parseScopeFrame(payload);
      this.frames++;
      if (!frame.aligned) this.misaligned++;
      this._buf = this._buf.subarray(HEADER_BYTES + FRAME_BYTES);
      this.emit('frame', { seq, kind, ...frame });
    }
  }

  _findHeader(from) {
    for (let i = from; i + 2 < this._buf.length; i++) {
      if (this._buf[i] === HEADER_MAGIC0 && this._buf[i + 1] === HEADER_MAGIC1 && this._buf[i + 2] === HEADER_VERSION) return i;
    }
    return -1;
  }
}

// The axis maths, the CAT reply parsers and the small-screen downsampler live
// in lib/scope-axis.js so the pop-out and the web client run the same code.
const {
  parseSsReply, parseExReply, spanHzFromCode, modeFromCode, speedFromCode,
  scopeAxis, binToHz, hzToBin, downsampleBins, formatHz, formatSpan,
} = ScopeAxis;

// ─── The helper process ──────────────────────────────────────────────────────

const HELPER_EXIT = {
  0: { key: 'stopped',      severity: 'info',  headline: 'Scope helper stopped' },
  2: { key: 'no-library',   severity: 'blocker',
       headline: 'FTDI LibFT4222 is not installed',
       detail: 'POTACAT reads the FT-710 scope through FTDI\'s LibFT4222 driver library, which the radio\'s USB driver package does not include.',
       action: 'Install LibFT4222 from ftdichip.com (FT4222H Software Examples), then reopen the Band Scope.' },
  3: { key: 'no-device',    severity: 'blocker',
       headline: 'No FT4222 device found on USB',
       detail: 'The FT-710 shows up to the PC as an FTDI device named "FT4222 A" when its USB driver is installed and the radio is on.',
       action: 'Check the radio is powered on and on this USB port, and that the Yaesu FT-710 USB driver is installed.' },
  4: { key: 'spi-init',     severity: 'blocker',
       headline: 'The FT4222 bridge opened but would not initialise',
       detail: 'The device answered but refused SPI master setup. Another program (wfview, 710 Console) may be holding it.',
       action: 'Close other FT-710 scope programs, then reopen the Band Scope.' },
  5: { key: 'silent',       severity: 'blocker',
       headline: 'The bridge is open but the radio is sending nothing',
       detail: 'The FT-710 only streams scope data when SCU-LAN10 is ON in its menu (OPERATION SETTING > GENERAL > SCU-LAN10). You do not need the SCU-LAN10 box, only the setting.',
       action: 'Turn SCU-LAN10 on in the radio menu, or let POTACAT set it (EX0301261;).' },
  6: { key: 'read-error',   severity: 'error',
       headline: 'Lost the FT4222 bridge',
       detail: 'A read failed mid-stream — usually the USB cable or the radio power.',
       action: 'POTACAT will retry. If it keeps happening, reseat the USB cable.' },
  7: { key: 'no-sync',      severity: 'error',
       headline: 'Scope data arrived but never aligned',
       detail: 'Bytes are flowing but the frame sync pattern was not found. The protocol may differ from the one POTACAT knows (firmware or model).',
       action: 'Send a bug report — the log carries the first bytes seen.' },
};

/** Explain a helper exit code to an operator. Unknown codes are 'error'. */
function describeHelperExit(code, { signal = null } = {}) {
  if (signal) return { key: 'killed', severity: 'info', headline: `Scope helper stopped (${signal})` };
  const d = HELPER_EXIT[Number(code)];
  if (d) return { code: Number(code), ...d };
  return { code, key: 'unknown', severity: 'error', headline: `Scope helper exited with code ${code}`, detail: 'See the log for its last lines.' };
}

/** Whether an exit reason is worth an automatic restart. */
function helperExitIsTransient(code) {
  return Number(code) === 6;
}

function helperBinaryName(platform) {
  return platform === 'win32' ? 'yaesu-scope.exe' : 'yaesu-scope';
}

/**
 * Where to look for the helper binary, first match wins:
 *   1. an explicit settings.yaesuScopeHelperPath
 *   2. the packaged app's resources/bin/ (electron-builder extraResources)
 *   3. the dev checkout's assets/yaesu-scope/ (what the release workflow stages)
 *   4. the dev checkout's helpers/yaesu-scope/build/ (a local compile)
 */
function helperPathCandidates({ settings = {}, isPackaged = false, resourcesPath = '', appDir = '', platform = process.platform } = {}) {
  const path = require('path');
  const bin = helperBinaryName(platform);
  const list = [];
  if (settings.yaesuScopeHelperPath) list.push(String(settings.yaesuScopeHelperPath));
  if (isPackaged && resourcesPath) list.push(path.join(resourcesPath, 'bin', bin));
  if (appDir) {
    list.push(path.join(appDir, 'assets', 'yaesu-scope', bin));
    list.push(path.join(appDir, 'helpers', 'yaesu-scope', 'build', bin));
  }
  return list;
}

/**
 * Arguments for the helper. `fps` caps the frames it writes (the radio
 * produces ~30/s; the pop-out draws at 20 and ECHOCAT wants 10).
 */
function helperArgs({ fps = 20, synth = false } = {}) {
  const args = ['--fps', String(Math.max(1, Math.min(60, Math.round(fps))))];
  if (synth) args.push('--synth');
  return args;
}

module.exports = {
  FRAME_BYTES, BINS, META_BYTES, HEADER_BYTES, SYNC,
  SPAN_HZ_BY_CODE, MODE_BY_CODE, SPEED_BY_CODE, HELPER_EXIT,
  isFrameAligned, parseScopeFrame, buildScopeFrame, frameHeader,
  YaesuScopeStream, downsampleBins,
  parseSsReply, parseExReply, spanHzFromCode, modeFromCode, speedFromCode,
  scopeAxis, binToHz, hzToBin, formatHz, formatSpan,
  describeHelperExit, helperExitIsTransient, helperBinaryName, helperPathCandidates, helperArgs,
};
