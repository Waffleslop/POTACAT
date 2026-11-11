'use strict';
/**
 * The JTCAT auto-calibrated audio latency, kept per audio source.
 *
 * The engine learns the receive pipeline's lag from decoded DTs and starts a
 * fresh engine from the last learned value (seedAudioLatencyMs). One value for
 * every source was wrong: a USB sound card through PipeWire learned 1760 ms,
 * and the same seed on the Yaesu SCU-LAN10 (about 0.1-0.5 s) moved the decode
 * window so far that nothing decoded, and with nothing decoded the auto loop
 * could never correct it (DA2PK FT-710, 2026-11-11). Each source now learns its
 * own value; a source with none starts at 0.
 *
 * settings.jtcatAudioLatencyMs stays the value a manual pin uses and the one
 * older builds read; it is written for sound-card sources only, so a network
 * source's lag never seeds a sound card either.
 */

// Audio that reaches POTACAT as network packets: their lag has nothing to do
// with a sound card's, so the old single value is never a seed for them.
const NETWORK_SOURCES = new Set(['smartsdr', 'icom-network', 'yaesu-lan']);

function sourceKey(settings) {
  return String((settings && settings.audioSource) || 'dax');
}

/** The learned latency to seed a fresh engine with, or null to start at 0. */
function seedFor(settings) {
  const key = sourceKey(settings);
  const by = settings && settings.jtcatAudioLatencyBySource;
  if (by && typeof by[key] === 'number' && Number.isFinite(by[key])) return by[key];
  if (!NETWORK_SOURCES.has(key) && settings && typeof settings.jtcatAudioLatencyMs === 'number') return settings.jtcatAudioLatencyMs;
  return null;
}

/** Store a newly learned value for the current source. Returns true when anything changed. */
function remember(settings, ms) {
  const key = sourceKey(settings);
  const by = (settings.jtcatAudioLatencyBySource && typeof settings.jtcatAudioLatencyBySource === 'object')
    ? settings.jtcatAudioLatencyBySource : {};
  let changed = false;
  if (by[key] !== ms) { by[key] = ms; changed = true; }
  settings.jtcatAudioLatencyBySource = by;
  if (!NETWORK_SOURCES.has(key) && settings.jtcatAudioLatencyMs !== ms) { settings.jtcatAudioLatencyMs = ms; changed = true; }
  return changed;
}

module.exports = { NETWORK_SOURCES, sourceKey, seedFor, remember };
