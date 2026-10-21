/**
 * Rig presets — a named set of rig levels (TX power, RF gain, AF gain) that
 * is applied in one go, by a tap on any surface or automatically when the
 * radio's mode moves into a mode FAMILY the preset is assigned to.
 *
 * Why this exists (a POTA hunter, 2026-10-21): SSB hunting runs 100 W with the
 * RF gain up and the speaker on; FT8 wants 60 W, RF gain near 50 % and the
 * speaker silent. Forgetting the power step before an FT8 session started
 * from a phone over ECHOCAT is the one that can hurt the radio, and the
 * wrong level is easier to miss on a phone.
 *
 * Deliberately NOT a VFO profile: a VFO profile is a place (frequency, mode)
 * and every client drops a profile with no frequency — a preset is a way of
 * running the radio wherever it is tuned. A VFO profile may still carry its
 * own txPower, as before.
 *
 * Pure and dual-mode (require + window.RigPresets): main.js applies the
 * decisions, the VFO window, the Rig menu and ECHOCAT Web render the same
 * model, test/rig-presets-test.js holds the rules.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RigPresets = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Mode families a preset can be assigned to, in display order. */
  var FAMILIES = ['ssb', 'cw', 'digital', 'fm', 'am'];
  var FAMILY_LABELS = { ssb: 'SSB', cw: 'CW', digital: 'Digital (FT8, JS8, PSK, RTTY, …)', fm: 'FM', am: 'AM' };

  /**
   * The levels a preset can hold. `cap` is the rig capability that says the
   * radio takes the level at all; a preset field the rig cannot set is kept
   * (the preset may be for another radio one day) but never sent.
   */
  var FIELDS = [
    { key: 'txPower', label: 'TX power', unit: 'W', cap: 'txpower', min: 0, max: 2000, action: 'set-tx-power' },
    { key: 'rfGain', label: 'RF gain', unit: '%', cap: 'rfgain', min: 0, max: 100, action: 'set-rf-gain' },
    { key: 'afGain', label: 'AF gain', unit: '%', cap: 'afgain', min: 0, max: 100, action: 'set-af-gain' },
  ];

  /** Rig mode → family, or null for a mode no family claims (a memory/VFO
   *  name, an empty string, FreeDV's display label). */
  function modeFamily(mode) {
    var m = String(mode == null ? '' : mode).trim().toUpperCase();
    if (!m) return null;
    if (m === 'USB' || m === 'LSB' || m === 'SSB') return 'ssb';
    if (m === 'CW' || m === 'CWR' || m === 'CW-R' || m === 'CWL' || m === 'CWU') return 'cw';
    if (m === 'FM' || m === 'FMN' || m === 'WFM' || m === 'FM-D' || m === 'DV' || m === 'DSTAR') return 'fm';
    if (m === 'AM' || m === 'AMN' || m === 'AM-D' || m === 'SAM') return 'am';
    if (/^(USB|LSB)-D\d?$/.test(m)) return 'digital';
    if (m === 'DIGU' || m === 'DIGL' || m === 'DATA' || m === 'DATA-U' || m === 'DATA-L') return 'digital';
    if (m === 'PKTUSB' || m === 'PKTLSB' || m === 'PKTFM' || m === 'PKT') return 'digital';
    if (m === 'RTTY' || m === 'RTTYR' || m === 'RTTY-R' || m === 'FSK' || m === 'FSK-R' || m === 'PSK' || m === 'PSKR') return 'digital';
    if (/^(FT8|FT4|FT2|JS8|JTTY|PSK\d+|WSPR|DIGITAL|FREEDV)/.test(m)) return 'digital';
    return null;
  }

  function newId() {
    return 'rp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function cleanNumber(v, f) {
    var n = Number(v);
    if (v === '' || v == null || !Number.isFinite(n)) return undefined;
    if (n < f.min || n > f.max) return undefined;
    return Math.round(n * 10) / 10;
  }

  /**
   * Coerce any inbound list (settings file, a phone, the web) into a clean
   * preset list. Junk entries are dropped, every preset gets an id, levels
   * outside the field's range are dropped from that preset (never sent to a
   * radio), unknown keys are kept. A preset with a name and no level at all
   * is kept: the operator can fill it in.
   */
  function sanitizePresets(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
      var clean = {};
      for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) clean[k] = p[k];
      clean.name = String(p.name == null ? '' : p.name).trim().slice(0, 40);
      if (!clean.name) continue;
      clean.id = (typeof p.id === 'string' && p.id && !seen[p.id]) ? p.id : newId();
      seen[clean.id] = true;
      if (p.rigId != null && p.rigId !== '') clean.rigId = String(p.rigId); else delete clean.rigId;
      for (var j = 0; j < FIELDS.length; j++) {
        var f = FIELDS[j];
        var n = cleanNumber(p[f.key], f);
        if (n === undefined) delete clean[f.key]; else clean[f.key] = n;
      }
      out.push(clean);
      if (out.length >= 100) break;
    }
    return out;
  }

  /** `{ [rigId or '*']: { family: presetId } }`, unknown families and
   *  presets that no longer exist dropped. */
  function sanitizeByMode(obj, presets) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    var ids = {};
    (presets || []).forEach(function (p) { ids[p.id] = true; });
    var out = {};
    for (var rig in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, rig)) continue;
      var m = obj[rig];
      if (!m || typeof m !== 'object') continue;
      var cleanMap = {};
      var any = false;
      for (var i = 0; i < FAMILIES.length; i++) {
        var fam = FAMILIES[i];
        var id = m[fam];
        if (typeof id === 'string' && id && (!presets || ids[id])) { cleanMap[fam] = id; any = true; }
      }
      if (any) out[String(rig)] = cleanMap;
    }
    return out;
  }

  /** The presets that apply to a rig: saved for that rig, or for any rig. */
  function presetsForRig(presets, rigId) {
    var rid = rigId == null ? '' : String(rigId);
    return (presets || []).filter(function (p) { return !p.rigId || p.rigId === rid; });
  }

  function rigKey(rigId) { return rigId == null || rigId === '' ? '*' : String(rigId); }

  /** The family → preset map for a rig: its own map, else the any-rig map. */
  function byModeForRig(byMode, rigId) {
    var m = byMode || {};
    return m[rigKey(rigId)] || m['*'] || {};
  }

  function findPreset(presets, id) {
    for (var i = 0; i < (presets || []).length; i++) if (presets[i].id === id) return presets[i];
    return null;
  }

  /**
   * What the dispatcher sends for a preset on a rig with these capabilities:
   * one `{action, value, field}` per level the preset holds AND the rig
   * takes. No caps = every held level.
   */
  function presetCommands(preset, caps) {
    var out = [];
    if (!preset) return out;
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      var v = preset[f.key];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (caps && !caps[f.cap]) continue;
      out.push({ action: f.action, value: v, field: f.key });
    }
    return out;
  }

  function formatLevel(f, v) {
    if (typeof v !== 'number') return '';
    var s = (Math.round(v * 10) / 10).toString();
    return f.key === 'txPower' ? s + ' W' : f.label.split(' ')[0] + ' ' + s + '%';
  }

  /** `60 W · RF 50% · AF 0%` — the detail line under a preset name. Levels
   *  the rig cannot set are shown struck through by the caller (`skipped`). */
  function describePreset(preset, caps) {
    var parts = [];
    var skipped = [];
    if (!preset) return { text: '', skipped: skipped };
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      var v = preset[f.key];
      if (typeof v !== 'number') continue;
      var txt = formatLevel(f, v);
      if (caps && !caps[f.cap]) skipped.push(txt); else parts.push(txt);
    }
    return { text: parts.join(' · '), skipped: skipped };
  }

  /**
   * Build a preset from the radio's live levels. A level the radio has not
   * reported (null/undefined, or TX power 0 = unknown) is left out rather
   * than saved as a number the operator never chose. AF gain is set-only on
   * every CAT protocol POTACAT speaks, so it is included only when the
   * caller has a value it sent itself.
   */
  function snapshotPreset(name, state, opts) {
    var o = opts || {};
    var p = { id: newId(), name: String(name == null ? '' : name).trim().slice(0, 40) };
    if (!p.name) return null;
    if (o.rigId != null && o.rigId !== '') p.rigId = String(o.rigId);
    var s = state || {};
    if (typeof s.txPower === 'number' && s.txPower > 0) p.txPower = s.txPower;
    if (typeof s.rfGain === 'number' && Number.isFinite(s.rfGain)) p.rfGain = s.rfGain;
    if (typeof s.afGain === 'number' && Number.isFinite(s.afGain)) p.afGain = s.afGain;
    return p;
  }

  /**
   * The mode-change decision. Called with every mode the rig reports; only a
   * change of FAMILY (SSB → digital, not USB → LSB) can apply a preset, and
   * only when the operator assigned one to the new family. Returns
   *   { family, apply: preset|null, reason }
   * reason: 'remote' (a laptop driving a shack — the shack applies its own),
   * 'no-family' (a VFO/memory name; the previous family is kept), 'same',
   * 'first' (the first mode seen this session is never an occasion to move
   * levels), 'transmitting' (never move TX power under a key-down — the
   * caller re-asks after the unkey; SSB-over-DATA on an Icom flips USB to
   * USB-D for exactly the length of a voice PTT), 'unassigned', 'apply'.
   */
  function decideModePreset(input) {
    var i = input || {};
    var family = modeFamily(i.mode);
    if (i.remote) return { family: family, apply: null, reason: 'remote' };
    if (!family) return { family: i.prevFamily || null, apply: null, reason: 'no-family' };
    if (!i.prevFamily) return { family: family, apply: null, reason: 'first' };
    if (family === i.prevFamily) return { family: family, apply: null, reason: 'same' };
    if (i.transmitting) return { family: i.prevFamily, apply: null, reason: 'transmitting' };
    var map = byModeForRig(i.byMode, i.rigId);
    var preset = map[family] ? findPreset(presetsForRig(i.presets, i.rigId), map[family]) : null;
    if (!preset) return { family: family, apply: null, reason: 'unassigned' };
    return { family: family, apply: preset, reason: 'apply' };
  }

  return {
    FAMILIES: FAMILIES,
    FAMILY_LABELS: FAMILY_LABELS,
    FIELDS: FIELDS,
    modeFamily: modeFamily,
    newId: newId,
    sanitizePresets: sanitizePresets,
    sanitizeByMode: sanitizeByMode,
    presetsForRig: presetsForRig,
    byModeForRig: byModeForRig,
    rigKey: rigKey,
    findPreset: findPreset,
    presetCommands: presetCommands,
    describePreset: describePreset,
    snapshotPreset: snapshotPreset,
    decideModePreset: decideModePreset,
  };
});
