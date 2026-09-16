'use strict';

// Rig setup notes — the menu settings a radio needs before POTACAT can drive
// it, shown in the rig editor behind "Setup instructions".
//
// Why a table: every one of these was a support thread first. The radio
// accepts CAT fine and then silently ignores the thing that matters (an
// FTDX10 whose PC KEYING doesn't name the line POTACAT drives sends no CW; an
// Icom addressed on the wrong CI-V address answers nothing; a generic "Yaesu"
// model sends a CW command the radio rejects). Nothing in the log says so, so
// the answer has to be in front of the operator while they set the rig up.
//
// Rules for entries:
//   - Only what a real station confirmed, or what POTACAT itself decides.
//     Each note names where it came from (`source`).
//   - A value POTACAT chooses is never typed into the text. Write a
//     {placeholder} and let resolveSetupNotes() fill it from the same
//     resolver the keying code uses, so the note cannot disagree with what
//     POTACAT actually drives — and it follows the dropdown when the
//     operator changes it.
//   - Scope tightly (models / brands / radio types / platform). An
//     IC-7300 owner must never be shown a Flex note (the rig-scoped UI rule).
//
// Placeholders: {mainKeyLine} {keyPortLine} {civAddr} {model}
//
// Pure: no Electron, no I/O. main.js supplies the model table entry and the
// platform; test/rig-setup-notes-test.js checks every entry.

const { resolveCwKeyPins, resolveKeyPortPins, keyLineLabel } = require('./cw-key-line');
const { familyFromCatTarget } = require('./rig-family');

const LEVELS = ['required', 'recommended', 'tip'];

// Rig-editor radio types (renderer/index.html input[name="radio-type"]).
const SERIAL_TYPES = ['serialcat', 'icom', 'hamlib'];
const ICOM_CIV_TYPES = ['icom', 'civ-tcp', 'icom-network'];

const NOTES = [
  {
    id: 'ftdx10-pc-keying',
    level: 'required',
    feature: 'CW',
    applies: { models: ['FTDX10'], radioTypes: ['serialcat', 'hamlib'] },
    title: 'Set PC KEYING to the line POTACAT keys',
    steps: [
      'On the radio: MENU → CW SETTING → PC KEYING → {keyPortLine}.',
      'In POTACAT: set CW Key Port (below) to the radio\'s second USB COM port — the "Standard" port, not the "Enhanced" CAT port.',
    ],
    why: 'POTACAT keys CW by switching {keyPortLine} on that port. If PC KEYING names a different line, the radio ignores it and no CW goes out.',
    source: 'Operator report, September 2026',
  },
  {
    id: 'ft891-pc-keying',
    level: 'required',
    feature: 'CW',
    applies: { models: ['FT-891'], radioTypes: ['serialcat', 'hamlib'] },
    title: 'Set PC KEYING and use the second USB port for CW',
    steps: [
      'On the radio: menu 07-12 PC KEYING → {keyPortLine}. Turn BK-IN on.',
      'In POTACAT: set CW Key Port (below) to the radio\'s second USB port ("Standard"; on Linux the one ending if01-port0).',
    ],
    why: 'The FT-891 sends typed CW through the key port. The CAT port only carries rig control.',
    source: 'KM4CFT, July 2026',
  },
  {
    id: 'icom-usb-keying-cw',
    level: 'required',
    feature: 'CW',
    applies: { models: ['IC-7300', 'IC-7300 MK II', 'IC-705', 'IC-7610'], radioTypes: ['icom'] },
    title: 'Match USB Keying (CW) to POTACAT',
    steps: [
      'On the radio: MENU → SET → Connectors → USB SEND/Keying → USB Keying (CW) → {mainKeyLine}.',
    ],
    why: 'POTACAT keys CW by switching {mainKeyLine} on the USB port. Change "CW keying line" below if your radio is set to the other one.',
    source: 'KQ3Q and KM4CFT, April 2026',
  },
  {
    id: 'icom-civ-address',
    level: 'recommended',
    feature: 'CAT',
    applies: { brands: ['Icom'], radioTypes: ICOM_CIV_TYPES, requiresCivAddr: true },
    title: 'Leave the CI-V address at {civAddr}',
    steps: [
      'On the radio: MENU → SET → Connectors → CI-V → CI-V Address → {civAddr} (the {model} default).',
    ],
    why: 'An Icom ignores every command addressed to a different CI-V address. The connection looks healthy and the radio does nothing.',
    source: 'K3FZT and W3AOK, IC-7760, September 2026',
  },
  {
    id: 'pick-exact-model',
    level: 'recommended',
    feature: 'CAT',
    applies: { noModel: true, radioTypes: ['serialcat', 'icom', 'tcpcat'] },
    title: 'Choose your exact radio model',
    steps: [
      'Pick your radio in "Radio Model" above rather than leaving it unset.',
    ],
    why: 'Without a model POTACAT uses generic commands. Some radios reject them silently. An FT-891 on the generic Yaesu setting keyed the transmitter and sent no CW.',
    source: 'KM4CFT, FT-891, July 2026',
  },
  {
    id: 'cat-rate-matches',
    level: 'tip',
    feature: 'CAT',
    applies: { brands: ['Yaesu', 'Kenwood', 'Elecraft'], radioTypes: ['serialcat', 'hamlib'] },
    title: 'Radio CAT rate must equal the Baud rate here',
    steps: [
      'Find CAT RATE (Yaesu) or the COM/USB baud setting in the radio\'s menu and set the same value in POTACAT\'s Baud rate field.',
    ],
    why: 'A mismatch looks like a radio that never answers.',
    source: 'POTACAT support threads',
  },
  {
    id: 'linux-dialout',
    level: 'required',
    feature: 'CAT',
    applies: { platforms: ['linux'], radioTypes: SERIAL_TYPES },
    title: 'Give your user access to serial ports',
    steps: [
      'In a terminal: sudo usermod -aG dialout "$USER"',
      'Log out and back in (or reboot) so the new group applies.',
    ],
    why: 'Without it Linux refuses to open /dev/ttyUSB0 and the connection fails with "permission denied".',
    source: 'docs/linux-cw-keying.md',
  },
  {
    id: 'macos-cu-port',
    level: 'tip',
    feature: 'CAT',
    applies: { platforms: ['darwin'], radioTypes: SERIAL_TYPES },
    title: 'Pick the /dev/cu.* port',
    steps: [
      'Choose the port that starts with /dev/cu. rather than /dev/tty.',
    ],
    why: 'On macOS the tty. device waits for a modem signal and reports "Resource busy". POTACAT retries the cu. twin on its own, but starting on it avoids the wait.',
    source: 'POTACAT 1.10.13 fix',
  },
  {
    id: 'windows-named-audio',
    level: 'recommended',
    feature: 'Audio',
    applies: { platforms: ['win32'], radioTypes: ['serialcat', 'icom', 'hamlib', 'tcpcat', 'civ-tcp', 'rigctldnet'] },
    title: 'Pick the radio\'s own sound device',
    steps: [
      'Set Audio Input and Output to the radio\'s USB audio device by name (for example "USB Audio CODEC"), not "Default" or "Communications".',
    ],
    why: 'Windows moves "Default" around. FT8 then plays to the wrong device: the radio keys with 0 W out.',
    source: 'KQ4MHD, FT-710, July 2026',
  },
];

// Rig-editor radio type for a SAVED catTarget — the same mapping
// populateRadioSection() applies when the editor opens a rig.
const TARGET_TYPE_TO_RADIO_TYPE = {
  'k4-network': 'k4network', serial: 'serialcat', icom: 'icom', 'civ-tcp': 'civ-tcp',
  'icom-network': 'icom-network', rigctld: 'hamlib', rigctldnet: 'rigctldnet',
};
function radioTypeFromCatTarget(t) {
  if (!t || !t.type) return 'flex';
  if (t.type === 'tcp') return familyFromCatTarget(t) === 'flex' ? 'flex' : 'tcpcat';
  return TARGET_TYPE_TO_RADIO_TYPE[t.type] || 'flex';
}

function _fill(text, values) {
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (values[k] != null ? String(values[k]) : m));
}

/**
 * The notes that apply to one rig, with every placeholder filled.
 *
 * @param {object} o
 * @param {string} [o.model]        rig.model, or the Icom picker's civModel
 * @param {object} [o.modelInfo]    RIG_MODELS entry for that model (or null)
 * @param {string} [o.radioType]    rig-editor radio type
 * @param {string} [o.cwKeyLine]    rig.cwKeyLine ('auto' | 'dtr' | 'rts' | 'both')
 * @param {string} [o.platform]     process.platform
 * @param {string[]} [o.done]       note ids the operator ticked for this rig
 * @returns {Array<object>} required first, then recommended, then tips
 */
function resolveSetupNotes(o) {
  o = o || {};
  const model = String(o.model || '').trim();
  const info = o.modelInfo || null;
  const brand = info ? info.brand : '';
  const radioType = String(o.radioType || '');
  const platform = String(o.platform || '');
  const done = new Set(Array.isArray(o.done) ? o.done : []);
  const pins = (info && info.cw && info.cw.dtrPins) || null;
  const values = {
    model: model || 'this radio',
    mainKeyLine: keyLineLabel(resolveCwKeyPins({ modelPins: pins, cwKeyLine: o.cwKeyLine })),
    keyPortLine: keyLineLabel(resolveKeyPortPins({ modelPins: pins, cwKeyLine: o.cwKeyLine })),
    // Icom menus show the address as "94h".
    civAddr: info && info.civAddr != null ? Number(info.civAddr).toString(16).toUpperCase().padStart(2, '0') + 'h' : null,
  };
  const out = [];
  for (const n of NOTES) {
    const a = n.applies || {};
    if (a.radioTypes && !a.radioTypes.includes(radioType)) continue;
    if (a.platforms && !a.platforms.includes(platform)) continue;
    if (a.noModel && model) continue;
    if (a.models && !a.models.includes(model)) continue;
    if (a.brands && !a.brands.includes(brand)) continue;
    if (a.requiresCivAddr && values.civAddr == null) continue;
    out.push({
      id: n.id,
      level: n.level,
      feature: n.feature,
      title: _fill(n.title, values),
      steps: n.steps.map((s) => _fill(s, values)),
      why: _fill(n.why, values),
      source: n.source,
      done: done.has(n.id),
    });
  }
  out.sort((x, y) => LEVELS.indexOf(x.level) - LEVELS.indexOf(y.level));
  return out;
}

module.exports = { NOTES, LEVELS, resolveSetupNotes, radioTypeFromCatTarget };
