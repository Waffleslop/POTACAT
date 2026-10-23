'use strict';
/**
 * A Kenwood TS-2000 CAT server on TCP, so N1MM+ (Config > Configure Ports:
 * Port "TCP", Radio "TS-2000", 127.0.0.1 and this port) — or any logger that
 * speaks Kenwood CAT over a socket — drives the radio POTACAT drives. On a
 * laptop operating a remote shack (desktop-to-desktop) the frequency, mode,
 * PTT and CW go on to the shack, so N1MM at home controls the station across
 * the internet with no virtual COM drivers (NK8Q, Dayton → Frankenmuth,
 * 2026-10-23).
 *
 * The pure part is handleTs2000Command(cmd, state) → {reply, action}; the
 * replies follow the TS-2000 CAT reference. IF; is the 38-character status
 * line every Kenwood client polls (P8 at index 28 = TX, P9 at 29 = mode).
 * Loopback only by default: CAT has no authentication.
 */
const net = require('net');

const MODE_TO_KENWOOD = {
  LSB: '1', DIGL: '1', PKTLSB: '1',
  USB: '2', DIGU: '2', PKTUSB: '2', FT8: '2', FT4: '2', FT2: '2', JS8: '2', PSK31: '2', JTTY: '2', WSPR: '2', SSTV: '2',
  CW: '3', 'CW-L': '3', FM: '4', AM: '5', RTTY: '6', 'CW-R': '7', CWR: '7', 'RTTY-R': '9',
};
const KENWOOD_TO_MODE = { 1: 'LSB', 2: 'USB', 3: 'CW', 4: 'FM', 5: 'AM', 6: 'RTTY', 7: 'CW', 9: 'RTTY' };

function kenwoodMode(mode, freqHz) {
  const m = String(mode || '').toUpperCase();
  if (m === 'SSB') return freqHz && freqHz < 10e6 ? '1' : '2';
  return MODE_TO_KENWOOD[m] || '2';
}

function pad(n, len) { return String(Math.max(0, Math.round(Number(n) || 0))).padStart(len, '0').slice(-len); }

function ifLine(st) {
  const f = pad(st.freqHz, 11);
  return 'IF' + f + '     ' + '+0000' + '0' + '0' + '0' + '00'
    + (st.ptt ? '1' : '0') + kenwoodMode(st.mode, st.freqHz) + '0' + '0' + '0' + '0' + '00' + '0' + ';';
}

/**
 * One command (without its ';'). state = {freqHz, mode, ptt, smeter (0-255),
 * powerW, wpm}. Returns {reply?: string, action?: {...}}.
 */
function handleTs2000Command(raw, st) {
  const cmd = String(raw || '').replace(/^[\r\n]+/, '');
  if (!cmd) return {};
  const head = cmd.slice(0, 2).toUpperCase();
  const arg = cmd.slice(2);
  switch (head) {
    case 'ID': return { reply: 'ID019;' };
    case 'PS': return arg ? {} : { reply: 'PS1;' };
    case 'AI': return arg ? {} : { reply: 'AI0;' };
    case 'IF': return { reply: ifLine(st) };
    case 'FA':
    case 'FB': {
      if (!arg) return { reply: head + pad(st.freqHz, 11) + ';' };
      const hz = parseInt(arg, 10);
      return hz > 0 ? { action: { setFreqHz: hz } } : {};
    }
    case 'FR':
    case 'FT': return arg ? {} : { reply: head + '0;' };
    case 'MD': {
      if (!arg) return { reply: 'MD' + kenwoodMode(st.mode, st.freqHz) + ';' };
      const m = KENWOOD_TO_MODE[arg.charAt(0)];
      return m ? { action: { setMode: m } } : {};
    }
    case 'TX': return { action: { ptt: true } };
    case 'RX': return { action: { ptt: false } };
    case 'KY': {
      if (!arg || arg === ';') return { reply: 'KY0;' }; // buffer ready
      const text = arg.replace(/^\s/, '').replace(/\s+$/, '');
      return text ? { action: { cw: text } } : {};
    }
    case 'KS': {
      if (!arg) return { reply: 'KS' + pad(st.wpm || 20, 3) + ';' };
      const w = parseInt(arg, 10);
      return w > 0 ? { action: { wpm: w } } : {};
    }
    case 'PC': {
      if (!arg) return { reply: 'PC' + pad(st.powerW || 100, 3) + ';' };
      const w = parseInt(arg, 10);
      return w > 0 ? { action: { powerW: w } } : {};
    }
    case 'SM': return { reply: 'SM0' + pad(Math.round((Number(st.smeter) || 0) * 30 / 255), 4) + ';' };
    // RIT/XIT/split/NB/NR/preamp/attenuator: reported off, sets accepted and
    // ignored (POTACAT's own controls own them). RC (RIT clear) answers nothing.
    case 'RT': case 'XT': case 'SP': case 'NB': case 'NR': case 'PA': case 'RA':
      return arg ? {} : { reply: head + '0;' };
    case 'RC': return {};
    default: return { reply: '?;' };
  }
}

/**
 * The TCP server. hooks: getState() → state above; onAction(action, client).
 * Several clients may connect (N1MM plus a band decoder, say).
 */
function createTs2000Server(hooks, { host = '127.0.0.1', port } = {}) {
  const server = net.createServer((sock) => {
    sock.setNoDelay(true);
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      if (buf.length > 4096) buf = buf.slice(-4096);
      let i;
      while ((i = buf.indexOf(';')) >= 0) {
        const one = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let r = {};
        try { r = handleTs2000Command(one, hooks.getState()); } catch { r = { reply: '?;' }; }
        if (r.action) { try { hooks.onAction(r.action); } catch {} }
        if (r.reply && !sock.destroyed) sock.write(r.reply, 'latin1');
      }
    });
    sock.on('error', () => {});
    if (hooks.onClient) hooks.onClient(sock);
  });
  server.listen(port, host);
  return server;
}

module.exports = { handleTs2000Command, createTs2000Server, ifLine, kenwoodMode, MODE_TO_KENWOOD, KENWOOD_TO_MODE };
