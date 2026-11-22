// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS packet parser: one APRS-IS line in TNC2 form (SRC>DEST,PATH:info)
// into a plain object. Written from the APRS Protocol Reference 1.0.1; no
// other implementation was copied.
//
// parse(line) returns null for anything that is not a usable packet: server
// comments ('#'), blank or garbage lines, a bad header, a position that does
// not decode. It never throws. A packet of a type the window does not draw
// (telemetry, capabilities, ...) comes back as type 'other' with no position.
//
// Result:
//   from, to, path[], igate (the station after the q construct), raw,
//   type: 'position' | 'object' | 'item' | 'status' | 'message' | 'weather' | 'other'
//   format: 'uncompressed' | 'compressed' | 'mic-e' (positions only)
//   lat, lon (decimal degrees, null when none), symbolTable, symbol,
//   comment, course (degrees), speed (knots), altitude (feet),
//   timestamp { raw, day, hour, minute, second, zulu } or null,
//   messaging (the station can take messages), ambiguity (0-4),
//   weather { windDir, windSpeed (mph), windGust (mph), tempF, rain1h,
//             rain24h, rainMidnight (hundredths of an inch), humidity (%),
//             pressure (mbar) } when present,
//   name + live (objects and items), status (status), message
//   { addressee, text, id, ack, rej } (messages, parsed only),
//   micEMessage (Mic-E), thirdParty { from, to, path } (unwrapped '}').
//
// Dual-mode: require() in main, window.AprsParser in the APRS window.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AprsParser = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CALL_RE = /^[A-Za-z0-9-]{1,12}$/;
  const MAX_THIRD_PARTY_DEPTH = 2;

  function blank(header) {
    return {
      from: header.from, to: header.to, path: header.path, igate: header.igate, raw: header.raw,
      type: 'other', format: null,
      lat: null, lon: null, symbolTable: null, symbol: null,
      comment: '', course: null, speed: null, altitude: null,
      timestamp: null, messaging: false, ambiguity: 0,
    };
  }

  function parseHeader(line) {
    const colon = line.indexOf(':');
    if (colon < 3) return null;
    const head = line.slice(0, colon);
    const info = line.slice(colon + 1);
    const gt = head.indexOf('>');
    if (gt < 1) return null;
    const from = head.slice(0, gt);
    const parts = head.slice(gt + 1).split(',');
    const to = parts.shift();
    if (!CALL_RE.test(from) || !to || !CALL_RE.test(to.replace(/\*$/, ''))) return null;
    for (const p of parts) if (!/^[A-Za-z0-9*-]{1,12}$/.test(p)) return null;
    let igate = null;
    const q = parts.findIndex((p) => /^qA[A-Za-z]$/.test(p));
    if (q >= 0 && parts[q + 1]) igate = parts[q + 1].replace(/\*$/, '');
    return { from: from.toUpperCase(), to: to.toUpperCase(), path: parts, igate, raw: line, info };
  }

  // ── timestamps ────────────────────────────────────────────────────────────
  function parseTimestamp(s) {
    if (!/^\d{6}[zh/]$/.test(s)) return null;
    const a = +s.slice(0, 2), b = +s.slice(2, 4), c = +s.slice(4, 6);
    if (s[6] === 'h') {
      if (a > 23 || b > 59 || c > 59) return null;
      return { raw: s, day: null, hour: a, minute: b, second: c, zulu: true };
    }
    if (a < 1 || a > 31 || b > 23 || c > 59) return null;
    return { raw: s, day: a, hour: b, minute: c, second: null, zulu: s[6] === 'z' };
  }

  // ── positions ─────────────────────────────────────────────────────────────
  const isTable = (c) => /^[/\\0-9A-Z]$/.test(c);
  const AMBIG_MINUTES = [0, 0.1, 1, 10, 60];

  /** "4903.50N/07201.75W-" (19 chars). Returns null when it does not decode. */
  function parseUncompressed(s) {
    if (s.length < 19) return null;
    const latS = s.slice(0, 8), table = s[8], lonS = s.slice(9, 18), sym = s[18];
    if (!/^[0-9 ]{4}\.[0-9 ]{2}[NSns]$/.test(latS)) return null;
    if (!/^[0-9 ]{5}\.[0-9 ]{2}[EWew]$/.test(lonS)) return null;
    if (!isTable(table) || sym < '!' || sym > '~') return null;
    const ambiguity = (latS.slice(0, 7).match(/ /g) || []).length;
    // Spaces may only replace digits from the right: "4903.5 ", "4903.  ", "490 .  ", "49  .  ".
    if (ambiguity > 4 || / \d/.test(latS.slice(0, 7).replace('.', ''))) return null;
    const half = AMBIG_MINUTES[Math.min(ambiguity, 4)] / 2;
    const latDeg = +latS.slice(0, 2).replace(/ /g, '0');
    const latMin = +latS.slice(2, 7).replace(/ /g, '0');
    // The longitude carries the latitude's ambiguity (spec ch. 6).
    let lonMinS = lonS.slice(3, 8);
    if (ambiguity) {
      const digits = lonMinS.replace('.', '').split('');
      for (let i = 0; i < Math.min(ambiguity, 4); i++) digits[3 - i] = '0';
      lonMinS = digits.slice(0, 2).join('') + '.' + digits.slice(2).join('');
    }
    const lonDeg = +lonS.slice(0, 3).replace(/ /g, '0');
    const lonMin = +lonMinS.replace(/ /g, '0');
    if (latMin >= 60 || lonMin >= 60) return null;
    let lat = latDeg + (latMin + half) / 60;
    let lon = lonDeg + (lonMin + half) / 60;
    if (/[Ss]/.test(latS[7])) lat = -lat;
    if (/[Ww]/.test(lonS[8])) lon = -lon;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon, symbolTable: table, symbol: sym, ambiguity, rest: s.slice(19), format: 'uncompressed' };
  }

  function b91(s) {
    let v = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i) - 33;
      if (c < 0 || c > 90) return NaN;
      v = v * 91 + c;
    }
    return v;
  }

  /** "/5L!!<*e7>7P[" (13 chars). */
  function parseCompressed(s) {
    if (s.length < 13) return null;
    const table = s[0];
    if (!/^[/\\A-Za-j]$/.test(table)) return null;
    const y = b91(s.slice(1, 5)), x = b91(s.slice(5, 9));
    if (!isFinite(y) || !isFinite(x)) return null;
    const lat = 90 - y / 380926;
    const lon = -180 + x / 190463;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const sym = s[9];
    if (sym < '!' || sym > '~') return null;
    // An overlay a-j stands for 0-9 (spec ch. 9).
    const symbolTable = /[a-j]/.test(table) ? String.fromCharCode(table.charCodeAt(0) - 49) : table;
    const out = { lat, lon, symbolTable, symbol: sym, ambiguity: 0, rest: s.slice(13), format: 'compressed',
      course: null, speed: null, altitude: null };
    const c = s.charCodeAt(10) - 33, sp = s.charCodeAt(11) - 33, t = s.charCodeAt(12) - 33;
    if (s[10] !== ' ' && c >= 0 && sp >= 0 && t >= 0) {
      if (((t >> 3) & 3) === 2) {
        out.altitude = Math.round(Math.pow(1.002, c * 91 + sp));
      } else if (c <= 89) {
        out.course = c * 4;
        out.speed = Math.round((Math.pow(1.08, sp) - 1) * 10) / 10;
      }
      // c == 90 ('{') is a radio range, not drawn.
    }
    return out;
  }

  function parsePosition(s) {
    if (!s) return null;
    return /^[0-9 ]/.test(s) ? parseUncompressed(s) : parseCompressed(s);
  }

  // ── weather ───────────────────────────────────────────────────────────────
  const WX_FIELDS = {
    c: ['windDir', 3], s: ['windSpeed', 3], g: ['windGust', 3], t: ['tempF', 3],
    r: ['rain1h', 3], p: ['rain24h', 3], P: ['rainMidnight', 3], h: ['humidity', 2], b: ['pressure', 5],
  };
  function emptyWeather() {
    return { windDir: null, windSpeed: null, windGust: null, tempF: null,
      rain1h: null, rain24h: null, rainMidnight: null, humidity: null, pressure: null };
  }
  /** Read weather fields from the front of s; returns { weather, rest, count }. */
  function readWeatherFields(s, wx) {
    let i = 0, count = 0;
    while (i < s.length) {
      const f = WX_FIELDS[s[i]];
      if (!f) break;
      const n = f[1];
      // Temperature may be negative: t-05.
      const body = s.slice(i + 1, i + 1 + n);
      if (body.length < n) break;
      if (/^[ .]+$/.test(body)) { wx[f[0]] = null; i += 1 + n; count++; continue; }
      if (!/^-?\d+$/.test(body)) break;
      let v = parseInt(body, 10);
      if (f[0] === 'humidity' && v === 0) v = 100;
      if (f[0] === 'pressure') v = v / 10;
      wx[f[0]] = v;
      i += 1 + n; count++;
    }
    return { rest: s.slice(i), count };
  }

  // ── comment extensions ────────────────────────────────────────────────────
  function applyComment(out, rest, isWeatherSymbol) {
    let s = rest || '';
    const ext = s.match(/^(\d{3}|\.{3}| {3})\/(\d{3}|\.{3}| {3})/);
    if (isWeatherSymbol) {
      const wx = emptyWeather();
      let any = false;
      if (ext) {
        wx.windDir = /^\d+$/.test(ext[1]) ? +ext[1] : null;
        wx.windSpeed = /^\d+$/.test(ext[2]) ? +ext[2] : null;
        s = s.slice(7); any = true;
      }
      const r = readWeatherFields(s, wx);
      if (r.count) { s = r.rest; any = true; }
      if (any) out.weather = wx;
    } else if (ext && out.course === null) {
      const crs = /^\d+$/.test(ext[1]) ? +ext[1] : null;
      const spd = /^\d+$/.test(ext[2]) ? +ext[2] : null;
      out.course = crs === 0 ? null : (crs === 360 ? 0 : crs);
      out.speed = spd;
      s = s.slice(7);
    }
    const alt = s.match(/\/A=(-\d{5}|\d{6})/);
    if (alt) {
      out.altitude = parseInt(alt[1], 10);
      s = s.slice(0, alt.index) + s.slice(alt.index + alt[0].length);
    }
    out.comment = s.replace(/\s+/g, ' ').trim();
  }

  function fillPosition(out, pos) {
    out.lat = pos.lat; out.lon = pos.lon;
    out.symbolTable = pos.symbolTable; out.symbol = pos.symbol;
    out.ambiguity = pos.ambiguity; out.format = pos.format;
    if (pos.course != null) out.course = pos.course;
    if (pos.speed != null) out.speed = pos.speed;
    if (pos.altitude != null) out.altitude = pos.altitude;
    applyComment(out, pos.rest, pos.symbol === '_');
  }

  // ── Mic-E ─────────────────────────────────────────────────────────────────
  const MICE_STD = ['Emergency', 'Priority', 'Special', 'Committed', 'Returning', 'In Service', 'En Route', 'Off Duty'];
  const MICE_CUSTOM = ['Emergency', 'Custom 6', 'Custom 5', 'Custom 4', 'Custom 3', 'Custom 2', 'Custom 1', 'Custom 0'];

  function miceDigit(c) {
    if (c >= '0' && c <= '9') return { d: c, bit: 0 };
    if (c >= 'A' && c <= 'J') return { d: String(c.charCodeAt(0) - 65), bit: 2 };
    if (c === 'K') return { d: ' ', bit: 2 };
    if (c === 'L') return { d: ' ', bit: 0 };
    if (c >= 'P' && c <= 'Y') return { d: String(c.charCodeAt(0) - 80), bit: 1 };
    if (c === 'Z') return { d: ' ', bit: 1 };
    return null;
  }

  function parseMicE(out, info) {
    const dest = out.to.split('-')[0];
    if (dest.length !== 6 || info.length < 9) return null;
    const ds = [];
    for (const ch of dest) { const m = miceDigit(ch); if (!m) return null; ds.push(m); }
    // Characters 4-6 only use 0-9, L and P-Z.
    for (let i = 3; i < 6; i++) if (/[A-K]/.test(dest[i])) return null;
    const latDigits = ds.map((x) => x.d).join('');
    const ambiguity = (latDigits.match(/ /g) || []).length;
    const latDeg = +latDigits.slice(0, 2).replace(/ /g, '0');
    const latMin = +(latDigits.slice(2, 4) + '.' + latDigits.slice(4, 6)).replace(/ /g, '0');
    if (!isFinite(latDeg) || !isFinite(latMin) || latMin >= 60) return null;
    let lat = latDeg + (latMin + AMBIG_MINUTES[Math.min(ambiguity, 4)] / 2) / 60;
    const north = ds[3].bit === 1;
    const lonOffset = ds[4].bit === 1 ? 100 : 0;
    const west = ds[5].bit === 1;
    if (!north) lat = -lat;

    const b = (i) => info.charCodeAt(i) - 28;
    let lonDeg = b(1) + lonOffset;
    if (lonDeg >= 180 && lonDeg <= 189) lonDeg -= 80;
    else if (lonDeg >= 190 && lonDeg <= 199) lonDeg -= 190;
    let lonMin = b(2);
    if (lonMin >= 60) lonMin -= 60;
    const lonHun = b(3);
    if (lonDeg < 0 || lonDeg > 179 || lonMin < 0 || lonHun < 0 || lonHun > 99) return null;
    let lon = lonDeg + (lonMin + lonHun / 100) / 60;
    if (west) lon = -lon;
    if (Math.abs(lat) > 90) return null;

    const sp = b(4), dc = b(5), se = b(6);
    if (sp < 0 || dc < 0 || se < 0) return null;
    const speed = (sp * 10 + Math.floor(dc / 10)) % 800;
    const course = ((dc % 10) * 100 + se) % 400;
    const sym = info[7], table = info[8];
    if (!isTable(table) || sym < '!' || sym > '~') return null;

    out.type = 'position';
    out.format = 'mic-e';
    out.lat = lat; out.lon = lon; out.ambiguity = ambiguity;
    out.symbolTable = table; out.symbol = sym;
    out.speed = speed; out.course = course === 0 ? null : course;
    out.messaging = true;
    const bits = ds.slice(0, 3);
    const custom = bits.some((x) => x.bit === 2);
    const n = bits.reduce((acc, x) => acc * 2 + (x.bit ? 1 : 0), 0);
    out.micEMessage = custom ? MICE_CUSTOM[n] : MICE_STD[n];

    let rest = info.slice(9);
    // A radio-type byte may lead the status text.
    if (/^[>\]`' ]/.test(rest)) rest = rest.slice(1);
    const alt = rest.match(/^(.{3})\}/);
    if (alt) {
      const m = b91(alt[1]);
      if (isFinite(m)) { out.altitude = Math.round((m - 10000) * 3.28084); rest = rest.slice(4); }
    }
    // Trailing radio model codes: "=" after "]" (TM-D700) or "^" after "]" etc.
    rest = rest.replace(/^\]/, '').replace(/[\]`][=^ ]?$/, '');
    out.comment = rest.replace(/\s+/g, ' ').trim();
    return out;
  }

  // ── the dispatcher ────────────────────────────────────────────────────────
  function parse(line, depth) {
    try {
      if (typeof line !== 'string') return null;
      const text = line.replace(/[\r\n]+$/, '');
      if (!text.trim() || text[0] === '#') return null;
      const h = parseHeader(text);
      if (!h || !h.info) return null;
      return parseInfo(h, depth || 0);
    } catch (e) {
      return null;
    }
  }

  function parseInfo(h, depth) {
    const info = h.info;
    const out = blank(h);
    const dti = info[0];

    if (dti === '}') {
      if (depth >= MAX_THIRD_PARTY_DEPTH) return null;
      const inner = parse(info.slice(1), depth + 1);
      if (!inner) return null;
      inner.thirdParty = inner.thirdParty || { from: h.from, to: h.to, path: h.path };
      inner.raw = h.raw;
      if (!inner.igate) inner.igate = h.igate;
      return inner;
    }

    if (dti === '!' || dti === '=') {
      const pos = parsePosition(info.slice(1));
      if (!pos) return null;
      out.type = 'position';
      out.messaging = dti === '=';
      fillPosition(out, pos);
      return out;
    }

    if (dti === '/' || dti === '@') {
      const ts = parseTimestamp(info.slice(1, 8));
      if (!ts) return null;
      const pos = parsePosition(info.slice(8));
      if (!pos) return null;
      out.type = 'position';
      out.messaging = dti === '@';
      out.timestamp = ts;
      fillPosition(out, pos);
      return out;
    }

    if (dti === ';') {
      if (info.length < 18) return null;
      const name = info.slice(1, 10);
      const flag = info[10];
      if (flag !== '*' && flag !== '_') return null;
      const ts = parseTimestamp(info.slice(11, 18));
      if (!ts) return null;
      const pos = parsePosition(info.slice(18));
      if (!pos) return null;
      out.type = 'object';
      out.name = name.trim();
      if (!out.name) return null;
      out.live = flag === '*';
      out.timestamp = ts;
      fillPosition(out, pos);
      return out;
    }

    if (dti === ')') {
      const m = info.slice(1).match(/^([\x20-\x7e]{3,9}?)([!_])/);
      if (!m || /[!_]/.test(m[1])) return null;
      const pos = parsePosition(info.slice(1 + m[0].length));
      if (!pos) return null;
      out.type = 'item';
      out.name = m[1].trim();
      out.live = m[2] === '!';
      fillPosition(out, pos);
      return out;
    }

    if (dti === '>') {
      let s = info.slice(1);
      const ts = /^\d{6}z/.test(s) ? parseTimestamp(s.slice(0, 7)) : null;
      if (ts) { out.timestamp = ts; s = s.slice(7); }
      out.type = 'status';
      out.status = s.trim();
      return out;
    }

    if (dti === ':') {
      if (info.length < 11 || info[10] !== ':') return null;
      const addressee = info.slice(1, 10).trim();
      if (!addressee) return null;
      let text = info.slice(11);
      const msg = { addressee, text: '', id: null, ack: null, rej: null };
      const ar = text.match(/^(ack|rej)([A-Za-z0-9]{1,5})\s*$/);
      if (ar) {
        msg[ar[1]] = ar[2];
      } else {
        const idm = text.match(/\{([A-Za-z0-9]{1,5})(\}[A-Za-z0-9]{0,5})?\s*$/);
        if (idm) { msg.id = idm[1]; text = text.slice(0, idm.index); }
        msg.text = text.trim();
      }
      out.type = 'message';
      out.message = msg;
      return out;
    }

    if (dti === '`' || dti === "'" || dti === '\x1c' || dti === '\x1d') {
      return parseMicE(out, info);
    }

    if (dti === '_') {
      // Positionless weather: _MMDDHHMM then fields.
      if (!/^\d{8}/.test(info.slice(1))) return null;
      const wx = emptyWeather();
      const r = readWeatherFields(info.slice(9), wx);
      if (!r.count) return null;
      out.type = 'weather';
      out.weather = wx;
      out.comment = r.rest.trim();
      return out;
    }

    return out; // 'other': kept, never drawn
  }

  return { parse, parseTimestamp };
});
