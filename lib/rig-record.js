// One shape for a saved radio (settings.rigs[]), shared by the Settings rig
// editor (renderer/app.js saveRigEditor) and the first run's "which radio"
// step (lib/rig-quick-setup.js), so a radio saved in either place is the same
// record.
//
//   newRigRecord(v)    the record saveRigEditor builds for a new radio. Keys
//                      that are stored only when set (voiceAsData, audioJack,
//                      txChannel, ...) are left out otherwise, exactly as the
//                      editor does.
//   NEW_RIG_DEFAULTS   what the editor's Add Rig form holds before the
//                      operator changes anything (renderer/index.html and
//                      openRigEditor('add')).
//   catTargetFor(t, v) the connection target for the connection types the
//                      first run sets up itself, in the shape the editor's
//                      buildCatTargetFromForm() gives for the same values.
//                      test/rig-record-test.js runs the editor's own code and
//                      compares the two.
//
// Pure. Dual-mode: require() in Node, window.RigRecord in the renderer.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RigRecord = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NEW_RIG_DEFAULTS = Object.freeze({
    remoteAudioInput: '',
    remoteAudioOutput: '',
    rxLevelDb: 0,
    fullPowerW: null,
    cwKeyPort: '',
    cwKeyLine: 'auto',
    catLabel: '',
    radioNr: 1,
    flexApiHost: '',
    flexSlice: 0,
    externalAtu: '',
    externalAtuWatts: 10,
    externalAtuSeconds: 4,
    atuKeepOn: false,
  });

  /**
   * The record for a new radio. v carries the values the editor read from its
   * form (or the first run's equivalents); see saveRigEditor for each one.
   */
  function newRigRecord(v) {
    return {
      id: v.id,
      name: v.name,
      model: v.model,
      catTarget: v.catTarget,
      remoteAudioInput: v.remoteAudioInput,
      remoteAudioOutput: v.remoteAudioOutput,
      rxLevelDb: v.rxLevelDb,
      fullPowerW: v.fullPowerW,
      audioSource: v.audioSource,
      cwKeyPort: v.cwKeyPort,
      cwKeyLine: v.cwKeyLine,
      catLabel: v.catLabel,
      radioNr: v.radioNr,
      flexApiHost: v.flexApiHost,
      flexSlice: v.flexSlice,
      externalAtu: v.externalAtu,
      externalAtuWatts: v.externalAtuWatts,
      externalAtuSeconds: v.externalAtuSeconds,
      atuKeepOn: v.atuKeepOn,
      ...(v.voiceAsData ? { voiceAsData: true } : {}),
      ...(v.audioJack === 'mic' ? { audioJack: 'mic' } : {}),
      ...(typeof v.voiceDataSwitch === 'boolean' ? { voiceDataSwitch: v.voiceDataSwitch } : {}),
      ...(v.allowPowerOffNoWake !== undefined ? { allowPowerOffNoWake: v.allowPowerOffNoWake } : {}),
      ...(v.ampDriveLimitW > 0 ? { ampDriveLimitW: v.ampDriveLimitW } : {}),
      ...(v.txAudioInput ? { txAudioInput: v.txAudioInput } : {}),
      ...(v.txLeftOnly ? { txChannel: 'left' } : {}),
      ...(v.icomUsbDataModOff ? { icomUsbDataModOff: true } : {}),
      ...(v.lanVoiceInSsb ? { lanVoiceInSsb: true } : {}),
      ...(v.packetMode ? { packetMode: v.packetMode } : {}),
      ...(v.cwSideband ? { cwSideband: v.cwSideband } : {}),
      flexBandAntennaMap: v.flexBandAntennaMap,
      ...(v.sdrScope ? { sdrScope: v.sdrScope } : {}),
      setupDone: v.setupDone,
      ...(v.bands ? { bands: v.bands } : {}),
    };
  }

  function pttField(p) { return p === 'vox' || p === 'rts' || p === 'dtr' ? { ptt: p } : {}; }
  function int(v, dflt) { const n = parseInt(v, 10); return n || dflt; }

  /**
   * The connection target for one of the types the first run sets up:
   * serialcat, icom, hamlib, flex, flrig, nocat. Values the operator did not
   * give take the editor's defaults. Returns null for any other type.
   */
  function catTargetFor(type, v) {
    v = v || {};
    if (type === 'serialcat') {
      return {
        type: 'serial',
        path: v.path || '',
        baudRate: int(v.baudRate, 9600),
        dtrOff: !!v.dtrOff,
        serialHandshake: v.serialHandshake || 'auto',
        ...pttField(v.ptt),
      };
    }
    if (type === 'icom') {
      const pace = v.civPace === 'always' || v.civPace === 'never' ? v.civPace : 'auto';
      return {
        type: 'icom',
        path: v.path || '',
        baudRate: int(v.baudRate, 115200),
        civAddress: Number(v.civAddress),
        civModel: v.civModel || '',
        civPace: pace,
        ...pttField(v.ptt),
      };
    }
    if (type === 'hamlib') {
      const pttPort = v.pttPort || '';
      return {
        type: 'rigctld',
        rigId: int(v.rigId, NaN),
        serialPort: v.serialPort || '',
        baudRate: int(v.baudRate, 9600),
        dtrOff: !!v.dtrOff,
        rigctldPort: int(v.rigctldPort, 4532),
        pttPort: pttPort || undefined,
        pttType: pttPort ? (v.pttType || 'RTS') : undefined,
      };
    }
    if (type === 'flex') {
      // The SmartSDR-Win CAT shim for the chosen slice (A = 5002 ... D = 5005);
      // POTACAT itself talks to the radio at rig.flexApiHost.
      const slice = parseInt(v.slice, 10) || 0;
      return { type: 'tcp', host: '127.0.0.1', port: 5002 + slice };
    }
    if (type === 'flrig') {
      return {
        type: 'flrig',
        host: (v.host && String(v.host).trim()) || '127.0.0.1',
        port: int(v.port, 12345),
        ...pttField(v.ptt),
      };
    }
    if (type === 'nocat') return { type: 'none' };
    return null;
  }

  return { NEW_RIG_DEFAULTS, newRigRecord, catTargetFor };
});
