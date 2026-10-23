// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// "Set up VARA for me" (Casey 2026-10-23: "We need this to be super simple").
//
// VARA is EA5HVK's closed modem; the operator installs it. What used to be
// six manual steps across three programs is one button: POTACAT finds the
// two virtual cables, writes VARA's own settings file so VARA opens the
// cables and keys nothing, points its own cable side at the matching ends,
// starts VARA and checks VARA's log for the one line that says a device
// name did not match. This module is the PURE part (tests:
// test/winlink-vara-test.js); main.js does the file I/O and the launch.
//
// Facts this rests on (read from a real install, C:\VARA, 2026-10-23):
// - VARA.ini is a plain INI beside VARA.exe: [Soundcard] "Input Device
//   Name" / "Output Device Name", [PTT] "Via", [Setup] "TCP Command Port".
//   VARA reads it at start and writes it back at exit, so it is patched
//   only while VARA is NOT running (the JS8Call lesson), by substituting
//   values on named lines; every other byte passes through.
// - VARA is a VB6 program on the old MME audio API, whose device names are
//   cut at 31 characters ("DAX Audio RX 1 (FlexRadio Syste"). The names
//   written must be the 31-character form of the Windows name POTACAT's
//   renderer reports, or VARA logs "Soundcard Input Device missing in
//   action !" and plays to nothing.
// - VARA's PTT dialog offers VOX, COM, CAT and RA-Board (the form's option
//   buttons optVOX/optCOM/optCAT); there is no "None". VOX = VARA keys
//   nothing, which is what POTACAT needs: Pat keys the radio through
//   POTACAT's shim. The stock ini ships Via=3 with COM1 for CAT.
//   VARA_PTT_VIA_VOX is the inferred 1-based index; confirmed on the first
//   real run (the setup result says what was written).
// - Cables: VB-Audio's free VB-CABLE is ONE cable ("CABLE Input" to play
//   into, "CABLE Output" to record from); a second free one is the Hi-Fi
//   Cable; the donation A+B pack gives CABLE-A and CABLE-B. Two are needed,
//   one per direction. Voicemeeter's endpoints only pass audio with its
//   mixer running and routed, so they are never auto-picked.

'use strict';

const MME_NAME_MAX = 31;
const VARA_PTT_VIA_VOX = 1;

const CABLE_LINKS = Object.freeze({
  vbCable: 'https://vb-audio.com/Cable/',
});

/**
 * THE RIG LAYER'S DECISION (Casey 2026-10-23: "all VARA settings
 * pre-configured based on the radio"): how VARA reaches this radio's audio
 * follows from the rig's audio source alone. A radio whose audio arrives
 * over the network (Flex Direct, Icom Network) has no sound card VARA could
 * open, so POTACAT carries it through two virtual cables. Every other radio
 * (a USB sound card, DAX on a Flex run the classic way) VARA opens directly,
 * the way Winlink Express does, and no cable exists. PTT is VOX in every
 * case: Pat keys the radio through POTACAT's shim.
 * @returns {{route:'cable'|'direct', why:string}}
 */
function varaRouteFor({ audioSource } = {}) {
  if (audioSource === 'smartsdr') return { route: 'cable', why: 'Flex Direct carries the radio\'s audio over the network, so VARA needs two virtual cables' };
  if (audioSource === 'icom-network') return { route: 'cable', why: 'Icom Network carries the radio\'s audio over the LAN, so VARA needs two virtual cables' };
  return { route: 'direct', why: 'VARA opens the radio\'s own sound card; no cable' };
}

/**
 * The direct route: VARA records the radio from the rig's own capture device
 * and plays to its playback device, both as the MME names POTACAT's ARDOP
 * device pick already resolved (lib/ardop-process.js proposeArdopDevices,
 * which lists through ardopcf and so sees exactly the names VARA sees).
 */
function planDirect({ capture, playback } = {}) {
  if (!capture || !playback) {
    return { ok: false, route: 'direct', advice: 'POTACAT could not tell which sound card is the radio\'s. Pick it under Settings > My Rigs > your radio > Audio (Input and Output), save, then click Set up again.' };
  }
  return { ok: true, route: 'direct', capture: String(capture), playback: String(playback), vara: { inputName: mmeName(capture), outputName: mmeName(playback) } };
}

/** The MME name VARA will compare against: the Windows name cut at 31 characters. */
function mmeName(label) {
  return String(label || '').slice(0, MME_NAME_MAX);
}

/**
 * Which virtual cable a device label belongs to, or null. Windows names the
 * two ends of a cable differently per API — the Hi-Fi Cable's playback end
 * is "Speakers (VB-Audio Hi-Fi Cable)" to WASAPI (what POTACAT's renderer
 * sees) and "Hi-Fi Cable Input (VB-Audio Hi-" to MME (what VARA sees) — so
 * pairing goes by FAMILY and direction comes from the device kind, never
 * from the words Input/Output in the label.
 */
function cableFamily(label) {
  const l = String(label || '');
  if (/voicemeeter/i.test(l)) return null;
  if (/hi-?fi\s*cable/i.test(l)) return 'Hi-Fi Cable';
  const ab = l.match(/\bCABLE-([A-D])\b/i);
  if (ab) return 'CABLE-' + ab[1].toUpperCase();
  if (/\bCABLE\b/i.test(l) && /vb-audio|virtual cable/i.test(l)) return 'CABLE';
  if (/\bcable\b/i.test(l)) return l.replace(/\s*\(.*$/, '').replace(/\s+(Input|Output)\b.*$/i, '').trim() || null;
  return null;
}

/**
 * Pair up virtual cables from an enumerateDevices-style list
 * [{kind:'audioinput'|'audiooutput', label, deviceId}]: one family with a
 * playback endpoint (what programs play INTO) and a capture endpoint (what
 * they record FROM). Voicemeeter is reported but never paired.
 * @returns {{cables: Array<{name, playbackId, playbackLabel, captureId, captureLabel}>, voicemeeter: boolean}}
 */
function findCables(devices) {
  const list = Array.isArray(devices) ? devices : [];
  const byName = new Map();
  let voicemeeter = false;
  for (const d of list) {
    if (!d || !d.label || !d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications') continue;
    if (/voicemeeter/i.test(d.label)) { voicemeeter = true; continue; }
    const name = cableFamily(d.label);
    if (!name) continue;
    const c = byName.get(name) || { name, playbackId: '', playbackLabel: '', captureId: '', captureLabel: '' };
    if (d.kind === 'audiooutput' && !c.playbackId) { c.playbackId = d.deviceId; c.playbackLabel = d.label; }
    if (d.kind === 'audioinput' && !c.captureId) { c.captureId = d.deviceId; c.captureLabel = d.label; }
    byName.set(name, c);
  }
  const cables = [...byName.values()].filter((c) => c.playbackId && c.captureId);
  cables.sort((a, b) => cableRank(a.name) - cableRank(b.name) || a.name.localeCompare(b.name));
  return { cables, voicemeeter };
}

/**
 * The names VARA will match, taken from an MME listing when one is given
 * (ardopcf lists through the same API VARA uses: lib/ardop-process.js
 * parseArdopDeviceList → {capture:[{name}], playback:[{name}]}). A cable's
 * capture end is "<family> Output…", its playback end "<family> Input…".
 * Without a listing the WASAPI label cut at 31 characters is the best guess.
 */
function mmeNamesFor(family, mme, fallback = {}) {
  const esc = String(family).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pick = (list, re) => { const hit = (list || []).find((x) => x && re.test(String(x.name || ''))); return hit ? String(hit.name) : ''; };
  const capture = mme ? pick(mme.capture, new RegExp('^' + esc + '\\s+Output\\b', 'i')) : '';
  const playback = mme ? pick(mme.playback, new RegExp('^' + esc + '\\s+Input\\b', 'i')) : '';
  return {
    capture: capture || mmeName(fallback.captureLabel || ''),
    playback: playback || mmeName(fallback.playbackLabel || ''),
    fromListing: !!(capture && playback),
  };
}

/** Preferred order: CABLE-A, CABLE-B, CABLE-C, CABLE-D, CABLE, Hi-Fi Cable, then anything else. */
function cableRank(name) {
  const n = String(name).toUpperCase();
  if (/^CABLE-[ABCD]$/.test(n)) return n.charCodeAt(6) - 65;
  if (n === 'CABLE') return 10;
  if (/HI-?FI/.test(n)) return 11;
  return 20;
}

/**
 * Decide the two cables and every name each side needs.
 *   cable 1 = radio → VARA: POTACAT plays into its Input, VARA records its Output.
 *   cable 2 = VARA → radio: VARA plays into its Input, POTACAT records its Output.
 * @returns {{ok, toVara?, fromVara?, vara?:{inputName, outputName}, potacat?:{inputId, outputId, inputLabel, outputLabel}, found: number, voicemeeter, advice}}
 */
function planCables(devices, { mme } = {}) {
  const { cables, voicemeeter } = findCables(devices);
  if (cables.length < 2) {
    return { ok: false, route: 'cable', found: cables.length, voicemeeter, advice: cableAdvice(cables, voicemeeter) };
  }
  const toVara = cables[0];
  const fromVara = cables[1];
  const n1 = mmeNamesFor(toVara.name, mme, toVara);
  const n2 = mmeNamesFor(fromVara.name, mme, fromVara);
  return {
    ok: true,
    route: 'cable',
    found: cables.length,
    voicemeeter,
    toVara,
    fromVara,
    vara: { inputName: n1.capture, outputName: n2.playback, fromListing: n1.fromListing && n2.fromListing },
    potacat: { inputId: fromVara.captureId, inputLabel: fromVara.captureLabel, outputId: toVara.playbackId, outputLabel: toVara.playbackLabel },
    advice: '',
  };
}

/**
 * Rebuild a cable plan from what a setup saved on the rig (ids + labels), so
 * a later sync (session start, rig switch) needs no renderer device list.
 */
function planCablesFromSaved(saved) {
  const s = saved || {};
  if (!s.inputId || !s.outputId || !s.varaInputName || !s.varaOutputName) return { ok: false, route: 'cable', found: 0, advice: 'Click Set up VARA for me once so POTACAT can find the two cables.' };
  return {
    ok: true,
    route: 'cable',
    found: 2,
    voicemeeter: false,
    toVara: { name: cableFamily(s.outputLabel) || 'cable 1', playbackId: s.outputId, playbackLabel: s.outputLabel || '', captureId: '', captureLabel: '' },
    fromVara: { name: cableFamily(s.inputLabel) || 'cable 2', playbackId: '', playbackLabel: '', captureId: s.inputId, captureLabel: s.inputLabel || '' },
    vara: { inputName: s.varaInputName, outputName: s.varaOutputName, fromListing: true },
    potacat: { inputId: s.inputId, inputLabel: s.inputLabel || '', outputId: s.outputId, outputLabel: s.outputLabel || '' },
    advice: '',
  };
}

/** One sentence that names the missing piece and where it is, nothing else. */
function cableAdvice(cables, voicemeeter) {
  const n = (cables || []).length;
  if (n >= 2) return '';
  const free = 'both free from vb-audio.com/Cable, run each installer as administrator, then reboot';
  if (n === 1) {
    return `One virtual cable found (${cables[0].name}); VARA needs two, one per direction. Install a second: the Hi-Fi Cable (${free}).`;
  }
  const vm = voicemeeter ? ' Voicemeeter is installed, but its endpoints only pass audio with its mixer running, so POTACAT does not use them.' : '';
  return `No virtual audio cable found. Install VB-CABLE and the Hi-Fi Cable (${free}).${vm}`;
}

/**
 * Patch VARA.ini text: set the four values on their named lines (added under
 * the section when missing; the section appended when missing). Line endings
 * and every other line are preserved byte for byte.
 * @returns {{text: string, changes: Array<{section, key, from, to}>}}
 */
function planVaraIniPatch(iniText, { inputName, outputName, port, pttVia = VARA_PTT_VIA_VOX } = {}) {
  const wanted = [
    ['Soundcard', 'Input Device Name', mmeName(inputName)],
    ['Soundcard', 'Output Device Name', mmeName(outputName)],
    ['PTT', 'Via', String(pttVia)],
    ['Setup', 'TCP Command Port', String(parseInt(port, 10) || 8300)],
  ];
  const src = String(iniText || '');
  const eol = /\r\n/.test(src) ? '\r\n' : '\n';
  const lines = src.length ? src.split(/\r?\n/) : [];
  const trailingBlank = lines.length && lines[lines.length - 1] === '' ? lines.pop() === '' : false;
  const changes = [];
  for (const [section, key, value] of wanted) {
    let secAt = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().toLowerCase() === `[${section.toLowerCase()}]`) { secAt = i; break; }
    }
    if (secAt < 0) {
      if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
      lines.push(`[${section}]`);
      secAt = lines.length - 1;
    }
    let end = lines.length;
    for (let i = secAt + 1; i < lines.length; i++) if (/^\s*\[/.test(lines[i])) { end = i; break; }
    let keyAt = -1;
    for (let i = secAt + 1; i < end; i++) {
      const m = lines[i].match(/^\s*([^=;#\[]+?)\s*=/);
      if (m && m[1].toLowerCase() === key.toLowerCase()) { keyAt = i; break; }
    }
    if (keyAt >= 0) {
      const from = lines[keyAt].slice(lines[keyAt].indexOf('=') + 1);
      if (from !== value) { changes.push({ section, key, from, to: value }); lines[keyAt] = `${key}=${value}`; }
    } else {
      // Insert at the end of the section, before a blank line that separates sections.
      let at = end;
      while (at > secAt + 1 && lines[at - 1].trim() === '') at--;
      lines.splice(at, 0, `${key}=${value}`);
      changes.push({ section, key, from: null, to: value });
    }
  }
  const text = lines.join(eol) + (trailingBlank || !src.length ? eol : '');
  return { text, changes };
}

/** The line VARA writes when an ini device name matches nothing it can open. */
function varaLogDeviceProblem(logTail) {
  const t = String(logTail || '');
  const lines = t.split(/\r?\n/).filter(Boolean).slice(-40);
  const bad = [];
  if (lines.some((l) => /Soundcard Input Device missing/i.test(l))) bad.push('input');
  if (lines.some((l) => /Soundcard Output Device missing/i.test(l))) bad.push('output');
  if (!bad.length) return '';
  return `VARA could not open its ${bad.join(' and ')} device (its log says "missing in action"). Open VARA's Settings > SoundCard and pick the cable ends by hand, then click Set up again.`;
}

/** What the operator reads after a successful setup. */
function describeSetup({ kind, plan, path, port, version, iniChanged }) {
  const name = kind === 'fm' ? 'VARA FM' : 'VARA HF';
  const parts = [`${name} is set up${version ? ' (' + version + ')' : ''}.`];
  if (plan.route === 'direct') parts.push(`VARA uses the radio's sound card directly: ${plan.capture} from the radio, ${plan.playback} to the radio. No cable.`);
  else parts.push(`Radio to VARA: ${plan.toVara.name}. VARA to radio: ${plan.fromVara.name}.`);
  parts.push(iniChanged ? `VARA's settings were written (sound cards, PTT via VOX, port ${port}).` : `VARA's settings already matched.`);
  if (path) parts.push(`Program: ${path}.`);
  return parts.join(' ');
}

module.exports = {
  MME_NAME_MAX,
  VARA_PTT_VIA_VOX,
  CABLE_LINKS,
  mmeName,
  cableFamily,
  mmeNamesFor,
  varaRouteFor,
  planDirect,
  findCables,
  planCables,
  planCablesFromSaved,
  cableAdvice,
  planVaraIniPatch,
  varaLogDeviceProblem,
  describeSetup,
};
