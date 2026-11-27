'use strict';

// The Bottom Banner Logger's "Grid | Distance | Heading" readout (#1097).
//
// The grid comes from the best source there is: QRZ, then a live spot, then
// cty.dat. The cty.dat answer is only an estimate: for the US, Canada, Japan
// and Australia it is a fixed point per call area (every US "5" call lands
// on EM12 in north Texas), elsewhere the middle of the DXCC entity. It used
// to be drawn exactly like a QRZ grid, and operators read it as the
// station's real grid square.
//
// The rule:
//   - QRZ or spot: "FN20 | 97mi | 92°", as before.
//   - Call-area estimate: "EM12 (estimate)", no distance and no heading. The
//     station can be hundreds of miles from the call-area point, about as far
//     as the distance itself, so a distance would mislead more than help.
//   - DXCC-entity estimate: "PM95 (estimate) | ~6,500mi | 330°". On a long DX
//     path the middle of the entity still gives a useful beam heading. Closer
//     than 500 mi / 800 km the error is as big as the distance, so neither is
//     shown.
// The estimate is never logged: the log's GRIDSQUARE comes from QRZ only
// (lib/qso-expand.js), and the banner does not send a grid.
//
// Pure. Dual-mode: require() in node, window.BannerStationGeo in the page.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BannerStationGeo = api;
}(typeof self !== 'undefined' ? self : this, function () {
  const ESTIMATE_MARK = '(estimate)';
  const NEAR = { mi: 500, km: 800 };
  const QRZ_HINT = 'QRZ.com with an XML Data subscription gives real grid squares.';

  // { grid, source: 'qrz'|'spot'|'cty', estimate: { kind: 'callarea'|'entity',
  //   area, region, entity }, distance (number|null), unit 'mi'|'km',
  //   heading (number|null) } -> { text, estimate (bool), title }
  function stationGeoReadout(o) {
    o = o || {};
    const grid = String(o.grid || '').trim().toUpperCase().slice(0, 4);
    const unit = o.unit === 'km' ? 'km' : 'mi';
    const hasDist = typeof o.distance === 'number' && isFinite(o.distance);
    const hasHdg = typeof o.heading === 'number' && isFinite(o.heading);
    const distTxt = hasDist ? Math.round(o.distance).toLocaleString() + unit : '';
    const hdgTxt = hasHdg ? Math.round(o.heading) + '°' : '';

    if (o.source !== 'cty') {
      const title = o.source === 'spot' ? 'Grid derived from spot location (park / cty.dat centroid)'
        : o.source === 'qrz' ? 'Grid from QRZ profile' : '';
      return { text: [grid, distTxt, hdgTxt].filter(Boolean).join(' | '), estimate: false, title };
    }

    const est = o.estimate || {};
    const entity = String(est.entity || '').trim();
    const gridTxt = grid ? `${grid} ${ESTIMATE_MARK}` : '';
    if (est.kind === 'callarea') {
      const where = [est.region, entity].filter(Boolean).join(', ');
      const area = est.area != null && est.area !== '' ? `call area ${est.area}` : 'the call area';
      return {
        text: gridTxt,
        estimate: true,
        title: `Estimate, not this station's grid: the middle of ${area}${where ? ` (${where})` : ''}. ` +
          'No distance or heading: the station could be hundreds of miles from that point. ' + QRZ_HINT,
      };
    }
    const near = hasDist && o.distance < NEAR[unit];
    const parts = near || !hasDist ? [gridTxt] : [gridTxt, '~' + distTxt, hdgTxt];
    const middle = entity ? `the middle of ${entity}` : 'the middle of the country';
    return {
      text: parts.filter(Boolean).join(' | '),
      estimate: true,
      title: `Estimate, not this station's grid: ${middle}. ` +
        (near ? 'No distance or heading: the station is too close for that point to tell. '
          : hasDist ? 'Distance and heading are to that point. ' : '') + QRZ_HINT,
    };
  }

  return { stationGeoReadout, ESTIMATE_MARK };
}));
