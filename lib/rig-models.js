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
 */

const RIG_MODELS = {
  // ── Icom ──────────────────────────────────────────────
  'IC-705': {
    brand: 'Icom', protocol: 'civ', civAddr: 0xA4,
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'civ', rfgain: true, txpower: true, power: true },
    cw: { text: 'civ', textChunk: 30, speed: 'civ', paddleKey: 'dtr', dtrPins: { dtr: true, rts: false }, taKey: false, breakIn: false },
    atuCmd: false, maxPower: 10,
  },
  'IC-7100': {
    brand: 'Icom', protocol: 'civ', civAddr: 0x88,
    caps: { nb: true, atu: false, vfo: true, filter: true, filterType: 'civ', rfgain: true, txpower: true, power: true },
    cw: { text: 'civ', textChunk: 30, speed: 'civ', paddleKey: false, dtrPins: null, taKey: false, breakIn: false },
    atuCmd: false, maxPower: 100,
  },
  'IC-7300': {
    brand: 'Icom', protocol: 'civ', civAddr: 0x94,
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'civ', rfgain: true, txpower: true, power: true },
    cw: { text: 'civ', textChunk: 30, speed: 'civ', paddleKey: 'dtr', dtrPins: { dtr: true, rts: false }, taKey: false, breakIn: true },
    atuCmd: false, maxPower: 100,
  },
  'IC-7300 MK II': {
    brand: 'Icom', protocol: 'civ', civAddr: 0xB6,
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'civ', rfgain: true, txpower: true, power: true },
    cw: { text: 'civ', textChunk: 30, speed: 'civ', paddleKey: 'dtr', dtrPins: { dtr: true, rts: false }, taKey: false, breakIn: true },
    atuCmd: false, maxPower: 100,
  },
  'IC-7600': {
    brand: 'Icom', protocol: 'civ', civAddr: 0x7A,
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'civ', rfgain: true, txpower: true, power: true },
    cw: { text: 'civ', textChunk: 30, speed: 'civ', paddleKey: 'dtr', dtrPins: { dtr: true, rts: false }, taKey: false, breakIn: true },
    atuCmd: false, maxPower: 100,
  },
  'IC-7610': {
    brand: 'Icom', protocol: 'civ', civAddr: 0x98,
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'civ', rfgain: true, txpower: true, power: true },
    cw: { text: 'civ', textChunk: 30, speed: 'civ', paddleKey: 'dtr', dtrPins: { dtr: true, rts: false }, taKey: false, breakIn: true },
    atuCmd: false, maxPower: 100,
  },
  'IC-7851': {
    brand: 'Icom', protocol: 'civ', civAddr: 0x8E,
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'civ', rfgain: true, txpower: true, power: true },
    cw: { text: 'civ', textChunk: 30, speed: 'civ', paddleKey: 'dtr', dtrPins: { dtr: true, rts: false }, taKey: false, breakIn: true },
    atuCmd: false, maxPower: 200,
  },
  'IC-9700': {
    brand: 'Icom', protocol: 'civ', civAddr: 0xA2,
    caps: { nb: true, atu: false, vfo: true, filter: true, filterType: 'civ', rfgain: true, txpower: true, power: true },
    cw: { text: 'civ', textChunk: 30, speed: 'civ', paddleKey: 'dtr', dtrPins: { dtr: true, rts: false }, taKey: false, breakIn: false },
    atuCmd: false, maxPower: 100,
  },

  // ── Yaesu ─────────────────────────────────────────────
  'FT-450': {
    brand: 'Yaesu', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'indexed', rfgain: true, txpower: true, power: true },
    cw: { text: 'ky1', textChunk: 50, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: false },
    atuCmd: 'ft450', maxPower: 100,
  },
  'FT-710': {
    brand: 'Yaesu', protocol: 'kenwood', connectDelay: 300,
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'indexed', rfgain: true, txpower: true, power: true },
    cw: { text: 'ky1', textChunk: 50, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'standard', maxPower: 100,
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
    caps: { nb: true, nbLevel: true, atu: true, vfo: true, vfoCopy: true, filter: true, filterType: 'indexed', rfgain: true, afGain: true, txpower: true, power: true, preamp: true, attenuator: true },
    cw: { text: 'ky1', textChunk: 50, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: false },
    atuCmd: 'ac002', minPower: 5, maxPower: 100, maxNbLevel: 10,
  },
  'FT-991/991A': {
    brand: 'Yaesu', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'indexed', rfgain: true, txpower: true, power: true },
    cw: { text: 'ky1', textChunk: 50, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'standard', maxPower: 100,
  },
  'FT-2000': {
    brand: 'Yaesu', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'indexed', rfgain: true, txpower: true, power: true },
    cw: { text: 'ky1', textChunk: 50, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'standard', maxPower: 200,
  },
  'FTDX3000': {
    brand: 'Yaesu', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'indexed', rfgain: true, txpower: true, power: true },
    cw: { text: 'ky1', textChunk: 50, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'ac002', minPower: 5, maxPower: 100,
  },
  'FTDX10': {
    brand: 'Yaesu', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'indexed', rfgain: true, txpower: true, power: true },
    cw: { text: 'ky1', textChunk: 50, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'ft891', maxPower: 100,
  },
  'FTDX101D/MP': {
    brand: 'Yaesu', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'indexed', rfgain: true, txpower: true, power: true },
    cw: { text: 'ky1', textChunk: 50, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: true, kyMode: 'km' },
    atuCmd: 'standard', maxPower: 200,
  },

  // ── Kenwood ───────────────────────────────────────────
  'TS-480': {
    brand: 'Kenwood', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'direct', rfgain: true, txpower: true, power: true },
    cw: { text: 'ky', textChunk: 24, speed: 'ks', paddleKey: 'ta', dtrPins: null, taKey: true, breakIn: false },
    atuCmd: 'standard', maxPower: 100,
  },
  'TS-590S/SG': {
    brand: 'Kenwood', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'direct', rfgain: true, txpower: true, power: true },
    cw: { text: 'ky', textChunk: 24, speed: 'ks', paddleKey: 'ta', dtrPins: null, taKey: true, breakIn: true },
    atuCmd: 'standard', maxPower: 100,
  },
  'TS-890S': {
    brand: 'Kenwood', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'direct', rfgain: true, txpower: true, power: true },
    cw: { text: 'ky', textChunk: 24, speed: 'ks', paddleKey: 'ta', dtrPins: null, taKey: true, breakIn: true },
    atuCmd: 'standard', maxPower: 200,
  },
  'TS-990S': {
    brand: 'Kenwood', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'direct', rfgain: true, txpower: true, power: true },
    cw: { text: 'ky', textChunk: 24, speed: 'ks', paddleKey: 'ta', dtrPins: null, taKey: true, breakIn: true },
    atuCmd: 'standard', maxPower: 200,
  },

  // ── Elecraft ──────────────────────────────────────────
  'K3/K3S': {
    brand: 'Elecraft', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'direct', rfgain: true, txpower: true, power: true },
    cw: { text: 'ky', textChunk: 24, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'standard', maxPower: 100,
  },
  'K4': {
    brand: 'Elecraft', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'direct', rfgain: true, txpower: true, power: true },
    cw: { text: 'ky', textChunk: 24, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'standard', maxPower: 100,
  },
  'KX2/KX3': {
    brand: 'Elecraft', protocol: 'kenwood',
    caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'direct', rfgain: true, txpower: true, power: true },
    cw: { text: 'ky', textChunk: 24, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'standard', maxPower: 15,
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
  'FLEX-6400/6400M': {
    brand: 'FlexRadio', protocol: 'smartsdr',
    caps: { nb: true, atu: true, vfo: false, filter: true, filterType: 'arbitrary', rfgain: true, txpower: true, power: false },
    cw: { text: 'smartsdr', textChunk: 64, speed: 'smartsdr', paddleKey: 'smartsdr', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'smartsdr', maxPower: 100,
  },
  'FLEX-6600/6600M': {
    brand: 'FlexRadio', protocol: 'smartsdr',
    caps: { nb: true, atu: true, vfo: false, filter: true, filterType: 'arbitrary', rfgain: true, txpower: true, power: false },
    cw: { text: 'smartsdr', textChunk: 64, speed: 'smartsdr', paddleKey: 'smartsdr', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'smartsdr', maxPower: 100,
  },
  'FLEX-8400/8600': {
    brand: 'FlexRadio', protocol: 'smartsdr',
    caps: { nb: true, atu: true, vfo: false, filter: true, filterType: 'arbitrary', rfgain: true, txpower: true, power: false },
    cw: { text: 'smartsdr', textChunk: 64, speed: 'smartsdr', paddleKey: 'smartsdr', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'smartsdr', maxPower: 100,
  },
  'FLEX Aurora': {
    brand: 'FlexRadio', protocol: 'smartsdr',
    caps: { nb: true, atu: true, vfo: false, filter: true, filterType: 'arbitrary', rfgain: true, txpower: true, power: false },
    cw: { text: 'smartsdr', textChunk: 64, speed: 'smartsdr', paddleKey: 'smartsdr', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'smartsdr', maxPower: 100,
  },
  'FLEX-6700': {
    brand: 'FlexRadio', protocol: 'smartsdr',
    caps: { nb: true, atu: true, vfo: false, filter: true, filterType: 'arbitrary', rfgain: true, txpower: true, power: false },
    cw: { text: 'smartsdr', textChunk: 64, speed: 'smartsdr', paddleKey: 'smartsdr', dtrPins: null, taKey: false, breakIn: true },
    atuCmd: 'smartsdr', maxPower: 100,
  },
};

// Generic fallbacks for unknown models
const GENERIC_CAPS = {
  icom:    { brand: 'Icom',    protocol: 'civ',     civAddr: 0x94, caps: { nb: false, atu: false, vfo: false, filter: false, filterType: false, rfgain: false, txpower: false, power: true }, cw: { text: 'civ', textChunk: 30, speed: 'civ', paddleKey: 'dtr', dtrPins: { dtr: true, rts: false }, taKey: false, breakIn: false }, atuCmd: false, maxPower: 100 },
  yaesu:   { brand: 'Yaesu',   protocol: 'kenwood', caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'indexed', rfgain: true, txpower: true, power: true }, cw: { text: 'ky1', textChunk: 50, speed: 'ks', paddleKey: 'txrx', dtrPins: null, taKey: false, breakIn: false }, atuCmd: 'standard', maxPower: 100 },
  kenwood: { brand: 'Kenwood', protocol: 'kenwood', caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'direct', rfgain: true, txpower: true, power: true }, cw: { text: 'ky', textChunk: 24, speed: 'ks', paddleKey: 'ta', dtrPins: null, taKey: true, breakIn: false }, atuCmd: 'standard', maxPower: 100 },
  flex:    { brand: 'FlexRadio', protocol: 'smartsdr', caps: { nb: true, atu: true, vfo: false, filter: true, filterType: 'arbitrary', rfgain: true, txpower: true, power: false }, cw: { text: 'smartsdr', textChunk: 64, speed: 'smartsdr', paddleKey: 'smartsdr', dtrPins: null, taKey: false, breakIn: true }, atuCmd: 'smartsdr', maxPower: 100 },
  rigctld: { brand: 'Hamlib',  protocol: 'rigctld', caps: { nb: true, atu: true, vfo: true, filter: true, filterType: 'passband', rfgain: true, txpower: true, power: true }, cw: { text: false, textChunk: 0, speed: false, paddleKey: false, dtrPins: null, taKey: false, breakIn: false }, atuCmd: false, maxPower: 100 },
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
  // Kenwood/Elecraft/Xiegu: mode before freq, no post-freq re-send, DA for digital
  return { modeBeforeFreq: true, modeAfterFreq: false, freqAfterMode: false, alwaysResendMode: false, daCommand: true };
}

module.exports = { RIG_MODELS, GENERIC_CAPS, getModel, getModelList, getTuneQuirks };
