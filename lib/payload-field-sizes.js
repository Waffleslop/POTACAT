'use strict';
// lib/payload-field-sizes.js — which fields make an ECHOCAT message big (#776).
// Over POTACAT Cloud on a weak uplink the connect sequence is slow; auth-ok
// and the pushes after it (expedition-callsigns, directory, SSTV templates)
// reach 100+ KB. The connect-window push log names each message's largest
// fields so a report shows what to trim. Logging only; Node only.

/** JSON size of one value in bytes (UTF-8); 0 when it cannot be serialised. */
function jsonBytes(v) {
  if (v === undefined) return 0;
  try { return Buffer.byteLength(JSON.stringify(v)); } catch { return 0; }
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The largest fields of a message, largest first. A field that is itself an
 * object (auth-ok's `settings`) is split one level down (`settings.sstvTemplates`),
 * so the line names the real offender, not the wrapper.
 * @returns {Array<{ field: string, bytes: number }>}
 */
function topFieldSizes(msg, n = 5) {
  if (!isPlainObject(msg)) return [];
  const out = [];
  for (const [k, v] of Object.entries(msg)) {
    if (k === 'type') continue;
    if (isPlainObject(v) && Object.keys(v).length) {
      for (const [k2, v2] of Object.entries(v)) out.push({ field: `${k}.${k2}`, bytes: jsonBytes(v2) });
    } else {
      out.push({ field: k, bytes: jsonBytes(v) });
    }
  }
  out.sort((a, b) => b.bytes - a.bytes || (a.field < b.field ? -1 : 1));
  return out.slice(0, Math.max(0, n));
}

function kb(bytes) {
  return (bytes / 1024).toFixed(1) + 'KB';
}

/**
 * One log line: "push msg=auth-ok bytes=32530 (31.8KB) top: settings.sstvTemplates=20.1KB ..."
 * The field list is left off a message under `minBytes` (a ping has nothing to trim).
 */
function formatPushSizeLine(type, bytes, msg, { n = 5, minBytes = 1024 } = {}) {
  let line = `push msg=${type} bytes=${bytes} (${kb(bytes)})`;
  if (bytes >= minBytes) {
    const top = topFieldSizes(msg, n);
    if (top.length) line += ' top: ' + top.map((f) => `${f.field}=${kb(f.bytes)}`).join(' ');
  }
  return line;
}

module.exports = { jsonBytes, topFieldSizes, formatPushSizeLine };
