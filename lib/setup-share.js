'use strict';

// "Share my working setup" — Station Setup's opt-in report of a radio setup
// that POTACAT has MEASURED working (Casey 2026-09-25: "pull settings from
// users who actually use POTACAT and their rig, so we can get all the POTACAT
// settings correct"). Aggregated per model on the cloud, it tells us which
// defaults to ship and which radio-menu notes to go and confirm.
//
// Rules, all load-bearing:
//   - Offered only once every REQUIRED checklist step works on this radio. A
//     report is evidence that a setup works; a half-working one would teach
//     us the wrong defaults (bug reports already cover broken setups).
//   - An ALLOWLIST, never a blocklist. Every field is copied by name from a
//     known source; nothing is spread from settings. Host names, IP
//     addresses, ports, serial device paths, user names, passwords, device
//     ids and the callsign never leave unless listed here — the callsign only
//     when the operator ticks the box. A new setting is NOT shared until
//     someone adds it here on purpose (the settings-export lesson: the old
//     3-key blocklist rotted and shipped live passwords).
//   - The operator sees exactly what is sent: describeShare() renders the
//     same payload the POST carries, in plain words, before they press Send.
//   - Radio menus POTACAT cannot read come from the operator in their own
//     words (menuNotes). They are CANDIDATES for lib/rig-setup-notes.js and
//     are never shown to other operators until a person has confirmed them.
//
// Pure: no Electron, no I/O. test/setup-share-test.js checks every rule.

const SHARE_SCHEMA = 1;
const SHARE_URL = 'https://api.potacat.com/v1/setup-reports';
const MENU_NOTES_MAX = 1000;
const LABEL_MAX = 120;
// A share that could not be delivered is kept and retried at launch for this
// long (the endpoint may ship after the desktop release that offers it).
const PENDING_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const PENDING_MAX = 10;

// catTarget fields that describe HOW the radio is connected, never WHERE.
// Deliberately absent: host, port, path, serialPort, pttPort, controlPort,
// civPort, rigctldPort, username, password.
const CAT_FIELDS = {
  type: 'string',          // serial | icom | civ-tcp | icom-network | rigctld | rigctldnet | tcp | k4-network
  baudRate: 'number',
  dtrOff: 'boolean',
  civAddress: 'number',
  civModel: 'string',
  rigId: 'number',         // Hamlib model number (rigctld)
  pttType: 'string',       // rigctld separate PTT line: DTR | RTS | ...
  networkTxGain: 'number', // Icom network TX audio gain
};

function str(v, max = LABEL_MAX) {
  if (v == null) return '';
  return String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function round(v, places = 1) { const n = num(v); if (n == null) return null; const f = 10 ** places; return Math.round(n * f) / f; }

// A device label is normally a hardware name ("USB Audio CODEC", "Microphone
// (2- FT-710)"), but macOS and Windows name Bluetooth and phone devices after
// their owner ("Casey's AirPods Pro", "John's iPhone Microphone"). A label
// with a possessive in it is withheld entirely — there is no reliable way to
// keep "the product part" — and the preview says so. Cloud question 3,
// 2026-09-25. Device IDS are never sent (they are per-machine hashes).
const POSSESSIVE_RE = /\b\S+['’]s\b/i;
function labelHasName(v) { return POSSESSIVE_RE.test(String(v || '')); }
function cleanLabel(v) { const s = str(v); return s && !labelHasName(s) ? s : ''; }

function pickCat(catTarget) {
  const out = {};
  if (!catTarget || typeof catTarget !== 'object') return out;
  for (const [k, t] of Object.entries(CAT_FIELDS)) {
    const v = catTarget[k];
    if (v == null) continue;
    if (t === 'number') { const n = num(v); if (n != null) out[k] = n; }
    else if (t === 'boolean') out[k] = !!v;
    else { const s = str(v, 40); if (s) out[k] = s; }
  }
  // A separate PTT port is a fact worth knowing (its name is not).
  if (catTarget.pttPort) out.separatePttPort = true;
  return out;
}

/** Can this checklist result be shared? Every required step must work. */
function eligibleToShare(result) {
  return !!(result && result.summary && result.summary.complete && result.summary.requiredTotal > 0);
}

/**
 * Build the report. Everything the cloud receives comes out of here.
 *
 * @param {object} o
 *   shareId      stable random id for this rig (lets a re-share replace the old one)
 *   appVersion, platform, arch
 *   rig          the stored rig object (only listed fields are read)
 *   radioType    rig-editor radio type (lib/rig-setup-notes radioTypeFromCatTarget)
 *   family       lib/rig-family rigFamily() result
 *   modelInfo    RIG_MODELS entry (brand)
 *   result       evaluateChecklist() output for this rig
 *   live         stationSetupLive() output (measurements)
 *   levels       { jtcatTxGain, jtcatRxGain, txDrive }
 *   audioLabels  { input, output } — resolved by the renderer from device ids
 *   answers      { menuNotes, includeCallsign }
 *   callsign     the operator's callsign (sent only when includeCallsign)
 */
function buildSetupShare(o) {
  o = o || {};
  const rig = o.rig || {};
  const info = o.modelInfo || {};
  const live = o.live || {};
  const result = o.result || { steps: [] };
  const answers = o.answers || {};
  const levels = o.levels || {};
  const labels = o.audioLabels || {};
  const netAudio = rig.audioSource === 'smartsdr' || rig.audioSource === 'icom-network';

  const steps = {};
  for (const s of result.steps || []) steps[String(s.id)] = String(s.state);

  // A step can be "ok" because it passed in an EARLIER session (the
  // checklist shows "Worked on <date>"). The measurement from that pass is
  // kept on the rig (rig.setupMeasured) so the report still carries numbers;
  // txTestEvidence says what the transmit tick rests on (cloud question 2).
  const stored = rig.setupMeasured || {};
  const liveRx = live.rxTest && (live.rxTest.result === 'ok' || live.rxTest.result === 'low') ? live.rxTest : null;
  const rx = liveRx || stored.rx || null;
  const liveTx = live.txTest && live.txTest.result === 'ok' ? live.txTest : null;
  const tx = liveTx || stored.tx || null;
  const txMeasured = !!(tx && !tx.byOperator && num(tx.watts) > 0);
  const txEvidence = txMeasured ? 'measured' : (tx && tx.byOperator) ? 'operator' : 'unrecorded';
  const day = (ms) => (num(ms) ? new Date(ms).toISOString().slice(0, 10) : null);
  const clock = live.clock || null;

  const payload = {
    schema: SHARE_SCHEMA,
    shareId: str(o.shareId, 64),
    app: {
      version: str(o.appVersion, 32), platform: str(o.platform, 16), arch: str(o.arch, 16),
      channel: /-(beta|alpha|rc)\b/i.test(String(o.appVersion || '')) ? 'beta' : 'release',
    },
    radio: {
      model: str(rig.model, 60),
      brand: str(info.brand, 40),
      radioType: str(o.radioType, 30),
      family: str(o.family, 30),
    },
    cat: pickCat(rig.catTarget),
    cw: {
      keyLine: str(rig.cwKeyLine, 12) || null,
      // Whether a separate CW key port is in use, never its name.
      separateKeyPort: !!rig.cwKeyPort,
    },
    audio: {
      // Stored value as-is ('dax' = a local sound device on every family).
      source: str(rig.audioSource, 30) || null,
      inputLabel: netAudio ? null : (cleanLabel(labels.input) || null),
      outputLabel: netAudio ? null : (cleanLabel(labels.output) || null),
      // true = the device's name contained a person's name and was not sent
      labelsWithheld: !netAudio && (labelHasName(labels.input) || labelHasName(labels.output)),
      ft8TxLevelPct: num(levels.jtcatTxGain) != null ? Math.round(Math.sqrt(Math.max(0, Math.min(1, levels.jtcatTxGain))) * 100) : null,
      ft8RxLevelPct: num(levels.jtcatRxGain) != null ? Math.round(Math.max(0, Math.min(1, levels.jtcatRxGain)) * 100) : null,
      txDrivePct: num(rig.txDrive != null ? rig.txDrive : levels.txDrive),
    },
    measured: {
      rxDbfs: rx && Number.isFinite(rx.dbfs) ? Math.round(rx.dbfs) : null,
      rxTestOn: rx ? day(rx.at) : null,
      txTestWatts: txMeasured ? round(tx.watts) : null,
      txTestSwr: txMeasured && num(tx.swr) > 0 ? round(tx.swr) : null,
      txConfirmedByOperator: txEvidence === 'operator',
      // measured    the radio's own power readback during POTACAT's test
      // operator    the operator watched the radio's meter move (no CAT meter)
      // unrecorded  the step passed before POTACAT kept the numbers (1.10.23 betas)
      txTestEvidence: result.steps && result.steps.some(s => s.id === 'tx-test' && (s.state === 'ok' || s.state === 'confirmed')) ? txEvidence : null,
      txTestOn: tx ? day(tx.at) : null,
      clockOffsetMs: clock && Number.isFinite(clock.offsetMs) ? Math.round(clock.offsetMs) : null,
    },
    steps,
    confirmedNotes: (rig.setupDone || []).map(x => str(x, 60)).filter(Boolean).slice(0, 40),
    menuNotes: str(answers.menuNotes, MENU_NOTES_MAX) || null,
    callsign: answers.includeCallsign ? (str(o.callsign, 20).toUpperCase() || null) : null,
  };
  return payload;
}

/**
 * The same payload as plain-language lines for the preview — what the
 * operator reads before pressing Send. Every non-empty field appears.
 */
function describeShare(p) {
  if (!p) return [];
  const lines = [];
  const add = (label, value) => { if (value !== null && value !== undefined && value !== '') lines.push({ label, value: String(value) }); };
  add('Radio', [p.radio.brand, p.radio.model].filter(Boolean).join(' ') || 'not named');
  add('Connected by', describeConnection(p));
  if (p.cat.baudRate) add('CAT speed', `${p.cat.baudRate} baud`);
  if (p.cat.civAddress != null) add('CI-V address', p.cat.civAddress.toString(16).toUpperCase() + 'h');
  if (p.cat.rigId) add('Hamlib radio number', p.cat.rigId);
  if (p.cat.dtrOff) add('DTR held off', 'yes');
  if (p.cat.pttType) add('Separate PTT line', p.cat.pttType);
  if (p.cw.keyLine) add('CW key line', p.cw.keyLine + (p.cw.separateKeyPort ? ' (separate key port)' : ''));
  add('Audio', AUDIO_SOURCE_NAMES[p.audio.source] || p.audio.source);
  add('Audio input', p.audio.inputLabel);
  add('Audio output', p.audio.outputLabel);
  if (p.audio.labelsWithheld) add('Audio device name', "not sent (it contains a person's name)");
  if (p.audio.ft8TxLevelPct != null) add('FT8 transmit level', p.audio.ft8TxLevelPct + '%');
  if (p.audio.ft8RxLevelPct != null) add('FT8 receive level', p.audio.ft8RxLevelPct + '%');
  if (p.audio.txDrivePct != null) add('Remote transmit drive', p.audio.txDrivePct + '%');
  if (p.measured.rxDbfs != null) add('Listen test', p.measured.rxDbfs + ' dBFS');
  if (p.measured.txTestWatts != null) add('Test transmit', `${p.measured.txTestWatts} W` + (p.measured.txTestSwr ? `, SWR ${p.measured.txTestSwr}` : ''));
  if (p.measured.txConfirmedByOperator) add('Test transmit', 'you saw the power meter move');
  if (p.measured.txTestEvidence === 'unrecorded') add('Test transmit', 'worked earlier (no reading kept)');
  if (p.measured.clockOffsetMs != null) add('Clock', `off by ${Math.abs(p.measured.clockOffsetMs)} ms`);
  const working = Object.values(p.steps).filter(s => s === 'ok' || s === 'confirmed').length;
  add('Checklist', `${working} of ${Object.keys(p.steps).length} steps working`);
  if (p.confirmedNotes.length) add('Menu settings you confirmed', p.confirmedNotes.length);
  add('Your note about the radio\'s menus', p.menuNotes);
  add('Callsign', p.callsign || 'not included');
  add('POTACAT', `${p.app.version}${p.app.channel === 'beta' ? ' (beta)' : ''} on ${platformName(p.app.platform)}`);
  return lines;
}

const AUDIO_SOURCE_NAMES = {
  dax: 'sound card on this computer', smartsdr: 'FlexRadio network audio', 'icom-network': 'Icom network audio',
};

function platformName(p) { return p === 'win32' ? 'Windows' : p === 'darwin' ? 'Mac' : p === 'linux' ? 'Linux' : p || 'unknown'; }

function describeConnection(p) {
  const t = p.cat.type || '';
  const byType = {
    serial: 'USB cable (serial CAT)', icom: 'USB cable (Icom CI-V)', 'civ-tcp': 'network (CI-V over TCP)',
    'icom-network': 'network (Icom LAN)', rigctld: 'USB cable through Hamlib', rigctldnet: 'Hamlib on another computer',
    tcp: p.radio.family === 'flex' ? 'network (FlexRadio)' : 'network (TCP CAT)', 'k4-network': 'network (Elecraft K4)',
  };
  return byType[t] || (p.radio.radioType === 'flex' ? 'network (FlexRadio)' : t);
}

/**
 * Fingerprint of what a share SAYS (not when it was made), so the checklist
 * can show "Shared" until the setup actually changes.
 */
function shareFingerprint(p) {
  if (!p) return '';
  const copy = JSON.parse(JSON.stringify(p));
  delete copy.app; delete copy.measured; delete copy.shareId;
  const s = JSON.stringify(copy);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

/**
 * Deliveries that failed are kept and retried; this decides which survive.
 * One pending share per shareId (the newest wins), none older than 30 days.
 */
function prunePending(list, now = Date.now()) {
  const byId = new Map();
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || !e.payload || !e.queuedAt) continue;
    if (now - e.queuedAt > PENDING_MAX_AGE_MS) continue;
    const k = e.payload.shareId || '';
    const prev = byId.get(k);
    if (!prev || e.queuedAt > prev.queuedAt) byId.set(k, e);
  }
  return [...byId.values()].sort((a, b) => a.queuedAt - b.queuedAt).slice(-PENDING_MAX);
}

/**
 * What to do with a delivery attempt's outcome.
 *   'sent'    2xx — done, record it
 *   'drop'    400 or 413 ONLY — our route refused THIS payload, and the same
 *             bytes can only fail again
 *   'retry'   everything else: no network, 404 (route not deployed), 429,
 *             5xx, and the codes Cloudflare can answer in front of the route
 *             (403 challenge, 405, 415, 52x) — none of them is a verdict on
 *             the report (cloud question 1, 2026-09-25)
 */
function deliveryOutcome(statusCode) {
  if (statusCode >= 200 && statusCode < 300) return 'sent';
  if (statusCode === 400 || statusCode === 413) return 'drop';
  return 'retry';
}

// Seconds between queued deliveries at launch: a club station behind one
// NAT address shares the cloud's per-IP hourly limit (cloud question 4).
const FLUSH_SPACING_MS = 2000;

module.exports = {
  SHARE_SCHEMA, SHARE_URL, MENU_NOTES_MAX, PENDING_MAX_AGE_MS, PENDING_MAX, CAT_FIELDS, FLUSH_SPACING_MS,
  eligibleToShare, labelHasName, buildSetupShare, describeShare, shareFingerprint, prunePending, deliveryOutcome,
};
