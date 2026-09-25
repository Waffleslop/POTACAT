'use strict';
// JTCAT renderer TX route: what to tell the operator when the CONFIGURED FT8
// output device cannot be opened and the transmission is refused.
//
// The rule is the one the ECHOCAT audio bridge adopted for its input device on
// 2026-08-28 (N2FSM): a device the operator chose is never silently replaced
// by whatever the OS calls "default". On the transmit side the substitute is
// worse than a hot mic — main has already keyed the radio when the samples
// reach the renderer, so playing the envelope to the default sink is a keyed
// radio with no modulation: red TX LED, 0 W, no SWR, FT8 tones out of the PC
// speakers, and nothing on screen to say why. NA7C's IC-7300 ran that way for
// three weeks (2026-09-09) after Windows re-enumerated his USB CODEC, while
// WSJT-X — which picks its device by NAME on every launch — worked first try.
//
// Pure so the wording is tested: this string is the ONLY thing between the
// operator and another three weeks.
const FIX = 'Pick the radio\'s USB CODEC / DAX TX again in Settings > My Rigs > Audio.';

function describeJtcatTxAudioFault(fault) {
  const f = fault || {};
  const name = String(f.name || '');
  const reason = String(f.reason || name || 'unknown error');
  // Tune uses the same output and the same rule (it keys the radio for 90 s).
  const what = f.context === 'tune' ? 'Tune refused' : f.context === 'voice' ? 'Voice macro refused' : 'TX refused';
  if (name === 'NotFoundError') {
    // Chromium's answer for an id that no longer enumerates: the device was
    // unplugged, moved to another USB port, or re-enumerated by a driver or
    // Windows update. The saved id is stale, not the device broken.
    return what + ': the saved FT8 audio output device is not present (' + reason + ') — ' +
      'it was unplugged, moved to another USB port, or re-enumerated by a driver/Windows update. ' +
      'POTACAT will not key the radio with no audio. ' + FIX;
  }
  return what + ': the saved FT8 audio output device could not be opened (' + reason + '). ' +
    'POTACAT will not key the radio with no audio. ' + FIX +
    ' If it is listed and still fails, another program may hold it exclusively.';
}

module.exports = { describeJtcatTxAudioFault };
