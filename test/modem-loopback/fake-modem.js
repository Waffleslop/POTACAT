'use strict';
// A stand-in modem for L4 (#187), its own process like ardopcf: connects to
// the modem audio socket, reads the receive audio (counting every sample it
// consumes), and on "go" on stdin writes a 1 kHz tone for --seconds, paced by
// its own clock with ardopcf's 100 ms lead (SocketAudio.c). On "count" it
// prints {"read": samples} on stdout.
//   node fake-modem.js --port 1234 --rate 12000 --seconds 120
const net = require('net');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('--port'));
const RATE = Number(arg('--rate', '12000'));
const SECONDS = Number(arg('--seconds', '120'));
let read = 0, carry = 0;
const sock = net.connect(PORT, '127.0.0.1');
sock.setNoDelay(true);
sock.on('data', (b) => { const n = b.length + carry; read += n >> 1; carry = n & 1; });
sock.on('error', () => {});
let writing = false;
function go() {
  if (writing) return;
  writing = true;
  const t0 = Date.now();
  let written = 0, phase = 0;
  const total = RATE * SECONDS;
  const tick = setInterval(() => {
    const due = Math.min(total, Math.floor((Date.now() - t0) / 1000 * RATE) + Math.round(RATE * 0.1)); // 100 ms ahead
    if (due > written) {
      const n = due - written;
      const b = Buffer.alloc(n * 2);
      for (let i = 0; i < n; i++) { b.writeInt16LE(Math.round(16000 * Math.sin(phase)), i * 2); phase += 2 * Math.PI * 1000 / RATE; }
      sock.write(b);
      written = due;
    }
    if (written >= total) { clearInterval(tick); process.stdout.write(JSON.stringify({ done: true, written }) + '\n'); }
  }, 10);
}
let line = '';
process.stdin.on('data', (d) => {
  line += d;
  let i;
  while ((i = line.indexOf('\n')) >= 0) {
    const cmd = line.slice(0, i).trim(); line = line.slice(i + 1);
    if (cmd === 'go') go();
    if (cmd === 'count') process.stdout.write(JSON.stringify({ read }) + '\n');
    if (cmd === 'reset') { read = 0; process.stdout.write(JSON.stringify({ reset: true }) + '\n'); }
    if (cmd === 'quit') { sock.destroy(); process.exit(0); }
  }
});
sock.on('connect', () => process.stdout.write(JSON.stringify({ connected: true }) + '\n'));
