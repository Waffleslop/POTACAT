// WWFF Spotline telnet re-spotter — one-shot DX spot via DXSpider at spots.wwff.co:7300
const net = require('net');

const WWFF_HOST = 'spots.wwff.co';
const WWFF_PORT = 7300;
const TIMEOUT = 10000;

/**
 * Post a re-spot to WWFF Spotline via telnet.
 * @param {Object} opts
 * @param {string} opts.activator  — activator callsign
 * @param {string} opts.spotter    — your callsign (login)
 * @param {string} opts.frequency  — frequency in kHz (string or number)
 * @param {string} opts.reference  — WWFF reference e.g. "VEFF-3789"
 * @param {string} opts.mode       — mode e.g. "SSB"
 * @param {string} [opts.comments] — optional comment
 * @returns {Promise<void>}
 */
function postWwffRespot({ activator, spotter, frequency, reference, mode, comments }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      if (err) reject(err); else resolve();
    };

    const sock = net.createConnection({ host: WWFF_HOST, port: WWFF_PORT }, () => {
      // Connected — wait for login prompt
    });

    const timer = setTimeout(() => finish(new Error('WWFF respot timed out')), TIMEOUT);

    let buf = '';
    let state = 'login'; // login -> prompt -> done

    sock.on('data', (chunk) => {
      buf += chunk.toString();

      if (state === 'login' && /login:|call:|Please enter your call/i.test(buf)) {
        state = 'prompt';
        buf = '';
        sock.write(spotter + '\r\n');
      } else if (state === 'prompt' && />\s*$/.test(buf)) {
        state = 'done';
        buf = '';
        const freqKhz = Math.round(parseFloat(frequency));
        const comment = [reference, mode, comments].filter(Boolean).join(' ');
        sock.write(`DX ${freqKhz} ${activator} ${comment}\r\n`);
        // Brief delay to let server acknowledge, then close
        setTimeout(() => {
          clearTimeout(timer);
          finish();
        }, 1500);
      }
    });

    sock.on('error', (err) => {
      clearTimeout(timer);
      finish(err);
    });

    sock.on('close', () => {
      clearTimeout(timer);
      finish(); // treat close as success if not already settled
    });
  });
}

module.exports = { postWwffRespot };
