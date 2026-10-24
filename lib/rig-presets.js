/**
 * Rig presets — a named set of rig settings that is applied in one go, by a
 * tap on any surface or automatically when the radio moves into a BAND and
 * MODE the preset is assigned to.
 *
 * Why this exists (a POTA hunter, 2026-10-21): SSB hunting runs 100 W with the
 * RF gain up and the speaker on; FT8 wants 60 W, RF gain near 50 % and the
 * speaker silent. Forgetting the power step before an FT8 session started
 * from a phone over ECHOCAT is the one that can hurt the radio, and the
 * wrong level is easier to miss on a phone.
 *
 * Grown on 2026-10-24 (a user through Casey: "when the Digi tab is selected,
 * turn off the noise blanker, noise reduction, the compressor, set TX power,
 * set the RX filter to 3 kHz …; allow each function to be enabled or
 * disabled; apply by condition — 20 m SSB this, 40 m SSB that — though most
 * people want all SSB on one profile and all digital on another"):
 *  - FIELDS covers switches (NB, NR, compressor, auto-notch, VOX, preamp,
 *    attenuator), choices (AGC), widths (RX filter) and levels. A preset holds
 *    only the fields the operator INCLUDED; everything else is left alone.
 *  - Triggers are RULES: `{ bands: [...] (empty = any band), families: [...]
 *    (empty = any mode), presetId }`, first match wins. The five per-family
 *    selects every surface shows are the simple form (byMode) and are the
 *    fallback when no rule matches, so "all SSB → A, all digital → B" needs
 *    no rule at all, and "20 m SSB → C" is one rule on top.
 *  - A preset is applied when the MATCH changes (a band change can change it
 *    now, not only a family change), never on the first dial seen, never
 *    under a key-down.
 *
 * Deliberately NOT a VFO profile: a VFO profile is a place (frequency, mode)
 * and every client drops a profile with no frequency — a preset is a way of
 * running the radio wherever it is tuned. A VFO profile may still carry its
 * own txPower, as before.
 *
 * Pure and dual-mode (require + window.RigPresets): main.js applies the
 * decisions, the VFO window, the Rig menu, Settings > Profiles and ECHOCAT Web
 * render the same model, test/rig-presets-test.js holds the rules.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RigPresets = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Mode families a preset can be assigned to, in display order. */
  var FAMILIES = ['ssb', 'cw', 'digital', 'fm', 'am'];
  var FAMILY_LABELS = { ssb: 'SSB', cw: 'CW', digital: 'Digital (FT8, JS8, PSK, RTTY, …)', fm: 'FM', am: 'AM' };
  var FAMILY_SHORT = { ssb: 'SSB', cw: 'CW', digital: 'Digital', fm: 'FM', am: 'AM' };
  /** Bands a rule may name, in display order. */
  var BANDS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '2m', '70cm'];
  var AGC_MODES = ['off', 'auto', 'fast', 'med', 'slow'];

  /**
   * The settings a preset can hold. `cap` is the rig capability that says the
   * radio takes the setting at all; a preset field the rig cannot set is kept
   * (the preset may be for another radio one day) but never sent. `kind`:
   * 'level' (a number with a unit), 'switch' (on/off), 'choice' (one of
   * `options`), 'width' (Hz).
   */
  var FIELDS = [
    { key: 'txPower', label: 'TX power', unit: 'W', kind: 'level', cap: 'txpower', min: 0, max: 2000, action: 'set-tx-power', group: 'tx' },
    { key: 'rfGain', label: 'RF gain', unit: '%', kind: 'level', cap: 'rfgain', min: 0, max: 100, action: 'set-rf-gain', group: 'rx' },
    { key: 'afGain', label: 'AF gain', unit: '%', kind: 'level', cap: 'afgain', min: 0, max: 100, action: 'set-af-gain', group: 'rx' },
    { key: 'filterWidth', label: 'RX filter', unit: 'Hz', kind: 'width', cap: 'filter', min: 50, max: 20000, action: 'set-filter-width', group: 'rx' },
    { key: 'nb', label: 'Noise blanker', kind: 'switch', cap: 'nb', action: 'set-nb', group: 'rx' },
    { key: 'nr', label: 'Noise reduction', kind: 'switch', cap: 'nr', action: 'set-nr', group: 'rx' },
    { key: 'anf', label: 'Auto notch', kind: 'switch', cap: 'anf', action: 'set-anf', group: 'rx' },
    { key: 'agc', label: 'AGC', kind: 'choice', cap: 'agc', options: AGC_MODES, action: 'set-agc', group: 'rx' },
    { key: 'preamp', label: 'Preamp', kind: 'switch', cap: 'preamp', action: 'set-preamp', group: 'rx' },
    { key: 'att', label: 'Attenuator', kind: 'switch', cap: 'att', action: 'set-att', group: 'rx' },
    { key: 'comp', label: 'Compressor / processor', kind: 'switch', cap: 'comp', action: 'set-comp', group: 'tx' },
    { key: 'vox', label: 'VOX', kind: 'switch', cap: 'vox', action: 'set-vox', group: 'tx' },
    // Transmit monitor (K8IKO 2026-10-24): hear your own signal on SSB, silence it for FT8.
    { key: 'mon', label: 'Monitor (MON)', kind: 'switch', cap: 'mon', action: 'set-mon', group: 'tx' },
    { key: 'monLevel', label: 'Monitor level', unit: '%', kind: 'level', cap: 'monLevel', min: 0, max: 100, action: 'set-mon-level', group: 'tx' },
  ];
  var FIELD_BY_KEY = {};
  FIELDS.forEach(function (f) { FIELD_BY_KEY[f.key] = f; });

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

  /** The stored value of a field from any inbound value, or undefined = not held. */
  function cleanField(f, v) {
    if (v === undefined || v === null || v === '') return undefined;
    if (f.kind === 'switch') {
      if (typeof v === 'boolean') return v;
      var s = String(v).toLowerCase();
      if (s === 'on' || s === 'true' || s === '1') return true;
      if (s === 'off' || s === 'false' || s === '0') return false;
      return undefined;
    }
    if (f.kind === 'choice') {
      var c = String(v).toLowerCase();
      return f.options.indexOf(c) >= 0 ? c : undefined;
    }
    var n = cleanNumber(v, f);
    return n === undefined ? undefined : (f.kind === 'width' ? Math.round(n) : n);
  }

  /**
   * Coerce any inbound list (settings file, a phone, the web) into a clean
   * preset list. Junk entries are dropped, every preset gets an id, values
   * outside a field's range are dropped from that preset (never sent to a
   * radio), unknown keys are kept. A preset with a name and no field at all
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
        var v = cleanField(f, p[f.key]);
        if (v === undefined) delete clean[f.key]; else clean[f.key] = v;
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

  /**
   * `{ [rigId or '*']: [ { bands: [], families: [], presetId } ] }` — the
   * nuanced triggers. Unknown bands/families and presets that no longer exist
   * are dropped; a rule with no preset, or naming nothing at all (any band,
   * any mode — that is what byMode is for), is dropped. At most 40 per rig.
   */
  function sanitizeRules(obj, presets) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    var ids = {};
    (presets || []).forEach(function (p) { ids[p.id] = true; });
    var out = {};
    for (var rig in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, rig)) continue;
      var list = obj[rig];
      if (!Array.isArray(list)) continue;
      var clean = [];
      for (var i = 0; i < list.length && clean.length < 40; i++) {
        var r = list[i];
        if (!r || typeof r !== 'object') continue;
        var presetId = typeof r.presetId === 'string' ? r.presetId : '';
        if (!presetId || (presets && !ids[presetId])) continue;
        var bands = Array.isArray(r.bands) ? r.bands.map(function (b) { return String(b).toLowerCase(); }).filter(function (b) { return BANDS.indexOf(b) >= 0; }) : [];
        var fams = Array.isArray(r.families) ? r.families.map(function (x) { return String(x).toLowerCase(); }).filter(function (x) { return FAMILIES.indexOf(x) >= 0; }) : [];
        if (!bands.length && !fams.length) continue;
        clean.push({ bands: bands, families: fams, presetId: presetId });
      }
      if (clean.length) out[String(rig)] = clean;
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

  /** The rule list for a rig: its own, else the any-rig list. */
  function rulesForRig(rules, rigId) {
    var m = rules || {};
    return m[rigKey(rigId)] || m['*'] || [];
  }

  function findPreset(presets, id) {
    for (var i = 0; i < (presets || []).length; i++) if (presets[i].id === id) return presets[i];
    return null;
  }

  /**
   * Which preset the triggers choose for a band + family on a rig: the first
   * rule whose bands (or any) and families (or any) both match, else the
   * family's byMode entry, else null. Returns { presetId, via: 'rule'|'family'|null, rule }.
   */
  function matchTrigger(input) {
    var i = input || {};
    var band = i.band ? String(i.band).toLowerCase() : '';
    var family = i.family || null;
    var rules = rulesForRig(i.rules, i.rigId);
    for (var r = 0; r < rules.length; r++) {
      var rule = rules[r];
      if (rule.bands.length && (!band || rule.bands.indexOf(band) < 0)) continue;
      if (rule.families.length && (!family || rule.families.indexOf(family) < 0)) continue;
      return { presetId: rule.presetId, via: 'rule', rule: rule };
    }
    if (family) {
      var map = byModeForRig(i.byMode, i.rigId);
      if (map[family]) return { presetId: map[family], via: 'family', rule: null };
    }
    return { presetId: null, via: null, rule: null };
  }

  /**
   * What the dispatcher sends for a preset on a rig with these capabilities:
   * one `{action, value, field}` per setting the preset holds AND the rig
   * takes. No caps = every held setting.
   */
  function presetCommands(preset, caps) {
    var out = [];
    if (!preset) return out;
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      var v = preset[f.key];
      if (v === undefined || v === null) continue;
      if (f.kind === 'switch' && typeof v !== 'boolean') continue;
      if (f.kind === 'choice' && f.options.indexOf(v) < 0) continue;
      if ((f.kind === 'level' || f.kind === 'width') && !(typeof v === 'number' && Number.isFinite(v))) continue;
      if (caps && !caps[f.cap]) continue;
      out.push({ action: f.action, value: v, field: f.key });
    }
    return out;
  }

  var SHORT = { nb: 'NB', nr: 'NR', anf: 'Notch', comp: 'Comp', vox: 'VOX', preamp: 'Preamp', att: 'ATT', mon: 'MON', monLevel: 'MON' };
  function formatValue(f, v) {
    if (f.kind === 'switch') return (SHORT[f.key] || f.label) + (v ? ' on' : ' off');
    if (f.kind === 'choice') return f.label + ' ' + String(v);
    if (f.kind === 'width') return 'Filter ' + (v >= 1000 ? (Math.round(v / 100) / 10) + ' kHz' : v + ' Hz');
    if (typeof v !== 'number') return '';
    var s = (Math.round(v * 10) / 10).toString();
    return f.key === 'txPower' ? s + ' W' : (SHORT[f.key] || f.label.split(' ')[0]) + ' ' + s + '%';
  }

  /** `60 W · RF 50% · NB off · Filter 3 kHz` — the detail line under a preset
   *  name. Settings the rig cannot set are listed separately (`skipped`). */
  function describePreset(preset, caps) {
    var parts = [];
    var skipped = [];
    if (!preset) return { text: '', skipped: skipped };
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      var v = preset[f.key];
      if (v === undefined || v === null) continue;
      if (f.kind === 'switch' && typeof v !== 'boolean') continue;
      var txt = formatValue(f, v);
      if (!txt) continue;
      if (caps && !caps[f.cap]) skipped.push(txt); else parts.push(txt);
    }
    return { text: parts.join(' · '), skipped: skipped };
  }

  /** One line for a rule: "20 m · SSB → Hunting", "any band · Digital → FT8". */
  function describeRule(rule, presets) {
    if (!rule) return '';
    var p = findPreset(presets, rule.presetId);
    var bands = rule.bands.length ? rule.bands.map(function (b) { return b.replace(/m$/, ' m'); }).join(', ') : 'any band';
    var fams = rule.families.length ? rule.families.map(function (f) { return FAMILY_SHORT[f] || f; }).join(', ') : 'any mode';
    return bands + ' · ' + fams + ' → ' + (p ? p.name : '?');
  }

  /**
   * Build a preset from the radio's live state. A setting the radio has not
   * reported (null/undefined, or TX power 0 = unknown) is left out rather
   * than saved as a value the operator never chose. AF gain is set-only on
   * every CAT protocol POTACAT speaks, so it is included only when the
   * caller has a value it sent itself. `state` keys follow FIELDS.
   */
  function snapshotPreset(name, state, opts) {
    var o = opts || {};
    var p = { id: newId(), name: String(name == null ? '' : name).trim().slice(0, 40) };
    if (!p.name) return null;
    if (o.rigId != null && o.rigId !== '') p.rigId = String(o.rigId);
    var s = state || {};
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      var v = s[f.key];
      if (f.key === 'txPower' && !(typeof v === 'number' && v > 0)) continue;
      var c = cleanField(f, v);
      if (c !== undefined) p[f.key] = c;
    }
    return p;
  }

  /**
   * The trigger decision. Called with every mode the rig reports AND every
   * band change; applies a preset when the trigger MATCH changes (a new
   * family, or a band a rule cares about). Returns
   *   { family, matchId, apply: preset|null, reason }
   * reason: 'remote' (a laptop driving a shack — the shack applies its own),
   * 'no-family' (a VFO/memory name; the previous state is kept), 'first' (the
   * first mode seen this session is never an occasion to move levels),
   * 'same' (the match did not change), 'transmitting' (never move settings
   * under a key-down — the caller re-asks after the unkey; SSB-over-DATA on
   * an Icom flips USB to USB-D for exactly the length of a voice PTT),
   * 'unassigned' (the context has no preset), 'apply'.
   * `prevMatchId` is the preset last chosen for the previous context (null =
   * none); `prevFamily` the family tracked so far.
   */
  function decideModePreset(input) {
    var i = input || {};
    var family = modeFamily(i.mode);
    if (i.remote) return { family: family, matchId: i.prevMatchId || null, apply: null, reason: 'remote' };
    if (!family) return { family: i.prevFamily || null, matchId: i.prevMatchId || null, apply: null, reason: 'no-family' };
    if (!i.prevFamily) return { family: family, matchId: null, apply: null, reason: 'first' };
    var mine = presetsForRig(i.presets, i.rigId);
    var m = matchTrigger({ band: i.band, family: family, rules: i.rules, byMode: i.byMode, rigId: i.rigId });
    var preset = m.presetId ? findPreset(mine, m.presetId) : null;
    var matchId = preset ? preset.id : null;
    // A caller that tracks only the family (the pre-rules contract) gets the
    // previous match derived from it, on the same band.
    var prev = i.prevMatchId;
    if (prev === undefined) {
      var pm = matchTrigger({ band: i.prevBand === undefined ? i.band : i.prevBand, family: i.prevFamily, rules: i.rules, byMode: i.byMode, rigId: i.rigId });
      prev = pm.presetId && findPreset(mine, pm.presetId) ? pm.presetId : null;
    }
    if (family === i.prevFamily && matchId === prev) return { family: family, matchId: matchId, apply: null, reason: 'same' };
    if (!preset) return { family: family, matchId: null, apply: null, reason: 'unassigned' };
    if (matchId === prev) return { family: family, matchId: matchId, apply: null, reason: 'same' };
    if (i.transmitting) return { family: i.prevFamily, matchId: prev, apply: null, reason: 'transmitting' };
    return { family: family, matchId: matchId, apply: preset, reason: 'apply', via: m.via };
  }

  return {
    FAMILIES: FAMILIES,
    FAMILY_LABELS: FAMILY_LABELS,
    FAMILY_SHORT: FAMILY_SHORT,
    BANDS: BANDS,
    AGC_MODES: AGC_MODES,
    FIELDS: FIELDS,
    FIELD_BY_KEY: FIELD_BY_KEY,
    modeFamily: modeFamily,
    newId: newId,
    cleanField: cleanField,
    sanitizePresets: sanitizePresets,
    sanitizeByMode: sanitizeByMode,
    sanitizeRules: sanitizeRules,
    presetsForRig: presetsForRig,
    byModeForRig: byModeForRig,
    rulesForRig: rulesForRig,
    rigKey: rigKey,
    findPreset: findPreset,
    matchTrigger: matchTrigger,
    presetCommands: presetCommands,
    formatValue: formatValue,
    describePreset: describePreset,
    describeRule: describeRule,
    snapshotPreset: snapshotPreset,
    decideModePreset: decideModePreset,
  };
});
