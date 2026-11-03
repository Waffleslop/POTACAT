'use strict';
/**
 * XML-RPC encode/decode — the wire flrig speaks (lib/flrig-transport.js
 * carries it over HTTP, lib/codecs/flrig-codec.js decides what to say).
 *
 * Pure: strings in, strings/values out, no I/O. Shaped to what flrig's
 * xmlrpcpp actually sends (read from flrig 2.0.12 src/xmlrpcpp, 2026-10-25):
 *   - a string result is `<value>text</value>` with NO <string> tag;
 *   - an int is `<value><i4>n</i4></value>`, a double `<double>`;
 *   - an array is `<value><array><data><value>…</value>…</data></array></value>`;
 *   - a method that sets no result answers an EMPTY <param> (null here);
 *   - an unknown method is a <fault> whose struct carries faultCode/faultString.
 * Parameter types are strict on flrig's side (xmlrpcpp throws "type error"
 * when `int(params[0])` meets a <double>), so callers type every parameter
 * with i4()/dbl()/str() instead of trusting JavaScript's single number type.
 */

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function xmlUnescape(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Typed parameter wrappers. */
function i4(n) { return { i4: Math.trunc(Number(n) || 0) }; }
function dbl(n) { return { double: Number(n) || 0 }; }
function str(s) { return { string: String(s == null ? '' : s) }; }

function encodeValue(p) {
  if (p && typeof p === 'object') {
    if ('i4' in p) return `<value><i4>${p.i4}</i4></value>`;
    if ('double' in p) return `<value><double>${p.double}</double></value>`;
    if ('string' in p) return `<value><string>${xmlEscape(p.string)}</string></value>`;
    if ('boolean' in p) return `<value><boolean>${p.boolean ? 1 : 0}</boolean></value>`;
    if (Array.isArray(p)) return `<value><array><data>${p.map(encodeValue).join('')}</data></array></value>`;
  }
  if (typeof p === 'boolean') return `<value><boolean>${p ? 1 : 0}</boolean></value>`;
  if (typeof p === 'number') return Number.isInteger(p) ? `<value><i4>${p}</i4></value>` : `<value><double>${p}</double></value>`;
  return `<value><string>${xmlEscape(p == null ? '' : p)}</string></value>`;
}

/**
 * One <methodCall>.
 * @param {string} method  e.g. 'rig.get_vfo'
 * @param {Array} [params] typed with i4()/dbl()/str(), or plain JS values
 */
function encodeCall(method, params = []) {
  const m = String(method || '').trim();
  if (!/^[A-Za-z_][\w.]*$/.test(m)) throw new Error(`xmlrpc: bad method name ${JSON.stringify(method)}`);
  const ps = params.length ? `<params>${params.map((p) => `<param>${encodeValue(p)}</param>`).join('')}</params>` : '<params></params>';
  return `<?xml version="1.0"?>\r\n<methodCall><methodName>${m}</methodName>${ps}</methodCall>\r\n`;
}

// --- decoding ---

// Deepest array/struct nesting we follow. flrig never nests; the cap is what
// keeps a malformed reply from recursing until the stack runs out.
const MAX_DEPTH = 16;

// Parse one <value>…</value> starting at `pos` (which points AT "<value>").
// Returns { value, end } or null. `end` is always past `pos`, so every loop
// over values moves forward. Anything malformed is dropped, never chased
// (WG9I 2026-10-26: a homebrew flrig bridge's reply made the struct branch
// search for <name> from -1, re-enter the same struct and recurse until
// "Maximum call stack size exceeded" took the app down).
function parseValue(xml, pos, depth = 0) {
  if (!(pos >= 0) || depth > MAX_DEPTH) return null;
  const open = xml.indexOf('<value>', pos);
  if (open === -1) {
    const selfClosing = xml.indexOf('<value/>', pos);
    if (selfClosing !== -1) return { value: '', end: selfClosing + 8 };
    return null;
  }
  let i = open + 7;
  // Skip whitespace between <value> and its child.
  while (i < xml.length && /\s/.test(xml[i])) i++;
  if (xml.startsWith('<array>', i)) {
    const data = xml.indexOf('<data>', i);
    if (data === -1) return null;
    const dataEnd = findClose(xml, '<data>', '</data>', data);
    const items = [];
    let p = data + 6;
    while (true) {
      const next = xml.indexOf('<value>', p);
      if (next === -1 || next >= dataEnd) break;
      const r = parseValue(xml, next, depth + 1);
      if (!r || r.end <= p) break;
      items.push(r.value);
      p = r.end;
    }
    const close = xml.indexOf('</value>', dataEnd);
    return { value: items, end: close === -1 ? xml.length : close + 8 };
  }
  if (xml.startsWith('<struct>', i)) {
    const structEnd = findClose(xml, '<struct>', '</struct>', i);
    const obj = {};
    let p = i + 8;
    while (true) {
      const m = xml.indexOf('<member>', p);
      if (m === -1 || m >= structEnd) break;
      const memberEnd = xml.indexOf('</member>', m);
      const nameAt = xml.indexOf('<name>', m);
      const n1 = nameAt === -1 ? -1 : xml.indexOf('</name>', nameAt + 6);
      // A member with no name (or one that runs past its struct) is skipped.
      if (nameAt === -1 || n1 === -1 || n1 >= structEnd || (memberEnd !== -1 && nameAt > memberEnd)) {
        if (memberEnd === -1 || memberEnd >= structEnd) break;
        p = memberEnd + 9;
        continue;
      }
      const name = xmlUnescape(xml.slice(nameAt + 6, n1).trim());
      const r = parseValue(xml, n1, depth + 1);
      if (!r || r.end <= n1) break;
      obj[name] = r.value;
      p = r.end;
    }
    const close = xml.indexOf('</value>', structEnd);
    return { value: obj, end: close === -1 ? xml.length : close + 8 };
  }
  const typed = /^<(i4|int|double|boolean|string|dateTime\.iso8601|base64)>/.exec(xml.slice(i, i + 24));
  if (typed) {
    const tag = typed[1];
    const start = i + tag.length + 2;
    const stop = xml.indexOf(`</${tag}>`, start);
    const raw = stop === -1 ? '' : xml.slice(start, stop);
    let value;
    if (tag === 'i4' || tag === 'int') value = parseInt(raw.trim(), 10);
    else if (tag === 'double') value = parseFloat(raw.trim());
    else if (tag === 'boolean') value = raw.trim() === '1' || raw.trim().toLowerCase() === 'true';
    else value = xmlUnescape(raw);
    const close = xml.indexOf('</value>', stop === -1 ? start : stop);
    return { value, end: close === -1 ? xml.length : close + 8 };
  }
  // Untyped = string (how xmlrpcpp writes every string).
  const close = xml.indexOf('</value>', open);
  if (close === -1) return null;
  return { value: xmlUnescape(xml.slice(open + 7, close)), end: close + 8 };
}

function findClose(xml, openTag, closeTag, from) {
  let depth = 0;
  let i = from;
  while (i < xml.length) {
    const o = xml.indexOf(openTag, i);
    const c = xml.indexOf(closeTag, i);
    if (c === -1) return xml.length;
    if (o !== -1 && o < c) { depth++; i = o + openTag.length; continue; }
    depth--;
    if (depth <= 0) return c;
    i = c + closeTag.length;
  }
  return xml.length;
}

/**
 * Decode a <methodResponse>.
 * @returns {{ok:true, value:any}|{ok:false, fault:{code:number,string:string}}}
 *   value is null for an empty <param> (a setter that set no result).
 */
function decodeResponse(xml) {
  try { return decodeResponseUnsafe(xml); } catch (e) {
    // Nothing a server sends may throw out of a socket handler.
    return { ok: false, fault: { code: -32700, string: `unreadable reply (${e && e.message ? e.message : e})` } };
  }
}

function decodeResponseUnsafe(xml) {
  const s = String(xml || '');
  const faultAt = s.indexOf('<fault>');
  if (faultAt !== -1) {
    const r = parseValue(s, faultAt);
    const st = (r && r.value && typeof r.value === 'object') ? r.value : {};
    return { ok: false, fault: { code: Number(st.faultCode) || 0, string: String(st.faultString || 'fault') } };
  }
  const paramAt = s.indexOf('<param>');
  if (paramAt === -1) {
    if (s.indexOf('<methodResponse') === -1) return { ok: false, fault: { code: -32700, string: 'not an XML-RPC response' } };
    return { ok: true, value: null };
  }
  const paramEnd = s.indexOf('</param>', paramAt);
  const valueAt = s.indexOf('<value', paramAt);
  if (valueAt === -1 || (paramEnd !== -1 && valueAt > paramEnd)) return { ok: true, value: null };
  const r = parseValue(s, paramAt);
  return { ok: true, value: r ? r.value : null };
}

module.exports = { encodeCall, decodeResponse, i4, dbl, str, xmlEscape };
