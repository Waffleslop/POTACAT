#!/usr/bin/env node
'use strict';
/**
 * assets/geo/us-counties.json from TQSL's config.xml: the US counties LoTW
 * accepts, per state, exactly as TQSL spells them (the value is what goes in
 * ADIF MY_CNTY after "ST,"; the label is TQSL's display name).
 *
 *   node scripts/build-us-counties.js "C:\Program Files (x86)\TrustedQSL\config.xml"
 *
 * TQSL is Copyright (C) American Radio Relay League, Inc., BSD-style licence;
 * its notice travels with the data in assets/geo/LICENSE.
 */
const fs = require('fs');
const path = require('path');

const src = process.argv[2];
if (!src) { console.error('usage: build-us-counties.js <TQSL config.xml>'); process.exit(2); }
const xml = fs.readFileSync(src, 'utf8');
const start = xml.indexOf('<field Id="US_COUNTY"');
if (start < 0) { console.error('no US_COUNTY field in ' + src); process.exit(1); }
const block = xml.slice(start, xml.indexOf('</field>', start));
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const out = {};
const re = /<enums dependency="([A-Z]{2})">([\s\S]*?)<\/enums>/g;
let m;
while ((m = re.exec(block))) {
  const list = [];
  const er = /<enum value="([^"]*)">([^<]*)<\/enum>/g;
  let e;
  while ((e = er.exec(m[2]))) list.push([decode(e[1]), decode(e[2])]);
  out[m[1]] = list;
}
const states = Object.keys(out).sort();
const total = states.reduce((n, s) => n + out[s].length, 0);
const dest = path.join(__dirname, '..', 'assets', 'geo', 'us-counties.json');
fs.writeFileSync(dest, JSON.stringify({ source: 'TQSL config.xml (ARRL)', states: out }));
console.log(`${states.length} states, ${total} counties -> ${path.relative(process.cwd(), dest)}`);
