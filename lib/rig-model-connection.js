/**
 * Which connection the rig editor selects when the operator picks a Radio
 * Model (renderer/app.js, the Radio Model dropdown). The model table
 * (lib/rig-models.js, grouped by getModelList) says what each model needs:
 *
 *   noCat               -> "No CAT control (VOX)" (Pebble HF and friends)
 *   hamlib              -> "Other Rig (Hamlib)" with that Hamlib model and
 *                          baud rate (Xiegu G90)
 *   preferredConnection -> that connection, unless the operator already chose
 *                          one that can reach this radio (Xiegu X6100: FLRig,
 *                          #1084; it does not speak Kenwood / Yaesu CAT)
 *   catLink 'tcpcat'    -> "IP Radio (TCP CAT)" (Zeus's CAT port, #185)
 *
 * Everything else follows the brand: FlexRadio, Icom (CI-V), or Serial CAT.
 * A radio reached through another program (flrig, DXLab Commander, a remote
 * rigctld) keeps that connection; the model then only supplies bands and
 * limits.
 *
 * Dual-mode: Node require() gets module.exports, a <script> gets
 * window.RigModelConnection. Pure.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RigModelConnection = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Connections run by another program; any model keeps them.
  const SHARED = ['flrig', 'dxlab-commander', 'rigctldnet'];

  // Connections that can reach a radio whatever its maker: a model with a
  // preferredConnection keeps one of these when the operator already chose
  // it. Anything else (Serial CAT, FlexRadio, the vendor network links, a new
  // rig's untouched default) is replaced by the preferred connection.
  const MODEL_AGNOSTIC = SHARED.concat(['hamlib', 'icom', 'civ-tcp', 'nocat']);

  function inList(group, key, model) {
    return !!(group && Array.isArray(group[key]) && group[key].includes(model));
  }

  /**
   * @param {object} o
   * @param {string} o.model    the Radio Model picked, e.g. 'X6100'
   * @param {object} o.group    its getModelList() entry ({ brand, models, noCat?, hamlib?, tcpcat?, preferred? })
   * @param {string} o.current  the radio type selected now (input[name="radio-type"]; 'none' if nothing)
   * @returns {{ type: string, keep: boolean, hamlib?: { rigId: number, baudRate: number } } | null}
   *   type: the radio type to select (equal to current when keep is true).
   *   null when the model is not in the group.
   */
  function connectionForModel(o) {
    o = o || {};
    const model = String(o.model || '');
    const group = o.group || null;
    const current = String(o.current || 'none');
    if (!model || !group || !Array.isArray(group.models) || !group.models.includes(model)) return null;
    const pick = (type) => ({ type, keep: type === current });

    if (inList(group, 'noCat', model)) return pick('nocat');
    const hamlib = group.hamlib && group.hamlib[model];
    if (hamlib) return { type: 'hamlib', keep: current === 'hamlib', hamlib: { rigId: hamlib.rigId, baudRate: hamlib.baudRate } };
    const preferred = group.preferred && group.preferred[model];
    if (preferred) return MODEL_AGNOSTIC.includes(current) ? pick(current) : pick(preferred);
    if (SHARED.includes(current)) return pick(current);
    if (group.brand === 'Yaesu' && current === 'yaesu-lan') return pick(current); // the SCU-LAN10 connection
    if (inList(group, 'tcpcat', model)) return pick('tcpcat');
    if (group.brand === 'FlexRadio') return pick('flex');
    if (group.brand === 'Icom') return pick('icom');
    return pick('serialcat');
  }

  return { connectionForModel, SHARED, MODEL_AGNOSTIC };
});
