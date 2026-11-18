// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// The APRS window's nine icons, drawn for POTACAT: a round badge in a theme
// colour with a simple glyph on it. Car, boat and aircraft are drawn from
// above, nose up, so they turn to the station's course (with a small pointer
// on the badge's rim). Nothing here comes from the classic APRS symbol
// bitmaps or any other program's icon set.
//
// Colours are the theme's own tokens, read from the page when the theme
// changes; the glyph is dark or light, whichever reads on the badge.
// lib/aprs-symbols.js decides which icon a station gets.
//
// window.AprsIcons: { ICONS, LABEL, readColours(), svg(icon, px, course), sprite(icon, px, dpr) }
(function () {
  'use strict';

  // 24 x 24, centre 12,12; the badge is a circle of radius 11.
  // Each part: [path, 'fill' | 'stroke', 'ink' (glyph) | 'badge' (cut-out in the badge colour)]
  var GLYPHS = {
    car: [
      ['M9.2 4.5h5.6a2.2 2.2 0 0 1 2.2 2.2v10.6a2.2 2.2 0 0 1-2.2 2.2H9.2A2.2 2.2 0 0 1 7 17.3V6.7a2.2 2.2 0 0 1 2.2-2.2z', 'fill', 'ink'],
      ['M8.6 8.6h6.8l-1 2.6H9.6z', 'fill', 'badge'],
      ['M9.4 15.6h5.2l.6 1.7H8.8z', 'fill', 'badge'],
    ],
    house: [
      ['M5 12.2L12 6l7 6.2', 'stroke', 'ink'],
      ['M7.2 10.6V18h9.6v-7.4', 'stroke', 'ink'],
      ['M10.6 18v-3.8h2.8V18', 'stroke', 'ink'],
    ],
    digi: [
      ['M12 7a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3z', 'fill', 'ink'],
      ['M12 10.5L9.2 19M12 10.5l2.8 8.5M10.2 16h3.6', 'stroke', 'ink'],
      ['M9.8 6.4a3 3 0 0 0 0 4.2M14.2 6.4a3 3 0 0 1 0 4.2', 'stroke', 'ink'],
      ['M7.6 4.3a6 6 0 0 0 0 8.4M16.4 4.3a6 6 0 0 1 0 8.4', 'stroke', 'ink'],
    ],
    igate: [
      ['M12 5.8a6.2 6.2 0 1 0 0 12.4a6.2 6.2 0 1 0 0-12.4z', 'stroke', 'ink'],
      ['M12 5.8c-2.4 1.9-2.4 10.5 0 12.4M12 5.8c2.4 1.9 2.4 10.5 0 12.4M5.8 12h12.4', 'stroke', 'ink'],
    ],
    weather: [
      ['M8.2 17h8.3a3.4 3.4 0 0 0 .3-6.8A4.9 4.9 0 0 0 7.5 11.6a2.7 2.7 0 0 0 .7 5.4z', 'stroke', 'ink'],
    ],
    hiker: [
      ['M13.2 4a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6z', 'fill', 'ink'],
      ['M12.6 8.8l-1.8 4.8l2.8 2.4V20M10.8 13.6L9 20M12.4 9.6l2.8 2.2M11.6 10l-2.6 1.8', 'stroke', 'ink'],
      ['M16.8 11.5V20', 'stroke', 'ink'],
    ],
    boat: [
      ['M12 3.5c2.8 2.8 4.3 5.8 4.3 9.6v5.6a1.6 1.6 0 0 1-1.6 1.6H9.3a1.6 1.6 0 0 1-1.6-1.6v-5.6c0-3.8 1.5-6.8 4.3-9.6z', 'fill', 'ink'],
      ['M10.2 12.2h3.6v4.6h-3.6z', 'fill', 'badge'],
    ],
    aircraft: [
      ['M12 2.8c.8 0 1.4.8 1.4 1.9v4.9l6.1 3.8v1.9l-6.1-1.9v4l1.9 1.4v1.6L12 19.5l-3.3.9v-1.6l1.9-1.4v-4l-6.1 1.9v-1.9l6.1-3.8V4.7c0-1.1.6-1.9 1.4-1.9z', 'fill', 'ink'],
    ],
    other: [
      ['M12 8.4a3.6 3.6 0 1 0 0 7.2a3.6 3.6 0 1 0 0-7.2z', 'fill', 'ink'],
    ],
    you: [
      ['M12 5.5l1.9 4.1 4.4.5-3.3 3 .9 4.4L12 15.3l-3.9 2.2.9-4.4-3.3-3 4.4-.5z', 'fill', 'ink'],
    ],
  };

  var ICONS = ['car', 'house', 'digi', 'igate', 'weather', 'hiker', 'boat', 'aircraft', 'other'];
  var HEADED = { car: true, boat: true, aircraft: true };
  var LABEL = {
    car: 'Car or vehicle', house: 'Home station', digi: 'Digipeater', igate: 'iGate',
    weather: 'Weather', hiker: 'On foot', boat: 'Boat', aircraft: 'Aircraft', other: 'Other', you: 'You',
  };
  var SHORT = {
    car: 'Vehicle', house: 'Home', digi: 'Digi', igate: 'iGate', weather: 'Weather',
    hiker: 'On foot', boat: 'Boat', aircraft: 'Aircraft', other: 'Other', you: 'You',
  };
  // The theme token each badge takes, and a fallback if a theme leaves it unset.
  var TOKEN = {
    car: ['--accent-green', '#4ecca3'],
    house: ['--accent-blue', '#4fc3f7'],
    digi: ['--source-sota', '#f0a500'],
    igate: ['--source-rbn', '#00bcd4'],
    weather: ['--source-dxc', '#e040fb'],
    hiker: ['--source-pskr', '#ff6b6b'],
    boat: ['--source-wwff', '#26a69a'],
    aircraft: ['--source-tiles', '#ab47bc'],
    other: ['--source-wwbota', '#78909c'],
    you: ['--accent-red', '#e94560'],
  };

  var colours = null;     // icon -> { badge, ink, rim }
  var sprites = {};       // 'icon|px|dpr' -> canvas
  var paths = {};         // path string -> Path2D

  function parseColour(c) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
    if (m) {
      var h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(c);
    return m ? [+m[1], +m[2], +m[3]] : null;
  }
  function luminance(rgb) {
    var a = rgb.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }

  /** Read the badge colours from the current theme. Call again when it changes. */
  function readColours() {
    var cs = getComputedStyle(document.documentElement);
    var out = {};
    Object.keys(TOKEN).forEach(function (k) {
      var v = (cs.getPropertyValue(TOKEN[k][0]) || '').trim();
      var rgb = parseColour(v);
      if (!rgb) { v = TOKEN[k][1]; rgb = parseColour(v); }
      // The glyph: near-black on a light badge, white on a dark one.
      var ink = luminance(rgb) > 0.36 ? '#10131a' : '#ffffff';
      out[k] = { badge: v, ink: ink, rim: ink === '#ffffff' ? 'rgba(255,255,255,0.9)' : 'rgba(16,19,26,0.55)' };
    });
    colours = out;
    sprites = {};
    return out;
  }
  function col(icon) { if (!colours) readColours(); return colours[icon] || colours.other; }

  /** Inline SVG for the list, the legend and the details. course turns a headed icon. */
  function svg(icon, px, course) {
    var g = GLYPHS[icon] ? icon : 'other';
    var c = col(g);
    var turn = HEADED[g] && course != null && isFinite(course) && course > 0 && course <= 360;
    var body = '<circle cx="12" cy="12" r="11" fill="' + c.badge + '" stroke="' + c.rim + '" stroke-width="1.2"/>';
    if (turn) body += '<path d="M12 -2.2L9.4 1.6h5.2z" fill="' + c.badge + '"/>';
    GLYPHS[g].forEach(function (p) {
      var colour = p[2] === 'badge' ? c.badge : c.ink;
      body += p[1] === 'fill'
        ? '<path d="' + p[0] + '" fill="' + colour + '"/>'
        : '<path d="' + p[0] + '" fill="none" stroke="' + colour + '" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>';
    });
    var rot = turn ? '<g transform="rotate(' + Math.round(course) + ' 12 12)">' + body + '</g>' : body;
    return '<svg class="aprs-ico" width="' + px + '" height="' + px + '" viewBox="-2.5 -2.5 29 29" aria-hidden="true">' + rot + '</svg>';
  }

  function path2d(d) { return paths[d] || (paths[d] = new Path2D(d)); }

  /**
   * A drawn badge for the map canvas, nose up, px across (CSS pixels), with
   * room for the course pointer. Cached until the theme changes. The caller
   * centres it on the station and turns it to the course.
   */
  function sprite(icon, px, dpr, pointer) {
    var g = GLYPHS[icon] ? icon : 'other';
    var key = g + '|' + px + '|' + dpr + '|' + (pointer ? 1 : 0);
    if (sprites[key]) return sprites[key];
    var c = col(g);
    var box = Math.ceil(px * 29 / 24);             // the badge plus the pointer and rim
    var cv = document.createElement('canvas');
    cv.width = cv.height = Math.ceil(box * dpr);
    var ctx = cv.getContext('2d');
    var s = (px / 24) * dpr;
    ctx.setTransform(s, 0, 0, s, (box * dpr) / 2 - 12 * s, (box * dpr) / 2 - 12 * s);
    ctx.beginPath(); ctx.arc(12, 12, 11, 0, Math.PI * 2);
    ctx.fillStyle = c.badge; ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = c.rim; ctx.stroke();
    if (pointer) {
      ctx.beginPath(); ctx.moveTo(12, -2.2); ctx.lineTo(9.4, 1.6); ctx.lineTo(14.6, 1.6); ctx.closePath();
      ctx.fillStyle = c.badge; ctx.fill();
    }
    GLYPHS[g].forEach(function (p) {
      var colour = p[2] === 'badge' ? c.badge : c.ink;
      if (p[1] === 'fill') { ctx.fillStyle = colour; ctx.fill(path2d(p[0])); }
      else { ctx.strokeStyle = colour; ctx.lineWidth = 1.9; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(path2d(p[0])); }
    });
    var out = { canvas: cv, size: box };
    sprites[key] = out;
    return out;
  }

  window.AprsIcons = {
    ICONS: ICONS, LABEL: LABEL, SHORT: SHORT,
    isHeaded: function (icon) { return !!HEADED[icon]; },
    readColours: readColours, colour: col, svg: svg, sprite: sprite,
  };
})();
