'use strict';
/**
 * KenwoodCodec — ASCII semicolon-terminated protocol encoder/decoder.
 * Handles Kenwood, Yaesu, Elecraft, QRP Labs, Xiegu radios.
 *
 * Unlike the old CatClient, this codec has NO if(_isYaesu) branches.
 * All Yaesu vs Kenwood differences are encoded in the model's `commands`
 * and `modes` tables. The codec just expands templates.
 */
const { EventEmitter } = require('events');

// Default command tables — used when model doesn't define explicit commands.
// Built from brand+protocol to provide backward compatibility.
const KENWOOD_DEFAULTS = {
  faDigits: 11,
  getFreq: 'FA;',
  setFreq: 'FA{freq:pad11};',
  getMode: 'MD;',
  setMode: 'MD{mode};',
  setTransmitOn: 'TX;',
  setTransmitOff: 'RX;',
  setNbOn: 'NB1;',
  setNbOff: 'NB0;',
  getNb: 'NB;',
  getSmeter: 'SM;',
  setRfGain: 'RG{val:pad3};',
  setSquelch: 'SQ0{val:pad3};', // FM squelch, main RX (0-100)
  getPower: 'PC;',
  setPower: 'PC{val:pad3};',
  getFilter: null,
  setFilter: 'FW{val:pad4};',
  setVfoA: 'FR0;',
  setVfoB: 'FR1;',
  swapVfo: null,
  setSplit: 'FT1;',
  setSplitOff: 'FT0;',
  setDa: 'DA{val};',
  setPowerOn: 'PS1;',
  setPowerOff: 'PS0;',
  // Extended controls
  setNbLevel: 'NL{val:pad3};',
  setAfGain: 'AG{val:pad3};',
  setPreampOn: 'PA1;',
  setPreampOff: 'PA0;',
  setAttenuatorOn: 'RA1;',
  setAttenuatorOff: 'RA0;',
  vfoCopyAB: null,           // not standard Kenwood
  vfoCopyBA: null,
};

const YAESU_DEFAULTS = {
  faDigits: 9,
  getFreq: 'FA;',
  setFreq: 'FA{freq:pad9};',
  getMode: 'MD0;',
  setMode: 'MD0{mode:hexU};',
  setTransmitOn: 'TX1;',
  setTransmitOff: 'TX0;',
  getPtt: 'TX;',
  setNbOn: 'NB01;',
  setNbOff: 'NB00;',
  getNb: 'NB0;',
  getSmeter: 'SM0;',
  setRfGain: 'RG0{val:pad3};',
  setSquelch: 'SQ0{val:pad3};', // FM squelch, P1=0 main RX (000-100)
  getPower: 'PC;',
  setPower: 'PC{val:pad3};',
  getFilter: null,
  setFilter: 'SH01{val:pad2};',
  setVfoA: 'VS0;',
  setVfoB: 'VS1;',
  swapVfo: 'SV;',
  setSplit: 'ST1;',
  setSplitOff: 'ST0;',
  setDa: null, // Yaesu uses dedicated MD codes, no DA command
  setPowerOn: 'PS1;',
  setPowerOff: 'PS0;',
  // Extended controls
  setNbLevel: 'NL0{val:pad3};',
  setAfGain: 'AG0{val:pad3};',
  setPreampOn: 'PA01;',
  setPreampOff: 'PA00;',
  setAttenuatorOn: 'RA01;',
  setAttenuatorOff: 'RA00;',
  vfoCopyAB: 'AB;',
  vfoCopyBA: 'BA;',
};

// Default mode tables
const KENWOOD_MODES = {
  'LSB':  { md: 1, da: 0 },
  'USB':  { md: 2, da: 0 },
  'CW':   { md: 3 },
  'FM':   { md: 4, da: 0 },
  'AM':   { md: 5, da: 0 },
  'RTTY': { md: 6 },
  'DIGU': { md: 2, da: 1 },
  'DIGL': { md: 1, da: 1 },
  'PKTUSB': { md: 2, da: 1 },
  'PKTLSB': { md: 1, da: 1 },
  'FT8':  { md: 2, da: 1 },
  'FT4':  { md: 2, da: 1 },
  'FT2':  { md: 2, da: 1 },
  'SSB':  null, // resolved at runtime via ssbSideband
};

const YAESU_MODES = {
  'LSB':  { md: 1 },
  'USB':  { md: 2 },
  'CW':   { md: 3 },
  'FM':   { md: 4 },
  'AM':   { md: 5 },
  'RTTY': { md: 6 },
  'DIGU': { md: 0xC },
  'DIGL': { md: 8 },
  'PKTUSB': { md: 0xC },
  'PKTLSB': { md: 8 },
  'FT8':  { md: 0xC },
  'FT4':  { md: 0xC },
  'FT2':  { md: 0xC },
  'SSB':  null,
};

// Mode parse tables (wire value -> POTACAT mode name)
const KENWOOD_MODE_PARSE = {
  1: 'LSB', 2: 'USB', 3: 'CW', 4: 'FM', 5: 'AM', 6: 'RTTY', 7: 'CW', 9: 'DIGU',
};

const YAESU_MODE_PARSE = {
  1: 'LSB', 2: 'USB', 3: 'CW', 4: 'FM', 5: 'AM', 6: 'RTTY', 7: 'CW',
  8: 'DIGL', 9: 'DIGU',
  0xA: 'FM', 0xB: 'FM', 0xC: 'DIGU', 0xD: 'AM', 0xE: 'FM',
};

// Yaesu SH0 bandwidth tables
const YAESU_SSB_BW = [200,400,600,850,1100,1350,1500,1650,1800,1950,2100,2250,2400,2500,2600,2700,2800,2900,3000,3200,3600];
const YAESU_CW_BW  = [50,100,150,200,250,300,350,400,450,500,600,800,1000,1200,1500,2400];

function ssbSideband(freqHz) {
  // 60m (≈5.25–5.45 MHz) is USB by convention/regulation despite being below
  // 10 MHz — channelized band, USB mandated worldwide. Everything else: LSB
  // below 10 MHz, USB at/above.
  if (freqHz >= 5250000 && freqHz < 5450000) return 'USB';
  return freqHz >= 10000000 ? 'USB' : 'LSB';
}

function yaesuBwToIndex(hz, mode) {
  // Yaesu DATA modes (DIGU, DIGL, RTTY) use the same SH0 index table as CW
  const m = (mode || '').toUpperCase();
  const useCwTable = m === 'CW' || m === 'CW-R' || m === 'DIGU' || m === 'DIGL' ||
    m === 'RTTY' || m === 'RTTY-R' || m === 'PKTUSB' || m === 'PKTLSB' || m === 'DATA';
  const table = useCwTable ? YAESU_CW_BW : YAESU_SSB_BW;
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < table.length; i++) {
    const d = Math.abs(table[i] - hz);
    if (d < bestDist) { bestDist = d; best = i + 1; } // 1-based
  }
  return best;
}

/**
 * Expand a command template with variables.
 * {freq:pad9} -> zero-pad to 9 digits
 * {val:pad3}  -> zero-pad to 3 digits
 * {mode:hexU} -> uppercase hex digit
 * {mode}      -> plain toString
 * {val}       -> plain toString
 */
function expand(template, vars) {
  if (!template) return null;
  return template.replace(/\{(\w+)(?::(\w+))?\}/g, (_, name, fmt) => {
    const v = vars[name];
    if (v == null) return '';
    if (fmt && fmt.startsWith('pad')) {
      const width = parseInt(fmt.slice(3), 10);
      return String(Math.round(v)).padStart(width, '0');
    }
    if (fmt === 'hexU') return v.toString(16).toUpperCase();
    return String(v);
  });
}

// ATU command sequences
// Different Yaesu generations interpret AC differently — keep this table in
// sync with lib/codecs/rigctld-codec.js so direct-serial and rigctld users
// behave identically.
const ATU_SEQUENCES = {
  'ft891':    [{ cmd: 'AC001;', delay: 0 }, { cmd: 'AC002;', delay: 300 }],
  'ac002':    [{ cmd: 'AC002;', delay: 0 }],
  'ac003':    [{ cmd: 'AC003;', delay: 0 }], // FT-710 Tuner Activate — tunes from off or on, no AC001 first (baumertjohn #55, 2026-06)
  'ac103':    [{ cmd: 'AC103;', delay: 0 }], // FTX-1 Optima (W9JL 2026-04-19)
  'standard': [{ cmd: 'AC011;', delay: 0 }],
  'ft450':    [{ cmd: 'AC011;', delay: 0 }],
};

class KenwoodCodec extends EventEmitter {
  /**
   * @param {object} model — rig model entry from rig-models.js
   * @param {function} writeFn — function to write data to transport
   */
  constructor(model, writeFn) {
    super();
    this._model = model;
    this._write = writeFn;

    // Resolve command table: model.commands > brand defaults
    const isYaesu = model.brand === 'Yaesu';
    const defaults = isYaesu ? YAESU_DEFAULTS : KENWOOD_DEFAULTS;
    this._cmds = Object.assign({}, defaults, model.commands || {});
    this._defaultCmds = Object.assign({}, this._cmds); // snapshot before overrides

    // Resolve mode table
    const defaultModes = isYaesu ? YAESU_MODES : KENWOOD_MODES;
    this._modes = Object.assign({}, defaultModes, model.modes || {});

    // Resolve mode parse table
    const defaultParse = isYaesu ? YAESU_MODE_PARSE : KENWOOD_MODE_PARSE;
    this._modeParse = Object.assign({}, defaultParse, model.modesParse || {});

    // Rig-model overrides for digital modes (e.g. QMX uses MD6)
    this._digiMd = model.digiMd || null;

    // Power limits
    this._minPower = model.minPower || 0;
    this._maxPower = model.maxPower || 100;
    this._powerScale = model.powerScale || 1;
    this._powerDecimals = model.powerDecimals != null
      ? model.powerDecimals
      : (this._powerScale > 1 ? 1 : 0);
    this._powerMap = model.powerMap || null;
    this._powerReverseMap = null;
    if (this._powerMap) {
      this._powerReverseMap = {};
      for (const [watts, raw] of Object.entries(this._powerMap)) {
        this._powerReverseMap[String(raw)] = Number(watts);
      }
    }

    // ATU sequence
    this._atuCmd = model.atuCmd || 'standard';

    // Response parser state
    this._buf = '';
    this._lastParsedMode = null;
    this._lastFreqHz = 0;
    this._faDigits = this._cmds.faDigits || (isYaesu ? 9 : 11);

    // RM meter channel assignments differ by brand (verified against manuals):
    //   Kenwood (TS-590/890/990):  RM1=SWR, RM3=ALC
    //   Yaesu (FT-991A/710/FTDX10): RM2=ALC, RM4=SWR
    //   Yaesu FTX-1:                RM4=ALC, RM6=SWR (per-model override)
    // Wrong channel = reads back garbage or the wrong meter. (KO4WIL on FT-991A,
    // Hitman90210 KF4YHC on FTX-1 PR #39)
    this._rmSwr = (model.rmSwr != null) ? model.rmSwr : (isYaesu ? 4 : 1);
    this._rmAlc = (model.rmAlc != null) ? model.rmAlc : (isYaesu ? 2 : 3);

    // Meter scaling to the app's de-facto wire scale (set by SmartSDR and the
    // Yaesu 0-255 meters): S-meter S9=120 / full≈255, SWR raw such that
    // ratio = 1 + raw/60, ALC 0-255. Real Kenwoods report SM 0-30 (S9=15)
    // and RM 0-30, which every consumer (desktop meter box, web remote,
    // phone) then renders ~8x low — the TS-480 report: "S-meter/PWR much
    // less than the original, SWR doesn't show anything". Scaling at the
    // parse fixes all three UIs at once. Per-model fields override the
    // brand default (TS-890/990 meter is 0-70, S9=35); non-Kenwood brands
    // pass through untouched unless the model opts in (Yaesu is already
    // 0-255; Elecraft et al. unmeasured).
    const isKenwood = model.brand === 'Kenwood';
    this._smS9   = (model.smS9   != null) ? model.smS9   : (isKenwood ? 15 : null);
    this._rmFull = (model.rmFull != null) ? model.rmFull : (isKenwood ? 30 : null);
    // RM payload width differs by brand: Yaesu answers 3 digits (0-255, and
    // the FTX-1 appends extra non-value fields — PR #39 added the 3-digit
    // clamp for that), but Kenwood answers 4 digits (RM10015; = 15). The
    // unconditional 3-digit clamp truncated Kenwood readings to a tenth
    // (15 -> "001") — the third reason the TS-480's SWR read as nothing.
    this._rmYaesuClamp = isYaesu;

    // Yaesu FTX-1 power responses are model-prefixed: `PC1xxx;` (Field) or
    // `PC2xxx;` (Optima). Parse strips the prefix when set. (KF4YHC PR #39)
    this._pcPrefix = model.pcPrefix != null ? String(model.pcPrefix) : null;

    // FTX-1 clarifier state — RX/TX enable flags are written together as a
    // CF state command (`CF000<rx><tx>000;`); track both so a single-side
    // toggle preserves the other side's enabled state.
    this._clarRx = false;
    this._clarTx = false;
  }

  // --- Command generation ---

  setFrequency(hz) {
    const cmd = expand(this._cmds.setFreq, { freq: hz });
    if (cmd) this._write(cmd);
  }

  getFrequency() {
    if (this._cmds.getFreq) this._write(this._cmds.getFreq);
  }

  /**
   * Set mode. Resolves SSB -> USB/LSB, handles digiMd override and DA command.
   * @returns {object|null} the resolved mode mapping (for tune sequencing)
   */
  setMode(modeName, freqHz) {
    const resolved = this.resolveMode(modeName, freqHz);
    if (!resolved) return null;

    // Kenwood data mode: DA0 must come BEFORE MD when exiting data mode,
    // otherwise the radio stays in USB-D/LSB-D. When entering data mode,
    // MD comes first then DA1 to activate it.
    if (resolved.da === 0 && this._cmds.setDa) {
      this._write(expand(this._cmds.setDa, { val: 0 }));
    }

    const mdCmd = expand(this._cmds.setMode, { mode: resolved.md });
    if (mdCmd) this._write(mdCmd);

    if (resolved.da === 1 && this._cmds.setDa) {
      this._write(expand(this._cmds.setDa, { val: 1 }));
    }
    return resolved;
  }

  getMode() {
    if (this._cmds.getMode) this._write(this._cmds.getMode);
  }

  // Physical PTT poll (Yaesu `TX;`). When the rig reports >0 we emit 'ptt'
  // so the host can swap to TX-side meters even on a hand-mic / footswitch
  // / external-keyer transmit. (KF4YHC PR #39)
  getPtt() {
    if (this._cmds.getPtt) this._write(this._cmds.getPtt);
  }

  /**
   * Resolve a POTACAT mode name to wire values.
   * Handles SSB -> USB/LSB, digiMd override.
   */
  resolveMode(modeName, freqHz) {
    let m = (modeName || '').toUpperCase();
    if (m === 'SSB') m = ssbSideband(freqHz);

    let mapping = this._modes[m];
    if (!mapping) return null;

    // Rig-model override: QMX uses MD6 for all digital modes.
    // Only trigger when da=1 (data mode ON), not da=0 (data mode OFF = voice/CW).
    if (this._digiMd != null && mapping.da === 1) {
      return { md: this._digiMd };
    }

    return mapping;
  }

  /** Get the parsed mode name for a mode mapping (for change detection) */
  modeNameForMapping(mapping) {
    if (!mapping) return null;
    return this._modeParse[mapping.md] || null;
  }

  setTransmit(on) {
    const cmd = on ? this._cmds.setTransmitOn : this._cmds.setTransmitOff;
    if (cmd) this._write(cmd);
  }

  setNb(on) {
    const cmd = on ? this._cmds.setNbOn : this._cmds.setNbOff;
    if (cmd) this._write(cmd);
  }

  getNb() {
    if (this._cmds.getNb) this._write(this._cmds.getNb);
  }

  getSmeter() {
    if (this._cmds.getSmeter) this._write(this._cmds.getSmeter);
  }

  getSwr() {
    this._write(`RM${this._rmSwr};`);
  }

  getAlc() {
    this._write(`RM${this._rmAlc};`);
  }

  setRfGain(pct) {
    const scaled = Math.max(0, Math.min(255, Math.round(pct * 2.55)));
    const cmd = expand(this._cmds.setRfGain, { val: scaled });
    if (cmd) this._write(cmd);
  }

  getRfGain() {
    if (this._cmds.getRfGain) this._write(this._cmds.getRfGain);
  }

  setSquelch(pct) {
    // SQ takes a 0-100 value directly (three digits) — NOT the 0-255 scaling
    // RG uses. Pass the app-level percent straight through.
    const val = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    const cmd = expand(this._cmds.setSquelch, { val });
    if (cmd) this._write(cmd);
  }

  setTxPower(watts) {
    const numeric = Number(watts);
    if (!Number.isFinite(numeric)) return;
    const clamped = Math.max(this._minPower, Math.min(this._maxPower, numeric));
    const rounded = Math.round(clamped);
    const encoded = this._powerMap && this._powerMap[rounded] != null
      ? this._powerMap[rounded]
      : Math.round(clamped * this._powerScale);
    const cmd = expand(this._cmds.setPower, { val: encoded });
    if (cmd) this._write(cmd);
  }

  getPower() {
    if (this._cmds.getPower) this._write(this._cmds.getPower);
  }

  setFilterWidth(hz) {
    const filterType = this._model.caps?.filterType || this._cmds.filterType;
    if (filterType === 'indexed') {
      const mode = this._lastParsedMode || '';
      const idx = yaesuBwToIndex(hz, mode);
      const cmd = expand(this._cmds.setFilter, { val: idx });
      if (cmd) this._write(cmd);
    } else if (filterType === 'direct') {
      const cmd = expand(this._cmds.setFilter, { val: hz });
      if (cmd) this._write(cmd);
    }
  }

  setVfo(vfo) {
    const cmd = (vfo || 'A').toUpperCase() === 'B' ? this._cmds.setVfoB : this._cmds.setVfoA;
    if (cmd) this._write(cmd);
  }

  swapVfo() {
    if (this._cmds.swapVfo) this._write(this._cmds.swapVfo);
  }

  setSplit(on) {
    const cmd = on ? this._cmds.setSplit : this._cmds.setSplitOff;
    if (cmd) this._write(cmd);
  }

  /** Set TX CLAR (XIT) using native Yaesu XT/RU/RD commands.
   *  hz > 0: enable + offset up.  hz < 0: enable + offset down.  hz === 0: disable. */
  setXit(hz) {
    if (!hz) {
      this._write('XT0;'); // TX CLAR off
      return;
    }
    this._write('XT1;'); // TX CLAR on
    this._write('RC;');  // reset to zero
    const abs = String(Math.min(9999, Math.abs(Math.round(hz)))).padStart(4, '0');
    this._write((hz > 0 ? 'RU' : 'RD') + abs + ';');
  }

  setPowerState(on) {
    const cmd = on ? this._cmds.setPowerOn : this._cmds.setPowerOff;
    if (!cmd) return;
    this._write(cmd);
    // Yaesu standby-wake retry: when the rig is in standby, the CAT
    // UART is in low-power state. The first PS1; byte wakes the UART
    // buffer but is often discarded as part of the wake transition,
    // which is why a single-send Power-On worked ~50% of the time.
    // Send a second PS1; after 500ms so it lands in a now-awake
    // buffer. Hamlib's newcat backend does the same dance for the
    // FT-710 / FT-991A / FT-891 family. KB2UXB FT-710 2026-06-09.
    //
    // Only retry on power-ON. Power-OFF doesn't need it (the rig is
    // already on, UART is awake, first command always lands). Retry
    // is harmless on Kenwood (rig already on after first PS1; second
    // is a no-op).
    if (on) {
      this.emit('log', `setPowerState ON: first ${cmd} sent — waking UART…`);
      setTimeout(() => {
        if (this._write) {
          this._write(cmd);
          this.emit('log', `setPowerState ON: second ${cmd} sent (wake retry)`);
        }
      }, 500);
    }
  }

  /** Returns array of { cmd, delay } for ATU tune sequence */
  getAtuStartSequence() {
    return ATU_SEQUENCES[this._atuCmd] || ATU_SEQUENCES['standard'];
  }

  getAtuStopCmd() {
    return 'AC000;';
  }

  // Direct ATU methods (used by RigController as fallback if getAtuStartSequence returns null).
  // Honor the model's atuCmd preset rather than hardcoding AC011 — fixes FT-891-
  // family radios via direct serial (DA2PK FT-710 silent ATU report).
  startTune() {
    const seq = ATU_SEQUENCES[this._atuCmd] || ATU_SEQUENCES['standard'];
    this.emit('log', `ATU start (variant=${this._atuCmd}): ${seq.map(s => s.cmd).join(' then ')}`);
    let delay = 0;
    for (const step of seq) {
      delay += step.delay || 0;
      if (delay === 0) this._write(step.cmd);
      else setTimeout(() => this._write(step.cmd), delay);
    }
  }
  stopTune() {
    this.emit('log', 'ATU stop: AC000;');
    this._write('AC000;');
  }

  sendCwText(text) {
    // Handled by rig-controller based on model.cw config
    // This is just the protocol-level send
    const clean = text.toUpperCase().replace(/[^A-Z0-9 /?.=,\-[\]_<>#%\\]/g, '');
    const cw = this._model.cw || {};
    const chunk = cw.textChunk || 24;

    if (cw.kyMode === 'km') {
      // FTDX101D: write to memory 5 via KM, play back via KYA
      let frames = 0;
      for (let i = 0; i < clean.length; i += chunk) {
        const part = clean.substring(i, i + chunk);
        this.emit('log', `CW write KM frame #${++frames}: KM5${part}; then KYA;`);
        this._write(`KM5${part};`);
        this._write('KYA;');
      }
    } else if (cw.text === 'ky1') {
      // Yaesu KY format: KY<P1> <text>; — no padding (spaces are transmitted as CW gaps)
      const p1 = cw.kyParam != null ? cw.kyParam : 0;
      let frames = 0;
      for (let i = 0; i < clean.length; i += 48) {
        const part = clean.substring(i, i + 48);
        this.emit('log', `CW write KY1 frame #${++frames}: KY${p1} ${part};`);
        this._write(`KY${p1} ${part};`);
      }
    } else {
      // Kenwood KY format: KY <text>;
      let frames = 0;
      for (let i = 0; i < clean.length; i += chunk) {
        const part = clean.substring(i, i + chunk).padEnd(chunk, ' ');
        this.emit('log', `CW write KY frame #${++frames}: KY ${part};`);
        this._write(`KY ${part};`);
      }
    }
  }

  setCwSpeed(wpm) {
    const clamped = Math.max(4, Math.min(60, Math.round(wpm)));
    this._write(`KS${String(clamped).padStart(3, '0')};`);
  }

  // --- Extended controls ---

  setNbLevel(val) {
    const max = this._model.maxNbLevel != null ? this._model.maxNbLevel : 100;
    const level = Math.max(0, Math.min(max, Math.round(Number(val) || 0)));
    const cmd = expand(this._cmds.setNbLevel, { val: level });
    if (cmd) this._write(cmd);
  }

  setAfGain(pct) {
    const scaled = Math.max(0, Math.min(255, Math.round(pct * 2.55)));
    const cmd = expand(this._cmds.setAfGain, { val: scaled });
    if (cmd) this._write(cmd);
  }

  setPreamp(on) {
    const cmd = on ? this._cmds.setPreampOn : this._cmds.setPreampOff;
    if (cmd) this._write(cmd);
  }

  setAttenuator(on) {
    const cmd = on ? this._cmds.setAttenuatorOn : this._cmds.setAttenuatorOff;
    if (cmd) this._write(cmd);
  }

  vfoCopyAB() {
    if (this._cmds.vfoCopyAB) this._write(this._cmds.vfoCopyAB);
  }

  vfoCopyBA() {
    if (this._cmds.vfoCopyBA) this._write(this._cmds.vfoCopyBA);
  }

  // --- FTX-1-class extended controls (Yaesu raw CAT) ---
  // Only valid for Yaesu rigs whose model.caps declares the matching cap.
  // Standard Yaesu command formats; validated against the FTX-1 by K3SBP
  // 2026-05-29 (see docs/ftx1-handoff.md). Kenwood radios use rigctld
  // levels (NB/NR/MIC etc.) so these are gated on isYaesu via the cap.

  setVox(on) {
    if (!this._isYaesu()) return;
    this._write(on ? 'VX1;' : 'VX0;');
  }

  getVox() {
    if (this._cmds.getVox) this._write(this._cmds.getVox);
  }

  setVoxLevel(pct) {
    if (!this._isYaesu()) return;
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    this._write(`VG${String(v).padStart(3, '0')};`);
  }

  getVoxLevel() {
    if (this._cmds.getVoxLevel) this._write(this._cmds.getVoxLevel);
  }

  // GT0<x>; — FTX-1 / FTDX-class AGC. 0=Auto, 1=Fast, 2=Mid, 3=Slow, 4=Off.
  setAgc(mode) {
    if (!this._isYaesu()) return;
    const map = this._model.agcMap || { auto: 0, fast: 1, med: 2, mid: 2, slow: 3, off: 4 };
    const v = map[(mode || '').toLowerCase()];
    if (v == null) return;
    this._write(`GT0${v};`);
  }

  getAgc() {
    if (this._cmds.getAgc) this._write(this._cmds.getAgc);
  }

  // Speech processor on/off (Yaesu PR), distinct from level.
  setCompressor(on) {
    if (!this._isYaesu()) return;
    const cmd = on ? this._cmds.setCompOn : this._cmds.setCompOff;
    this._write(cmd || (on ? 'PR1;' : 'PR0;'));
  }

  getCompressor() {
    if (this._cmds.getComp) this._write(this._cmds.getComp);
  }

  // Speech processor level (PL on FTX-1; FTDX-class radios share this).
  setCompLevel(pct) {
    if (!this._isYaesu()) return;
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    const cmd = expand(this._cmds.setCompLevel || 'PL{val:pad3};', { val: v });
    this._write(cmd);
  }

  getCompLevel() {
    if (this._cmds.getCompLevel) this._write(this._cmds.getCompLevel);
  }

  // DSP DNR level (FTX-1 'RL' — separate from NB 'NL').
  setDnrLevel(level) {
    if (!this._isYaesu()) return;
    const max = this._model.maxDnrLevel != null ? this._model.maxDnrLevel : 15;
    const min = this._model.maxDnrLevel != null ? 0 : 1;
    const v = Math.max(min, Math.min(max, Math.round(Number(level) || 0)));
    const cmd = expand(this._cmds.setDnrLevel || 'RL0{val:pad2};', { val: v });
    this._write(cmd);
  }

  getDnrLevel() {
    if (this._cmds.getDnrLevel) this._write(this._cmds.getDnrLevel);
  }

  // Monitor split-channel format (validated against FTX-1 by KF4YHC PR #39):
  //   ML0xxx; — channel 0 carries the enable bit (xxx = 001 on / 000 off)
  //   ML1xxx; — channel 1 carries the volume level (000-100)
  // Earlier interpretation collapsed both into ML0xxx with the level
  // doubling as the enable — that mis-reads the FTX-1 spec and produces
  // a moving level setting on every toggle. Channel-1 levels are independent.
  setMonitor(on) {
    if (!this._isYaesu()) return;
    this._write(on ? 'ML0001;' : 'ML0000;');
  }

  getMonitor() {
    if (this._cmds.getMonitor) this._write(this._cmds.getMonitor);
  }

  setMonLevel(pct) {
    if (!this._isYaesu()) return;
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    this._write(`ML1${String(v).padStart(3, '0')};`);
  }

  // Mic gain (MG) — 0..100.
  setMicGain(pct) {
    if (!this._isYaesu()) return;
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    this._write(`MG${String(v).padStart(3, '0')};`);
  }

  getMicGain() {
    if (this._cmds.getMicGain) this._write(this._cmds.getMicGain);
  }

  // FTX-1 clarifier (validated against real radio by KF4YHC PR #39).
  // The FTX-1 uses ONE multiplexed CF command instead of the RT/XT/CF triple
  // that older Yaesu rigs (FT-991/FTDX10) use:
  //   CF000<rx><tx>000;   — setting mode 0 toggles RX/TX enable together
  //   CF001<sign><pad4>;  — setting mode 1 writes the shared offset
  // Both RX and TX enable are sent together because the rig's setting-mode
  // 0 reply reports both bits in one frame — toggling one preserves the
  // other's state via the codec-side _clarRx/_clarTx flags.
  //
  // Earlier RT/XT/CF{sign}{4}; sequence was tried — FTX-1 rejects it.
  setClarRx(on) {
    if (!this._isYaesu()) return;
    this._clarRx = !!on;
    this._write(`CF000${this._clarRx ? '1' : '0'}${this._clarTx ? '1' : '0'}000;`);
  }

  setClarTx(on) {
    if (!this._isYaesu()) return;
    this._clarTx = !!on;
    this._write(`CF000${this._clarRx ? '1' : '0'}${this._clarTx ? '1' : '0'}000;`);
  }

  // CF001<sign><pad4>; — sign is '+' or '-', offset 0..9999 Hz.
  setClarOffset(hz) {
    if (!this._isYaesu()) return;
    const v = Math.max(-9999, Math.min(9999, Math.round(hz || 0)));
    const sign = v < 0 ? '-' : '+';
    this._write(`CF001${sign}${String(Math.abs(v)).padStart(4, '0')};`);
  }

  // Break-in on/off (BI).
  setBreakIn(on) {
    if (!this._isYaesu()) return;
    this._write(on ? 'BI1;' : 'BI0;');
  }

  getBreakIn() {
    if (this._cmds.getBreakIn) this._write(this._cmds.getBreakIn);
  }

  // Break-in delay (SD). Yaesu coded values:
  //   30ms=0001, 50ms=0002, 100ms=0003, 150ms=0004, 200ms=0005, 250ms=0006
  //   then 300..3000ms in 100ms steps mapping to 0007..0034.
  setBreakInDelay(ms) {
    if (!this._isYaesu()) return;
    const lo = [30, 50, 100, 150, 200, 250];
    let code;
    if (ms <= 30) code = 1;
    else if (ms < 300) {
      let best = 0, bestDist = Infinity;
      for (let i = 0; i < lo.length; i++) {
        const d = Math.abs(lo[i] - ms);
        if (d < bestDist) { bestDist = d; best = i + 1; }
      }
      code = best;
    } else {
      const steps = Math.max(0, Math.min(27, Math.round((ms - 300) / 100)));
      code = 7 + steps;
    }
    this._write(`SD${String(code).padStart(4, '0')};`);
  }

  // FTX-1 preamp targeting. The radio supports HF/50, VHF, UHF independently;
  // PA0/PA1/PA2 channel byte selects which front-end the command addresses.
  // PA0n; sets HF/50, PA1n; sets VHF, PA2n; sets UHF. n is 0=IPO, 1=AMP1,
  // 2=AMP2 (AMP2 only on HF/50; not yet exposed in the UI).
  setPreampTarget(target, level) {
    if (!this._isYaesu()) return;
    const chMap = { hf50: 0, vhf: 1, uhf: 2 };
    const ch = chMap[(target || '').toLowerCase()];
    if (ch == null) return;
    const maxLevel = ch === 0 ? 2 : 1;
    const v = Math.max(0, Math.min(maxLevel, Math.round(level || 0)));
    this._write(`PA${ch}${v};`);
  }

  // FTX-1 Optima HF antenna port select. Field does not declare this command.
  setAntennaPort(port) {
    if (!this._isYaesu() || !this._cmds.setAntennaPort) return;
    const val = Math.max(1, Math.min(2, Math.round(Number(port) || 1)));
    const cmd = expand(this._cmds.setAntennaPort, { val: val - 1, port: val });
    this._write(cmd);
  }

  getAntennaPort() {
    if (this._cmds.getAntennaPort) this._write(this._cmds.getAntennaPort);
  }

  // Standard RIT toggle — used independently of CLAR splits when the
  // caller treats RX clarifier as plain RIT.
  setRit(on) {
    if (!this._isYaesu()) return;
    this._write(on ? 'RT1;' : 'RT0;');
  }

  setNoiseReduction(on) {
    if (!this._isYaesu()) return;
    const cmd = on ? this._cmds.setNoiseReductionOn : this._cmds.setNoiseReductionOff;
    this._write(cmd || (on ? 'NR01;' : 'NR00;'));
  }

  setAutoNotch(on) {
    if (!this._isYaesu()) return;
    this._write(on ? 'BC01;' : 'BC00;');
  }

  getAutoNotch() {
    if (this._cmds.getAutoNotch) this._write(this._cmds.getAutoNotch);
  }

  setNrLevel(pct) {
    if (!this._isYaesu()) return;
    if (this._model.caps?.dnrLevel && !this._model.caps?.nrLevel) {
      this.setDnrLevel(pct);
      return;
    }
    // Yaesu RL: 1..15 depth scale. Map a 0..100 UI pct onto 1..15.
    const v = Math.max(1, Math.min(15, Math.round((pct / 100) * 15)));
    this._write(`RL0${String(v).padStart(2, '0')};`);
  }

  _isYaesu() {
    return this._model && this._model.brand === 'Yaesu';
  }

  sendRaw(text) {
    const cmd = text.replace(/[\r\n]/g, '').trim();
    if (cmd) this._write(cmd.endsWith(';') ? cmd : cmd + ';');
  }

  // --- Response parsing ---

  /**
   * Feed incoming data from transport. Parses semicolon-terminated messages.
   * Emits: 'frequency', 'mode', 'power', 'nb', 'error'
   */
  onData(chunk) {
    this._buf += chunk.toString();
    let idx;
    while ((idx = this._buf.indexOf(';')) !== -1) {
      const msg = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (msg) this._parseMessage(msg);
    }
    // Check for '?' error responses (no semicolon)
    while (this._buf.includes('?')) {
      const qIdx = this._buf.indexOf('?');
      const before = this._buf.slice(0, qIdx).trim();
      this._buf = this._buf.slice(qIdx + 1);
      this.emit('error', { message: `? (command error${before ? ' for: ' + before : ''})`, raw: before });
    }
  }

  _parseMessage(msg) {
    // Frequency: FA followed by digits
    if (msg.startsWith('FA') && msg.length > 2) {
      const digits = msg.slice(2);
      const hz = parseInt(digits, 10);
      if (!isNaN(hz) && hz > 0) {
        // Detect FA digit count (Yaesu=9, Kenwood=11)
        if (digits.length === 9 || digits.length === 11) {
          this._faDigits = digits.length;
        }
        this._lastFreqHz = hz;
        this.emit('frequency', hz);
      }
      return;
    }

    // Mode: MD followed by digits or MD0 followed by hex digit (Yaesu)
    if (msg.startsWith('MD')) {
      const payload = msg.slice(2);
      // Yaesu: MD0C (VFO selector + hex mode). Kenwood: MD2 (decimal mode)
      const mdVal = payload.length > 1
        ? parseInt(payload.slice(-1), 16)  // last char as hex
        : parseInt(payload, 10);
      const modeName = this._modeParse[mdVal];
      if (modeName) {
        this._lastParsedMode = modeName;
        this.emit('mode', modeName);
      }
      return;
    }

    // Power: PC followed by digits. FTX-1 prefixes the value with a model
    // byte (`PC1xxx;`/`PC2xxx;`) that other Yaesu rigs don't use; when the
    // model declares `pcPrefix`, strip it before parsing. Without this,
    // FTX-1 `PC2100;` is read as 2100W instead of 100W. (KF4YHC PR #39)
    if (msg.startsWith('PC') && msg.length > 2) {
      let payload = msg.slice(2);
      if (this._pcPrefix && payload.length > 1 && payload.charAt(0) === this._pcPrefix) {
        payload = payload.slice(1);
      }
      const rawWatts = parseInt(payload, 10);
      if (!isNaN(rawWatts)) {
        const watts = this._powerReverseMap && this._powerReverseMap[String(rawWatts)] != null
          ? this._powerReverseMap[String(rawWatts)]
          : rawWatts / this._powerScale;
        this.emit('power', Number(watts.toFixed(this._powerDecimals)));
      }
      return;
    }

    // Noise blanker: NB followed by 0/1 (Kenwood) or NB0 followed by 0/1 (Yaesu)
    if (msg.startsWith('NB')) {
      const last = msg.slice(-1);
      this.emit('nb', last === '1');
      return;
    }

    // FTX-1 noise blanker level: NL0xxx, where 000=off and 001..010=level.
    if (msg.startsWith('NL')) {
      const m = msg.match(/^NL\d?(\d{3})$/);
      if (m) {
        const level = parseInt(m[1], 10);
        if (!isNaN(level)) {
          this.emit('nbLevel', level);
          this.emit('nb', level > 0);
        }
      }
      return;
    }

    // RF gain: Yaesu RG0xxx (0..255 raw) / Kenwood RGxxx. Convert to UI percent.
    if (msg.startsWith('RG')) {
      const digits = msg.replace(/^RG0?/, '');
      const raw = parseInt(digits, 10);
      if (!isNaN(raw)) this.emit('rfgain', Math.max(0, Math.min(100, Math.round(raw / 2.55))));
      return;
    }

    // S-meter: SM followed by digits (Kenwood: SM0005, Yaesu: SM0128).
    // Rescaled to the S9=120 wire scale when the model declares a native
    // range (see constructor) — consumers assume S = val*9/120.
    if (msg.startsWith('SM')) {
      const digits = msg.replace(/^SM0?/, '');
      let val = parseInt(digits, 10) || 0;
      if (this._smS9) val = Math.round(val * 120 / this._smS9);
      this.emit('smeter', val);
      return;
    }

    // SWR/ALC meter — per-brand/per-model channel numbers (set in constructor).
    // Take only the first 3 digits after the channel byte; some rigs (notably
    // the FTX-1) append additional fields to a meter reply that aren't part of
    // the metered value. (KF4YHC PR #39)
    // Rescaled like SM: consumers assume SWR ratio = 1 + raw/60 (so native
    // full-scale maps to ~3:1) and ALC = raw/255.
    if (msg.startsWith('RM')) {
      const rmType = parseInt(msg.charAt(2), 10);
      // 3-digit clamp is Yaesu-only (see constructor) — Kenwood is 4-digit.
      const payload = (this._rmYaesuClamp && msg.length >= 6) ? msg.slice(3, 6) : msg.slice(3);
      const rmVal = parseInt(payload, 10) || 0;
      if (rmType === this._rmSwr) this.emit('swr', this._rmFull ? Math.round(rmVal * 120 / this._rmFull) : rmVal);
      else if (rmType === this._rmAlc) this.emit('alc', this._rmFull ? Math.round(rmVal * 255 / this._rmFull) : rmVal);
      return;
    }

    // Physical PTT polling — Yaesu `TX;` returns `TX<0|1|2>;` where >0 means
    // the radio is transmitting. Catches external-key / mic-PTT / footswitch
    // transmits the host didn't initiate. (KF4YHC PR #39)
    if (msg.startsWith('TX') && msg.length > 2) {
      const state = parseInt(msg.slice(2), 10);
      if (!isNaN(state)) this.emit('ptt', state > 0);
      return;
    }

    // FTX-1 clarifier response (KF4YHC PR #39).
    //   CF000<rx><tx>000;  — setting-mode 0 reply, both enable bits
    //   CF001<sign><pad4>; — setting-mode 1 reply, signed offset
    if (msg.startsWith('CF') && msg.length > 4) {
      const setMode = msg.charAt(4);
      if (setMode === '0' && msg.length >= 10) {
        this._clarRx = msg.charAt(5) === '1';
        this._clarTx = msg.charAt(6) === '1';
        this.emit('rit', this._clarRx);
        this.emit('txClar', this._clarTx);
        return;
      }
      if (setMode === '1' && msg.length >= 10) {
        const sign = msg.charAt(5);
        const raw = parseInt(msg.slice(6), 10);
        if (!isNaN(raw)) this.emit('clarFreq', sign === '-' ? -raw : raw);
        return;
      }
    }

    if (this._cmds.getAntennaPort && /^EX030704[01]$/.test(msg)) {
      this.emit('antennaPort', parseInt(msg.slice(-1), 10) + 1);
      return;
    }

    // FTX-1 DNR level: RL0xx, where 00=off and 01..10=level.
    if (msg.startsWith('RL')) {
      const m = msg.match(/^RL\d?(\d{2})$/);
      if (m) {
        const level = parseInt(m[1], 10);
        if (!isNaN(level)) {
          this.emit('dnrLevel', level);
          this.emit('nrLevel', level);
          this.emit('nr', level > 0);
        }
      }
      return;
    }

    // Speech processor state and level.
    if (msg.startsWith('PR')) {
      const raw = parseInt(msg.slice(2), 10);
      if (!isNaN(raw)) {
        this.emit('comp', raw > 0);
      }
      return;
    }

    if (msg.startsWith('PL')) {
      const level = parseInt(msg.slice(2), 10);
      if (!isNaN(level)) {
        const clamped = Math.max(0, Math.min(100, level));
        this.emit('compLevel', clamped);
      }
      return;
    }

    // AGC: reverse through the active model map so FTX-1 Auto/Off do not swap.
    if (msg.startsWith('GT')) {
      const raw = parseInt(msg.slice(-1), 10);
      const map = this._model.agcMap || { auto: 0, fast: 1, med: 2, mid: 2, slow: 3, off: 4 };
      const preferred = ['off', 'auto', 'fast', 'med', 'slow'];
      const mode = preferred.find((key) => map[key] === raw);
      if (mode) this.emit('agc', mode === 'mid' ? 'med' : mode);
      return;
    }

    // Yaesu DNF/ANF button state. FTX-1 labels this DNF on the radio.
    if (msg.startsWith('BC')) {
      const last = msg.slice(-1);
      this.emit('anf', last === '1');
      return;
    }

    if (msg.startsWith('VX')) {
      const last = msg.slice(-1);
      this.emit('vox', last === '1');
      return;
    }

    if (msg.startsWith('VG')) {
      const level = parseInt(msg.slice(2), 10);
      if (!isNaN(level)) this.emit('voxLevel', Math.max(0, Math.min(100, level)));
      return;
    }

    if (msg.startsWith('MG')) {
      const level = parseInt(msg.slice(2), 10);
      if (!isNaN(level)) this.emit('micGain', Math.max(0, Math.min(100, level)));
      return;
    }

    if (msg.startsWith('ML')) {
      const channel = msg.charAt(2);
      const level = parseInt(msg.slice(3), 10);
      if (!isNaN(level)) {
        if (channel === '0') this.emit('mon', level > 0);
        else if (channel === '1') this.emit('monLevel', Math.max(0, Math.min(100, level)));
      }
      return;
    }

    if (msg.startsWith('BI')) {
      const last = msg.slice(-1);
      this.emit('breakIn', last === '1');
      return;
    }

    // Data mode: DA followed by 0/1
    if (msg.startsWith('DA')) {
      this.emit('da', msg.slice(-1) === '1');
      return;
    }
  }

  /** Get the detected/configured FA digit count */
  get faDigits() { return this._faDigits; }

  /** Get the last parsed mode name */
  get lastMode() { return this._lastParsedMode; }

  /** Set last parsed mode (for external sync) */
  set lastMode(m) { this._lastParsedMode = m; }

  /** Return the resolved command table for the Table tab UI */
  getCommandTable() {
    const c = this._cmds;
    const LABELS = {
      getFreq: 'Get Frequency', setFreq: 'Set Frequency',
      getMode: 'Get Mode', setMode: 'Set Mode',
      setTransmitOn: 'PTT On', setTransmitOff: 'PTT Off',
      setNbOn: 'NB On', setNbOff: 'NB Off', getNb: 'Get NB',
      getSmeter: 'S-Meter', setRfGain: 'RF Gain',
      getPower: 'Get Power', setPower: 'TX Power',
      setFilter: 'Filter Width',
      setVfoA: 'VFO A', setVfoB: 'VFO B', swapVfo: 'VFO Swap',
      setSplit: 'Split On', setDa: 'Data Mode',
      setPowerOn: 'Power On', setPowerOff: 'Power Off',
      setNbLevel: 'NB Level', setAfGain: 'AF Gain',
      setPreampOn: 'Preamp On', setPreampOff: 'Preamp Off',
      setAttenuatorOn: 'Atten On', setAttenuatorOff: 'Atten Off',
      vfoCopyAB: 'VFO Copy A->B', vfoCopyBA: 'VFO Copy B->A',
    };
    const entries = [];
    const d = this._defaultCmds;
    for (const [key, label] of Object.entries(LABELS)) {
      if (c[key]) entries.push({ key, label, value: c[key], defaultValue: d[key] || c[key] });
    }
    // ATU sequence
    const atuSeq = ATU_SEQUENCES[this._atuCmd];
    if (atuSeq) {
      const atuStr = atuSeq.map(s => s.cmd).join(' -> ');
      entries.push({ key: 'atuTune', label: 'ATU Tune', value: atuStr, defaultValue: atuStr });
    }
    return entries;
  }

  /** Apply user command overrides from settings */
  applyOverrides(overrides) {
    if (!overrides || typeof overrides !== 'object') return;
    for (const [key, value] of Object.entries(overrides)) {
      if (typeof value === 'string' && value && key in this._cmds) {
        this._cmds[key] = value;
      }
    }
  }
}

module.exports = { KenwoodCodec, expand, ssbSideband, yaesuBwToIndex, YAESU_SSB_BW, YAESU_CW_BW };
