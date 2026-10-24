/**
 * Worked-states / worked-countries map overlay (docs/worked-states-countries-plan.md):
 * the one place that decides how a state or country is TINTED and what the
 * legend says, shared by the Spots map, its pop-out, the JTCAT window map,
 * the JTCAT map pop-out and ECHOCAT Web. Every map calls `buildLayer` with
 * the same roster, geo and scope, so they can never disagree.
 *
 * Tints are POTACAT's own (Casey 2026-10-23, "I don't want to copy
 * GridTracker"): not worked = no fill, worked = POTACAT blue, confirmed =
 * POTA green. Never yellow.
 *
 * Dual-mode: `require()` (tests, main) and `window.WorkedOverlay`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root.WorkedRoster ? root.WorkedRoster : require('./worked-roster'));
  else root.WorkedOverlay = factory(root.WorkedRoster);
})(typeof self !== 'undefined' ? self : this, function (WorkedRoster) {
  'use strict';

  var COLORS = { worked: '#4fc3f7', confirmed: '#4ecca3', none: '#9aa0a6' };

  var TINTS = {
    none: { stroke: true, color: COLORS.none, weight: 0.6, opacity: 0.35, fill: false, interactive: false },
    worked: { stroke: true, color: COLORS.worked, weight: 1, opacity: 0.85, fill: true, fillColor: COLORS.worked, fillOpacity: 0.32, interactive: false },
    confirmed: { stroke: true, color: COLORS.confirmed, weight: 1, opacity: 0.9, fill: true, fillColor: COLORS.confirmed, fillOpacity: 0.42, interactive: false },
  };

  var SCOPES = ['any', 'band', 'band-mode', 'band-exact'];
  var SCOPE_LABELS = { any: 'any band', band: 'this band', 'band-mode': 'band + mode', 'band-exact': 'band + exact mode' };

  /** Leaflet path options for a roster status. */
  function styleFor(status) {
    return Object.assign({}, TINTS[status] || TINTS.none);
  }

  function nextScope(scope) {
    var i = SCOPES.indexOf(scope);
    return SCOPES[(i + 1) % SCOPES.length];
  }

  function scopeLabel(scope) {
    return SCOPE_LABELS[scope] || SCOPE_LABELS['band-mode'];
  }

  /** The best status over several entity names (a GB polygon stands for England, Scotland and Wales). */
  function bestStatus(roster, kind, keys, opts) {
    var best = 'none';
    for (var i = 0; i < keys.length; i++) {
      var s = WorkedRoster.status(roster, kind, keys[i], opts);
      if (s === 'confirmed') return 'confirmed';
      if (s === 'worked') best = 'worked';
    }
    return best;
  }

  /**
   * A status source: `statusOf(kind, key)` -> none|worked|confirmed. The
   * desktop answers from the roster under a scope; ECHOCAT Web answers from
   * the status maps the shack sent (it has no roster).
   */
  function rosterStatusOf(roster, opts) {
    return function (kind, key) { return WorkedRoster.status(roster, kind, key, opts); };
  }
  function mapStatusOf(stateMap, countryMap) {
    return function (kind, key) {
      var m = kind === 'state' ? stateMap : countryMap;
      var s = m && m[key];
      return s === 'confirmed' || s === 'worked' ? s : 'none';
    };
  }

  function bestStatusWith(statusOf, kind, keys) {
    var best = 'none';
    for (var i = 0; i < keys.length; i++) {
      var s = statusOf(kind, keys[i]);
      if (s === 'confirmed') return 'confirmed';
      if (s === 'worked') best = 'worked';
    }
    return best;
  }

  function featureStatusWith(statusOf, kind, feature) {
    var p = (feature && feature.properties) || {};
    if (kind === 'state') return statusOf('state', p.code);
    return bestStatusWith(statusOf, 'entity', Array.isArray(p.dxcc) ? p.dxcc : []);
  }

  function featureStatus(roster, kind, feature, opts) {
    return featureStatusWith(rosterStatusOf(roster, opts), kind, feature);
  }

  /**
   * What the legend says for one layer: "States 37/50 worked, 12 confirmed".
   * `places` = codes (states) or entity names (countries); countries count
   * every DXCC entity, polygon or circle.
   */
  function summary(roster, kind, keys, opts) {
    var c = WorkedRoster.counts(roster, kind, keys, opts);
    return { worked: c.worked, confirmed: c.confirmed, total: c.total };
  }

  /**
   * Build the Leaflet layer for the current roster and scope.
   * @param {object} L        Leaflet
   * @param {object} geo      { states: FeatureCollection, countries: FeatureCollection, points: [{name, lat, lon}] }
   * @param {object} roster   lib/worked-roster.js roster
   * @param {object} opts     { scope, band, mode, confirmedOnly }
   * @param {object} show     { states: bool, countries: bool }
   * @param {string} [pane]   map pane name (created by the caller, under the markers)
   */
  function buildLayer(L, geo, roster, opts, show, pane) {
    return buildLayerWith(L, geo, rosterStatusOf(roster || WorkedRoster.empty(), opts || {}), show, pane);
  }

  /** Same, from any status source (ECHOCAT Web passes the shack's maps). */
  function buildLayerWith(L, geo, statusOf, show, pane) {
    var group = L.layerGroup();
    var paneOpt = pane ? { pane: pane } : {};
    if (show && show.countries && geo && geo.countries) {
      group.addLayer(L.geoJSON(geo.countries, Object.assign({
        style: function (f) { return styleFor(featureStatusWith(statusOf, 'entity', f)); },
      }, paneOpt)));
      // Entities with no polygon: a circle at cty.dat's lat/lon, drawn at
      // three world copies like every other marker. Unworked ones are
      // skipped: a sea of faint rings says nothing.
      var pts = (geo.points || []);
      for (var i = 0; i < pts.length; i++) {
        var st = statusOf('entity', pts[i].name);
        if (st === 'none') continue;
        var style = styleFor(st);
        style.weight = 1.5; style.fillOpacity = Math.min(0.7, style.fillOpacity + 0.2);
        for (var k = -360; k <= 360; k += 360) {
          group.addLayer(L.circle([pts[i].lat, pts[i].lon + k], Object.assign({ radius: 90000 }, style, paneOpt)));
        }
      }
    }
    if (show && show.states && geo && geo.states) {
      group.addLayer(L.geoJSON(geo.states, Object.assign({
        style: function (f) { return styleFor(featureStatusWith(statusOf, 'state', f)); },
      }, paneOpt)));
    }
    return group;
  }

  /** A line of plain text for the legend / tooltip. */
  function legendLine(roster, kind, keys, opts) {
    var s = summary(roster, kind, keys, opts);
    var what = kind === 'state' ? 'States' : 'Countries';
    return what + ' ' + s.worked + '/' + s.total + ' worked, ' + s.confirmed + ' confirmed';
  }

  /** "on 20m digital" / "on 20m" / "any band" for the legend title. */
  function scopeText(opts) {
    var o = opts || {};
    var fam = WorkedRoster.awardFamily(o.mode);
    if (o.scope === 'any') return 'any band';
    if (!o.band) return scopeLabel(o.scope);
    if (o.scope === 'band') return 'on ' + o.band;
    if (o.scope === 'band-exact') return 'on ' + o.band + (o.mode ? ' ' + String(o.mode).toUpperCase() : '');
    return 'on ' + o.band + (fam ? ' ' + fam : '');
  }

  /**
   * The legend control: checkboxes for the two layers (mouse and touch), the
   * scope with its F8 hint, the counts. One DOM for every map; styles inline
   * so no window needs a stylesheet. `onChange({states?, countries?, scope?})`
   * is the caller's hook to main (which persists and re-broadcasts).
   */
  function createLegend(L, onChange, onSync) {
    var btnCss = 'background:rgba(255,255,255,.1);color:inherit;border:1px solid rgba(255,255,255,.25);border-radius:3px;padding:0 6px;font:inherit;cursor:pointer;line-height:1.5';
    var Legend = L.Control.extend({
      options: { position: 'bottomleft' },
      onAdd: function () {
        var el = L.DomUtil.create('div', 'worked-overlay-legend');
        el.style.cssText = 'background:rgba(22,33,62,0.88);color:#e8e8e8;font:11px/1.4 system-ui,sans-serif;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);min-width:150px;box-shadow:0 1px 4px rgba(0,0,0,0.4)';
        el.innerHTML =
          '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;white-space:nowrap"><input type="checkbox" data-k="states" style="margin:0"> <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + COLORS.worked + '"></span>States <kbd style="margin-left:auto;opacity:.6;font-size:9px">F6</kbd></label>' +
          '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;white-space:nowrap"><input type="checkbox" data-k="countries" style="margin:0"> <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + COLORS.worked + '"></span>Countries <kbd style="margin-left:auto;opacity:.6;font-size:9px">F7</kbd></label>' +
          '<div data-k="scope" title="Which band and mode the tints are about. F8 cycles it." style="display:flex;align-items:center;gap:5px;cursor:pointer;white-space:nowrap;margin-top:2px"><span data-k="scope-text" style="text-decoration:underline dotted"></span><kbd style="margin-left:auto;opacity:.6;font-size:9px">F8</kbd></div>' +
          '<div data-k="swatches" style="margin-top:4px;display:flex;gap:8px;white-space:nowrap"><span><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + COLORS.worked + ';vertical-align:-1px"></i> worked</span><span><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + COLORS.confirmed + ';vertical-align:-1px"></i> confirmed</span></div>' +
          '<div data-k="counts" style="margin-top:3px;opacity:.85;white-space:nowrap"></div>' +
          // Sync from the map itself (the FT8 window's included), desktop only — a device has no log.
          '<div data-k="sync" style="margin-top:4px;display:none;align-items:center;gap:4px;white-space:nowrap"><span style="opacity:.7">Update from</span>' +
          '<button type="button" data-k="sync-lotw" title="Download your LoTW confirmations. Each one carries the state and grid the other station certified, so this fills states too." style="' + btnCss + '">LoTW</button>' +
          '<button type="button" data-k="sync-qrz" title="Fill the state on older QSOs that have none: from the park for a park contact, else from QRZ (150 lookups a press)." style="' + btnCss + '">QRZ</button></div>' +
          '<div data-k="sync-text" style="margin-top:2px;opacity:.85;max-width:230px;white-space:normal;display:none"></div>';
        L.DomEvent.disableClickPropagation(el);
        L.DomEvent.disableScrollPropagation(el);
        if (onSync) {
          el.querySelector('[data-k=sync]').style.display = 'flex';
          var syncBtns = el.querySelectorAll('[data-k^=sync-]');
          var textEl = el.querySelector('[data-k=sync-text]');
          var clearTimer = null;
          var run = function (kind) {
            for (var b = 0; b < syncBtns.length; b++) syncBtns[b].disabled = true;
            clearTimeout(clearTimer);
            textEl.style.display = ''; textEl.textContent = kind === 'lotw' ? 'Downloading from LoTW…' : 'Looking up…';
            Promise.resolve().then(function () { return onSync(kind); }).then(function (r) {
              textEl.textContent = (r && r.text) || (r && r.ok ? 'Done.' : 'Could not update.');
              if (r && r.ok) clearTimer = setTimeout(function () { textEl.style.display = 'none'; }, 20000);
            }, function (e) {
              textEl.textContent = 'Could not update: ' + (e && e.message || e);
            }).then(function () { for (var b = 0; b < syncBtns.length; b++) syncBtns[b].disabled = false; });
          };
          el.querySelector('[data-k=sync-lotw]').addEventListener('click', function () { run('lotw'); });
          el.querySelector('[data-k=sync-qrz]').addEventListener('click', function () { run('qrz'); });
        }
        var boxes = el.querySelectorAll('input[type=checkbox]');
        for (var i = 0; i < boxes.length; i++) {
          boxes[i].addEventListener('change', function (ev) {
            var patch = {}; patch[ev.target.getAttribute('data-k')] = ev.target.checked;
            if (onChange) onChange(patch);
          });
        }
        el.querySelector('[data-k=scope]').addEventListener('click', function () {
          if (onChange) onChange({ scope: nextScope(el._scope || 'band-mode') });
        });
        this._el = el;
        return el;
      },
      /** state = { states, countries, scope, band, mode, confirmedOnly }, lines = [] of text */
      update: function (state, lines) {
        var el = this._el; if (!el) return;
        el._scope = state.scope;
        el.querySelector('input[data-k=states]').checked = !!state.states;
        el.querySelector('input[data-k=countries]').checked = !!state.countries;
        el.querySelector('[data-k=scope-text]').textContent = 'Scope: ' + scopeText(state) + (state.confirmedOnly ? ' (confirmed only)' : '');
        el.querySelector('[data-k=counts]').innerHTML = (lines || []).map(function (t) { return '<div>' + t.replace(/[<>&]/g, '') + '</div>'; }).join('');
        var any = !!(state.states || state.countries);
        el.querySelector('[data-k=swatches]').style.display = any ? '' : 'none';
        el.querySelector('[data-k=counts]').style.display = any ? '' : 'none';
      },
    });
    return new Legend();
  }

  /**
   * F6 / F7 / F8 -> the change to send, or null. `state` is the current
   * overlay state (for F8's next scope).
   */
  function keyPatch(key, state) {
    if (key === 'F6') return { states: !(state && state.states) };
    if (key === 'F7') return { countries: !(state && state.countries) };
    if (key === 'F8') return { scope: nextScope(state && state.scope) };
    return null;
  }

  /**
   * The whole per-window glue, so every map is one call:
   *   var ov = WorkedOverlay.attach(L, map, window.api);
   *   document.addEventListener('keydown', function (e) { ov.onKey(e); });
   * `api` needs: getWorkedRoster(), onWorkedRoster(cb), workedOverlayGet(),
   * onWorkedOverlayState(cb), workedOverlayGeo(), workedOverlaySet(patch).
   * The geo files are fetched once, the first time a layer is switched on.
   * Everything draws in its own pane UNDER the markers (zIndex 350: above
   * the tiles at 200, below the overlay pane at 400 where markers, grid
   * rectangles, arcs and the night shade live).
   */
  function attach(L, map, api, options) {
    var o = options || {};
    var paneName = o.pane || 'workedOverlayPane';
    if (!map.getPane(paneName)) { map.createPane(paneName); map.getPane(paneName).style.zIndex = 350; map.getPane(paneName).style.pointerEvents = 'none'; }
    var ctl = { roster: null, state: { states: false, countries: false, scope: 'band-mode', band: '', mode: '', confirmedOnly: false }, geo: null, layer: null, legend: null, loading: false };
    var keys = { states: WorkedRoster.US_STATES.map(function (s) { return s.code; }), entities: [] };

    function countLine(what, c) {
      return what + ' ' + c.worked + '/' + c.total + ' worked, ' + c.confirmed + ' confirmed';
    }
    function redraw() {
      if (ctl.layer) { map.removeLayer(ctl.layer); ctl.layer = null; }
      var st = ctl.state;
      var opts = { scope: st.scope, band: st.band, mode: st.mode, confirmedOnly: st.confirmedOnly };
      var lines = [];
      var statusOf;
      if (o.web) {
        // ECHOCAT Web: the shack sent the statuses and the counts under ITS scope.
        statusOf = mapStatusOf(st.stateMap, st.countryMap);
        if (st.counts) {
          if (st.states && st.counts.states) lines.push(countLine('States', st.counts.states));
          if (st.countries && st.counts.countries) lines.push(countLine('Countries', st.counts.countries));
        }
      } else {
        statusOf = rosterStatusOf(ctl.roster || WorkedRoster.empty(), opts);
        if (ctl.roster) {
          if (st.states) lines.push(legendLine(ctl.roster, 'state', keys.states, opts));
          if (st.countries && keys.entities.length) lines.push(legendLine(ctl.roster, 'entity', keys.entities, opts));
        }
      }
      if (ctl.legend) ctl.legend.update(st, lines);
      if (!(st.states || st.countries)) return;
      if (!ctl.geo) { loadGeo(); return; }
      ctl.layer = buildLayerWith(L, ctl.geo, statusOf, { states: st.states, countries: st.countries }, paneName);
      ctl.layer.addTo(map);
    }
    function loadGeo() {
      if (ctl.loading || !api.workedOverlayGeo) return;
      ctl.loading = true;
      Promise.resolve(api.workedOverlayGeo()).then(function (geo) {
        ctl.loading = false;
        if (!geo) return;
        ctl.geo = geo;
        keys.entities = Array.isArray(geo.entityNames) ? geo.entityNames : [];
        redraw();
      }).catch(function () { ctl.loading = false; });
    }
    if (!o.noLegend) {
      ctl.legend = createLegend(L, function (patch) { if (api.workedOverlaySet) api.workedOverlaySet(patch); }, !o.web && api.workedSync ? function (kind) { return api.workedSync(kind); } : null);
      ctl.legend.addTo(map);
      ctl.legend.update(ctl.state, []);
    }
    if (api.onWorkedRoster) api.onWorkedRoster(function (r) { ctl.roster = r; redraw(); });
    if (api.getWorkedRoster) Promise.resolve(api.getWorkedRoster()).then(function (r) { if (r) { ctl.roster = r; redraw(); } }).catch(function () {});
    if (api.onWorkedOverlayState) api.onWorkedOverlayState(function (s) { if (s) { ctl.state = Object.assign({}, ctl.state, s); redraw(); } });
    if (api.workedOverlayGet) Promise.resolve(api.workedOverlayGet()).then(function (s) { if (s) { ctl.state = Object.assign({}, ctl.state, s); redraw(); } }).catch(function () {});

    ctl.redraw = redraw;
    /** Key handler: returns true when the key was taken. Bare F6/F7/F8 only, never from a text field. */
    ctl.onKey = function (e) {
      if (!e || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false;
      if (e.target && e.target.matches && e.target.matches('input, select, textarea, [contenteditable]')) return false;
      var patch = keyPatch(e.key, ctl.state);
      if (!patch) return false;
      e.preventDefault();
      if (api.workedOverlaySet) api.workedOverlaySet(patch);
      return true;
    };
    return ctl;
  }

  return {
    COLORS: COLORS,
    TINTS: TINTS,
    SCOPES: SCOPES,
    keyPatch: keyPatch,
    attach: attach,
    rosterStatusOf: rosterStatusOf,
    mapStatusOf: mapStatusOf,
    featureStatusWith: featureStatusWith,
    buildLayerWith: buildLayerWith,
    styleFor: styleFor,
    nextScope: nextScope,
    scopeLabel: scopeLabel,
    scopeText: scopeText,
    featureStatus: featureStatus,
    bestStatus: bestStatus,
    summary: summary,
    legendLine: legendLine,
    buildLayer: buildLayer,
    createLegend: createLegend,
  };
});
