'use strict';
// #1061: CW Spots get the same QRZ grid placement as DX Cluster spots. Source-text guard:
// connectCwSpots must call refineClusterSpotWithQrz (one lookup path: same qrz cache, limiter
// and enableQrz setting), pointed at the cwSpots array.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

const start = src.indexOf('function connectCwSpots()');
const end = src.indexOf('function disconnectCwSpots()');
assert(start > 0 && end > start, 'connectCwSpots found');
const body = src.slice(start, end);
assert(/refineClusterSpotWithQrz\(raw\.callsign, spot, myPos, \(\) => cwSpots\)/.test(body),
  'connectCwSpots refines each CW spot through refineClusterSpotWithQrz against cwSpots');

const fs0 = src.indexOf('function refineClusterSpotWithQrz(');
const fe = src.indexOf('let clusterClients', fs0);
const refine = src.slice(fs0, fe);
assert(/getSpots = \(\) => clusterSpots/.test(refine), 'DX Cluster default list is unchanged');
assert(/qrz\.lookup\(/.test(refine) && /settings\.enableQrz/.test(refine), 'one lookup path, gated by enableQrz');
assert(!/qrz\.lookup\(/.test(body), 'CW Spots add no second lookup path');
console.log('cw-spots-qrz-grid-test: ok');
