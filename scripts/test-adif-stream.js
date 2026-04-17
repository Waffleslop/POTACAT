'use strict';
// Quick verification for parseAdifStream — run with: node scripts/test-adif-stream.js

const { parseAdifStream } = require('../lib/adif');

let pass = 0, fail = 0;
function assert(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok ', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

// Standard ADIF with <EOR>
{
  const text = '<call:5>K3SBP <qso_date:8>20260101 <eor> <call:6>KF8ELA <qso_date:8>20260102 <eor>';
  const recs = parseAdifStream(text);
  assert('std-eor: count', recs.length === 2, `got ${recs.length}`);
  assert('std-eor: rec0 call', recs[0].CALL === 'K3SBP');
  assert('std-eor: rec1 call', recs[1].CALL === 'KF8ELA');
  assert('std-eor: rec1 date', recs[1].QSO_DATE === '20260102');
}

// ADIF with header and <EOH>
{
  const text = 'My header text <adif_ver:5>3.1.4 <programid:7>POTACAT <eoh>\n<call:5>K3SBP <qso_date:8>20260101 <eor>';
  const recs = parseAdifStream(text);
  assert('eoh-header: count', recs.length === 1);
  assert('eoh-header: header dropped', !recs[0].ADIF_VER, `got ${recs[0].ADIF_VER}`);
  assert('eoh-header: call ok', recs[0].CALL === 'K3SBP');
}

// QRZ-style: NO <EOR>, records delimited by repeating <call>
{
  const text = '<call:5>K3SBP <qso_date:8>20260101 <freq:6>14.250 <call:6>KF8ELA <qso_date:8>20260102 <freq:6>14.300';
  const recs = parseAdifStream(text);
  assert('no-eor: count', recs.length === 2, `got ${recs.length}`);
  assert('no-eor: rec0 call', recs[0].CALL === 'K3SBP');
  assert('no-eor: rec0 freq', recs[0].FREQ === '14.250', `got ${recs[0].FREQ}`);
  assert('no-eor: rec1 call', recs[1].CALL === 'KF8ELA');
  assert('no-eor: rec1 freq', recs[1].FREQ === '14.300', `got ${recs[1].FREQ}`);
}

// Length-respecting: value contains < and >
{
  const text = '<call:5>K3SBP <comment:11>see <below> <freq:6>14.250 <eor>';
  const recs = parseAdifStream(text);
  assert('len-respect: count', recs.length === 1);
  assert('len-respect: comment with brackets', recs[0].COMMENT === 'see <below>', `got "${recs[0].COMMENT}"`);
  assert('len-respect: freq after', recs[0].FREQ === '14.250', `got "${recs[0].FREQ}"`);
}

// Mixed case tags
{
  const text = '<CALL:5>K3SBP <Qso_Date:8>20260101 <EOR>';
  const recs = parseAdifStream(text);
  assert('mixed-case: count', recs.length === 1);
  assert('mixed-case: call uppercase key', recs[0].CALL === 'K3SBP');
  assert('mixed-case: date uppercase key', recs[0].QSO_DATE === '20260101');
}

// Drop records without CALL (header garbage etc)
{
  const text = '<adif_ver:5>3.1.4 <eoh> <freq:6>14.250 <eor> <call:5>K3SBP <eor>';
  const recs = parseAdifStream(text);
  assert('no-call-drop: count', recs.length === 1, `got ${recs.length}`);
  assert('no-call-drop: rec is K3SBP', recs[0].CALL === 'K3SBP');
}

// Trailing record without <EOR>
{
  const text = '<call:5>K3SBP <freq:6>14.250 <eor> <call:6>KF8ELA <freq:6>14.300';
  const recs = parseAdifStream(text);
  assert('trail-no-eor: count', recs.length === 2, `got ${recs.length}`);
  assert('trail-no-eor: last call', recs[1].CALL === 'KF8ELA');
  assert('trail-no-eor: last freq', recs[1].FREQ === '14.300', `got "${recs[1].FREQ}"`);
}

// Empty / edge
{
  assert('empty', parseAdifStream('').length === 0);
  assert('null', parseAdifStream(null).length === 0);
  assert('only header', parseAdifStream('<adif_ver:5>3.1.4 <eoh>').length === 0);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
