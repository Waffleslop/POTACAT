'use strict';
// Which radios key CW only through break-in (BK-IN), so POTACAT turns it on
// for a message and puts the operator's setting back afterwards.
//
// The Yaesu models whose CW text command is KY (cw.text 'ky1'): the radio
// keys itself from the text through BK-IN, and with BK-IN off it plays the
// message in the sidetone only (W2XYZ FTX-1F on 1.13.8). A CW Key Port
// (DTR/RTS on the radio's KEY input) is the same on these radios: sidetone
// and no RF with BK-IN off (#745). One rule for both paths, here.

function cwKeysThroughBreakIn(model) {
  const cw = (model && model.cw) || {};
  return cw.text === 'ky1' && !!model && model.brand === 'Yaesu';
}

module.exports = { cwKeysThroughBreakIn };
