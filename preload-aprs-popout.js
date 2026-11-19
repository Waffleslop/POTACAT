// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
// Preload for the APRS window (phase 1, read-only): window chrome, the feed's
// three channels, the range, and opening QRZ in the browser.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  minimize: () => ipcRenderer.send('aprs-popout-minimize'),
  maximize: () => ipcRenderer.send('aprs-popout-maximize'),
  close: () => ipcRenderer.send('aprs-popout-close'),
  // { home: {lat, lon, grid, call} | null, distUnit: 'mi'|'km', km }
  onInit: (cb) => ipcRenderer.on('aprs-init', (_e, d) => cb(d)),
  // { state: 'connecting'|'connected'|'waiting'|'refused'|'stopped'|'no-grid', server, call, anonymous, km, retryInMs }
  onStatus: (cb) => ipcRenderer.on('aprs-status', (_e, s) => cb(s)),
  // [parsed packet, ...] from lib/aprs-parser.js, at most every 500 ms
  onPackets: (cb) => ipcRenderer.on('aprs-packets', (_e, p) => cb(p)),
  setRange: (km) => ipcRenderer.send('aprs-set-range', km),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  ready: () => ipcRenderer.send('aprs-ready'),
  // Phase 2, "Listen on my radio" (receive only): the switch, and its state
  // { on, state: 'off'|'starting'|'listening'|'paused'|'refused', sentence, band, mhz, heard, lastAt, note }
  listenSet: (on) => ipcRenderer.send('aprs-listen-set', !!on),
  // Phase 3: the band chips. The state also carries { bands: ['2m','30m'], modeLabel: 'FM'|'USB' }.
  listenBand: (b) => ipcRenderer.send('aprs-listen-band', String(b || '')),
  onListen: (cb) => ipcRenderer.on('aprs-listen', (_e, s) => cb(s)),
  // Phase 4: the iGate's marks { on, active, call, sentence, link, gated, lastAt, lastFrom }
  onIgate: (cb) => ipcRenderer.on('aprs-igate', (_e, s) => cb(s)),
  // Asked once the bar listens; main answers with one 'aprs-listen' push.
  listenGet: () => ipcRenderer.send('aprs-listen-get'),
  // Phase 5: the beacon over APRS-IS. beaconSet takes any of { symbol, comment, approx, intervalMin, lat, lon, activation }.
  beaconNow: () => ipcRenderer.send('aprs-beacon-now'),
  beaconGet: () => ipcRenderer.send('aprs-beacon-get'), // the state now (the section may load after the window said ready)
  beaconSet: (patch) => ipcRenderer.send('aprs-beacon-set', patch || {}),
  // { settings, call, grid, position: {lat, lon, source: 'map'|'grid'} | null, lastAt, lastPacket, sentence, backAt, sending, timerOn, nextAt }
  // Extra 1: also activation: { comment, added, text, running }, the comment both beacons send now.
  onBeacon: (cb) => ipcRenderer.on('aprs-beacon', (_e, s) => cb(s)),
  // Phase 7: ONE manual beacon over the radio. rfAsk shows the confirmation line
  // (nothing is keyed); only rfSend transmits; rfCancel drops the line.
  rfGet: () => ipcRenderer.send('aprs-rf-get'),
  rfAsk: () => ipcRenderer.send('aprs-rf-ask'),
  rfSend: () => ipcRenderer.send('aprs-rf-send'),
  rfCancel: () => ipcRenderer.send('aprs-rf-cancel'),
  // { allowed, reason, why, band, bandLabel, mode, mhz, powerW, confirm, phase, keyed, sentence, lastAt, lastPacket, lastBand }
  onRf: (cb) => ipcRenderer.on('aprs-rf', (_e, s) => cb(s)),
});
