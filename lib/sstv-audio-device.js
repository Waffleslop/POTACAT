/**
 * Which sound device SSTV listens to and transmits through: SHARED between
 * the SSTV window (a plain <script> tag gives `window.SstvAudioDevice`) and
 * tests (`require`). No DOM or Node dependencies.
 *
 * The SSTV window used to capture `settings.sstvAudioInput` only, whose
 * default "" meant the computer's default recording device and never the
 * radio. Every other decoder (FT8, JS8, ECHOCAT, the Station Setup listen
 * check) uses the rig's own input (`remoteAudioInput`, mirrored from the
 * active rig), so on a USB-codec or SignaLink station Station Setup passed
 * while SSTV decoded the laptop microphone, and a saved device that had gone
 * away was silently replaced by the default (Casey 2026-09-28: "Nobody is
 * getting good rx").
 *
 * Rules, for input and output alike:
 *  - An empty SSTV setting FOLLOWS THE RADIO (My Rigs > Audio).
 *  - A device chosen in the SSTV window is kept as an override, and the
 *    window says when it differs from the radio's.
 *  - A configured device that is not present is REFUSED with a message,
 *    never replaced by the default ("a chosen audio device is never silently
 *    replaced").
 *  - Nothing configured anywhere: the system default, with a warning.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SstvAudioDevice = api;
})(typeof self !== 'undefined' ? self : this, function () {
  function labelOf(devices, id) {
    const d = (devices || []).find((x) => x && x.deviceId === id);
    return d ? (d.label || id.slice(0, 20)) : null;
  }

  /**
   * @param {{sstvId?: string, rigId?: string, devices?: {deviceId:string,label?:string}[],
   *          kind: 'input'|'output'}} opts
   * @returns {{deviceId: string, source: 'rig'|'sstv'|'default', ok: boolean,
   *            label: string|null, message: string|null, notice: string|null}}
   *   ok=false means do not open anything; `message` says why.
   */
  function resolveSstvAudio(opts) {
    const sstvId = (opts && opts.sstvId) || '';
    const rigId = (opts && opts.rigId) || '';
    const devices = (opts && opts.devices) || [];
    const noun = opts && opts.kind === 'output' ? 'output' : 'input';
    const rigPlace = `My Rigs > Audio (radio ${noun})`;
    // Raw ALSA ids are not browser devices; the capture path handles them.
    const present = (id) => id.startsWith('alsa:') || devices.some((d) => d && d.deviceId === id);

    if (sstvId) {
      if (!present(sstvId)) {
        return { deviceId: sstvId, source: 'sstv', ok: false, label: null, notice: null,
          message: `The SSTV audio ${noun} chosen in this window is not connected. Choose it again, or pick "From My Rigs" to use the radio's.` };
      }
      const rigLabel = rigId ? labelOf(devices, rigId) : null;
      return { deviceId: sstvId, source: 'sstv', ok: true, label: labelOf(devices, sstvId), message: null,
        notice: rigId && rigId !== sstvId
          ? `SSTV is using ${labelOf(devices, sstvId) || 'another device'}, not your radio's ${noun}${rigLabel ? ` (${rigLabel})` : ''}. Pick "From My Rigs" to follow the radio.`
          : null };
    }
    if (rigId) {
      if (!present(rigId)) {
        return { deviceId: rigId, source: 'rig', ok: false, label: null, notice: null,
          message: `Your radio's audio ${noun} is not connected. Re-pick it in ${rigPlace}.` };
      }
      return { deviceId: rigId, source: 'rig', ok: true, label: labelOf(devices, rigId), message: null, notice: null };
    }
    return { deviceId: '', source: 'default', ok: true, label: null, message: null,
      notice: `No radio audio ${noun} is set in ${rigPlace}, so SSTV is using the computer's default device.` };
  }

  return { resolveSstvAudio };
});
