#!/usr/bin/env node
'use strict';
/**
 * FreeDV / RADE gate (#642): the two addons must be present, load, and run
 * a real over: speech in, modem out, modem back in, sync reached and speech
 * out. Every Mac and Linux release until 1.14.6 shipped with no FreeDV at
 * all because build-natives failures were continue-on-error'd; this fails
 * the job instead.
 *
 *   node scripts/check-freedv-natives.js            the build tree (lib/)
 *   node scripts/check-freedv-natives.js --packaged  every app.asar.unpacked under dist/
 *   ... --expect-arch=arm64|x64                      also check the Mach-O / ELF arch
 *
 * Both are N-API addons, so plain Node loads the same .node the packaged
 * Electron app loads.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const packaged = args.includes('--packaged');
const expectArch = (args.find((a) => a.startsWith('--expect-arch=')) || '').slice(14);
const ROOT = path.join(__dirname, '..');

function speechLike(rate, seconds) {
  const out = new Int16Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const f0 = 120 + 30 * Math.sin(2 * Math.PI * 0.7 * t);
    let s = 0;
    for (let h = 1; h <= 12; h++) s += Math.sin(2 * Math.PI * f0 * h * t) / h;
    out[i] = Math.round(4000 * s * (0.55 + 0.45 * Math.sin(2 * Math.PI * 3.5 * t)));
  }
  return out;
}

// Speech -> tx -> modem -> rx: true when the receiver synced and gave speech back.
function overLoopback(codec, handle, nSpeech, speechRate) {
  const speech = speechLike(speechRate, 6);
  const modem = [];
  for (let off = 0; off + nSpeech <= speech.length; off += nSpeech) {
    const m = codec.tx(handle, speech.slice(off, off + nSpeech));
    for (let i = 0; i < m.length; i++) modem.push(m[i]);
  }
  if (!modem.length) throw new Error('tx gave no modem samples');
  let pos = 0, synced = false, speechOut = 0;
  while (pos + codec.getNin(handle) <= modem.length) {
    const nin = codec.getNin(handle);
    const r = codec.rx(handle, Int16Array.from(modem.slice(pos, pos + nin)));
    pos += nin;
    if (r.sync) synced = true;
    if (r.speech) speechOut += r.speech.length;
  }
  return { modem: modem.length, synced, speechOut };
}

function archOf(file) {
  try {
    const out = execFileSync('file', ['-b', file], { encoding: 'utf8' });
    if (/arm64|aarch64/i.test(out)) return 'arm64';
    if (/x86[-_]64|x86-64/i.test(out)) return 'x64';
    return out.trim();
  } catch { return null; } // no `file` (Windows): skip the arch check
}

function checkBase(base) {
  let bad = 0;
  const say = (ok, msg) => { console.log(`${ok ? '  ok  ' : '  FAIL'} ${msg}`); if (!ok) bad++; };
  console.log(`[check-freedv-natives] ${base}`);
  const files = {
    freedv: path.join(base, 'freedv_native', 'build', 'Release', 'freedv_native.node'),
    rade: path.join(base, 'rade_native', 'build', 'Release', 'rade_native.node'),
  };
  for (const [name, file] of Object.entries(files)) {
    if (!fs.existsSync(file)) { say(false, `${name}: missing ${file}`); continue; }
    if (expectArch) {
      const a = archOf(file);
      if (a) say(a === expectArch, `${name}: arch ${a} (want ${expectArch})`);
    }
    let addon;
    try { addon = require(file); } catch (e) { say(false, `${name}: does not load: ${e.message}`); continue; }
    try {
      if (name === 'freedv') {
        const h = addon.open(addon.MODE_700D);
        if (h == null) throw new Error('open(700D) failed');
        const info = addon.getInfo(h);
        const r = overLoopback(addon, h, info.nSpeech, info.speechRate);
        addon.close(h);
        say(r.synced && r.speechOut > 0, `freedv 700D loopback: ${r.modem} modem samples, sync ${r.synced}, ${r.speechOut} speech samples back`);
      } else {
        const h = addon.open();
        if (h == null) throw new Error('open() failed');
        const info = addon.getInfo(h);
        const r = overLoopback(addon, h, info.nSpeech, info.speechRate);
        addon.close(h);
        say(r.synced && r.speechOut > 0, `rade V1 loopback: ${r.modem} modem samples, sync ${r.synced}, ${r.speechOut} speech samples back`);
      }
    } catch (e) { say(false, `${name}: ${e.message}`); }
  }
  return bad;
}

function packagedBases() {
  const out = [];
  const dist = path.join(ROOT, 'dist');
  if (!fs.existsSync(dist)) return out;
  const walk = (dir, depth) => {
    if (depth > 6) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.name === 'app.asar.unpacked') { out.push(path.join(p, 'lib')); continue; }
      if (e.name.endsWith('.app') || /unpacked$|^mac/.test(e.name) || ['Contents', 'Resources', 'resources'].includes(e.name)) walk(p, depth + 1);
    }
  };
  walk(dist, 0);
  return out;
}

const bases = packaged ? packagedBases() : [path.join(ROOT, 'lib')];
if (!bases.length) { console.error('::error::no packaged app (app.asar.unpacked) found under dist/'); process.exit(1); }
let bad = 0;
for (const b of bases) bad += checkBase(b);
if (bad) {
  console.error(`::error::FreeDV/RADE addons failed ${bad} check(s): this build would ship without working FreeDV`);
  process.exit(1);
}
console.log('[check-freedv-natives] FreeDV and RADE present, load, and decode a loopback over');
