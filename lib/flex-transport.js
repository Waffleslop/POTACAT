// SPDX-License-Identifier: Apache-2.0
/**
 * How POTACAT reaches a Flex's API, and how it tells the radio where to send UDP.
 *
 * A transport opens the radio's line-based command channel. Two kinds:
 *   - LAN: plain TCP to the radio's API port 4992. These are exactly the bytes
 *     POTACAT has always sent; nothing about the LAN path changes.
 *   - injected: the caller supplies `open()`. FlexRadio SmartLink uses this for a
 *     TLS socket that has already sent `wan validate` (lib/smartlink-session.js).
 *
 * open(host, attach) creates the socket, calls attach(sock) SYNCHRONOUSLY so the
 * caller's line parser is in place, and only then starts any I/O. Over TLS the
 * radio speaks first (V and H lines), and a parser attached late drops them
 * (FlexRadio SmartLink API reference, Part 3). The socket is any EventEmitter with
 * write(), end() and destroy() that emits 'connect' once commands may be sent,
 * 'data', 'error' and 'close'.
 *
 * UDP registration is a strategy too:
 *   - LAN: `client udpport <port>` on the command channel (unchanged).
 *   - WAN: `client udp_register handle=0x<H>` sent OVER UDP to the radio's public
 *     UDP port every 50 ms until the first VITA-49 packet with FlexRadio's OUI
 *     arrives, giving up at 30 s; then `client ping handle=0x<H>` every 5 s to hold
 *     the NAT mapping. It never starts with an unknown handle (the radio ignores
 *     handle=0x0) and waits at most 10 s for one. The socket stays unconnected,
 *     because NAT may change the radio's source port. A socket 'error' (Windows
 *     reports the ICMP port-unreachable of the first register as one) is logged
 *     and the loop goes on. (FlexRadio SmartLink API reference, Part 4 and
 *     "Timeouts and Constants".)
 */
'use strict';

const net = require('net');

const FLEX_API_PORT = 4992;
const FLEX_OUI = 0x001C2D;

const WAN_UDP_DEFAULTS = {
  registerEveryMs: 50,
  giveUpMs: 30000,
  pingEveryMs: 5000,
  handleWaitMs: 10000,
};

/** True when a datagram is a VITA-49 packet carrying FlexRadio's OUI. */
function isFlexVita(buf) {
  if (!buf || buf.length < 12) return false;
  return (buf.readUInt32BE(8) & 0xFFFFFF) === FLEX_OUI;
}

/** `client udpport <port>` on the command channel: the LAN registration. */
function lanUdpRegistration() {
  return {
    kind: 'lan',
    /**
     * @param {object} o
     * @param {number} o.port       local UDP port we listen on
     * @param {function} o.sendCmd  sends one API command, returns its sequence number
     * @returns {{seq:number|null, onPacket:function, stop:function}}
     */
    start(o) {
      const seq = o.sendCmd(`client udpport ${o.port}`);
      return { seq, onPacket() {}, stop() {} };
    },
  };
}

/**
 * The WAN registration (see the header). `host` and `port` are the radio's public
 * address and public UDP port. Timers and clock are injectable for tests.
 */
function wanUdpRegistration(cfg) {
  const c = { ...WAN_UDP_DEFAULTS, ...(cfg || {}) };
  const setT = c.setTimeout || setTimeout;
  const clearT = c.clearTimeout || clearTimeout;
  const setI = c.setInterval || setInterval;
  const clearI = c.clearInterval || clearInterval;
  const now = c.now || Date.now;
  return {
    kind: 'wan',
    /**
     * @param {object} o
     * @param {object} o.udpSock      a bound dgram socket (never connect()ed)
     * @param {function} o.getHandle  () => our client handle hex ('4A30F977') or null
     * @param {function} [o.onConfirmed] (ms) first Flex VITA packet arrived
     * @param {function} [o.onFailed]    ('no-handle' | 'udp-blocked')
     * @param {function} [o.log]
     */
    start(o) {
      const log = o.log || (() => {});
      let handle = null;
      let regTimer = null;
      let pingTimer = null;
      let waitTimer = null;
      let giveUpTimer = null;
      let startedAt = 0;
      let confirmed = false;
      let stopped = false;
      const send = (text) => {
        if (stopped) return;
        try {
          o.udpSock.send(Buffer.from(text), c.port, c.host, (err) => {
            if (err) log(`UDP send error (kept open): ${err.message}`);
          });
        } catch (err) { log(`UDP send error (kept open): ${err.message}`); }
      };
      const fail = (why) => {
        if (stopped) return;
        if (regTimer) { clearI(regTimer); regTimer = null; }
        if (o.onFailed) o.onFailed(why);
      };
      const begin = () => {
        startedAt = now();
        const reg = `client udp_register handle=0x${handle}`;
        send(reg);
        regTimer = setI(() => send(reg), c.registerEveryMs);
        giveUpTimer = setT(() => { giveUpTimer = null; if (!confirmed) fail('udp-blocked'); }, c.giveUpMs);
      };
      const waitHandle = () => {
        const deadline = now() + c.handleWaitMs;
        const poll = () => {
          waitTimer = null;
          if (stopped) return;
          const h = o.getHandle && o.getHandle();
          if (h && !/^0+$/.test(String(h))) { handle = String(h).replace(/^0x/i, '').toUpperCase(); begin(); return; }
          if (now() >= deadline) { fail('no-handle'); return; }
          waitTimer = setT(poll, c.registerEveryMs);
        };
        poll();
      };
      waitHandle();
      return {
        seq: null,
        get confirmed() { return confirmed; },
        onPacket(buf) {
          if (confirmed || stopped || !handle || !isFlexVita(buf)) return;
          confirmed = true;
          if (regTimer) { clearI(regTimer); regTimer = null; }
          if (giveUpTimer) { clearT(giveUpTimer); giveUpTimer = null; }
          const ms = now() - startedAt;
          log(`UDP registered: first FlexRadio packet ${ms} ms after udp_register began`);
          pingTimer = setI(() => send(`client ping handle=0x${handle}`), c.pingEveryMs);
          if (o.onConfirmed) o.onConfirmed(ms);
        },
        stop() {
          stopped = true;
          if (regTimer) { clearI(regTimer); regTimer = null; }
          if (pingTimer) { clearI(pingTimer); pingTimer = null; }
          if (waitTimer) { clearT(waitTimer); waitTimer = null; }
          if (giveUpTimer) { clearT(giveUpTimer); giveUpTimer = null; }
        },
      };
    },
  };
}

/** The LAN transport: TCP to <host>:4992, today's behaviour. */
function lanTransport(opts) {
  const port = (opts && opts.port) || FLEX_API_PORT;
  return {
    kind: 'lan',
    udp: lanUdpRegistration(),
    open(host, attach) {
      const sock = new net.Socket();
      sock.setNoDelay(true);
      attach(sock);
      sock.connect(port, host);
      return sock;
    },
  };
}

/**
 * A transport built from a caller's open(host, attach). `udp` defaults to the LAN
 * registration; SmartLink passes a wanUdpRegistration. `firstSeq` lets a caller
 * that already used sequence numbers on the socket (SmartLink's `C1|wan validate`)
 * keep the client's commands from reusing them.
 */
function injectedTransport(t) {
  if (!t || typeof t.open !== 'function') throw new Error('injectedTransport needs open(host, attach)');
  return {
    kind: t.kind || 'injected',
    udp: t.udp || lanUdpRegistration(),
    firstSeq: t.firstSeq || 1,
    open: t.open,
    describe: t.describe,
  };
}

module.exports = {
  FLEX_API_PORT, FLEX_OUI, WAN_UDP_DEFAULTS,
  isFlexVita, lanTransport, injectedTransport, lanUdpRegistration, wanUdpRegistration,
};
