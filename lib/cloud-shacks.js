// A Cloud address per shack (Casey 2026-11-08: "I want the phone app to be
// able to switch between rigs while a Cloud member").
//
// An account used to have ONE Cloud address, <call>.potacat.com, and one
// shack on it at a time (lib/tunnel-claim.js). The phone already pairs with
// several shacks and switches between them (MY SHACKS, Paired desktops);
// what it could not do was reach the second shack through Cloud. Now each
// shack can have its own address:
//   the first shack keeps <call>.potacat.com (nobody's address changes);
//   another shack gets <call>-<name>.potacat.com, from a name the operator
//   chooses (az, field, home), up to SHACK_LIMIT shacks per membership.
// The server builds every hostname; the desktop only sends the name it was
// given and shows the preview (cloud-tunnel.js guardrail #2).
//
// Server contract (cloudlog, handoff DESKTOP_TO_CLOUD_HANDOFF_2026-11-08_SHACK_ADDRESSES.md):
//   POST /v1/cloud-tunnel/provision { deviceId, name, shackName? }
//     200 { tunnelId, tunnelToken, cloudHost, perShack:true, primary }
//     409 { error:'shack_name_required', prefix, suffix, limit, shacks }
//     409 { error:'shack_name_taken', prefix, suffix, limit, shacks }
//     400 { error:'shack_name_invalid', message }
//     409 { error:'shack_limit', limit, shacks }
//   409 from POST /claim (another shack on THIS address) may carry
//     ownAddress: { available, prefix, suffix, limit, used }
//   GET    /v1/cloud-tunnel/shacks            { limit, shacks }
//   DELETE /v1/cloud-tunnel/shacks/:deviceId  removes that shack's address
// shacks = [{ deviceId, name, cloudHost, primary, online, lastSeen }].
// A server without per-shack addresses ignores the new fields and answers
// as it always did, so every call here degrades to the old behaviour.
// Pure and dual-mode (require + window.CloudShacks): lib/cloud-tunnel.js does
// the requests, main.js and renderer/cloud-ui.js the UI, one set of rules.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CloudShacks = api;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/** The default the server is expected to enforce; the server's own number wins. */
const SHACK_LIMIT = 3;
const NAME_MAX = 20;

/**
 * "AZ Shack", "Field #2" → "az-shack", "field-2": lowercase letters, digits
 * and single hyphens, no hyphen at either end, at most NAME_MAX characters.
 * '' when nothing usable is left.
 */
function sanitizeShackName(text) {
  let s = String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > NAME_MAX) s = s.slice(0, NAME_MAX).replace(/-+$/g, '');
  return s;
}

/** "k3sbp-az.potacat.com" from the server's prefix/suffix, or '' if either part is missing. */
function shackHostPreview(prefix, suffix, name) {
  const n = sanitizeShackName(name);
  if (!n || !prefix || !suffix) return '';
  return String(prefix) + n + String(suffix);
}

function cleanShacks(list) {
  return (Array.isArray(list) ? list : [])
    .filter((s) => s && (s.deviceId || s.device_id))
    .map((s) => ({
      deviceId: String(s.deviceId || s.device_id),
      name: String(s.name || '').trim() || 'Unnamed shack',
      cloudHost: String(s.cloudHost || s.cloud_host || ''),
      primary: s.primary === true,
      online: s.online === true,
      lastSeen: s.lastSeen || s.last_seen_at || null,
    }));
}

function limitOf(body) {
  const n = Number(body && body.limit);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : SHACK_LIMIT;
}

/**
 * The answer to POST /provision.
 * @returns {{state:'ok'|'name-required'|'name-taken'|'name-invalid'|'limit'|'error',
 *   perShack?:boolean, primary?:boolean, prefix?:string, suffix?:string, limit?:number,
 *   shacks?:Array, message?:string}}
 */
function interpretProvision(res, err) {
  if (!err) {
    return { state: 'ok', perShack: !!(res && res.perShack), primary: !(res && res.primary === false) };
  }
  const body = err.body || {};
  const code = err.code || body.error || '';
  const base = { prefix: String(body.prefix || ''), suffix: String(body.suffix || ''), limit: limitOf(body), shacks: cleanShacks(body.shacks) };
  if (code === 'shack_name_required') return { state: 'name-required', ...base };
  if (code === 'shack_name_taken') return { state: 'name-taken', ...base };
  if (code === 'shack_name_invalid') return { state: 'name-invalid', ...base, message: String(body.message || '') };
  if (code === 'shack_limit') return { state: 'limit', ...base };
  return { state: 'error', message: String(err.message || err) };
}

/** The offer a 409 from POST /claim may carry, or null on a server without per-shack addresses. */
function ownAddressOffer(body) {
  const o = body && body.ownAddress;
  if (!o || typeof o !== 'object') return null;
  return {
    available: o.available !== false,
    prefix: String(o.prefix || ''),
    suffix: String(o.suffix || ''),
    limit: limitOf(o),
    used: Number.isFinite(Number(o.used)) ? Math.floor(Number(o.used)) : 0,
  };
}

/** "KQ5O-MAC (kq5o.potacat.com) and DELL (kq5o-field.potacat.com)" */
function describeShacks(shacks) {
  const names = (shacks || []).map((s) => s.cloudHost ? `${s.name} (${s.cloudHost})` : s.name);
  if (!names.length) return 'no shacks';
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

/** What the Cloud card says for each refusal. */
function provisionMessage(p) {
  if (!p) return '';
  const example = shackHostPreview(p.prefix, p.suffix, 'field') || 'yourcall-field.potacat.com';
  if (p.state === 'name-required') {
    return `Another shack already has your main Cloud address. Give this shack a short name and it gets its own address, like ${example}.`;
  }
  if (p.state === 'name-taken') return 'Another of your shacks already uses that name. Choose a different one.';
  if (p.state === 'name-invalid') return p.message || 'Use letters and numbers only, up to 20 characters.';
  if (p.state === 'limit') {
    return `Your POTACAT Cloud membership includes ${p.limit} shack addresses, and all ${p.limit} are in use: ${describeShacks(p.shacks)}. Remove one below to give this shack an address.`;
  }
  return p.message || '';
}

return {
  SHACK_LIMIT, NAME_MAX, sanitizeShackName, shackHostPreview, cleanShacks,
  interpretProvision, ownAddressOffer, describeShacks, provisionMessage,
};
});
