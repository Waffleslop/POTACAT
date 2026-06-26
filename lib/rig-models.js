'use strict';

/**
 * Radio model database — maps model name to capabilities, CW config,
 * CI-V addresses, ATU commands, filter tables, and quirks.
 *
 * Each entry:
 *   brand       — manufacturer name (for grouping in UI)
 *   protocol    — 'kenwood' | 'civ' | 'smartsdr' | 'rigctld'
 *   civAddr     — default CI-V address (Icom only, hex)
 *   connectDelay— ms to wait after serial port open before first command
 *   caps        — capability flags for rig control panel
 *   cw          — CW keying configuration for remote CW
 *   atuCmd      — ATU command variant: 'standard' | 'ft891' | 'ft450' | false
 *   filterType  — 'indexed' (Yaesu SH0) | 'direct' (Kenwood FW) | 'arbitrary' (Flex) | 'civ' | 'passband' | false
 *   maxPower    — max TX power in watts (for slider scaling)
 *   powerStep   — UI TX-power step in watts (defaults to 1)
 *   powerScale  — CAT PC unit scale; 10 means PC100 represents 10.0 W
 *   powerMap    — displayed watt value -> raw CAT PC value
 */

const RIG_MODELS = {
  // ── Icom ──────────────────────────────────────────────
  'IC-705': {
    brand: 'Icom', protocol: 'civ', civAddr: 0xA4,
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'civ', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, nrLevel: true, nbLevel: true, voxLevel: true, mon: true, monLevel: true, rit: true },
    cw: { text: 'civ', textChunk: 30, speed: 'civ', paddleKey: 'dtr', dtrPins: { dtr: true, rts: false }, taKey: false, breakIn: false },
    atuCmd: false, maxPower: 10,
  },
  'IC-706MKII': {
    brand: 'Icom', protocol: 'civ', civAddr: 0x4E, connectDelay: 200,
    // 1996-era Icom — CI-V address 0x4E (the MkIIG below moved to 0x58).
    // Supports basic freq/mode set/read plus a useful chunk of the 0x16
    // function family: NB 16-22, Preamp 16-02, Comp 16-44, VOX 16-46,
    // Tone 16-42, TSQL 16-43, BK-In 16-47. Mode set requires the 2-byte
    // form [mode, filter] like the IC-7100/7200/9100 (silent-drop on
    // 1-byte) — civ-codec already does this. AGC has Fast/Slow only
    // (no Off) via 16-12 sub. Filters are 01/02/03 via the Mode response
    // (Get 04 returns mode + filter byte). No internal ATU, no CI-V
    // CW message memory (0x17 send-CW arrived on the IC-7000), no
    // 0x14 level reads (so no RF-gain / TX-power sliders), no remote
    // power on/off. Older sibling of the MkIIG which adds 6m/2m/70cm.
    // Pre-DSP era — no NR/ANF (16-40 / 16-41 weren't in the firmware yet).
    // Attenuator works but uses 0x14 for "on" instead of the codec's
    // default 0x20 — civ-codec honors `attOnByte` from this entry.
    caps: { nb: true, atu: false, vfo: true, filter: true, filterType: 'civ', rfgain: false, txpower: false, power: false, preamp: true, att: true, comp: true, nr: false, anf: false, vox: true, agc: true, rit: true },
    attOnByte: 0x14,
    cw: { text: false, textChunk: 0, speed: false, paddleKey: false, dtrPins: null, taKey: false, breakIn: false },
    atuCmd: false, maxPower: 100,
  },
  'IC-706MKIIG': {
    brand: 'Icom', protocol: 'civ', civAddr: 0x58, connectDelay: 200,
    // Older Icom (1999-era) — CI-V supports basic freq/mode set/read but
    // not the level/function sub-commands used by newer rigs. No internal
    // ATU (FL-100-series IF filters are mechanical, switched via the
    // front-panel FILTER button), no CI-V CW message memory (the 0x17
    // send-CW command was introduced on the IC-7000), no remote power
    // on/off. Users wanting fuller control can fall back to rigctld
    // (hamlib backend ID 311 covers this rig). Same 0x16 function family
    // as the MkII above — Preamp, Comp, VOX, AGC fast/slow all work. No
    // NR/ANF (pre-DSP). Attenuator uses 0x14 not 0x20 — per-model
    // `attOnByte` override below.
    caps: { nb: true, atu: false, vfo: true, filter: true, filterType: 'civ', rfgain: false, txpower: false, power: false, preamp: true, att: true, comp: true, nr: false, anf: false, vox: true, agc: true, rit: true },
    attOnByte: 0x14,
    cw: { text: false, textChunk: 0, speed: false, paddleKey: false, dtrPins: null, taKey: false, breakIn: false },
    atuCmd: false, maxPower: 100,
  },
  'IC-7100': {
    brand: 'Icom', protocol: 'civ', civAddr: 0x88,
    caps: { nb: true, atu: false, vfo: true, filter: true, filterType: 'civ', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, nrLevel: true, nbLevel: true, voxLevel: true, mon: true, monLevel: true, rit: true },
    cw: { text: 'civ', textChunk: 30, speed: 'civ', paddleKey: false, dtrPins: null, taKey: false, breakIn: false },
    atuCmd: false, maxPower: 100,
  },
  'IC-7200': {
    brand: 'Icom', protocol: 'civ', civAddr: 0x76,
    // No internal ATU. Digital filter selection via CI-V. Single USB CI-V port
    // (no second virtual COM for DTR keying), so paddle-over-DTR is disabled.
    caps: { nb: true, atu: false, vfo: true, filter: true, filterType: 'civ', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, nrLevel: true, nbLevel: true, voxLevel: true, mon: true, monLevel: true, rit: true },
    cw: { text: 'civ', textChunk: 30, speed: 'civ', paddleKey: false, dtrPins: null, taKey: false, breakIn: false },
    atuCmd: false, maxPower: 100,
  },
  'IC-7300': {
    brand: 'Icom', protocol: 'civ', civAddr: 0x94,
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'civ', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, nrLevel: true, nbLevel: true, voxLevel: true, mon: true, monLevel: true, rit: true },
    cw: { text: 'civ', textChunk: 30, speed: 'civ', paddleKey: 'dtr', dtrPins: { dtr: true, rts: false }, taKey: false, breakIn: true },
    atuCmd: false, maxPower: 100,
  },
  'IC-7300 MK II': {
    brand: 'Icom', protocol: 'civ', civAddr: 0xB6,
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'civ', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, nrLevel: true, nbLevel: true, voxLevel: true, mon: true, monLevel: true, rit: true },
    cw: { text: 'civ', textChunk: 30, speed: 'civ', paddleKey: 'dtr', dtrPins: { dtr: true, rts: false }, taKey: false, breakIn: true },
    atuCmd: false, maxPower: 100,
  },
  'IC-7600': {
    brand: 'Icom', protocol: 'civ', civAddr: 0x7A,
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'civ', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, nrLevel: true, nbLevel: true, voxLevel: true, mon: true, monLevel: true, rit: true },
    cw: { text: 'civ', textChunk: 30, speed: 'civ', paddleKey: 'dtr', dtrPins: { dtr: true, rts: false }, taKey: false, breakIn: true },
    atuCmd: false, maxPower: 100,
  },
  'IC-7610': {
    brand: 'Icom', protocol: 'civ', civAddr: 0x98,
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'civ', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, nrLevel: true, nbLevel: true, voxLevel: true, mon: true, monLevel: true, rit: true },
    cw: { text: 'civ', textChunk: 30, speed: 'civ', paddleKey: 'dtr', dtrPins: { dtr: true, rts: false }, taKey: false, breakIn: true },
    atuCmd: false, maxPower: 100,
  },
  'IC-7851': {
    brand: 'Icom', protocol: 'civ', civAddr: 0x8E,
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'civ', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, nrLevel: true, nbLevel: true, voxLevel: true, mon: true, monLevel: true, rit: true },
    cw: { text: 'civ', textChunk: 30, speed: 'civ', paddleKey: 'dtr', dtrPins: { dtr: true, rts: false }, taKey: false, breakIn: true },
    atuCmd: false, maxPower: 200,
  },
  'IC-9700': {
    brand: 'Icom', protocol: 'civ', civAddr: 0xA2,
    caps: { nb: true, atu: false, vfo: true, filter: true, filterType: 'civ', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, nrLevel: true, nbLevel: true, voxLevel: true, mon: true, monLevel: true, rit: true },
    cw: { text: 'civ', textChunk: 30, speed: 'civ', paddleKey: 'dtr', dtrPins: { dtr: true, rts: false }, taKey: false, breakIn: false },
    atuCmd: false, maxPower: 100,
  },

  // ── Yaesu ─────────────────────────────────────────────
  'FT-450': {
    brand: 'Yaesu', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'indexed', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, rit: true },
    cw: { text: 'ky1', textChunk: 50, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: false },
    atuCmd: 'ft450', maxPower: 100,
  },
  'FT-710': {
    brand: 'Yaesu', protocol: 'kenwood', connectDelay: 300,
    // ATU remote tune works via AC003; (Tuner ACTIVATE) — confirmed to start
    // and run a full tune cycle from either OFF or ON state, with no AC001;
    // needed first (baumertjohn, issue #55, 2026-06; matches FLRIG
    // RIG_FT710::tune_rig case 2). The firmware rejects the documented AC002;
    // (Tuning Start) with "?;" and accepts AC011; without ever tuning — AC003;
    // is the correct trigger. AC000;=tuner off, AC001;=tuner on, AC003;=tune.
    // (Earlier the ATU button was hidden, v1.5.4, before AC003 was found.)
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'indexed', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, rit: true },
    // kyParam:'' produces "KY <text>;" — Yaesu's documented format where P1
    // is a SPACE character, not a digit. Default of 0 produced "KY0 <text>;"
    // which the FT-710 silently rejects. Kept for the rare case the user
    // doesn't have a CW key port wired (textMethod below is the preferred
    // path on this radio).
    //
    // textMethod:'dtr-key-port' — multiple FT-710 reports (Arch user 2026-04)
    // say the CAT KY+TX1 auto-key sequence enters TX but the internal keyer
    // never plays the buffered text, regardless of BK-IN setting / CAT
    // timeout. DTR keying via the CAT-2 port (USB Keying (CW) = DTR in the
    // radio menu) works reliably. When the user has a cwKeyPort configured,
    // sendCwTextToRadio generates morse locally and pulses DTR — same effect
    // as a hand-key on the CW jack.
    cw: { text: 'ky1', textChunk: 50, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: true, kyParam: '', textMethod: 'dtr-key-port' },
    // PTT stays on Yaesu's default TX1;/TX0;. An earlier patch flipped this
    // to MX1;/MX0; based on a user report claiming TX1; was rejected with
    // "?;" — that turned out to be a CAT-1 timeout artifact (10ms factory
    // default is too short, see notes below). MX1; keys the radio but does
    // not engage the CW keyer, so KY-buffered text never played out and the
    // user reported "goes into TX, no carrier". Reverted.
    atuCmd: 'ac003', maxPower: 100,
    notes: [
      '[FT-710] ATU remote tune uses AC003; (Tuner Activate) — runs a full tune cycle from either off or on. AC000; turns the tuner off.',
      '[FT-710] Set the radio menu OPERATION SETTING -> GENERAL -> CAT-1 TIME OUT TIMER to 1000 ms. The factory default of 10 ms is too short for round-trip CAT and causes spurious "?;" rejections.',
      '[FT-710] CW text-send uses DTR keying on the CAT-2 port. In Settings, set "CW Key Port" to your CAT-2 device (e.g. /dev/ttyUSB1 or COM<n+1>), and on the radio set OPERATION SETTING -> CAT/LINEAR/TUNER -> USB Keying (CW) = DTR. Without a CW key port, POTACAT falls back to the CAT KY command which is unreliable on this radio.',
    ],
  },
  'FT-817/818': {
    brand: 'Yaesu', protocol: 'kenwood',
    caps: { nb: false, atu: false, vfo: true, filter: false, filterType: false, rfgain: false, txpower: false, power: false },
    cw: { text: false, textChunk: 0, speed: false, paddleKey: false, dtrPins: null, taKey: false, breakIn: false },
    atuCmd: false, maxPower: 5,
  },
  'FT-857': {
    brand: 'Yaesu', protocol: 'kenwood',
    caps: { nb: false, atu: false, vfo: true, filter: false, filterType: false, rfgain: false, txpower: false, power: false },
    cw: { text: false, textChunk: 0, speed: false, paddleKey: false, dtrPins: null, taKey: false, breakIn: false },
    atuCmd: false, maxPower: 100,
  },
  'FT-891': {
    brand: 'Yaesu', protocol: 'kenwood',
    caps: { nb: true, nbLevel: true, atu: true, vfo: true, vfoCopy: true, filter: true, filterType: 'indexed', rfgain: true, afGain: true, txpower: true, power: true, preamp: true, attenuator: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, rit: true },
    cw: { text: 'ky1', textChunk: 50, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: false },
    atuCmd: 'ac002', minPower: 5, maxPower: 100, maxNbLevel: 10,
  },
  'FT-991/991A': {
    brand: 'Yaesu', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'indexed', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, rit: true },
    cw: { text: 'ky1', textChunk: 50, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'standard', maxPower: 100,
  },
  'FT-2000': {
    brand: 'Yaesu', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'indexed', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, rit: true },
    cw: { text: 'ky1', textChunk: 50, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'standard', maxPower: 200,
  },
  'FTDX3000': {
    brand: 'Yaesu', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'indexed', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, rit: true },
    cw: { text: 'ky1', textChunk: 50, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'ac002', minPower: 5, maxPower: 100,
  },
  'FTDX10': {
    brand: 'Yaesu', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'indexed', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, rit: true },
    cw: { text: 'ky1', textChunk: 50, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'ft891', maxPower: 100,
  },
  'FTDX101D/MP': {
    brand: 'Yaesu', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'indexed', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, rit: true },
    cw: { text: 'ky1', textChunk: 50, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: true, kyMode: 'km' },
    atuCmd: 'standard', maxPower: 200,
  },
  // FTX-1 Field — radio-validated against an actual FTX-1 by K3SBP 2026-05-29.
  // Shares CAT surface with the Optima below; differs in transmit power
  // budget. Native tuner start uses AC103; for the FTX-1 external tuner path.
  // FTX-1-specific caps: clarRx/clarTx/clarOffset (CF), monLevel (ML),
  // micGain (MG), dnrLevel (RL), breakIn (BI), breakInDelay
  // (SD), preampTarget (HF/50 vs VHF vs UHF independently).
  // FTX-1 power responses are model-prefixed (PC1xxx Field, PC2xxx Optima).
  // SWR/ALC are on RM6/RM4 instead of the generic Yaesu RM4/RM2. See PC and
  // RM handling in `lib/codecs/kenwood-codec.js` constructor + parsers.
  // (KF4YHC PR #39, both verified against real FTX-1 hardware.)
  'FTX-1 Field': {
    brand: 'Yaesu', protocol: 'kenwood', connectDelay: 300,
    caps: {
      nb: true, nbLevel: true, atu: true, vfo: true, vfoCopy: true,
      filter: true, filterType: 'indexed', rfgain: true, afGain: true,
      txpower: true, power: true, preamp: true, attenuator: true, att: true,
      comp: false, compLevel: false, nr: true, nrLevel: false, anf: true,
      vox: true, voxLevel: true, agc: true, rit: false,
      mon: true, monLevel: true, micGain: true,
      clarRx: true, clarTx: true, clarOffset: true,
      breakIn: true, breakInDelay: true,
      preampTarget: true, dnrLevel: true,
    },
    cw: { text: 'ky1', textChunk: 50, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: true, kyMode: 'km' },
    atuCmd: 'ac103', minPower: 1, maxPower: 10, powerStep: 1,
    // Field hardware testing confirms whole-watt CAT power values:
    // PC1001 -> 1W through PC1010 -> 10W. The front panel can also show
    // 0.5W, but no CAT payload for that half-watt setpoint is confirmed yet.
    powerChoices: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    powerMap: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10 },
    maxNbLevel: 10, maxDnrLevel: 10,
    agcModes: ['off', 'auto', 'fast', 'med', 'slow'],
    agcMap: { off: 0, fast: 1, med: 2, mid: 2, slow: 3, auto: 4 },
    preampTargets: ['hf50', 'vhf', 'uhf'],
    pcPrefix: 1, rmSwr: 6, rmAlc: 4, pollTxMetersAlways: true, powerPollEvery: 2,
    commands: {
      setNbOn: 'NL0001;', setNbOff: 'NL0000;', getNb: 'NL0;', setNbLevel: 'NL0{val:pad3};',
      setPower: 'PC1{val:pad3};',
      getRfGain: 'RG0;', getAgc: 'GT0;',
      setNoiseReductionOn: 'RL001;', setNoiseReductionOff: 'RL000;', getDnrLevel: 'RL0;', setDnrLevel: 'RL0{val:pad2};',
      getMicGain: 'MG;', getVox: 'VX;', getVoxLevel: 'VG;', getAutoNotch: 'BC0;',
      getMonitor: 'ML;', getClarState: 'CF000;', getClarOffset: 'CF001;',
    },
  },
  'FTX-1 Optima': {
    brand: 'Yaesu', protocol: 'kenwood', connectDelay: 300,
    caps: {
      nb: true, nbLevel: true, atu: true, vfo: true, vfoCopy: true,
      filter: true, filterType: 'indexed', rfgain: true, afGain: true,
      txpower: true, power: true, preamp: true, attenuator: true, att: true,
      comp: false, compLevel: false, nr: true, nrLevel: false, anf: true,
      vox: true, voxLevel: true, agc: true, rit: false,
      mon: true, monLevel: true, micGain: true,
      clarRx: true, clarTx: true, clarOffset: true,
      breakIn: true, breakInDelay: true,
      preampTarget: true, dnrLevel: true, antennaPort: true,
    },
    cw: { text: 'ky1', textChunk: 50, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: true, kyMode: 'km' },
    atuCmd: 'ac103', minPower: 5, maxPower: 100, maxNbLevel: 10, maxDnrLevel: 10,
    agcModes: ['off', 'auto', 'fast', 'med', 'slow'],
    agcMap: { off: 0, fast: 1, med: 2, mid: 2, slow: 3, auto: 4 },
    preampTargets: ['hf50', 'vhf', 'uhf'],
    pcPrefix: 2, rmSwr: 6, rmAlc: 4, pollTxMetersAlways: true, powerPollEvery: 2,
    commands: {
      setNbOn: 'NL0001;', setNbOff: 'NL0000;', getNb: 'NL0;', setNbLevel: 'NL0{val:pad3};',
      setPower: 'PC2{val:pad3};',
      getRfGain: 'RG0;', getAgc: 'GT0;',
      setNoiseReductionOn: 'RL001;', setNoiseReductionOff: 'RL000;', getDnrLevel: 'RL0;', setDnrLevel: 'RL0{val:pad2};',
      getMicGain: 'MG;', getVox: 'VX;', getVoxLevel: 'VG;', getAutoNotch: 'BC0;',
      getMonitor: 'ML;', getClarState: 'CF000;', getClarOffset: 'CF001;',
      setAntennaPort: 'EX030704{val};', getAntennaPort: 'EX030704;',
    },
  },

  // ── Kenwood ───────────────────────────────────────────
  'TS-2000': {
    brand: 'Kenwood', protocol: 'kenwood',
    // TS-2000 predates the RM1/RM2 meter-read extension that ships on the
    // TS-590 and later — polling RM1; returns ? (K4VL, 2026-04-23).
    caps: { nb: true, atu: true, vfo: true, filter: false, rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, rit: true },
    cw: { text: 'ky', textChunk: 24, speed: 'ks', paddleKey: 'ta', dtrPins: null, taKey: false, breakIn: false },
    atuCmd: 'standard', maxPower: 100,
    noSwr: true,
  },
  'TS-480': {
    brand: 'Kenwood', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'direct', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, rit: true },
    cw: { text: 'ky', textChunk: 24, speed: 'ks', paddleKey: 'ta', dtrPins: null, taKey: true, breakIn: false },
    atuCmd: 'standard', maxPower: 100,
  },
  'TS-590S/SG': {
    brand: 'Kenwood', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'direct', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, rit: true },
    cw: { text: 'ky', textChunk: 24, speed: 'ks', paddleKey: 'ta', dtrPins: null, taKey: true, breakIn: true },
    atuCmd: 'standard', maxPower: 100,
    // Data-send PTT: plain `TX;` keys the FRONT MIC; `TX1;` keys with the
    // REAR/ACC/USB data input. POTACAT only ever keys these rigs to send
    // computer audio (FT8/SSTV/voice macros), so the front-mic form transmits
    // dead air — the radio beeps and TX is silent. `RX;` stops TX regardless of
    // which TX form started it. (KF0WXX, TS-590S/SG, serial-logger-confirmed
    // 2026-06.) Same modern-Kenwood CAT generation → TS-890S/TS-990S share the
    // TX0/TX1 data-send convention; NOT applied to TS-2000 (predates it).
    commands: { setTransmitOn: 'TX1;' },
  },
  'TS-890S': {
    brand: 'Kenwood', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'direct', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, rit: true },
    cw: { text: 'ky', textChunk: 24, speed: 'ks', paddleKey: 'ta', dtrPins: null, taKey: true, breakIn: true },
    atuCmd: 'standard', maxPower: 200,
    commands: { setTransmitOn: 'TX1;' }, // data-send PTT (rear/USB audio) — see TS-590S/SG note
  },
  'TS-990S': {
    brand: 'Kenwood', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'direct', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, rit: true },
    cw: { text: 'ky', textChunk: 24, speed: 'ks', paddleKey: 'ta', dtrPins: null, taKey: true, breakIn: true },
    atuCmd: 'standard', maxPower: 200,
    commands: { setTransmitOn: 'TX1;' }, // data-send PTT (rear/USB audio) — see TS-590S/SG note
  },

  // ── Elecraft ──────────────────────────────────────────
  'K3/K3S': {
    brand: 'Elecraft', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'direct', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, rit: true },
    cw: { text: 'ky', textChunk: 24, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'standard', maxPower: 100,
    commands: { setDa: 'DT{val};' }, // Elecraft uses DT (not DA) for DATA mode
  },
  'K4/K4D': {
    brand: 'Elecraft', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'direct', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, rit: true },
    cw: { text: 'ky', textChunk: 24, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'standard', maxPower: 100,
    commands: { setDa: 'DT{val};' }, // Elecraft K4 uses DT (not DA) for DATA sub-mode
    digiMd: 6,                       // CatClient._digiMd override for the legacy TCP/serial path
    // K4 DATA modes: MD6=DATA, MD9=DATA-REV, DT0=DATA-A (for FT8/DIGU)
    modes: {
      'DIGU': { md: 6, da: 0 }, 'DIGL': { md: 9, da: 0 },
      'PKTUSB': { md: 6, da: 0 }, 'PKTLSB': { md: 9, da: 0 },
      'FT8': { md: 6, da: 0 }, 'FT4': { md: 6, da: 0 }, 'FT2': { md: 6, da: 0 },
    },
    modesParse: { 6: 'DIGU', 9: 'DIGL' }, // K4: MD6=DATA->DIGU, MD9=DATA-REV->DIGL
    noSwr: true, // K4 doesn't support RM1; (SWR read)
  },
  'KX2/KX3': {
    brand: 'Elecraft', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'direct', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, rit: true },
    cw: { text: 'ky', textChunk: 24, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'standard', maxPower: 15,
    commands: { setDa: 'DT{val};' }, // Elecraft uses DT (not DA) for DATA mode
  },

  // ── QRP Labs ──────────────────────────────────────────
  'QMX': {
    brand: 'QRP Labs', protocol: 'kenwood',
    caps: { nb: false, atu: false, vfo: false, filter: false, filterType: false, rfgain: false, txpower: false, power: false },
    cw: { text: 'ky', textChunk: 80, speed: 'ks', paddleKey: 'dtr', dtrPins: { dtr: true, rts: true }, taKey: false, breakIn: true },
    atuCmd: false, maxPower: 5, digiMd: 6, // QMX uses MD6 (RTTY) for DIGI/FT8 mode
    // QMX doesn't support DA command — override tune quirks
    tune: { modeBeforeFreq: true, modeAfterFreq: false, freqAfterMode: false, alwaysResendMode: false, daCommand: false },
    // Override commands: no DA, no VFO prefix (pure Kenwood)
    commands: { setDa: null },
  },
  'QDX': {
    brand: 'QRP Labs', protocol: 'kenwood',
    caps: { nb: false, atu: false, vfo: false, filter: false, filterType: false, rfgain: false, txpower: false, power: false },
    cw: { text: false, textChunk: 0, speed: false, paddleKey: false, dtrPins: null, taKey: false, breakIn: false },
    atuCmd: false, maxPower: 5, digiMd: 6,
    tune: { modeBeforeFreq: true, modeAfterFreq: false, freqAfterMode: false, alwaysResendMode: false, daCommand: false },
    commands: { setDa: null },
  },

  // ── Xiegu ─────────────────────────────────────────────
  'G90': {
    brand: 'Xiegu', protocol: 'kenwood',
    caps: { nb: false, atu: true, vfo: false, filter: false, filterType: false, rfgain: false, txpower: true, power: false },
    cw: { text: 'ky1', textChunk: 50, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: false },
    atuCmd: 'standard', maxPower: 20,
  },
  'X6100': {
    brand: 'Xiegu', protocol: 'kenwood',
    caps: { nb: false, atu: true, vfo: true, filter: false, filterType: false, rfgain: false, txpower: true, power: false },
    cw: { text: 'ky1', textChunk: 50, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: false },
    atuCmd: 'standard', maxPower: 10,
  },

  // ── FlexRadio ─────────────────────────────────────────
  'FLEX-6300': {
    brand: 'FlexRadio', protocol: 'smartsdr',
    caps: { nb: true, atu: true, vfo: false, filter: true, filterType: 'arbitrary', rfgain: true, txpower: true, power: false, preamp: false, att: false, comp: true, nr: true, anf: true, apf: true, vox: true, agc: true, nrLevel: true, nbLevel: true, voxLevel: true, mon: true, monLevel: true, rit: true, cwSidetone: true },
    cw: { text: 'smartsdr', textChunk: 64, speed: 'smartsdr', paddleKey: 'smartsdr', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'smartsdr', maxPower: 100,
  },
  'FLEX-6500': {
    brand: 'FlexRadio', protocol: 'smartsdr',
    caps: { nb: true, atu: true, vfo: false, filter: true, filterType: 'arbitrary', rfgain: true, txpower: true, power: false, preamp: false, att: false, comp: true, nr: true, anf: true, apf: true, vox: true, agc: true, nrLevel: true, nbLevel: true, voxLevel: true, mon: true, monLevel: true, rit: true, cwSidetone: true },
    cw: { text: 'smartsdr', textChunk: 64, speed: 'smartsdr', paddleKey: 'smartsdr', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'smartsdr', maxPower: 100,
  },
  'FLEX-6400/6400M': {
    brand: 'FlexRadio', protocol: 'smartsdr',
    caps: { nb: true, atu: true, vfo: false, filter: true, filterType: 'arbitrary', rfgain: true, txpower: true, power: false, preamp: false, att: false, comp: true, nr: true, anf: true, apf: true, vox: true, agc: true, nrLevel: true, nbLevel: true, voxLevel: true, mon: true, monLevel: true, rit: true, cwSidetone: true },
    cw: { text: 'smartsdr', textChunk: 64, speed: 'smartsdr', paddleKey: 'smartsdr', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'smartsdr', maxPower: 100,
  },
  'FLEX-6600/6600M': {
    brand: 'FlexRadio', protocol: 'smartsdr',
    caps: { nb: true, atu: true, vfo: false, filter: true, filterType: 'arbitrary', rfgain: true, txpower: true, power: false, preamp: false, att: false, comp: true, nr: true, anf: true, apf: true, vox: true, agc: true, nrLevel: true, nbLevel: true, voxLevel: true, mon: true, monLevel: true, rit: true, cwSidetone: true },
    cw: { text: 'smartsdr', textChunk: 64, speed: 'smartsdr', paddleKey: 'smartsdr', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'smartsdr', maxPower: 100,
  },
  'FLEX-8400/8600': {
    brand: 'FlexRadio', protocol: 'smartsdr',
    caps: { nb: true, atu: true, vfo: false, filter: true, filterType: 'arbitrary', rfgain: true, txpower: true, power: false, preamp: false, att: false, comp: true, nr: true, anf: true, apf: true, vox: true, agc: true, nrLevel: true, nbLevel: true, voxLevel: true, mon: true, monLevel: true, rit: true, cwSidetone: true },
    cw: { text: 'smartsdr', textChunk: 64, speed: 'smartsdr', paddleKey: 'smartsdr', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'smartsdr', maxPower: 100,
  },
  'FLEX Aurora': {
    brand: 'FlexRadio', protocol: 'smartsdr',
    caps: { nb: true, atu: true, vfo: false, filter: true, filterType: 'arbitrary', rfgain: true, txpower: true, power: false, preamp: false, att: false, comp: true, nr: true, anf: true, apf: true, vox: true, agc: true, nrLevel: true, nbLevel: true, voxLevel: true, mon: true, monLevel: true, rit: true, cwSidetone: true },
    cw: { text: 'smartsdr', textChunk: 64, speed: 'smartsdr', paddleKey: 'smartsdr', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'smartsdr', maxPower: 100,
  },
  'FLEX-6700': {
    brand: 'FlexRadio', protocol: 'smartsdr',
    caps: { nb: true, atu: true, vfo: false, filter: true, filterType: 'arbitrary', rfgain: true, txpower: true, power: false, preamp: false, att: false, comp: true, nr: true, anf: true, apf: true, vox: true, agc: true, nrLevel: true, nbLevel: true, voxLevel: true, mon: true, monLevel: true, rit: true, cwSidetone: true },
    cw: { text: 'smartsdr', textChunk: 64, speed: 'smartsdr', paddleKey: 'smartsdr', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'smartsdr', maxPower: 100,
  },
};

// Generic fallbacks for unknown models
const GENERIC_CAPS = {
  // txpower is on so RF power is polled (0x14 0x0A) for any Icom even when the
  // user picked the rig by CI-V address and we never resolved a specific model.
  // Without it, blank-power QSOs logged the default 100 W instead of the rig's
  // actual setting. Modern Icoms all answer 0x14 0x0A; a rig that can't (e.g.
  // IC-706MKIIG) is given txpower:false back via getActiveRigModel's per-model
  // power override. Other panel caps stay off — we don't claim untested Icom
  // controls from a generic fallback. (NA7C Ted)
  icom:    { brand: 'Icom',    protocol: 'civ',     civAddr: 0x94, caps: { nb: false, atu: false, vfo: false, filter: false, filterType: false, rfgain: false, txpower: true, power: true, rit: true }, cw: { text: 'civ', textChunk: 30, speed: 'civ', paddleKey: 'dtr', dtrPins: { dtr: true, rts: false }, taKey: false, breakIn: false }, atuCmd: false, maxPower: 100 },
  yaesu:   { brand: 'Yaesu',   protocol: 'kenwood', caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'indexed', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, rit: true }, cw: { text: 'ky1', textChunk: 50, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: false }, atuCmd: 'standard', maxPower: 100 },
  kenwood: { brand: 'Kenwood', protocol: 'kenwood', caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'direct', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, rit: true }, cw: { text: 'ky', textChunk: 24, speed: 'ks', paddleKey: 'ta', dtrPins: null, taKey: true, breakIn: false }, atuCmd: 'standard', maxPower: 100 },
  flex:    { brand: 'FlexRadio', protocol: 'smartsdr', caps: { nb: true, atu: true, vfo: false, filter: true, filterType: 'arbitrary', rfgain: true, txpower: true, power: false, preamp: false, att: false, comp: true, nr: true, anf: true, apf: true, vox: true, agc: true, nrLevel: true, nbLevel: true, voxLevel: true, mon: true, monLevel: true, rit: true, cwSidetone: true }, cw: { text: 'smartsdr', textChunk: 64, speed: 'smartsdr', paddleKey: 'smartsdr', dtrPins: null, taKey: false, breakIn: true }, atuCmd: 'smartsdr', maxPower: 100 },
  rigctld: { brand: 'Hamlib',  protocol: 'rigctld', caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'passband', rfgain: true, txpower: true, power: true, preamp: true, att: true, comp: true, nr: true, anf: true, vox: true, agc: true, nrLevel: true, nbLevel: true, voxLevel: true, mon: true, monLevel: true, rit: true }, cw: { text: false, textChunk: 0, speed: false, paddleKey: false, dtrPins: null, taKey: false, breakIn: false }, atuCmd: false, maxPower: 100 },
};

/**
 * Look up a radio model. Returns the model entry or a generic fallback.
 * @param {string} modelName — e.g. 'IC-7300', 'FT-891', etc.
 * @param {string} [fallbackType] — 'icom'|'yaesu'|'kenwood'|'flex'|'rigctld' for generic fallback
 */
function getModel(modelName, fallbackType) {
  if (modelName && RIG_MODELS[modelName]) return RIG_MODELS[modelName];
  if (fallbackType && GENERIC_CAPS[fallbackType]) return GENERIC_CAPS[fallbackType];
  return null;
}

/** Get sorted list of all model names, grouped by brand */
function getModelList() {
  const byBrand = {};
  for (const [name, info] of Object.entries(RIG_MODELS)) {
    const brand = info.brand || 'Other';
    if (!byBrand[brand]) byBrand[brand] = [];
    byBrand[brand].push(name);
  }
  // Sort brands, then models within each brand
  const sorted = [];
  for (const brand of Object.keys(byBrand).sort()) {
    byBrand[brand].sort();
    sorted.push({ brand, models: byBrand[brand] });
  }
  return sorted;
}

/**
 * Build tune quirk flags for a model based on brand/protocol.
 * Models can override these with an explicit `tune` property.
 */
function getTuneQuirks(model) {
  if (model.tune) return model.tune;
  const brand = (model.brand || '').toLowerCase();
  const proto = model.protocol;
  if (proto === 'civ') {
    // Icom: mode before + after freq (band stacking registers)
    return { modeBeforeFreq: true, modeAfterFreq: true, freqAfterMode: false, alwaysResendMode: false, daCommand: false };
  }
  if (proto === 'rigctld') {
    // rigctld: M,F,M,F sandwich (handles band-recall + CW pitch offset)
    return { modeBeforeFreq: true, modeAfterFreq: true, freqAfterMode: true, alwaysResendMode: false, daCommand: false };
  }
  if (brand === 'yaesu') {
    // Yaesu serial: always re-send mode after freq (band-recall), no DA command
    return { modeBeforeFreq: true, modeAfterFreq: true, freqAfterMode: false, alwaysResendMode: true, daCommand: false };
  }
  if (brand === 'elecraft') {
    // Elecraft: mode before + after freq (KX2/KX3/K3/K4 have per-band memory recall)
    return { modeBeforeFreq: true, modeAfterFreq: true, freqAfterMode: false, alwaysResendMode: false, daCommand: true };
  }
  // Kenwood/Xiegu: mode before freq, no post-freq re-send, DA for digital
  return { modeBeforeFreq: true, modeAfterFreq: false, freqAfterMode: false, alwaysResendMode: false, daCommand: true };
}

module.exports = { RIG_MODELS, GENERIC_CAPS, getModel, getModelList, getTuneQuirks };
