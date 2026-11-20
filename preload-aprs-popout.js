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
  // { home: {lat, lon, grid, call} | null, distUnit: 'mi'|'km', km, showLastMin }
  onInit: (cb) => ipcRenderer.on('aprs-init', (_e, d) => cb(d)),
  // { state: 'connecting'|'connected'|'waiting'|'refused'|'stopped'|'no-grid', server, call, anonymous, km, retryInMs }
  onStatus: (cb) => ipcRenderer.on('aprs-status', (_e, s) => cb(s)),
  // [parsed packet, ...] from lib/aprs-parser.js, at most every 500 ms
  onPackets: (cb) => ipcRenderer.on('aprs-packets', (_e, p) => cb(p)),
  setRange: (km) => ipcRenderer.send('aprs-set-range', km),
  // "Show the last" in minutes (15, 30, 60, 180, 360), saved per profile.
  setShowLast: (min) => ipcRenderer.send('aprs-set-show-last', min),
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
  // Phase 5: the beacon over APRS-IS. beaconSet takes any of { symbol, comment, approx, intervalMin, lat, lon, activation, rfSsid, source }.
  // source: 'settings' (map point or Settings grid, the default) or 'gps' (the radio's GPS, lib/aprs-position.js).
  beaconNow: () => ipcRenderer.send('aprs-beacon-now'),
  beaconGet: () => ipcRenderer.send('aprs-beacon-get'), // the state now (the section may load after the window said ready)
  beaconSet: (patch) => ipcRenderer.send('aprs-beacon-set', patch || {}),
  // { settings, call, grid, position: {lat, lon, source: 'map'|'grid'|'gps'} | null, positionSentence, gps, lastAt, lastPacket, sentence, backAt, sending, timerOn, nextAt }
  // Extra 1: also activation: { comment, added, text, running }, the comment both beacons send now.
  onBeacon: (cb) => ipcRenderer.on('aprs-beacon', (_e, s) => cb(s)),
  // The radio's GPS, read only (lib/flex-gps.js): { installed, fix, lat, lon, grid, tracked, visible, status, line }.
  gpsGet: () => ipcRenderer.invoke('flex-gps-get'),
  onGps: (cb) => ipcRenderer.on('aprs-gps', (_e, s) => cb(s)),
  // Phase 7: ONE manual beacon over the radio. One click: rfSend transmits one
  // packet at once (no confirmation step; main judges the gate again and ignores
  // a click while a beacon is going out).
  rfGet: () => ipcRenderer.send('aprs-rf-get'),
  rfSend: () => ipcRenderer.send('aprs-rf-send'),
  // The on-air banner's "Stop transmitting": main aborts the beacon in flight
  // the way closing the window does (PTT drops at once).
  rfStop: () => ipcRenderer.send('aprs-rf-stop'),
  // The APRS-IS card's switch: the window's read-only feed off or on.
  feedSet: (on) => ipcRenderer.send('aprs-feed-set', !!on),
  // The APRS settings panel's "Report what I hear to APRS-IS (iGate)": settings.aprsIgate, the one setting.
  igateSet: (on) => ipcRenderer.send('aprs-igate-set', !!on),
  // { allowed, reason, why, band, bandLabel, mode, mhz, powerW, preview: {button, detail}, sending, phase, keyed,
  //   meters: {smeter, swr, alc, power}, lastPeak: {swr, fwdW} | null, sentence, lastAt, lastPacket, lastBand,
  //   keyedAt, airMs, lastHeldMs, txNarrow: {lo, hi} | null }
  onRf: (cb) => ipcRenderer.on('aprs-rf', (_e, s) => cb(s)),
  // The radio beside the beacon: TX power (the JTCAT and Winlink windows' payload,
  // set through the one rig-control dispatcher, set-tx-power) and the meters every
  // window gets (cat-smeter / cat-swr are the 0-255 wire values, cat-swr-ratio the
  // radio's true ratio, cat-fwd-power watts).
  rigControl: (d) => ipcRenderer.invoke('rig-control', d),
  rigPowerGet: () => ipcRenderer.send('aprs-rig-power-get'),
  onRigPower: (cb) => ipcRenderer.on('aprs-rig-power', (_e, p) => cb(p)),
  onCatSmeter: (cb) => ipcRenderer.on('cat-smeter', (_e, v) => cb(v)),
  onCatSwr: (cb) => ipcRenderer.on('cat-swr', (_e, v) => cb(v)),
  onCatSwrRatio: (cb) => ipcRenderer.on('cat-swr-ratio', (_e, v) => cb(v)),
  onCatFwdPower: (cb) => ipcRenderer.on('cat-fwd-power', (_e, v) => cb(v)),
  // A1: messages over the internet (renderer/aprs-messages.js). Main checks every send again.
  // { call, sentence, link, convos: [{ call, unread, updatedAt, last, lastDir, lastState }], unread, viewing,
  //   thread: [{ lid, dir: 'in'|'out', text, at, id, via, state, tries, status }] }
  messagesGet: () => ipcRenderer.send('aprs-messages-get'),
  messageSend: (to, text) => ipcRenderer.invoke('aprs-message-send', { to: String(to || ''), text: String(text || '') }),
  messagesView: (call) => ipcRenderer.send('aprs-messages-view', String(call || '')),
  messageStop: (lid) => ipcRenderer.send('aprs-message-stop', String(lid || '')),
  messagesDelete: (call) => ipcRenderer.send('aprs-messages-delete', String(call || '')),
  onMessages: (cb) => ipcRenderer.on('aprs-messages', (_e, s) => cb(s)),
  // A2: templates (renderer/aprs-templates-panel.js). { context: { park, summit, freq, mode, call, running }, mine: [{ id, name, to, text }] }
  templatesGet: () => ipcRenderer.send('aprs-templates-get'),
  templatesSave: (t) => ipcRenderer.invoke('aprs-templates-save', { name: String((t && t.name) || ''), to: String((t && t.to) || ''), text: String((t && t.text) || '') }),
  templatesDelete: (id) => ipcRenderer.send('aprs-templates-delete', String(id || '')),
  onTemplates: (cb) => ipcRenderer.on('aprs-templates', (_e, s) => cb(s)),
});
