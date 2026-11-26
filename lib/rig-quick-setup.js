// The first run's "which radio" step: the operator picks the model, POTACAT
// fills in the rest.
//
//   searchModels(groups, text)   the radios that match what was typed
//   planForModel(groups, model)  what POTACAT fills in from the model: the
//                                connection (lib/rig-model-connection.js, the
//                                rule the Settings editor uses, X6100 to FLRig
//                                and all), baud rate, CI-V address, audio source
//   radioPorts(ports)            the serial ports the OS reported, without the
//                                duplicate names some systems add
//   suggestPort(ports, plan)     the one port that is plainly the radio's, or
//                                none. Reads the names only: no port is opened.
//   buildRig(plan, answers)      the saved radio, in the Settings editor's own
//                                record shape (lib/rig-record.js)
//   activationPatch(rigs, rig)   the save that makes it the radio in use, with
//                                the same keys the CAT menu's radio switch sends
//
// groups is lib/rig-models.js getModelList() (the renderer has it from
// window.api.getRigModels()). Nothing here opens a port, sends a command or
// transmits. Radio menu settings are never written here: the screen shows
// lib/rig-setup-notes.js for those.
//
// Pure. Dual-mode: require() in Node, window.RigQuickSetup in the renderer
// (after rig-model-connection.js, rig-record.js and rig-family.js).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./rig-model-connection'), require('./rig-record'), require('./rig-family'));
  } else {
    root.RigQuickSetup = factory(root.RigModelConnection, root.RigRecord, root.RigFamily);
  }
})(typeof self !== 'undefined' ? self : this, function (RigModelConnection, RigRecord, RigFamily) {
  'use strict';

  // The connections this step sets up itself. Anything else (a radio reached
  // only over the network, such as Zeus over TCP CAT) is set up in Settings >
  // Radio, with the model already picked there.
  const QUICK_TYPES = ['serialcat', 'icom', 'hamlib', 'flex', 'flrig', 'nocat'];
  // The ones that need the radio's USB serial port.
  const PORT_TYPES = ['serialcat', 'icom', 'hamlib'];
  // The Settings editor's Baud Rate list and its defaults (renderer/index.html).
  const BAUD_CHOICES = [4800, 9600, 19200, 38400, 57600, 115200];
  const DEFAULT_BAUD = { serialcat: 9600, icom: 115200 };
  // Radios the Settings editor can also reach over the network: any Icom
  // (Icom Network), the SCU-LAN10 radios (app.js YAESU_LAN_MODELS) and the K4.
  const YAESU_LAN_MODELS = ['FTDX10', 'FT-710', 'FTDX101D', 'FTDX101MP'];

  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, ''); }

  /**
   * The radios that match the typed text, best first: the model starting
   * with it, then containing it, then the maker. Every word typed must match
   * ("yaesu 710"). Empty text matches nothing (the screen says to type).
   * @returns {{brand: string, model: string}[]}
   */
  function searchModels(groups, text, limit) {
    const words = String(text == null ? '' : text).split(/\s+/).map(norm).filter(Boolean);
    if (!words.length) return [];
    const out = [];
    for (const g of groups || []) {
      for (const m of (g && g.models) || []) {
        const nm = norm(m), nb = norm(g.brand), all = nb + nm;
        if (!words.every((w) => all.includes(w) || nm.includes(w))) continue;
        const first = words[0];
        const rank = nm.startsWith(first) ? 0 : nm.includes(first) ? 1 : 2;
        out.push({ brand: g.brand, model: m, rank });
      }
    }
    out.sort((a, b) => a.rank - b.rank || a.brand.localeCompare(b.brand) || a.model.localeCompare(b.model));
    return out.slice(0, limit || 8).map(({ brand, model }) => ({ brand, model }));
  }

  function hex2(n) { return Number(n).toString(16).toUpperCase().padStart(2, '0') + 'h'; }

  /** The one sentence that says what POTACAT set up, for the screen. */
  function howSentence(plan) {
    switch (plan.radioType) {
      case 'icom': return 'POTACAT talks to it over its USB cable with Icom CI-V, at ' + plan.baudRate + ' baud' +
        (Number.isInteger(plan.civAddress) ? ', CI-V address ' + hex2(plan.civAddress) : '') + '.';
      case 'serialcat': return 'POTACAT talks to it over its USB cable with ' + plan.brand + ' CAT commands.';
      case 'hamlib': return 'POTACAT talks to it over its USB cable through Hamlib, at ' + plan.baudRate + ' baud.';
      case 'flex': return 'POTACAT talks to it over your network. Its audio comes over the network too, so there is no sound card to choose.';
      case 'flrig': return 'POTACAT talks to it through flrig, a free program that runs on this computer with the radio connected.';
      case 'nocat': return 'This radio has no computer control. You tune it by hand, and its VOX keys it from POTACAT\'s audio.';
      default: return 'This radio is set up in Settings > Radio.';
    }
  }

  /**
   * What POTACAT fills in from the model, or null for a model it does not know.
   * @returns {{model, brand, radioType, quick, needsPort, chooseBaud, baudRate,
   *   civAddress, hamlibRigId, flrigHost, flrigPort, audioSource, networkAlt, how}}
   */
  function planForModel(groups, model) {
    const group = (groups || []).find((g) => g && Array.isArray(g.models) && g.models.includes(model));
    if (!group) return null;
    // A new radio has no connection chosen yet: the model decides, by the
    // same rule as the Settings editor's Radio Model dropdown.
    const conn = RigModelConnection.connectionForModel({ model, group, current: 'none' });
    if (!conn) return null;
    const type = conn.type;
    const plan = {
      model,
      brand: group.brand,
      radioType: type,
      quick: QUICK_TYPES.includes(type),
      needsPort: PORT_TYPES.includes(type),
      // Serial CAT is the one connection whose speed is set on the radio as
      // well; the screen offers the editor's list and the radio's notes.
      chooseBaud: type === 'serialcat',
      baudRate: DEFAULT_BAUD[type] || null,
      civAddress: null,
      hamlibRigId: null,
      flrigHost: null,
      flrigPort: null,
      audioSource: RigFamily.defaultAudioSourceFor(RigFamily.familyFromRadioType(type)),
      networkAlt: group.brand === 'Icom' || YAESU_LAN_MODELS.includes(model) || /^K4/.test(model),
      how: '',
    };
    if (type === 'icom' && group.civ && Number.isInteger(group.civ[model])) plan.civAddress = group.civ[model];
    if (type === 'hamlib' && conn.hamlib) { plan.hamlibRigId = conn.hamlib.rigId; plan.baudRate = conn.hamlib.baudRate; }
    if (type === 'flrig') { plan.flrigHost = '127.0.0.1'; plan.flrigPort = 12345; } // flrig's own defaults, as the editor fills them
    plan.how = howSentence(plan);
    return plan;
  }

  function portText(p) { return [p.path, p.friendlyName, p.manufacturer].filter(Boolean).join(' '); }

  /**
   * The ports the OS reported, as the operator should see them: on a Mac the
   * /dev/tty.* twin of a /dev/cu.* port is left out (POTACAT opens the cu.*
   * one), and on Linux a device that also has a stable /dev/serial/by-id name
   * is listed once, by that name. Nothing is added that the OS did not report.
   */
  function radioPorts(ports) {
    const list = (ports || []).filter((p) => p && typeof p.path === 'string' && p.path);
    const paths = new Set(list.map((p) => p.path));
    const aliased = new Set();
    for (const p of list) {
      // lib/cat.js lists a by-id alias as "<name> (ttyUSB0)": the device it names.
      const m = p.path.startsWith('/dev/serial/by-id/') && /\((\w+)\)\s*$/.exec(p.friendlyName || '');
      if (m) aliased.add('/dev/' + m[1]);
    }
    return list.filter((p) => {
      if (p.path.startsWith('/dev/tty.') && paths.has(p.path.replace('/dev/tty.', '/dev/cu.'))) return false;
      if (aliased.has(p.path)) return false;
      return true;
    });
  }

  /**
   * The port to offer first. Only the names are read; no port is opened.
   * One port that is not Bluetooth: that one. Several: the one whose name
   * plainly belongs to this radio (its model number, its maker; on a Yaesu
   * with two ports the "Enhanced" one, which the rig notes say carries CAT),
   * when exactly one stands out. Otherwise none, and the screen says how to
   * tell them apart.
   * @returns {{path: string, reason: 'none'|'only'|'match'|'several'}}
   */
  function suggestPort(ports, plan) {
    const list = radioPorts(ports).filter((p) => !/bluetooth|debug-console/i.test(portText(p)));
    if (!list.length) return { path: '', reason: (ports || []).length ? 'several' : 'none' };
    if (list.length === 1) return { path: list[0].path, reason: 'only' };
    const brand = norm(plan && plan.brand);
    const digits = (String((plan && plan.model) || '').match(/\d{3,}/) || [])[0] || '';
    const yaesu = brand === 'yaesu';
    const scored = list.map((p) => {
      const t = portText(p).toLowerCase();
      let s = 0;
      if (digits && t.includes(digits)) s += 3;
      if (brand && norm(t).includes(brand)) s += 2;
      if (yaesu && /enhanced/.test(t)) s += 2;
      if (yaesu && /standard/.test(t)) s -= 2;
      return { p, s };
    }).sort((a, b) => b.s - a.s);
    if (scored[0].s > 0 && scored[0].s > scored[1].s) return { path: scored[0].p.path, reason: 'match' };
    return { path: '', reason: 'several' };
  }

  /**
   * The radio to save, in the Settings editor's record shape.
   * answers: { id, port, baudRate, flexHost, name }
   *   id: keep this id (the step was saved before and the operator came Back)
   */
  function buildRig(plan, answers) {
    const a = answers || {};
    if (!plan || !plan.quick) return null;
    const t = plan.radioType;
    let catTarget;
    if (t === 'serialcat') catTarget = RigRecord.catTargetFor(t, { path: a.port, baudRate: a.baudRate || plan.baudRate });
    else if (t === 'icom') catTarget = RigRecord.catTargetFor(t, { path: a.port, baudRate: plan.baudRate, civAddress: plan.civAddress, civModel: plan.model });
    else if (t === 'hamlib') catTarget = RigRecord.catTargetFor(t, { rigId: plan.hamlibRigId, serialPort: a.port, baudRate: plan.baudRate });
    else if (t === 'flex') catTarget = RigRecord.catTargetFor(t, { slice: 0 });
    else if (t === 'flrig') catTarget = RigRecord.catTargetFor(t, { host: plan.flrigHost, port: plan.flrigPort });
    else catTarget = RigRecord.catTargetFor(t, {});
    const d = RigRecord.NEW_RIG_DEFAULTS;
    return RigRecord.newRigRecord({
      ...d,
      id: a.id || ('rig_' + (Number(a.now) || Date.now())),
      name: String(a.name || '').trim() || plan.model,
      model: plan.model,
      catTarget,
      audioSource: plan.audioSource,
      flexApiHost: t === 'flex' ? String(a.flexHost || '').trim() : d.flexApiHost,
      flexBandAntennaMap: {},
      setupDone: [],
    });
  }

  /** What is missing before the radio can be saved, as a sentence, or '' when nothing is. */
  function missing(plan, answers) {
    const a = answers || {};
    if (!plan) return 'Choose your radio first.';
    if (!plan.quick) return '';
    if (plan.needsPort && !String(a.port || '').trim()) return 'Choose the port the radio is on.';
    if (plan.radioType === 'flex' && !String(a.flexHost || '').trim()) return 'Find the radio on your network, or type its address.';
    return '';
  }

  /**
   * Add (or, with the same id, replace) the radio and make it the one in use.
   * Same keys as the CAT menu's radio switch (renderer/app.js), plus the list.
   */
  function activationPatch(rigs, rig) {
    const list = (Array.isArray(rigs) ? rigs : []).filter((r) => r && r.id !== rig.id);
    list.push(rig);
    return {
      rigs: list,
      activeRigId: rig.id,
      catTarget: rig.catTarget,
      remoteAudioInput: rig.remoteAudioInput || '',
      remoteAudioOutput: rig.remoteAudioOutput || '',
      cwKeyPort: rig.cwKeyPort || '',
      audioSource: rig.audioSource,
    };
  }

  return { QUICK_TYPES, PORT_TYPES, BAUD_CHOICES, YAESU_LAN_MODELS, searchModels, planForModel, radioPorts, suggestPort, buildRig, missing, activationPatch };
});
