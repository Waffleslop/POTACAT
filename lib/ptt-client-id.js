/**
 * Who is reconnecting: lets the shack release PTT held by a client's own dead
 * connection the moment that client comes back (#941).
 *
 * With "more than one device" on, an unpaired browser that reconnects leaves
 * its old socket behind. Until the heartbeat drops it (about 45 s) that dead
 * socket still owns PTT, and the shack ignores the PTT off from the new
 * socket because PTT belongs to "another device". Paired devices and
 * single-device mode already replace the old socket on reconnect.
 *
 * The client makes a random id once per page (32 hex characters from
 * crypto.getRandomValues, kept in sessionStorage so a reload keeps it) and
 * sends it as the optional `pttClientId` in its hello. It is a secret: it
 * goes only to the shack over the client's own socket, and the shack never
 * sends it to anyone or writes it to a log. Another device cannot guess it.
 *
 * The shack treats two connections as the same client only when the ids are
 * equal AND they authenticated the same way (both the owner, or both the same
 * Guest Pass) AND, when both are paired, the same paired device. Then, and
 * only while the old socket holds PTT, it unkeys and closes the old socket.
 * A different id, or no id (an older client), changes nothing.
 *
 * Nothing here ever keys: it only says when a release is due.
 *
 * Dual-mode: Node require() gets module.exports, ECHOCAT Web gets
 * window.PttClientId (inlined by lib/remote-server.js).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PttClientId = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const STORAGE_KEY = 'echocat-ptt-client-id';
  const ID_RE = /^[A-Za-z0-9_-]{22,64}$/;

  /** A well-formed id (22 to 64 URL-safe characters)? */
  function valid(id) {
    return typeof id === 'string' && ID_RE.test(id);
  }

  /** A new id: 16 random bytes as 32 hex characters. getRandomValues is crypto's. */
  function make(getRandomValues) {
    const bytes = new Uint8Array(16);
    getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return out;
  }

  /** This page's id: the stored one, else a new one (stored when storage works). */
  function load(storage, getRandomValues) {
    let id = null;
    try { id = storage ? storage.getItem(STORAGE_KEY) : null; } catch (e) { id = null; }
    if (valid(id)) return id;
    return renew(storage, getRandomValues);
  }

  /** Replace the id (a duplicated tab found another page using it). */
  function renew(storage, getRandomValues) {
    const id = make(getRandomValues);
    try { if (storage) storage.setItem(STORAGE_KEY, id); } catch (e) {}
    return id;
  }

  /** Equal strings, compared without stopping at the first difference. */
  function sameString(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  /**
   * Are two connections the same client? Each side is
   * { id, scope, deviceId }: id from its hello, scope how it authenticated
   * ('owner' or 'pass:<code>'), deviceId its paired device or ''.
   */
  function sameClient(a, b) {
    if (!a || !b || !valid(a.id) || !valid(b.id)) return false;
    if (!a.scope || a.scope !== b.scope) return false;
    if (a.deviceId && b.deviceId && a.deviceId !== b.deviceId) return false;
    return sameString(a.id, b.id);
  }

  /**
   * Does a newly admitted connection release PTT now? True only when PTT is
   * on, held by another connection, and that connection is the same client.
   */
  function releasesStaleHolder({ pttActive, holder, newcomer }) {
    if (!pttActive || !holder || !newcomer || holder === newcomer) return false;
    return sameClient(holder, newcomer);
  }

  return { STORAGE_KEY, valid, make, load, renew, sameClient, releasesStaleHolder };
});
