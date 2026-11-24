'use strict';
/**
 * The mode Station Setup's transmit test keys in (GitHub #755).
 *
 * The test asks "does this radio transmit the way FT8 does": the same audio
 * route, so the same mode. Run in plain USB it reached a different set of
 * radio menus. An FTdx-101D on rigctld with DTR PTT keyed for FT8 and never
 * for the test: in USB that radio takes its PTT source (RPTT SELECT, factory
 * DAKY) and its audio source (SSB MOD SOURCE, factory MIC) from the SSB menu,
 * and the operator had set DTR and USB only for DATA (FTDX101MP/D Operation
 * Manual 2406R, p.88-89 and p.93). The same split exists for CAT PTT: an
 * IC-7300's factory DATA OFF MOD is MIC,ACC, so a CAT-keyed USB test sends no
 * USB audio either. So the rule does not depend on the PTT method.
 *
 * The test switches USB -> DIGU (LSB -> DIGL, the sideband kept) only where
 * FT8 itself would run in the DATA mode (RigAudioJack.tuneMode):
 *   - a sound-card radio (RigAudioJack.appliesToFamily). A Flex, a TCI SDR, an
 *     Icom or Yaesu over the LAN, or a K4 carry their audio over the network,
 *     and the test keeps behaving as it always has there;
 *   - its interface on the data jack (a microphone-jack radio never goes to DATA);
 *   - "Switch radio to DATA mode (PKTUSB) for FT8 / FT4 (JTCAT)" on;
 *   - the radio has that data mode (DataModePicker.dataModesFor);
 *   - the radio is in USB or LSB and not in a DATA mode already.
 * The voice test never switches: it tests the SSB input on purpose.
 *
 * The switch itself is the key-down's own (handleRemotePtt forceDataMode):
 * key only once the radio reports DATA, and every release, however the test
 * ends, puts the mode back and confirms it. Pure.
 */

const DataModePicker = require('./data-mode-picker');
const RigAudioJack = require('./rig-audio-jack');

const DATA_REASON = 'the transmit test runs in the DATA mode FT8 uses on this radio';

/**
 * @param {object} o
 * @param {boolean} [o.voice]        the voice test (never switches)
 * @param {string}  o.mode           the radio's mode now
 * @param {boolean} [o.inData]       the radio reports its DATA flag on (an Icom reads USB + DATA)
 * @param {string}  o.family         RigFamily.rigFamily(rig)
 * @param {string}  [o.jack]         RigAudioJack.jackOf(rig, family)
 * @param {boolean} [o.useDataMode]  settings.jtcatUseDataMode !== false
 * @param {string[]} [o.dataModes]   DataModePicker.dataModesFor(...) for this radio
 * @returns {{ dataMode: 'DIGU'|'DIGL'|null, why: string }}
 *   why: 'switch' | 'voice' | 'mode' | 'in-data' | 'network-audio' | 'mic-jack' | 'plain-usb' | 'no-data-mode'
 */
function planTestMode(o) {
  o = o || {};
  if (o.voice) return { dataMode: null, why: 'voice' };
  const mode = String(o.mode || '').trim().toUpperCase();
  if (o.inData || DataModePicker.dataModeOf(mode)) return { dataMode: null, why: 'in-data' };
  const dataMode = mode === 'LSB' ? 'DIGL' : (mode === 'USB' || mode === 'SSB') ? 'DIGU' : null;
  if (!dataMode) return { dataMode: null, why: 'mode' };
  if (!RigAudioJack.appliesToFamily(o.family)) return { dataMode: null, why: 'network-audio' };
  if (RigAudioJack.normalizeJack(o.jack) === RigAudioJack.MIC) return { dataMode: null, why: 'mic-jack' };
  if (o.useDataMode === false) return { dataMode: null, why: 'plain-usb' };
  const has = Array.isArray(o.dataModes) ? o.dataModes : [];
  if (has.indexOf(dataMode) < 0) return { dataMode: null, why: 'no-data-mode' };
  return { dataMode, why: 'switch' };
}

/**
 * The one line the operator reads about the switch.
 * @param {object} o
 * @param {string}  o.from       the mode the radio was in (USB / LSB)
 * @param {boolean} o.restored   the radio reported that mode again after the test
 */
function modeNote({ from, restored } = {}) {
  const m = String(from || '').toUpperCase() || 'its voice mode';
  return restored
    ? `For the test POTACAT switched the radio from ${m} to its DATA mode, the one FT8 uses, and put it back to ${m}.`
    : `For the test POTACAT switched the radio from ${m} to its DATA mode, the one FT8 uses, and sent it back to ${m}, but the radio has not confirmed ${m} yet. Check the mode on the radio.`;
}

module.exports = { planTestMode, modeNote, DATA_REASON };
