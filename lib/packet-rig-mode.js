/**
 * "Packet mode on the radio", per rig (GitHub #128): which FM mode a Winlink
 * packet (or VARA FM) session puts the radio in — plain FM, or the radio's
 * own FM data mode — and how POTACAT gets it there.
 *
 * The one resolver. Session start, the key-down, the rig editor and the log
 * all read resolvePacketRigMode(); nothing else decides a packet mode.
 *
 * Rules:
 *   - "Automatic" is what POTACAT did before this setting existed, for every
 *     radio: an Icom is asked for FM-D, everything else stays in plain FM. A
 *     family gains an Automatic default only with a source in LINKS below.
 *   - "FM data" is asked over CAT only where one of POTACAT's own codecs has
 *     a mode for it (the `source` of each row). Everywhere else the operator
 *     sets it on the radio and POTACAT leaves the radio's mode alone.
 *   - No radio menu path lives here. Setup steps are lib/rig-setup-notes.js.
 *
 * SHARED between main, the renderer and tests (dual-mode like
 * lib/rig-family.js: require() gets module.exports, a <script> tag gets
 * window.PacketRigMode). Pure: no DOM, no Node.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PacketRigMode = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CHOICES = ['auto', 'fm', 'fmdata'];
  var LABELS = { auto: 'Automatic', fm: 'FM (voice)', fmdata: 'FM data' };
  var SETTING_LABEL = 'Packet mode on the radio';
  var SETTING_HELP = 'The mode the radio is in while Winlink sends packet (and VARA FM). FM (voice) suits an interface on the microphone jack, or a radio that takes its rear or USB audio in FM. FM data is the radio\'s own data or packet FM mode, for a radio that takes rear or USB audio only there. Automatic: FM data on an Icom, FM (voice) on every other radio. The mode the radio was in comes back when the session is over.';

  /**
   * How "FM data" reaches the radio on each kind of CAT link.
   *   dataMode  the POTACAT mode name sent (null: POTACAT has no command for it)
   *   radioName what the radio or the control program calls it
   *   confirm   can the radio's own report show the mode took?
   *   source    where dataMode comes from — the codec's own table
   */
  var LINKS = {
    civ: {
      name: 'Icom CI-V', dataMode: 'DIGFM', radioName: 'FM-D', confirm: true,
      source: 'lib/codecs/civ-codec.js CIV_MODES: DIGFM is FM (05) with the DATA flag on; in use for packet since 1.14.3',
    },
    hamlib: {
      name: 'Hamlib (rigctld)', dataMode: 'DIGFM', radioName: 'PKTFM', confirm: true,
      source: 'lib/codecs/rigctld-codec.js RIGCTLD_MODES: DIGFM is sent as Hamlib\'s PKTFM. Hamlib decides whether the radio takes it: NA4DQ\'s IC-7100 stayed in FM (#300)',
    },
    flrig: {
      name: 'flrig', dataMode: 'PKTFM', radioName: 'FM-D, DATA-FM or PKT-FM', confirm: true,
      source: 'lib/codecs/flrig-codec.js MODE_CANDIDATES.PKTFM: the first of FM-D, DATA-FM, PKT-FM, DATA-FMN that flrig lists for the radio',
    },
    'yaesu-legacy': {
      name: 'Yaesu FT-817/818/857/897', dataMode: 'PKTFM', radioName: 'PKT', confirm: false,
      source: 'lib/codecs/yaesu-legacy-codec.js MODES: PKTFM is mode byte 0C, which the radio reads back as FM; N5XHI (#128): the FT-857D manual names PKT for packet',
    },
    yaesu: { name: 'Yaesu', dataMode: null, radioName: 'FM data', confirm: false, source: 'lib/codecs/kenwood-codec.js YAESU_MODES has no FM data entry' },
    kenwood: { name: 'Kenwood, Elecraft and TS-2000 style', dataMode: null, radioName: 'FM data', confirm: false, source: 'lib/codecs/kenwood-codec.js KENWOOD_MODES: FM is sent with DATA off, and there is no FM data entry' },
    commander: { name: 'DXLab Commander', dataMode: null, radioName: 'FM data', confirm: false, source: 'lib/codecs/commander-codec.js TOKEN_TO_COMMANDER has no FM data mode' },
    flex: { name: 'FlexRadio', dataMode: null, radioName: 'FM data', confirm: false, source: 'no FM data mode is sent to a Flex by POTACAT' },
    none: { name: 'No CAT control', dataMode: null, radioName: 'FM data', confirm: false, source: 'no CAT link: the operator sets the radio by hand (lib/winlink-modes.js noCatNote)' },
  };

  /**
   * The kind of CAT link, from what the rig is.
   * @param {object} o
   * @param {string} o.family    RigFamily.rigFamily(rig) / familyFromRadioType(editor value)
   * @param {string} [o.brand]   the model's brand (lib/rig-models.js)
   * @param {string} [o.protocol] the model's protocol ('civ' | 'kenwood' | 'yaesu-legacy' | ...)
   */
  function linkOf(o) {
    o = o || {};
    var f = String(o.family || 'none');
    if (f === 'none') return 'none';
    if (f === 'flex') return 'flex';
    if (f === 'icom' || f === 'icom-network') return 'civ';
    if (f === 'hamlib' || f === 'rigctld') return 'hamlib';
    if (f === 'flrig') return 'flrig';
    if (f === 'commander') return 'commander';
    if (f === 'yaesu-lan') return 'yaesu';
    if (f === 'serial') {
      if (o.protocol === 'yaesu-legacy') return 'yaesu-legacy';
      if (o.protocol === 'civ') return 'civ';
      if (o.brand === 'Yaesu') return 'yaesu';
      return 'kenwood';
    }
    return 'kenwood'; // k4, generic TCP CAT: the Kenwood codec
  }

  function normalizeChoice(v) {
    return v === 'fm' || v === 'fmdata' ? v : 'auto';
  }

  /**
   * Automatic, exactly as before the setting: an Icom on its own CI-V link or
   * behind Hamlib is asked for FM-D once per session. An Icom behind flrig or
   * Commander was sent a mode name those codecs do not know, so it stayed in
   * FM; it still does. Every other radio: FM.
   */
  function automaticWant(link, brand) {
    if (link === 'civ') return 'fmdata';
    if (link === 'hamlib' && brand === 'Icom') return 'fmdata';
    return 'fm';
  }

  /**
   * @param {object} o
   * @param {string} [o.choice]  rig.packetMode ('fm' | 'fmdata'; anything else is Automatic)
   * @param {string} o.family    RigFamily family
   * @param {string} [o.brand]
   * @param {string} [o.protocol]
   * @returns {{choice:string, want:'fm'|'fmdata', link:string, linkName:string,
   *   dataMode:string|null, radioName:string, byHand:boolean, confirm:boolean,
   *   label:string, note:string, source:string}}
   *   want      the mode the session runs in
   *   dataMode  the mode name POTACAT sends after the FM tune (null: none)
   *   byHand    FM data was asked for and POTACAT cannot set it: the operator does
   *   label     for the log and the session summary line
   *   note      one line for the operator when there is something to do or know
   */
  function resolvePacketRigMode(o) {
    o = o || {};
    var choice = normalizeChoice(o.choice);
    var link = linkOf(o);
    var row = LINKS[link];
    var want = choice === 'auto' ? automaticWant(link, o.brand) : choice;
    var how = choice === 'auto' ? 'Automatic' : 'chosen for this rig';
    var out = {
      choice: choice, want: want, link: link, linkName: row.name,
      dataMode: null, radioName: 'FM', byHand: false, confirm: true,
      label: 'FM (voice), ' + how, note: '', source: row.source,
    };
    if (want !== 'fmdata') return out;
    out.radioName = row.radioName;
    out.confirm = !!row.confirm;
    if (row.dataMode) {
      out.dataMode = row.dataMode;
      out.label = 'FM data (' + row.radioName + '), ' + how;
      if (!row.confirm) out.note = 'This radio reports ' + row.radioName + ' as FM, so POTACAT cannot confirm it: check the radio\'s display during the session.';
      return out;
    }
    out.byHand = true;
    out.label = 'FM data, set on the radio by the operator';
    out.note = 'Set the radio to its FM data mode yourself: POTACAT has no command for it on this radio, and leaves the radio\'s mode alone.';
    return out;
  }

  /** What the rig editor shows under the choice: '' when there is nothing to say. */
  function editorNote(o) {
    var r = resolvePacketRigMode(o);
    if (r.choice === 'auto') return 'Automatic on this radio: ' + (r.want === 'fmdata' ? 'FM data (' + r.radioName + ').' : 'FM (voice).');
    return r.note;
  }

  /**
   * What a Winlink key-down may do with the mode. Outside packet and VARA FM
   * (resolved null) an Icom is forced to DATA, as before. In an FM session the
   * session start has set the mode: only an Icom running FM data keeps the
   * forced-DATA path (its fallback when the first ask did not take); every
   * other frame keys as the radio is and never swaps the mode, so
   * SSB-over-DATA cannot move an FM packet radio to USB data on each over.
   * @returns {{forceDataMode:boolean, noDataSwap?:boolean}}
   */
  function keyDownOpts(o) {
    o = o || {};
    var r = o.resolved;
    if (!r) return { forceDataMode: !!o.icom };
    var force = !!o.icom && r.want === 'fmdata' && !!r.dataMode;
    return force ? { forceDataMode: true } : { forceDataMode: false, noDataSwap: true };
  }

  /**
   * The session summary's "radio mode" text: the choice, what POTACAT sent,
   * and what the radio reports as the session ends.
   * @param {object} o
   * @param {object} o.resolved   resolvePacketRigMode()
   * @param {boolean} [o.noCat]
   * @param {string} [o.state]    '' | 'sent' | 'already' | 'link-down' | 'failed'
   * @param {string} [o.sent]     the mode name sent
   * @param {{mode:string,data:boolean}|null} [o.report]  the radio's last mode report
   * @param {string} [o.reportMode]
   */
  function sentText(o) {
    o = o || {};
    var r = o.resolved;
    if (!r) return '';
    if (o.noCat) return r.label + '; no CAT control, nothing sent';
    if (r.want !== 'fmdata') return r.label + '; FM sent with the tune';
    if (r.byHand) return r.label + '; no mode sent';
    var did = o.state === 'sent' ? o.sent + ' sent once after the FM tune'
      : o.state === 'already' ? 'the radio was in its data mode already, nothing sent'
      : o.state === 'failed' ? o.sent + ' could not be sent'
      : o.state === 'link-down' ? 'not sent, the radio link was down'
      : 'not sent';
    var rep = o.report;
    var mode = String((rep && rep.mode) || o.reportMode || '');
    var said = !r.confirm ? 'this radio reports ' + r.radioName + ' as FM, so it is not confirmed'
      : !rep ? 'the radio reported no mode'
      : rep.data ? 'the radio reports its data mode' + (mode ? ' (' + mode + ')' : '')
      : 'the radio reports ' + (mode || 'no mode') + ', not a data mode';
    return r.label + '; ' + did + '; ' + said;
  }

  return {
    keyDownOpts: keyDownOpts, sentText: sentText,
    CHOICES: CHOICES, LABELS: LABELS, SETTING_LABEL: SETTING_LABEL, SETTING_HELP: SETTING_HELP, LINKS: LINKS,
    linkOf: linkOf, normalizeChoice: normalizeChoice, resolvePacketRigMode: resolvePacketRigMode, editorNote: editorNote,
  };
});
