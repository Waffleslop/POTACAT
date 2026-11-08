/**
 * The TX power control outside the main window (GitHub #199: the VFO pop-out).
 *
 * Main builds one payload for every pop-out power control
 * (main.js jtcatPopoutRigPowerPayload): the radio's reported watts, whether a
 * set would take, the txpower capability, and the model's min/max/step/
 * decimals/power choices from getRigCapabilities. Those caps already carry
 * the rig's Full power (W) (lib/rig-full-power.js, applied in
 * getActiveRigModel), and a Guest Pass cap is enforced where the set lands
 * (gatedSetTxPower / gatedSmartSdrTxPower in the rig-control dispatcher), so
 * a surface only has to show the payload and send set-tx-power. No scaling
 * happens here.
 *
 * Dual-mode: Node require() gets module.exports, a <script> gets
 * window.RigPowerView. Pure.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RigPowerView = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // The main window's rigFormatPower: "5W", "2.5W" (test holds them equal).
  function formatWatts(watts, decimals) {
    const d = Math.max(0, parseInt(decimals || 0, 10));
    const n = Number(watts);
    if (!Number.isFinite(n)) return watts + 'W';
    return n.toFixed(d) + 'W';
  }

  // The power-table entry closest to the reported level, as the main window's
  // select does.
  function nearestChoice(choices, watts) {
    let best = null, bestDist = Infinity;
    for (const c of choices || []) {
      const dist = Math.abs(Number(c) - Number(watts));
      if (dist < bestDist) { best = c; bestDist = dist; }
    }
    return best;
  }

  function num(v, dflt) {
    const n = Number(v);
    return v != null && Number.isFinite(n) ? n : dflt;
  }

  /**
   * What the control shows for a payload. `shown` follows the txpower
   * capability, as the main window's TX Pwr row does; `enabled` is whether a
   * set would take (a Flex without the API, or no link, can only be read).
   */
  function powerView(p) {
    if (!p || !p.capable) return { shown: false };
    const choices = Array.isArray(p.powerChoices)
      ? p.powerChoices.map(Number).filter(Number.isFinite) : [];
    const decimals = Math.max(0, parseInt(p.powerDecimals || 0, 10));
    const known = !!p.known && Number(p.watts) > 0;
    const useSelect = choices.length > 0;
    const best = known && useSelect ? nearestChoice(choices, p.watts) : null;
    return {
      shown: true,
      enabled: !!p.settable,
      known,
      watts: known ? Number(p.watts) : null,
      min: num(p.minPower, 0),
      max: num(p.maxPower, 100),
      step: num(p.powerStep, 1),
      decimals,
      useSelect,
      choices,
      selectValue: best != null ? String(best) : null,
      label: known ? formatWatts(p.watts, decimals) : '—',
    };
  }

  /**
   * set-tx-power for a drag: the latest value goes out once the slider has
   * been quiet for QUIET_MS (the main window's 80 ms), and never sooner than
   * MIN_GAP_MS after the previous set, so a drag reaches the radio at most
   * four times a second and its final value always arrives.
   */
  const QUIET_MS = 80;
  const MIN_GAP_MS = 250;
  function createPowerSender(send, clock) {
    const c = clock || {};
    const now = c.now || (() => Date.now());
    const setT = c.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const clearT = c.clearTimeout || ((t) => clearTimeout(t));
    let timer = null, pending = null, lastAt = -Infinity;
    function fire() {
      timer = null;
      if (pending == null) return;
      const w = pending; pending = null;
      lastAt = now();
      send(w);
    }
    return function (watts) {
      pending = watts;
      if (timer) clearT(timer);
      timer = setT(fire, Math.max(QUIET_MS, lastAt + MIN_GAP_MS - now()));
    };
  }

  return { formatWatts, nearestChoice, powerView, createPowerSender, QUIET_MS, MIN_GAP_MS };
});
