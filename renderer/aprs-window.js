// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS window: the three status cards, the two banners and the Beacon panel
// (the layout Casey approved 2026-11-19). It replaces the listen bar, the
// beacon bar and the radio beacon bar. Every word and flag comes from
// lib/aprs-window-state.js; this file puts them in the page and sends the
// operator's clicks to main. Main does the work and decides every refusal
// (lib/aprs-rf-gate.js and the rest). No pop-ups.
//
// Safety kept from before: the radio beacon is one click and one packet (no
// RF timer); its button is enabled only when main's gate allows a beacon,
// and disabled it says why; a second click while one goes out does nothing;
// "Stop transmitting" is main's abort, the same one closing the window uses;
// the TX power control is the rig's own set-tx-power (the beacon never
// changes power); picking a timer or opening the window never sends.
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var W = window.AprsWindowState;
  var B = window.AprsBeacon;
  var M = window.AprsRfMeters;
  var P = window.RigPowerView;
  var api = window.api;

  var listen = { on: false, state: 'off', sentence: '', band: '', bands: [], modeLabel: 'FM', mhz: '', heard: 0, lastAt: 0, note: '' };
  var ig = null;         // the iGate's marks
  var beacon = null;     // the internet beacon's state
  var rf = null;         // the radio beacon's state
  var clickedAt = -Infinity; // a radio beacon click is on its way to main: the button stays disabled
  var CLICK_HOLD_MS = 1500;
  var meter = { smeter: null, swr: 0, swrRatioSeen: false, fwdW: 0 };
  var picking = false, pickMarker = null;

  function setText(id, t) { var el = $(id); if (el.textContent !== t) el.textContent = t; }
  function show(id, on) { $(id).classList.toggle('hidden', !on); }
  function lines(id, arr) {
    var box = $(id);
    var key = (arr || []).join('\n');
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.textContent = '';
    (arr || []).forEach(function (t) { var d = document.createElement('div'); d.textContent = t; box.appendChild(d); });
  }
  // The one switch (role="switch"): on or off, the same slider in both states.
  function setSwitch(id, on, disabled) {
    var el = $(id);
    el.setAttribute('aria-checked', on ? 'true' : 'false');
    el.disabled = !!disabled;
    setText(id + '-text', on ? 'On' : 'Off');
  }
  function switchOn(id) { return $(id).getAttribute('aria-checked') === 'true'; }
  function dot(id, kind) { $(id).className = 'aprs-dot' + (kind && kind !== 'off' ? ' ' + kind : ''); }
  function feed() { var m = window.aprsMapApi; return m && m.feedInfo ? m.feedInfo() : { link: null, rate: 0, heard: { count: 0, last: null }, unit: 'mi' }; }
  function clickHeld() { return Date.now() - clickedAt < CLICK_HOLD_MS; }
  function listening() { return !!listen.on && (listen.state === 'starting' || listen.state === 'listening' || listen.state === 'paused'); }

  // ── card 1: My radio ──────────────────────────────────────────────────────
  function renderRadio() {
    var c = W.radioCard({ listen: listen, rf: rf, smeter: meter.smeter, sText: M.sLabel(meter.smeter), available: (rf && rf.meters) || {} });
    var card = $('card-radio');
    card.className = 'aprs-card ' + c.kind;
    dot('radio-dot', c.dot);
    setText('radio-title', c.title);
    setSwitch('aprs-listen-on', !!c.switchOn, !!c.switchDisabled);
    renderBandSelect(c.bandSelect);
    lines('radio-lines', c.lines);
    var sm = $('radio-smeter');
    sm.classList.toggle('hidden', !c.smeter);
    if (c.smeter) {
      sm.classList.toggle('none', !!c.smeter.none);
      $('radio-smeter-fill').style.width = c.smeter.pct + '%';
      $('radio-smeter-bar').setAttribute('aria-label', 'S-meter ' + c.smeter.text);
      setText('radio-smeter-val', c.smeter.text);
    }
  }
  // The band beside the switch, only when the rig has more than one APRS band.
  // Listening: a new band moves listening there at once; off: the switch starts on it.
  function renderBandSelect(bs) {
    show('aprs-band-pick', !!bs);
    if (!bs) return;
    var sel = $('aprs-band-select');
    var key = bs.options.map(function (o) { return o.band; }).join('|');
    if (sel.dataset.key !== key) {
      sel.dataset.key = key;
      sel.textContent = '';
      bs.options.forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o.band;
        opt.textContent = o.label;
        sel.appendChild(opt);
      });
    }
    sel.disabled = !!bs.disabled;
    if (document.activeElement !== sel) sel.value = bs.value;
    sel.title = bs.value === '30m' ? '30 m: 10.1476 MHz USB, 300 baud (HF APRS, one frequency worldwide). Receive only.'
      : '2 m: the regional APRS frequency, FM, 1200 baud. Receive only.';
  }
  $('aprs-band-select').addEventListener('change', function (e) { api.listenBand(e.target.value); });
  $('aprs-listen-on').addEventListener('click', function () {
    if ($('aprs-listen-on').disabled) return;
    var next = !switchOn('aprs-listen-on');
    setSwitch('aprs-listen-on', next, false); // moves at once; main's answer confirms it or puts it back
    api.listenSet(next);
  });

  // ── card 2: APRS-IS ───────────────────────────────────────────────────────
  function renderIs(f) {
    var c = W.isCard({ link: f.link, rate: f.rate, ig: ig });
    $('card-is').className = 'aprs-card ' + c.kind;
    dot('is-dot', c.dot);
    setText('is-title', c.title);
    setSwitch('aprs-feed-on', !!c.switchOn, !!c.switchDisabled);
    lines('is-lines', c.lines);
    var l = f.link || {};
    $('card-is').title = l.call ? 'Read-only login as ' + l.call + (l.anonymous ? ' (no callsign in Settings)' : '') : '';
  }
  $('aprs-feed-on').addEventListener('click', function () {
    if ($('aprs-feed-on').disabled) return;
    var next = !switchOn('aprs-feed-on');
    setSwitch('aprs-feed-on', next, false);
    api.feedSet(next);
  });

  // ── APRS settings: a panel inside this window (no browser dialog) ─────────
  var settingsFrom = null; // the control that opened it gets the focus back
  function settingsOpen() { return !$('aprs-settings').classList.contains('hidden'); }
  function openSettings(from) {
    settingsFrom = from || null;
    show('aprs-settings', true);
    $('aprs-settings-btn').setAttribute('aria-expanded', 'true');
    renderSettings();
    $('aprs-settings-done').focus();
  }
  function closeSettings() {
    if (picking) setPicking(false);
    show('aprs-settings', false);
    $('aprs-settings-btn').setAttribute('aria-expanded', 'false');
    if (settingsFrom && settingsFrom.focus) settingsFrom.focus();
  }
  ['aprs-settings-btn', 'aprs-igate-settings', 'aprs-beacon-settings'].forEach(function (id) {
    $(id).addEventListener('click', function () { if (settingsOpen() && id === 'aprs-settings-btn') closeSettings(); else openSettings($(id)); });
  });
  $('aprs-settings-done').addEventListener('click', closeSettings);
  // The iGate: settings.aprsIgate, the one setting Settings > Idle Mode shows.
  $('aprs-igate-on').addEventListener('change', function (e) { api.igateSet(e.target.checked); });
  function renderSettings() {
    $('aprs-igate-on').checked = !!(ig && ig.on);
    setText('aprs-igate-state', ig && ig.on ? W.igateLine(ig) : '');
    if (!beacon) return;
    // Where the position comes from: shown only when a FlexRadio reports a GPS.
    var src = W.sourceChoices(beacon);
    show('aprs-pos-source', !!src);
    if (src) renderRadios($('aprs-pos-source'), 'aprs-pos-source', src, function (id) { api.beaconSet({ source: id }); });
    renderRadios($('aprs-precision'), 'aprs-precision', W.precisionChoices(beacon), function (id) { api.beaconSet({ precision: id }); });
  }
  function renderRadios(box, name, choices, pick) {
    var key = JSON.stringify(choices);
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.textContent = '';
    choices.forEach(function (c) {
      var lab = document.createElement('label');
      lab.className = 'aprs-radio' + (c.disabled ? ' off' : '');
      var inp = document.createElement('input');
      inp.type = 'radio'; inp.name = name; inp.value = c.id; inp.checked = c.checked; inp.disabled = c.disabled;
      inp.addEventListener('change', function () { if (inp.checked) pick(c.id); });
      var t = document.createElement('span'); t.textContent = c.label;
      var n = document.createElement('span'); n.className = 'aprs-note'; n.textContent = c.note;
      lab.appendChild(inp); lab.appendChild(t); lab.appendChild(n);
      box.appendChild(lab);
    });
  }

  // ── card 3: Heard by my radio ─────────────────────────────────────────────
  function renderHeard(f) {
    var c = W.heardCard({ heard: f.heard, listening: listening(), unit: f.unit, now: Date.now() });
    $('card-heard').className = 'aprs-card aprs-card-heard ' + c.kind;
    show('heard-count-row', c.count > 0);
    setText('heard-n', String(c.count));
    setText('heard-n-text', c.countText);
    show('heard-title', !!c.title);
    setText('heard-title', c.title);
    lines('heard-lines', c.lines);
  }

  // ── banners ───────────────────────────────────────────────────────────────
  function renderBanners() {
    var t = W.timerBanner({ beacon: beacon, band: listen.band || '' });
    show('aprs-timer-banner', !!t);
    if (t) { setText('aprs-timer-title', t.title); setText('aprs-timer-detail', t.detail); }
    var a = W.onAirBanner({ rf: rf, rfCall: beacon && beacon.rfCall, now: Date.now() });
    show('aprs-air-banner', !!a);
    if (a) { setText('aprs-air-title', a.title); setText('aprs-air-time', a.time); }
  }
  $('aprs-timer-stop').addEventListener('click', function () { api.beaconSet({ intervalMin: 0 }); });
  // Main aborts the beacon in flight: the same aprsRfAbort closing the window uses. PTT drops at once.
  $('aprs-rf-stop').addEventListener('click', function () { api.rfStop(); });

  // ── the Beacon panel ──────────────────────────────────────────────────────
  function renderSsid() {
    var sel = $('aprs-rf-ssid');
    if (!sel.options.length) {
      var d = document.createElement('option');
      d.value = '';
      d.textContent = 'As my Settings callsign';
      sel.appendChild(d);
      B.SSID_CHOICES.forEach(function (c) {
        var o = document.createElement('option');
        o.value = String(c.ssid);
        o.textContent = c.ssid === 0 ? 'None: ' + c.label.replace(/^none: /, '') : '-' + c.ssid + ' ' + c.label;
        sel.appendChild(o);
      });
    }
    var v = beacon.settings.rfSsid == null ? '' : String(beacon.settings.rfSsid);
    if (document.activeElement !== sel) sel.value = v;
  }

  function renderSymbols() {
    var box = $('aprs-beacon-syms');
    var cur = beacon ? beacon.settings.symbol : 'house';
    var key = cur + '|' + document.documentElement.getAttribute('data-theme') + document.documentElement.getAttribute('data-ds');
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.textContent = '';
    B.SYMBOLS.forEach(function (sym) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'aprs-chip' + (sym.id === cur ? ' on' : '');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', sym.id === cur ? 'true' : 'false');
      b.title = sym.label + ' (APRS symbol ' + sym.table + sym.code + ')';
      b.innerHTML = AprsIcons.svg(sym.icon, 18) + '<span>' + sym.label + '</span>';
      b.addEventListener('click', function () { if (beacon && beacon.settings.symbol !== sym.id) api.beaconSet({ symbol: sym.id }); });
      box.appendChild(b);
    });
  }

  function fmtPoint(lat, lon) {
    return Math.abs(lat).toFixed(4) + (lat >= 0 ? ' N' : ' S') + ', ' + Math.abs(lon).toFixed(4) + (lon >= 0 ? ' E' : ' W');
  }

  // Extra 1: the comment that will go out, shown before anything is sent (it is set in APRS settings).
  function renderSends() {
    var a = beacon.activation || { comment: beacon.settings.comment, added: false, text: '', running: false };
    var line;
    if (!beacon.settings.activation) line = a.running ? 'Your activation is not added. Comment sent: ' + (a.comment || '(none)') : 'Comment: ' + (a.comment || '(none)');
    else if (!a.running) line = 'No activation is running, so the comment goes as typed: ' + (a.comment || '(none)');
    else line = 'Comment sent: ' + a.comment;
    var el = $('aprs-beacon-sends');
    el.textContent = line;
    el.title = line ? 'At most 43 characters (' + (a.comment || '').length + ' now). The internet and radio beacons send the same comment.' : '';
    show('aprs-beacon-sends', !!line);
  }

  function renderBeacon() {
    var p = W.beaconPanel({ rf: rf, beacon: beacon, clickHeld: clickHeld(), now: Date.now(), ssidChoices: B.SSID_CHOICES });
    setText('aprs-beacon-as', p.as);
    $('aprs-beacon-as').title = p.asTitle;
    // The radio beacon's one-click button: what it will do, or why not.
    var btn = $('aprs-rf-now');
    btn.disabled = !!p.rf.disabled;
    setText('aprs-rf-now-label', p.rf.label);
    setText('aprs-rf-now-sub', p.rf.sub);
    btn.title = p.rf.title;
    setText('aprs-rf-detail', p.detail);
    show('aprs-rf-detail', !!p.detail);
    setText('aprs-rf-last', p.last);
    show('aprs-rf-last', !!p.last);
    var res = $('aprs-rf-result');
    res.textContent = p.result ? p.result.text : '';
    res.className = 'aprs-result' + (p.result && p.result.tone === 'bad' ? ' bad' : '');
    show('aprs-rf-result', !!p.result);
    // The internet beacon's button and line.
    var nb = $('aprs-beacon-now');
    nb.disabled = !!p.net.disabled;
    nb.title = p.net.title;
    setText('aprs-beacon-now-sub', p.net.sub);
    var st = $('aprs-beacon-status');
    st.textContent = p.netLine.text;
    st.classList.toggle('bad', !!p.netLine.bad);
    show('aprs-beacon-status', !!p.netLine.text);
    renderLive();
  }

  function renderBeaconSettings() {
    if (!beacon) return;
    renderSsid();
    renderSymbols();
    var iv = $('aprs-beacon-interval');
    if (document.activeElement !== iv) iv.value = String(beacon.settings.intervalMin || 0);
    var cm = $('aprs-beacon-comment');
    if (document.activeElement !== cm) cm.value = beacon.settings.comment;
    $('aprs-beacon-activation').checked = !!beacon.settings.activation;
    renderSends();
    var pos = $('aprs-beacon-pos');
    if (picking) pos.textContent = 'Click the map where you are';
    else if (beacon.settings.source === 'gps') {
      // The radio's GPS: its grid with a fix, else the radio's own status words.
      var g = beacon.gps || {};
      pos.textContent = !g.installed ? 'Radio GPS: no GPS connected'
        : (beacon.position ? 'Radio GPS ' + (g.grid || '') : 'Radio GPS: no fix (' + (g.line || '') + ')');
    }
    else if (!beacon.position) pos.textContent = 'No position';
    else if (beacon.position.source === 'map') pos.textContent = 'Map point ' + fmtPoint(beacon.position.lat, beacon.position.lon);
    else pos.textContent = 'Grid ' + (beacon.grid || '') + ' centre';
    $('aprs-beacon-pick').textContent = picking ? 'Cancel' : 'Pick on map';
    show('aprs-beacon-grid', !!(beacon.position && beacon.position.source === 'map') && !picking);
    renderSettings();
    drawPick();
  }

  // While a radio beacon goes out: power out and SWR, live.
  function renderLive() {
    var inFlight = W.rfInFlight(rf);
    show('aprs-rf-live', inFlight);
    if (!inFlight) return;
    var v = W.liveMeters({ fwdW: rf.keyed ? meter.fwdW : 0, swr: rf.keyed ? meter.swr : 0, setW: rf.powerW, available: rf.meters || {} });
    $('aprs-live-pwr-fill').style.width = v.power.pct + '%';
    $('aprs-live-pwr-bar').setAttribute('aria-label', 'Power out ' + v.power.text);
    $('aprs-live-pwr-bar').classList.toggle('hidden', !!v.power.none);
    setText('aprs-live-pwr-val', v.power.text);
    $('aprs-live-pwr-val').classList.toggle('none', !!v.power.none);
    var sf = $('aprs-live-swr-fill');
    sf.style.width = v.swr.pct + '%';
    sf.className = 'aprs-bar-fill aprs-fill-swr' + (v.swr.cls ? ' ' + v.swr.cls : '');
    $('aprs-live-swr-bar').setAttribute('aria-label', 'SWR ' + v.swr.text);
    $('aprs-live-swr-bar').classList.toggle('hidden', !!v.swr.none);
    setText('aprs-live-swr-val', v.swr.text);
    $('aprs-live-swr-val').classList.toggle('none', !!v.swr.none);
    setText('aprs-live-note', rf.keyed ? v.note : 'Waiting for a clear channel before keying. ' + v.note);
  }

  // The picked point on the map: a small ring in the accent colour, only while the point is in use.
  function drawPick() {
    var map = window.aprsMapApi && window.aprsMapApi.map;
    if (!map || !window.L) return;
    var p = beacon && beacon.position && beacon.position.source === 'map' ? beacon.position : null;
    if (!p) { if (pickMarker) { map.removeLayer(pickMarker); pickMarker = null; } return; }
    var colour = getComputedStyle(document.documentElement).getPropertyValue('--accent-red').trim() || '#e94560';
    if (!pickMarker) {
      pickMarker = L.circleMarker([p.lat, p.lon], { radius: 9, weight: 3, color: colour, fill: false, interactive: false }).addTo(map);
    } else {
      pickMarker.setLatLng([p.lat, p.lon]);
      pickMarker.setStyle({ color: colour });
    }
  }
  function setPicking(on) {
    picking = on;
    var map = window.aprsMapApi && window.aprsMapApi.map;
    if (map) map.getContainer().classList.toggle('aprs-picking', on);
    renderBeaconSettings();
  }

  $('aprs-beacon-now').addEventListener('click', function () { api.beaconNow(); });
  $('aprs-beacon-interval').addEventListener('change', function (e) { api.beaconSet({ intervalMin: Number(e.target.value) || 0 }); });
  $('aprs-beacon-comment').addEventListener('change', function (e) { api.beaconSet({ comment: e.target.value }); });
  $('aprs-rf-ssid').addEventListener('change', function (e) { api.beaconSet({ rfSsid: e.target.value === '' ? null : Number(e.target.value) }); });
  $('aprs-beacon-activation').addEventListener('change', function (e) { api.beaconSet({ activation: e.target.checked }); });
  $('aprs-beacon-pick').addEventListener('click', function () { setPicking(!picking); });
  $('aprs-beacon-grid').addEventListener('click', function () { api.beaconSet({ lat: null, lon: null }); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (picking) setPicking(false); else if (settingsOpen()) closeSettings();
  });
  (function hookMap() {
    var map = window.aprsMapApi && window.aprsMapApi.map;
    if (!map) { setTimeout(hookMap, 200); return; }
    map.on('click', function (e) {
      if (!picking) return;
      var ll = e.latlng.wrap();
      setPicking(false);
      // A picked point is the exact position (a grid square never uses one).
      // Picking a point also means "this point", not the radio's GPS.
      api.beaconSet({ lat: ll.lat, lon: ll.lng, precision: 'exact', source: 'settings' });
    });
  })();

  // ── the one click ─────────────────────────────────────────────────────────
  $('aprs-rf-now').addEventListener('click', function () {
    // A second click while a beacon is going out does nothing; main ignores it too.
    if (!rf || !rf.allowed || W.rfInFlight(rf) || clickHeld()) return;
    clickedAt = Date.now();
    $('aprs-rf-now').disabled = true;
    api.rfSend();
    renderBeacon();
  });

  // ── TX power: minus / the radio's read-back / plus (rig-control set-tx-power) ──
  var pwrView = null, pwrSetting = null, pwrSetAt = 0;
  var pwrSend = P.createPowerSender(function (w) { api.rigControl({ action: 'set-tx-power', value: w }); });
  function renderPower() {
    var v = pwrView;
    var box = $('aprs-rf-power');
    if (!v || !v.shown) {
      setText('aprs-rf-power-label', 'Power');
      setText('aprs-rf-power-val', 'not over CAT');
      $('aprs-rf-power-down').disabled = $('aprs-rf-power-up').disabled = true;
      box.title = 'This radio\'s power is not available over CAT. Set it on the radio.';
      return;
    }
    // What the radio reads back, never just what was asked.
    var waiting = pwrWaiting();
    setText('aprs-rf-power-label', v.known ? 'Power (radio reads ' + v.label.replace(/(\d)([W%])$/, '$1 $2') + ')' : 'Power (the radio has not reported it)');
    setText('aprs-rf-power-val', waiting ? 'setting ' + P.formatWatts(pwrSetting, v.decimals, v.unit) : (v.known ? v.label.replace(/(\d)([W%])$/, '$1 $2') : '—'));
    $('aprs-rf-power-down').disabled = W.powerStep(pwrBase(), -1) == null;
    $('aprs-rf-power-up').disabled = W.powerStep(pwrBase(), +1) == null;
    box.title = v.enabled ? 'The radio\'s TX power, ' + v.min + ' to ' + v.max + ' ' + v.unit + '. The beacon goes out at this power; it never changes it.'
      : 'The radio\'s TX power (read only: no power control over CAT for this radio)';
  }
  // A set on its way (up to 3 s): the next press steps from it; the value shown waits for the radio.
  function pwrWaiting() {
    var v = pwrView;
    return !!v && pwrSetting != null && Date.now() - pwrSetAt < 3000 && !(v.known && Math.abs(v.watts - pwrSetting) < 0.05);
  }
  function pwrBase() { return pwrWaiting() ? Object.assign({}, pwrView, { watts: pwrSetting }) : pwrView; }
  function stepPower(dir) {
    var next = W.powerStep(pwrBase(), dir);
    if (next == null) return;
    pwrSetting = next; pwrSetAt = Date.now();
    renderPower();
    pwrSend(next);
  }
  $('aprs-rf-power-down').addEventListener('click', function () { stepPower(-1); });
  $('aprs-rf-power-up').addEventListener('click', function () { stepPower(+1); });
  api.onRigPower(function (p) { pwrView = P.powerView(p); renderPower(); });

  // ── meters ────────────────────────────────────────────────────────────────
  api.onCatSmeter(function (v) { meter.smeter = Number(v); renderRadio(); });
  api.onCatSwr(function (v) { if (meter.swrRatioSeen) return; meter.swr = M.swrFromWire(v); renderLive(); });
  api.onCatSwrRatio(function (v) { meter.swrRatioSeen = true; meter.swr = Number(v) || 0; renderLive(); });
  api.onCatFwdPower(function (v) { meter.fwdW = Number(v) || 0; renderLive(); });

  // ── the whole window ──────────────────────────────────────────────────────
  function renderAll() {
    var f = feed();
    renderRadio();
    renderIs(f);
    renderHeard(f);
    renderBanners();
    if (beacon) renderBeacon();
  }
  if (window.aprsMapApi) window.aprsMapApi.onFeed = function () { renderIs(feed()); renderHeard(feed()); };

  api.onListen(function (d) { listen = d || listen; renderAll(); });
  if (api.onIgate) api.onIgate(function (d) { ig = d || ig; renderIs(feed()); renderSettings(); });
  // The push that answers 'aprs-ready' can come before this script has loaded;
  // ask now that the listeners above are attached (the 8600M's empty bar, 2026-11-18).
  api.listenGet();
  api.onBeacon(function (d) { if (d) { beacon = d; renderBeaconSettings(); renderAll(); } });
  // The radio's GPS between beacon pushes (it shows or hides the "From my radio's GPS" choice).
  if (api.onGps) api.onGps(function (g) { if (beacon && g) { beacon.gps = g; renderBeaconSettings(); } });
  api.beaconGet();
  api.onRf(function (d) {
    if (!d) return;
    // A new key-down: the SWR and RF out start fresh, never the last transmission's.
    if (d.keyed && !(rf && rf.keyed)) { meter.swr = 0; meter.fwdW = 0; }
    rf = d;
    renderAll();
  });
  api.rfGet();
  api.rigPowerGet();

  new MutationObserver(function () { renderBeaconSettings(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-ds', 'data-dark-variant'] });
  // Ages, the elapsed time on the air, the timer's next time.
  setInterval(renderAll, 1000);
  setInterval(function () { if (rf && rf.keyed) renderBanners(); }, 250);
  // The gate depends on the dial and the radio's state: ask again every second while the window is open.
  setInterval(function () { if (!document.hidden) api.rfGet(); }, 1000);
  // The activation, the dial and the mode change outside this window: ask for the comment again every few seconds.
  setInterval(function () { if (!document.hidden) api.beaconGet(); }, 3000);
  renderPower();
  renderAll();
})();
