'use strict';
// A band button goes back to where this radio last was on that band (GitHub #680).
//
// POTACAT notes the radio's dial as it reads it, one frequency per band per rig,
// and a band button tunes there. With nothing remembered for that band yet, the
// button tunes to its own preset as before. Every radio, every brand: the memory
// is POTACAT's, not the radio's band stack.
//
// The store is a plain object kept in settings.bandLastFreq:
//   { "<rigId>": { "20m": 14074.0, "40m": 7185.5 } }   (kHz)

const { freqToBand } = require('./bands');

function rigKey(rigId) {
  const k = String(rigId == null ? '' : rigId).trim();
  return k || 'default';
}

// Note a dial reading. Mutates `store`; returns the band the reading is on, or
// null when it is on no amateur band (nothing is remembered then).
function noteDial(store, rigId, hz) {
  if (!store || typeof store !== 'object') return null;
  const h = Number(hz);
  if (!Number.isFinite(h) || h <= 0) return null;
  const band = freqToBand(h / 1e6);
  if (!band) return null;
  const key = rigKey(rigId);
  if (!store[key] || typeof store[key] !== 'object') store[key] = {};
  store[key][band] = Math.round(h) / 1000;
  return band;
}

// The frequency (kHz) a band button for `presetKhz` should tune to: the rig's
// last frequency on that band, or the preset when there is none (or what is
// stored no longer sits on that band).
function jumpTarget(store, rigId, presetKhz) {
  const preset = Number(presetKhz);
  if (!Number.isFinite(preset) || preset <= 0) return presetKhz;
  const band = freqToBand(preset / 1000);
  if (!band || !store || typeof store !== 'object') return preset;
  const forRig = store[rigKey(rigId)];
  const khz = forRig && Number(forRig[band]);
  if (!Number.isFinite(khz) || khz <= 0) return preset;
  if (freqToBand(khz / 1000) !== band) return preset;
  return khz;
}

module.exports = { noteDial, jumpTarget, rigKey };
