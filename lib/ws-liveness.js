/**
 * Is the shack socket dead, and should the page reconnect? (ECHOCAT Web)
 *
 * A phone that sleeps can come back with a WebSocket that still reads OPEN
 * although the shack dropped it long ago; anything sent on it is lost. Two
 * checks catch that:
 *
 *  - isDead: a ping went out and nothing at all (a pong or any other message)
 *    came back within PONG_TIMEOUT_MS of the FIRST unanswered ping.
 *  - reconnectOnWake: the page became visible again and the socket is closed,
 *    or is open but has heard nothing for longer than one ping interval.
 *
 * The page calls reset() when a session starts, pingSent() for each ping,
 * messageReceived() for every inbound message, and runs its own reconnect
 * path when either check says so. No timers here; the caller passes `now`.
 *
 * Dual-mode: Node require() gets module.exports, ECHOCAT Web gets
 * window.WsLiveness (inlined by lib/remote-server.js). Pure.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WsLiveness = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const PING_INTERVAL_MS = 3000;
  const PONG_TIMEOUT_MS = 10000;

  function create(opts) {
    const o = opts || {};
    const pongTimeoutMs = o.pongTimeoutMs > 0 ? o.pongTimeoutMs : PONG_TIMEOUT_MS;
    const pingIntervalMs = o.pingIntervalMs > 0 ? o.pingIntervalMs : PING_INTERVAL_MS;
    let lastMessageAt = 0;
    let unansweredSince = 0; // time of the first ping sent since the last message; 0 = none

    return {
      /** A new session: the socket has just opened or authenticated. */
      reset(now) { lastMessageAt = now; unansweredSince = 0; },
      pingSent(now) { if (!unansweredSince) unansweredSince = now; },
      messageReceived(now) { lastMessageAt = now; unansweredSince = 0; },
      isDead(now) { return unansweredSince > 0 && now - unansweredSince >= pongTimeoutMs; },
      /**
       * @param {number} now
       * @param {'open'|'connecting'|'closed'} socketState
       */
      reconnectOnWake(now, socketState) {
        if (socketState === 'connecting') return false;
        if (socketState !== 'open') return true;
        return now - lastMessageAt > pingIntervalMs;
      },
    };
  }

  return { PING_INTERVAL_MS, PONG_TIMEOUT_MS, create };
});
