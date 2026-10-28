'use strict';
/**
 * What works with nothing turned on (Casey 2026-10-27: "make this simple and
 * 'just work' without having to turn stuff on"). Pure; main.js applies it.
 *
 * ALWAYS_ON: features with no switch at all. QSO logging (cloud SYNC stays a
 * choice), solar indices, the band activity heatmap and PSKReporter
 * Propagation. Forced on every load, so an old saved `false` can never hide
 * them again.
 *
 * applyDefaultsOnce: a one-time revision per profile (`installDefaultsRev`).
 * SOTA, WWFF and LLOTA spots on (the operator may untick them afterwards),
 * and the DX cluster on with a node picked AT RANDOM from the built-in list
 * when the operator never set one up. Random, never one fixed node: shipping
 * w3lpl.net as everyone's default once piled the whole user base onto one
 * volunteer's machine and became a reconnect storm (KD4D 2026-08-04). A
 * station that configured nodes and switched the cluster off keeps it off.
 *
 * replaceDeadAutoNode: a node WE picked that gives up (dead host, refused
 * login) is swapped for another untried preset, so "just works" survives a
 * node going away. A node the operator chose is never touched.
 */

const ALWAYS_ON = ['enableLogging', 'enableSolar', 'enableBandActivity', 'enablePskrMap'];
const DEFAULTS_REV = 1;

function applyAlwaysOn(s) {
  if (!s || typeof s !== 'object') return s;
  for (const k of ALWAYS_ON) s[k] = true;
  return s;
}

function pickClusterPreset(presets, rand = Math.random, exclude = []) {
  const skip = new Set((exclude || []).map((n) => String(n).toUpperCase()));
  const pool = (presets || []).filter((p) => p && p.host && !skip.has(String(p.name).toUpperCase()));
  if (!pool.length) return null;
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}

function autoNode(preset, tried, now = Date.now()) {
  return {
    id: 'auto-' + now.toString(36),
    name: preset.name,
    host: preset.host,
    port: preset.port,
    enabled: true,
    preset: preset.name,
    auto: true,                 // POTACAT picked it; replaced if it dies
    autoTried: tried.slice(),
  };
}

/** @returns {string[]} what changed, for one log line ([] = nothing) */
function applyDefaultsOnce(s, presets, rand = Math.random, now = Date.now()) {
  if (!s || typeof s !== 'object') return [];
  if ((Number(s.installDefaultsRev) || 0) >= DEFAULTS_REV) return [];
  const changed = [];
  for (const k of ['enableSota', 'enableWwff', 'enableLlota']) {
    if (s[k] !== true) { s[k] = true; changed.push(k); }
  }
  const nodes = Array.isArray(s.clusterNodes) ? s.clusterNodes : [];
  const configured = nodes.some((n) => n && n.host);
  if (!configured) {
    const p = pickClusterPreset(presets, rand);
    if (p) {
      s.clusterNodes = [autoNode(p, [p.name], now)];
      s.enableCluster = true;
      changed.push('enableCluster (' + p.name + ')');
    }
  }
  s.installDefaultsRev = DEFAULTS_REV;
  return changed;
}

/**
 * The node id that gave up → a replacement list, or null when nothing to do
 * (not ours, or every preset already tried).
 */
function replaceDeadAutoNode(nodes, deadId, presets, rand = Math.random, now = Date.now()) {
  const list = Array.isArray(nodes) ? nodes : [];
  const i = list.findIndex((n) => n && n.id === deadId);
  if (i < 0 || !list[i].auto) return null;
  const tried = Array.isArray(list[i].autoTried) ? list[i].autoTried : [list[i].name];
  const p = pickClusterPreset(presets, rand, tried);
  if (!p) return null;
  const next = list.slice();
  next[i] = autoNode(p, tried.concat(p.name), now);
  return { nodes: next, from: list[i].name, to: p.name };
}

module.exports = { ALWAYS_ON, DEFAULTS_REV, applyAlwaysOn, applyDefaultsOnce, pickClusterPreset, replaceDeadAutoNode };
