const { contextBridge, ipcRenderer, shell, webFrame } = require('electron');

// Note: preload runs sandboxed (Electron default with contextIsolation +
// nodeIntegration:false). Only the `electron` module is requireable —
// Node built-ins like `path`, `fs`, `http` are NOT available here. Anything
// that needs those has to live in main and reach the renderer via IPC.

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  openExternal: (url) => ipcRenderer.send('open-external', url),
  pairRedeemUrl: (url) => ipcRenderer.invoke('pair-redeem-url', url),
  guestPassRedeem: (input) => ipcRenderer.invoke('guest-pass-redeem', input),
  onGuestPassRedeemed: (cb) => ipcRenderer.on('guest-pass-redeemed', (_e, r) => cb(r)),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
  onSpots: (cb) => ipcRenderer.on('spots', (_e, data) => cb(data)),
  onSpotsError: (cb) => ipcRenderer.on('spots-error', (_e, msg) => cb(msg)),
  onCatStatus: (cb) => ipcRenderer.on('cat-status', (_e, s) => cb(s)),
  // `origin` captures the renderer-side call stack so a stray QSY (e.g. the
  // 33 MHz jump) can be traced to its exact caller in the main-process log.
  tune: (frequency, mode, bearing, slicePort) => ipcRenderer.send('tune', { frequency, mode, bearing, slicePort, origin: (new Error()).stack }),
  onTuneBlocked: (cb) => ipcRenderer.on('tune-blocked', (_e, msg) => cb(msg)),
  onSmartSdrUnreachable: (cb) => ipcRenderer.on('smartsdr-unreachable', (_e, data) => cb(data)),
  onSmartSdrReachable: (cb) => ipcRenderer.on('smartsdr-reachable', () => cb()),
  onExternalAtuStart: (cb) => ipcRenderer.on('external-atu-start', (_e, d) => cb(d)),
  onExternalAtuComplete: (cb) => ipcRenderer.on('external-atu-complete', () => cb()),
  externalAtuCancel: () => ipcRenderer.send('external-atu-cancel'),
  rotateTo: (azimuth) => ipcRenderer.send('rotate-to', azimuth),
  // Scan on/off sync with ECHOCAT mobile (scan-state-sync-desktop)
  scanStateChanged: (scanning) => ipcRenderer.send('scan-state-changed', scanning),
  scanControlSend: (action) => ipcRenderer.send('scan-control-send', action),
  onRemoteScanControl: (cb) => ipcRenderer.on('remote-scan-control', (_e, d) => cb(d)),
  onRemotePeerScanState: (cb) => ipcRenderer.on('remote-peer-scan-state', (_e, d) => cb(d)),
  refresh: () => ipcRenderer.send('refresh'),
  getSdrDirectory: () => ipcRenderer.invoke('get-sdr-directory'),
  getContests: () => ipcRenderer.invoke('get-contests'),
  openContestUrl: (url) => ipcRenderer.send('open-contest-url', url),
  // ECHOCAT mobile-app pairing
  echocatCreatePairingQr: (opts) => ipcRenderer.invoke('echocat-create-pairing-qr', opts || {}),
  echocatListPairedDevices: () => ipcRenderer.invoke('echocat-list-paired-devices'),
  echocatRevokeDevice: (deviceId) => ipcRenderer.invoke('echocat-revoke-device', deviceId),
  echocatRenameDevice: (deviceId, name) => ipcRenderer.invoke('echocat-rename-device', deviceId, name),
  echocatSetDeviceTrusted: (deviceId, trusted) => ipcRenderer.invoke('echocat-set-device-trusted', deviceId, trusted),
  // Persistent share-link API (Settings → Remote Access → Share Access).
  // Distinct from echocatCreatePairingQr — these tokens survive a restart
  // and support 1h / 24h / 7d / 30d TTLs for emailed pair links.
  pairLinkCreate: (opts) => ipcRenderer.invoke('pair-link-create', opts || {}),
  pairLinkList: () => ipcRenderer.invoke('pair-link-list'),
  pairLinkRevoke: (token) => ipcRenderer.invoke('pair-link-revoke', token),
  onPairLinksUpdated: (cb) => {
    const handler = (_e, list) => cb(list);
    ipcRenderer.on('pair-links-updated', handler);
    return () => ipcRenderer.removeListener('pair-links-updated', handler);
  },
  // ─── Laptop side: paired shacks (connection targets) ──────────────
  // These are populated when the user opens an emailed pair link or
  // scans a QR; the redemption stores a deviceToken locally so this
  // desktop can dial the shack later. Token is never returned to the
  // renderer — only display fields.
  connectionTargetsList: () => ipcRenderer.invoke('connection-targets-list'),
  connectionTargetsRename: (id, name) => ipcRenderer.invoke('connection-targets-rename', id, name),
  connectionTargetsRemove: (id) => ipcRenderer.invoke('connection-targets-remove', id),
  // Pass null to switch back to the local rig.
  connectionTargetsActivate: (id) => ipcRenderer.invoke('connection-targets-activate', id),
  connectionTargetsGetStatus: () => ipcRenderer.invoke('connection-targets-get-status'),
  // Remote-shack audio (desktop-as-client answerer; remote-desktop Phase 2).
  // Start/stop listening to the remote rig's audio (and sending mic for PTT);
  // remoteClientAudioPtt toggles the mic + keys the shack during transmit.
  remoteClientAudioStart: () => ipcRenderer.invoke('remote-client-audio-start'),
  remoteClientAudioStop: () => ipcRenderer.invoke('remote-client-audio-stop'),
  remoteClientAudioPtt: (on) => ipcRenderer.send('remote-client-audio-ptt', on),
  // mDNS discovery of nearby POTACAT shacks for welcome-screen "we
  // found a shack on your network" and Remote-Radios "+ Add new"
  // same-LAN add. Returns [{name, host, port, fingerprint, rigModel, …}].
  discoverShacks: () => ipcRenderer.invoke('discover-shacks'),
  // Tap-to-pair against a discovered shack — operator clicks Approve
  // on the shack's screen, response carries deviceToken which we
  // persist into settings.connectionTargets[].
  pairRequestDiscovered: (target) => ipcRenderer.invoke('pair-request-discovered', target),
  // Cloud-attested auto-pair (Path 1, v1.9). cloudFindShacks lists
  // shacks registered to the signed-in account; cloudPairShack does
  // a one-click pair against a chosen one. No Approve modal, no QR.
  cloudFindShacks: () => ipcRenderer.invoke('cloud-find-shacks'),
  cloudPairShack: (shackDeviceId) => ipcRenderer.invoke('cloud-pair-shack', shackDeviceId),
  // Live state from the RemoteClient.
  onRemoteClientStatus: (cb) => {
    const handler = (_e, s) => cb(s);
    ipcRenderer.on('remote-client-status', handler);
    return () => ipcRenderer.removeListener('remote-client-status', handler);
  },
  onRemoteClientDisplaced: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on('remote-client-displaced', handler);
    return () => ipcRenderer.removeListener('remote-client-displaced', handler);
  },
  // Architecture B (v1.9): the host couldn't deliver a forwarded QSO
  // (no capability, ws dropped, etc). Renderer must show a loud,
  // dismiss-by-user modal with the full QSO details so the operator
  // can write the contact down by hand. Casey's hard rule (2026-06-05):
  // a guest's QSO never falls back to the owner's logbook.
  onLogError: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('log-error', handler);
    return () => ipcRenderer.removeListener('log-error', handler);
  },
  onConnectionTargetsUpdated: (cb) => {
    const handler = (_e, list) => cb(list);
    ipcRenderer.on('connection-targets-updated', handler);
    return () => ipcRenderer.removeListener('connection-targets-updated', handler);
  },
  onPairLinkRedeemed: (cb) => {
    const handler = (_e, result) => cb(result);
    ipcRenderer.on('pair-link-redeemed', handler);
    return () => ipcRenderer.removeListener('pair-link-redeemed', handler);
  },
  echocatTailscaleStatus: () => ipcRenderer.invoke('echocat-tailscale-status'),
  echocatIssueTailscaleCert: () => ipcRenderer.invoke('echocat-issue-tailscale-cert'),
  echocatPickFile: (opts) => ipcRenderer.invoke('echocat-pick-file', opts || {}),
  echocatRestartAudio: () => ipcRenderer.invoke('echocat-restart-audio'),
  // Remote Launcher install / uninstall / status — exposes the install
  // dance previously buried in scripts/launcher-install.js as a UI button.
  launcherInstall: () => ipcRenderer.invoke('launcher-install'),
  launcherUninstall: () => ipcRenderer.invoke('launcher-uninstall'),
  launcherStatus: () => ipcRenderer.invoke('launcher-status'),
  launcherStart: () => ipcRenderer.invoke('launcher-start'),
  // --- ALSA bridge (Linux-only; resolves false / [] on Win+Mac) ----------
  // Exposed for Linux SDR users who need to pick raw hw:/plughw: subdevices
  // that Chromium's enumerateDevices hides. The capture flow is opt-in: the
  // renderer's audio-device dropdown merges these entries in alongside the
  // browser's list, and the consumer (FT8/SSTV/ECHOCAT mic) starts a session
  // when the user actually picks one.
  alsaAvailable: () => ipcRenderer.invoke('alsa-available'),
  alsaListDevices: () => ipcRenderer.invoke('alsa-list-devices'),
  alsaLoadError: () => ipcRenderer.invoke('alsa-load-error'),
  alsaStartCapture: (opts) => ipcRenderer.invoke('alsa-start-capture', opts || {}),
  alsaStopCapture: (sessionId) => ipcRenderer.invoke('alsa-stop-capture', sessionId),
  onAlsaAudioChunk: (channel, cb) => {
    // Multi-session: caller passes the channel name returned from
    // alsaStartCapture so concurrent streams demux cleanly. Returns a
    // function the caller invokes to unsubscribe (no leaks across stops).
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  onEchocatPairedDevices: (cb) => ipcRenderer.on('echocat-paired-devices', (_e, list) => cb(list)),
  pairPopoutOpen: () => ipcRenderer.send('pair-popout-open'),
  // --- POTACAT Cloud (one-tap remote tunnel) ---
  cloudTunnelGetState: () => ipcRenderer.invoke('cloud-tunnel-get-state'),
  cloudTunnelEnable: () => ipcRenderer.invoke('cloud-tunnel-enable'),
  cloudTunnelDisable: () => ipcRenderer.invoke('cloud-tunnel-disable'),
  cloudTunnelDiagnostics: () => ipcRenderer.invoke('cloud-tunnel-diagnostics'),
  onCloudTunnelState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('cloud-tunnel-state', handler);
    return () => ipcRenderer.removeListener('cloud-tunnel-state', handler);
  },
  // --- POTACAT Guest Pass enforcement (#43) ---
  passEnforcementGetState: () => ipcRenderer.invoke('pass-enforcement-get-state'),
  passEnforcementLoad: (code) => ipcRenderer.invoke('pass-enforcement-load', code),
  passEnforcementEnd: (reason) => ipcRenderer.invoke('pass-enforcement-end', reason),
  onPassEnforcementState: (cb) => {
    const handler = (_e, status) => cb(status);
    ipcRenderer.on('pass-enforcement-state', handler);
    return () => ipcRenderer.removeListener('pass-enforcement-state', handler);
  },
  onPassEnforcementExpiring: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on('pass-enforcement-expiring', handler);
    return () => ipcRenderer.removeListener('pass-enforcement-expiring', handler);
  },
  onPassEnforcementEnded: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on('pass-enforcement-ended', handler);
    return () => ipcRenderer.removeListener('pass-enforcement-ended', handler);
  },
  onPassCatBlocked: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on('pass-cat-blocked', handler);
    return () => ipcRenderer.removeListener('pass-cat-blocked', handler);
  },
  onCatTuneUnconfirmed: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on('cat-tune-unconfirmed', handler);
    return () => ipcRenderer.removeListener('cat-tune-unconfirmed', handler);
  },
  // --- Guest Pass issue/list/revoke (desktop UI under ECHOCAT) ---
  passesIssue: (body) => ipcRenderer.invoke('passes-issue', body),
  passesList: () => ipcRenderer.invoke('passes-list'),
  passesRevoke: (code) => ipcRenderer.invoke('passes-revoke', code),
  passesQrPng: (text) => ipcRenderer.invoke('passes-qr-png', text),
  cloudForgotPassword: (email) => ipcRenderer.invoke('cloud-forgot-password', email),
  onOpenSettingsPanel: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('open-settings-panel', handler);
    return () => ipcRenderer.removeListener('open-settings-panel', handler);
  },
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getRigModels: () => ipcRenderer.invoke('get-rig-models'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  discoverFlex: () => ipcRenderer.invoke('discover-flex'),
  listPorts: () => ipcRenderer.invoke('list-ports'),
  listRigs: () => ipcRenderer.invoke('list-rigs'),
  testHamlib: (config) => ipcRenderer.invoke('test-hamlib', config),
  testSerialCat: (config) => ipcRenderer.invoke('test-serial-cat', config),
  testIcomCiv: (config) => ipcRenderer.invoke('test-icom-civ', config),
  testCivTcp: (config) => ipcRenderer.invoke('test-civ-tcp', config),
  testIcomNetwork: (config) => ipcRenderer.invoke('test-icom-network', config),
  connectCat: (target) => ipcRenderer.send('connect-cat', target),
  onCatFrequency: (cb) => ipcRenderer.on('cat-frequency', (_e, hz) => cb(hz)),
  onCatMode: (cb) => ipcRenderer.on('cat-mode', (_e, mode) => cb(mode)),
  onCatPower: (cb) => ipcRenderer.on('cat-power', (_e, watts) => cb(watts)),
  onCatSmeter: (cb) => ipcRenderer.on('cat-smeter', (_e, val) => cb(val)),
  onCatSwr: (cb) => ipcRenderer.on('cat-swr', (_e, val) => cb(val)),
  onCatSwrRatio: (cb) => ipcRenderer.on('cat-swr-ratio', (_e, val) => cb(val)),
  onCatAlc: (cb) => ipcRenderer.on('cat-alc', (_e, val) => cb(val)),
  qrzLookup: (callsign) => ipcRenderer.invoke('qrz-lookup', callsign),
  resolveCallsignGeo: (callsign) => ipcRenderer.invoke('resolve-callsign-geo', callsign),
  qrzCheckSub: (force) => ipcRenderer.invoke('qrz-check-sub', force),
  qrzVerifyApiKey: (key) => ipcRenderer.invoke('qrz-verify-api-key', key),
  getReleaseNotes: (version) => ipcRenderer.invoke('get-release-notes', version),
  importAdif: () => ipcRenderer.invoke('import-adif'),
  parseAdif: () => ipcRenderer.invoke('parse-adif'),
  onDxccData: (cb) => ipcRenderer.on('dxcc-data', (_e, data) => cb(data)),
  onClusterStatus: (cb) => ipcRenderer.on('cluster-status', (_e, s) => cb(s)),
  onCwSpotsStatus: (cb) => ipcRenderer.on('cw-spots-status', (_e, s) => cb(s)),
  onRbnSpots: (cb) => ipcRenderer.on('rbn-spots', (_e, data) => cb(data)),
  onRbnStatus: (cb) => ipcRenderer.on('rbn-status', (_e, s) => cb(s)),
  onPskrStatus: (cb) => ipcRenderer.on('pskr-status', (_e, s) => cb(s)),
  onPskrMapSpots: (cb) => ipcRenderer.on('pskr-map-spots', (_e, data) => cb(data)),
  onPskrMapStatus: (cb) => ipcRenderer.on('pskr-map-status', (_e, s) => cb(s)),
  clearPskrMap: () => ipcRenderer.send('pskr-map-clear'),
  onAgStatus: (cb) => ipcRenderer.on('ag-status', (_e, s) => cb(s)),
  onAgAntennaNames: (cb) => ipcRenderer.on('ag-antenna-names', (_e, names) => cb(names)),
  onAgPortStatus: (cb) => ipcRenderer.on('ag-port-status', (_e, s) => cb(s)),
  clearRbn: () => ipcRenderer.send('rbn-clear'),
  onSolarData: (cb) => ipcRenderer.on('solar-data', (_e, d) => cb(d)),
  getSolar: () => ipcRenderer.invoke('get-solar'),
  refreshSolar: () => ipcRenderer.send('refresh-solar'),
  conditionsPopoutOpen: () => ipcRenderer.send('conditions-popout-open'),
  conditionsPopoutTheme: (theme) => ipcRenderer.send('conditions-popout-theme', theme),
  setTxEq: (eqConfig) => ipcRenderer.send('tx-eq-set', eqConfig),
  onTxEqUpdate: (cb) => ipcRenderer.on('tx-eq-update', (_e, eqConfig) => cb(eqConfig)),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_e, d) => cb(d)),
  onUpdaterActive: (cb) => ipcRenderer.on('updater-active', (_e, active) => cb(active)),
  onDownloadProgress: (cb) => ipcRenderer.on('update-download-progress', (_e, d) => cb(d)),
  onUpdateError: (cb) => ipcRenderer.on('update-error', (_e, msg) => cb(msg)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', () => cb()),
  onUpdateUpToDate: (cb) => ipcRenderer.on('update-up-to-date', () => cb()),
  startDownload: () => ipcRenderer.send('start-download'),
  installUpdate: () => ipcRenderer.send('install-update'),
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),
  onCatLog: (cb) => ipcRenderer.on('cat-log', (_e, msg) => cb(msg)),
  onCatLogHistory: (cb) => ipcRenderer.on('cat-log-history', (_e, lines) => cb(lines)),
  markBugReportStart: () => ipcRenderer.invoke('bug-report-mark'),
  getBugReportLog: () => ipcRenderer.invoke('get-bug-report-log'),
  onWorkedQsos: (cb) => ipcRenderer.on('worked-qsos', (_e, data) => cb(data)),
  onWorkedParks: (cb) => ipcRenderer.on('worked-parks', (_e, data) => cb(data)),
  onCreditedParks: (cb) => ipcRenderer.on('credited-parks', (_e, refs) => cb(refs)),
  choosePotaParksFile: () => ipcRenderer.invoke('choose-pota-parks-file'),
  onWsjtxStatus: (cb) => ipcRenderer.on('wsjtx-status', (_e, s) => cb(s)),
  onWsjtxState: (cb) => ipcRenderer.on('wsjtx-state', (_e, s) => cb(s)),
  onWsjtxDecode: (cb) => ipcRenderer.on('wsjtx-decode', (_e, d) => cb(d)),
  onWsjtxClear: (cb) => ipcRenderer.on('wsjtx-clear', () => cb()),
  onWsjtxQsoLogged: (cb) => ipcRenderer.on('wsjtx-qso-logged', (_e, q) => cb(q)),
  onWsjtxActivatorQso: (cb) => ipcRenderer.on('wsjtx-activator-qso', (_e, c) => cb(c)),
  wsjtxReply: (decode) => ipcRenderer.send('wsjtx-reply', decode),
  wsjtxHaltTx: () => ipcRenderer.send('wsjtx-halt-tx'),
  saveQso: (qsoData) => ipcRenderer.invoke('save-qso', qsoData),
  quickRespot: (data) => ipcRenderer.invoke('quick-respot', data),
  sendClusterCommand: (text, nodeId) => ipcRenderer.invoke('send-cluster-command', text, nodeId),
  getRecentQsos: () => ipcRenderer.invoke('get-recent-qsos'),
  getAllQsos: () => ipcRenderer.invoke('get-all-qsos'),
  updateQso: (data) => ipcRenderer.invoke('update-qso', data),
  deleteQso: (idx) => ipcRenderer.invoke('delete-qso', idx),
  deleteQsosByMatch: (match) => ipcRenderer.invoke('delete-qsos-by-match', match),
  updateQsosByMatch: (data) => ipcRenderer.invoke('update-qsos-by-match', data),
  getDefaultLogPath: () => ipcRenderer.invoke('get-default-log-path'),
  chooseLogFile: (currentPath) => ipcRenderer.invoke('choose-log-file', currentPath),
  exportAdif: (qsos) => ipcRenderer.invoke('export-adif', qsos),
  onQrzData: (cb) => ipcRenderer.on('qrz-data', (_e, data) => cb(data)),
  onDonorCallsigns: (cb) => ipcRenderer.on('donor-callsigns', (_e, data) => cb(data)),
  // Watchlist groups — main pushes fresh `remoteEntries` here after each
  // Ham2K PoLo URL fetch (boot, save, or manual refresh). Renderer
  // rebuilds the lookup map + re-renders the table.
  onWatchlistGroupsUpdated: (cb) => ipcRenderer.on('watchlist-groups-updated', (_e, data) => cb(data)),
  refreshWatchlistGroup: (idx) => ipcRenderer.invoke('watchlist-group-refresh', idx),
  onExpeditionCallsigns: (cb) => ipcRenderer.on('expedition-callsigns', (_e, data) => cb(data)),
  // Directory (HF Nets & SWL Broadcasts)
  onDirectoryData: (cb) => ipcRenderer.on('directory-data', (_e, data) => cb(data)),
  fetchDirectory: () => ipcRenderer.send('fetch-directory'),
  getDirectory: () => ipcRenderer.invoke('get-directory'),
  // Events system
  onActiveEvents: (cb) => ipcRenderer.on('active-events', (_e, data) => cb(data)),
  onActiveEventsMeta: (cb) => ipcRenderer.on('active-events-meta', (_e, data) => cb(data)),
  getActiveEvents: () => ipcRenderer.invoke('get-active-events'),
  setEventOptIn: (data) => ipcRenderer.invoke('set-event-optin', data),
  setEventWatchlist: (data) => ipcRenderer.invoke('set-event-watchlist', data),
  setEventSnooze: (data) => ipcRenderer.invoke('set-event-snooze', data),
  getEventProgress: (eventId) => ipcRenderer.invoke('get-event-progress', eventId),
  markEventRegion: (data) => ipcRenderer.invoke('mark-event-region', data),
  setEventItem: (data) => ipcRenderer.invoke('set-event-item', data),
  resetEventProgress: (eventId) => ipcRenderer.invoke('reset-event-progress', eventId),
  exportEventAdif: (data) => ipcRenderer.invoke('export-event-adif', data),
  eventRetroStamp: (data) => ipcRenderer.invoke('event-retro-stamp', data),
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close: () => ipcRenderer.send('win-close'),
  // Pop-out map
  popoutMapOpen: () => ipcRenderer.send('popout-map-open'),
  // Pop-out propagation map
  propPopoutOpen: () => ipcRenderer.send('prop-popout-open'),
  onPropPopoutStatus: (cb) => ipcRenderer.on('prop-popout-status', (_e, open) => cb(open)),
  popoutMapClose: () => ipcRenderer.send('popout-map-close'),
  sendPopoutSpots: (data) => ipcRenderer.send('popout-map-spots', data),
  sendPopoutTuneArc: (data) => ipcRenderer.send('popout-map-tune-arc', data),
  sendPopoutHome: (data) => ipcRenderer.send('popout-map-home', data),
  sendPopoutTheme: (theme) => ipcRenderer.send('popout-map-theme', theme),
  sendColorblindMode: (enabled) => ipcRenderer.send('colorblind-mode', enabled),
  sendWcagMode: (enabled) => ipcRenderer.send('wcag-mode', enabled),
  onPopoutMapStatus: (cb) => ipcRenderer.on('popout-map-status', (_e, open) => cb(open)),
  onPopoutOpenLog: (cb) => ipcRenderer.on('popout-open-log', (_e, spot) => cb(spot)),
  // Pop-out QSO log
  qsoPopoutOpen: () => ipcRenderer.send('qso-popout-open'),
  openLogPopout: (prefill) => ipcRenderer.send('log-popout-open', prefill),
  logPopoutTheme: (theme) => ipcRenderer.send('log-popout-theme', theme),
  pairPopoutTheme: (theme) => ipcRenderer.send('pair-popout-theme', theme),
  qsoPopoutClose: () => ipcRenderer.send('qso-popout-close'),
  sendQsoPopoutTheme: (theme) => ipcRenderer.send('qso-popout-theme', theme),
  onQsoPopoutStatus: (cb) => ipcRenderer.on('qso-popout-status', (_e, open) => cb(open)),
  // Pop-out spots window
  spotsPopoutOpen: () => ipcRenderer.send('spots-popout-open'),
  spotsPopoutClose: () => ipcRenderer.send('spots-popout-close'),
  sendSpotsPopoutTheme: (theme) => ipcRenderer.send('spots-popout-theme', theme),
  onSpotsPopoutStatus: (cb) => ipcRenderer.on('spots-popout-status', (_e, open) => cb(open)),
  // DX Cluster terminal pop-out
  clusterPopoutOpen: () => ipcRenderer.send('cluster-popout-open'),
  clusterPopoutClose: () => ipcRenderer.send('cluster-popout-close'),
  sendClusterPopoutTheme: (theme) => ipcRenderer.send('cluster-popout-theme', theme),
  onClusterPopoutStatus: (cb) => ipcRenderer.on('cluster-popout-status', (_e, open) => cb(open)),
  // Activation map pop-out
  actmapPopoutOpen: () => ipcRenderer.send('actmap-popout-open'),
  actmapPopoutData: (data) => ipcRenderer.send('actmap-popout-data', data),
  actmapPopoutContact: (data) => ipcRenderer.send('actmap-popout-contact', data),
  actmapPopoutTheme: (theme) => ipcRenderer.send('actmap-popout-theme', theme),
  onActmapPopoutStatus: (cb) => ipcRenderer.on('actmap-popout-status', (_e, open) => cb(open)),
  // VFO pop-out
  vfoPopoutOpen: () => ipcRenderer.send('vfo-popout-open'),
  vfoPopoutTheme: (theme) => ipcRenderer.send('vfo-popout-theme', theme),
  vfoTunedSpot: (spot) => ipcRenderer.send('vfo-tuned-spot', spot),
  onVfoPopoutStatus: (cb) => ipcRenderer.on('vfo-popout-status', (_e, open) => cb(open)),
  // JTCAT pop-out
  jtcatPopoutOpen: () => ipcRenderer.send('jtcat-popout-open'),
  jtcatSetUltracat: (on) => ipcRenderer.send('jtcat-set-ultracat', on),
  jtcatPopoutTheme: (theme) => ipcRenderer.send('jtcat-popout-theme', theme),
  onJtcatPopoutStatus: (cb) => ipcRenderer.on('jtcat-popout-status', (_e, open) => cb(open)),
  onJtcatPopoutReply: (cb) => ipcRenderer.on('jtcat-popout-reply', (_e, data) => cb(data)),
  onJtcatPopoutCallCq: (cb) => ipcRenderer.on('jtcat-popout-call-cq', () => cb()),
  onJtcatPopoutCancelQso: (cb) => ipcRenderer.on('jtcat-popout-cancel-qso', () => cb()),
  sendJtcatQsoState: (state) => ipcRenderer.send('jtcat-qso-state-update', state),
  // SSTV pop-out
  sstvPopoutOpen: () => ipcRenderer.send('sstv-popout-open'),
  sstvPopoutTheme: (theme) => ipcRenderer.send('sstv-popout-theme', theme),
  // Bandspread pop-out
  bandspreadPopoutOpen: () => ipcRenderer.send('bandspread-popout-open'),
  bandspreadPopoutClose: () => ipcRenderer.send('bandspread-popout-close'),
  sendBandspreadPopoutTheme: (theme) => ipcRenderer.send('bandspread-popout-theme', theme),
  onBandspreadPopoutStatus: (cb) => ipcRenderer.on('bandspread-popout-status', (_e, open) => cb(open)),
  // Push the main window's filtered spot list + a band hint to the bandspread
  // popout so it mirrors what Table View is showing.
  bandspreadPopoutPush: (payload) => ipcRenderer.send('bandspread-popout-push', payload),
  onBandspreadTunedSpot: (cb) => ipcRenderer.on('bandspread-tuned-spot', (_e, payload) => cb(payload)),
  // CW Keyer
  cwPaddleDit: (pressed) => ipcRenderer.send('cw-paddle-dit', pressed),
  cwPaddleDah: (pressed) => ipcRenderer.send('cw-paddle-dah', pressed),
  cwSetWpm: (wpm) => ipcRenderer.send('cw-set-wpm', wpm),
  cwStop: () => ipcRenderer.send('cw-stop'),
  sendCwText: (text) => ipcRenderer.send('send-cw-text', text),
  voiceMacroPtt: (state) => ipcRenderer.send('voice-macro-ptt', state),
  exportSettings: () => ipcRenderer.invoke('export-settings'),
  importSettings: () => ipcRenderer.invoke('import-settings'),
  relaunch: () => ipcRenderer.send('app-relaunch'),
  voiceMacroSave: (idx, base64) => ipcRenderer.invoke('voice-macro-save', idx, base64),
  voiceMacroLoad: (idx) => ipcRenderer.invoke('voice-macro-load', idx),
  voiceMacroDelete: (idx) => ipcRenderer.invoke('voice-macro-delete', idx),
  voiceMacroList: () => ipcRenderer.invoke('voice-macro-list'),
  voiceMacroLabelsSave: (labels) => ipcRenderer.invoke('voice-macro-labels-save', labels),
  onVoiceMacrosUpdated: (cb) => ipcRenderer.on('voice-macros-updated', () => cb()),
  onCwMacrosUpdated: (cb) => ipcRenderer.on('cw-macros-updated', () => cb()),
  // Phone-tapped macro slot — main relays here so the renderer's playback
  // chain (which owns the audio path) handles it the same as a local click.
  onPlayVoiceMacro: (cb) => ipcRenderer.on('play-voice-macro', (_e, idx) => cb(idx)),
  cwCancel: () => ipcRenderer.send('cw-cancel'),
  onCwEcho: (cb) => ipcRenderer.on('cw-echo', (_e, data) => cb(data)),
  onWinkeyerBusy: (cb) => ipcRenderer.on('winkeyer-busy', (_e, busy) => cb(busy)),
  // Activator mode — parks DB
  fetchParksDb: (prefix) => ipcRenderer.invoke('fetch-parks-db', prefix),
  searchParks: (query) => ipcRenderer.invoke('search-parks', query),
  getPark: (ref) => ipcRenderer.invoke('get-park', ref),
  parksDbStatus: () => ipcRenderer.invoke('parks-db-status'),
  exportActivationAdif: (data) => ipcRenderer.invoke('export-activation-adif', data),
  exportActivationAdifPerPark: (data) => ipcRenderer.invoke('export-activation-adif-perpark', data),
  uploadActivationToPota: (data) => ipcRenderer.invoke('upload-activation-to-pota', data),
  getPastActivations: () => ipcRenderer.invoke('get-past-activations'),
  deleteActivation: (parkRef, date) => ipcRenderer.invoke('delete-activation', parkRef, date),
  resolveCallsignLocations: (callsigns) => ipcRenderer.invoke('resolve-callsign-locations', callsigns),
  captureActmapPopout: () => ipcRenderer.invoke('capture-actmap-popout'),
  captureMainWindowRect: (rect) => ipcRenderer.invoke('capture-main-window-rect', rect),
  saveShareImage: (data) => ipcRenderer.invoke('save-share-image', data),
  // JTCAT (FT8/FT4)
  jtcatStart: (mode) => ipcRenderer.send('jtcat-start', mode),
  jtcatStop: () => ipcRenderer.send('jtcat-stop'),
  jtcatSetMode: (mode) => ipcRenderer.send('jtcat-set-mode', mode),
  jtcatSetWsprDial: (bandOrMHz) => ipcRenderer.send('jtcat-set-wspr-dial', bandOrMHz),
  jtcatSetTxFreq: (hz) => ipcRenderer.send('jtcat-set-tx-freq', hz),
  jtcatSetRxFreq: (hz) => ipcRenderer.send('jtcat-set-rx-freq', hz),
  jtcatSetAudioLatencyMs: (payload) => ipcRenderer.send('jtcat-set-audio-latency-ms', payload),
  onJtcatAudioLatency: (cb) => ipcRenderer.on('jtcat-audio-latency', (_e, data) => cb(data)),
  jtcatSetHoldTxFreq: (enabled) => ipcRenderer.send('jtcat-set-hold-tx-freq', !!enabled),
  jtcatSetLateStartTx: (enabled) => ipcRenderer.send('jtcat-set-late-start-tx', !!enabled),
  jtcatSetApDecode: (enabled) => ipcRenderer.send('jtcat-set-ap-decode', !!enabled),
  jtcatSetTxGain: (level) => ipcRenderer.send('jtcat-set-tx-gain', level),
  jtcatEnableTx: (enabled) => ipcRenderer.send('jtcat-enable-tx', enabled),
  jtcatHaltTx: () => ipcRenderer.send('jtcat-halt-tx'),
  jtcatTuneToggle: () => ipcRenderer.send('jtcat-tune-toggle'),
  jtcatSetTxMsg: (text) => ipcRenderer.send('jtcat-set-tx-msg', text),
  jtcatSetTxSlot: (slot) => ipcRenderer.send('jtcat-set-tx-slot', slot),
  jtcatTxComplete: () => ipcRenderer.send('jtcat-tx-complete'),
  jtcatAudio: (buf) => ipcRenderer.send('jtcat-audio', buf),
  jtcatLog: (msg) => ipcRenderer.send('jtcat-log', msg),
  jtcatQuietFreq: (hz) => ipcRenderer.send('jtcat-quiet-freq', hz),
  jtcatSpectrum: (bins) => ipcRenderer.send('jtcat-spectrum', bins),
  onJtcatDecode: (cb) => ipcRenderer.on('jtcat-decode', (_e, data) => cb(data)),
  onJtcatWsprSpots: (cb) => ipcRenderer.on('jtcat-wspr-spots', (_e, data) => cb(data)),
  onJtcatCycle: (cb) => ipcRenderer.on('jtcat-cycle', (_e, data) => cb(data)),
  onJtcatSpectrum: (cb) => ipcRenderer.on('jtcat-spectrum', (_e, data) => cb(data)),
  onJtcatStatus: (cb) => ipcRenderer.on('jtcat-status', (_e, data) => cb(data)),
  onJtcatClock: (cb) => ipcRenderer.on('jtcat-clock', (_e, data) => cb(data)),
  jtcatGetClock: () => ipcRenderer.invoke('jtcat-get-clock'),
  jtcatCheckClock: () => ipcRenderer.invoke('jtcat-check-clock'),
  jtcatSyncClock: () => ipcRenderer.invoke('jtcat-sync-clock'),
  jtcatOpenTimeSettings: () => ipcRenderer.invoke('jtcat-open-time-settings'),
  onJtcatTxAudio: (cb) => ipcRenderer.on('jtcat-tx-audio', (_e, data) => cb(data)),
  onJtcatSetTxGain: (cb) => ipcRenderer.on('jtcat-set-tx-gain', (_e, level) => cb(level)),
  onJtcatSetRxGain: (cb) => ipcRenderer.on('jtcat-set-rx-gain', (_e, level) => cb(level)),
  onJtcatTxStatus: (cb) => ipcRenderer.on('jtcat-tx-status', (_e, data) => cb(data)),
  onJtcatTuneState: (cb) => ipcRenderer.on('jtcat-tune-state', (_e, data) => cb(data)),
  onJtcatTuneAudioStart: (cb) => ipcRenderer.on('jtcat-tune-audio-start', () => cb()),
  onJtcatTuneAudioStop: (cb) => ipcRenderer.on('jtcat-tune-audio-stop', () => cb()),
  onJtcatStartForRemote: (cb) => ipcRenderer.on('jtcat-start-for-remote', () => cb()),
  onJtcatStopForRemote: (cb) => ipcRenderer.on('jtcat-stop-for-remote', () => cb()),
  // FreeDV Digital Voice
  freedvStart: (mode) => ipcRenderer.send('freedv-start', mode),
  freedvStop: () => ipcRenderer.send('freedv-stop'),
  freedvSetMode: (mode) => ipcRenderer.send('freedv-set-mode', mode),
  freedvRxAudio: (buf) => ipcRenderer.send('freedv-rx-audio', buf),
  freedvTxAudio: (buf) => ipcRenderer.send('freedv-tx-audio', buf),
  freedvSetTx: (enabled) => ipcRenderer.send('freedv-set-tx', enabled),
  freedvSetSquelch: (enabled, threshold) => ipcRenderer.send('freedv-set-squelch', enabled, threshold),
  onFreedvRxSpeech: (cb) => ipcRenderer.on('freedv-rx-speech', (_e, data) => cb(data)),
  onFreedvTxModem: (cb) => ipcRenderer.on('freedv-tx-modem', (_e, data) => cb(data)),
  onFreedvSync: (cb) => ipcRenderer.on('freedv-sync', (_e, data) => cb(data)),
  onFreedvStatus: (cb) => ipcRenderer.on('freedv-status', (_e, data) => cb(data)),
  onOpenLogForm: (cb) => ipcRenderer.on('open-log-form', () => cb()),
  onFreedvAutoStart: (cb) => ipcRenderer.on('freedv-auto-start', (_e, mode) => cb(mode)),
  onFreedvAutoStop: (cb) => ipcRenderer.on('freedv-auto-stop', () => cb()),
  // Zoom
  setZoom: (factor) => webFrame.setZoomFactor(factor),
  getZoom: () => webFrame.getZoomFactor(),
  onCwKey: (cb) => ipcRenderer.on('cw-key', (_e, data) => cb(data)),
  onCwKeyerStatus: (cb) => ipcRenderer.on('cw-keyer-status', (_e, s) => cb(s)),
  onCwText: (cb) => ipcRenderer.on('cw-text', (_e, data) => cb(data)),
  // Remote Access
  getLocalIPs: () => ipcRenderer.invoke('get-local-ips'),
  // Remote Launcher
  installLauncher: () => ipcRenderer.invoke('install-launcher'),
  uninstallLauncher: () => ipcRenderer.invoke('uninstall-launcher'),
  // Rig Control Panel
  rigControl: (data) => ipcRenderer.invoke('rig-control', data),
  getRigCommands: () => ipcRenderer.invoke('get-rig-commands'),
  saveRigCommandOverride: (key, value) => ipcRenderer.invoke('save-rig-command-override', { key, value }),
  resetAllRigCommands: () => ipcRenderer.invoke('reset-all-rig-commands'),
  onRigState: (cb) => ipcRenderer.on('rig-state', (_e, state) => cb(state)),
  onRemoteTxState: (cb) => ipcRenderer.on('remote-tx-state', (_e, state) => cb(state)),
  onRemoteStatus: (cb) => ipcRenderer.on('remote-status', (_e, s) => cb(s)),
  onReloadPrefs: (cb) => ipcRenderer.on('reload-prefs', () => cb()),
  tgxlSelectAntenna: (port) => ipcRenderer.invoke('tgxl-select-antenna', port),
  tgxlGetStatus: () => ipcRenderer.invoke('tgxl-get-status'),
  onTgxlStatus: (cb) => ipcRenderer.on('tgxl-status', (_e, s) => cb(s)),
  onRestartJtcatAudio: (cb) => ipcRenderer.on('restart-jtcat-audio', () => cb()),
  // VITA-49 dax_rx audio frames forwarded from main when the user is on
  // "SmartSDR Direct" — the renderer builds a synthetic MediaStream from
  // these to drive the JTCAT waterfall, since the Windows DAX device it
  // would normally capture is bypassed in that mode. K3SBP 2026-05-14.
  onJtcatVita49Audio: (cb) => {
    // Batch-ack so main can bound the IPC backlog. See main.js audioBus.
    //
    // Both the main window and the JTCAT popout are wired to this channel
    // (main forwards to both — only the one with an active AudioContext
    // actually plays). The cb returns true when it consumed the frame and
    // false (or undefined) when it didn't. For a no-op consumer we ack
    // EAGERLY — otherwise the dead window's backlog grows to
    // AUDIO_MAX_BACKLOG in <1 s and main starts dropping frames for the
    // live consumer too. K3SBP 2026-05-30, observed as "[Audio]
    // Backpressure: 200+ frames dropped" every 10 s while JTCAT view was
    // active.
    let _ackCount = 0;
    ipcRenderer.on('jtcat-vita49-audio', (_e, frame) => {
      const consumed = cb(frame);
      _ackCount++;
      if (!consumed || _ackCount >= 20) {
        ipcRenderer.send('audio-ack', { channel: 'jtcat-vita49-audio', count: _ackCount });
        _ackCount = 0;
      }
    });
  },
  setJtcatIpAudioReady: (ready) => ipcRenderer.send('jtcat-ip-audio-ready', { ready: !!ready }),
  // Cloud Sync
  qrzDownloadLogbook: () => ipcRenderer.invoke('qrz-download-logbook'),
  qrzDebugDump: () => ipcRenderer.invoke('qrz-debug-dump'),
  cloudGoogleSignIn: () => ipcRenderer.invoke('cloud-google-signin'),
  cloudLogin: (email, password) => ipcRenderer.invoke('cloud-login', email, password),
  cloudRegister: (email, password, callsign) => ipcRenderer.invoke('cloud-register', email, password, callsign),
  cloudLogout: () => ipcRenderer.invoke('cloud-logout'),
  cloudGetStatus: () => ipcRenderer.invoke('cloud-get-status'),
  cloudSyncNow: () => ipcRenderer.invoke('cloud-sync-now'),
  cloudBulkPrepare: () => ipcRenderer.invoke('cloud-bulk-prepare'),
  cloudBulkUpload: () => ipcRenderer.invoke('cloud-bulk-upload'),
  cloudDownloadAdif: () => ipcRenderer.invoke('cloud-download-adif'),
  cloudVerifySubscription: () => ipcRenderer.invoke('cloud-verify-subscription'),
  cloudSaveBmacEmail: (email) => ipcRenderer.invoke('cloud-save-bmac-email', email),
  cloudOpenSubscribe: () => ipcRenderer.invoke('cloud-open-subscribe'),
  cloudOpenManage: () => ipcRenderer.invoke('cloud-open-manage'),
  cloudGetSettings: () => ipcRenderer.invoke('cloud-get-settings'),
  cloudPutSettings: (data) => ipcRenderer.invoke('cloud-put-settings', data),
  onCloudSyncStatus: (cb) => ipcRenderer.on('cloud-sync-status', (_e, data) => cb(data)),
  // Main -> JTCAT popout: push currently-visible spot calls for decode-row
  // highlighting (Tyler K0OTC feature request, 2026-04-22).
  jtcatSpotsHighlight: (data) => ipcRenderer.send('jtcat-spots-highlight', data),
  // POTA.app Sync (parks-worked CSV auto-import)
  // Per-spot history lookup (POTA/WWFF via POTA.app, DXC/RBN via local buffers)
  potaSpotHistory: (data) => ipcRenderer.invoke('pota-spot-history', data),
  potaSyncStatus: () => ipcRenderer.invoke('pota-sync-status'),
  potaSyncConnect: () => ipcRenderer.invoke('pota-sync-connect'),
  potaSyncDisconnect: () => ipcRenderer.invoke('pota-sync-disconnect'),
  potaSyncNow: () => ipcRenderer.invoke('pota-sync-now'),
  potaSyncSetEnabled: (v) => ipcRenderer.invoke('pota-sync-set-enabled', v),
  potaSyncSetInterval: (v) => ipcRenderer.invoke('pota-sync-set-interval', v),
  onPotaSyncStatus: (cb) => ipcRenderer.on('pota-sync-status', (_e, data) => cb(data)),
  onCloudUploadProgress: (cb) => ipcRenderer.on('cloud-upload-progress', (_e, data) => cb(data)),
  // Settings → Summary card data
  getQsoCounts: () => ipcRenderer.invoke('get-qso-counts'),
  // Multi-operator profiles
  profilesList: () => ipcRenderer.invoke('profiles-list'),
  profilesAdd: (callsign) => ipcRenderer.invoke('profiles-add', callsign),
  profilesSwitch: (callsign) => ipcRenderer.invoke('profiles-switch', callsign),
  profilesArchive: (callsign) => ipcRenderer.invoke('profiles-archive', callsign),
});
