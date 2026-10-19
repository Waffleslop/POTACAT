/**
 * The {greeting} CW macro token (LZ3AW 2026-10-16, item 10): GM, GA or GE by
 * the OTHER station's local time, from their longitude — their grid when known,
 * else the cty.dat entity. Solar time (UTC + longitude / 15) is what decides
 * whether it is morning there; a time zone table would buy nothing for a
 * two-letter greeting. With no position at all it is GD (good day), never the
 * operator's own time of day.
 *
 * Expanded in ONE place — main's sendCwTextToRadio — so the desktop macros,
 * the VFO pop-out, ECHOCAT Web and text sent by a mobile device all agree.
 *
 * Dual-mode: Node require() gets module.exports, a renderer that loads it via
 * <script> gets window.CwGreeting. Pure.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CwGreeting = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const TOKEN = /\{greeting\}/gi;

  /** Local solar hour (0-24) at a longitude for an instant. */
  function solarHour(lon, nowMs) {
    const d = new Date(nowMs);
    const utc = d.getUTCHours() + d.getUTCMinutes() / 60;
    return (((utc + lon / 15) % 24) + 24) % 24;
  }

  /** 'GM' 04:00-11:59, 'GA' 12:00-17:59, 'GE' otherwise; 'GD' with no longitude. */
  function greetingForLongitude(lon, nowMs) {
    if (typeof lon !== 'number' || !Number.isFinite(lon)) return 'GD';
    const h = solarHour(lon, nowMs == null ? Date.now() : nowMs);
    if (h >= 4 && h < 12) return 'GM';
    if (h >= 12 && h < 18) return 'GA';
    return 'GE';
  }

  function hasGreeting(text) {
    TOKEN.lastIndex = 0;
    return TOKEN.test(String(text || ''));
  }

  /** Replace every {greeting} in text. */
  function expandGreeting(text, lon, nowMs) {
    const g = greetingForLongitude(lon, nowMs);
    return String(text || '').replace(TOKEN, g);
  }

  return { greetingForLongitude, expandGreeting, hasGreeting, solarHour };
});
