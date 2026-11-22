'use strict';
// Where the rigctld POTACAT starts for a Hamlib radio listens, and where
// POTACAT dials it. Casey 2026-11-22: bind it to 127.0.0.1 unless remote
// access is set up.
//
// Without -T, rigctld listens on every network interface: anyone on the LAN
// (or beyond, on a forwarded port) could tune and key the radio, and Windows
// asks the operator for firewall permission each time a new rigctld.exe path
// appears. POTACAT is the only client of this rigctld and it connects over
// loopback. No setting reaches it from another machine today: remote control
// of the radio goes through ECHOCAT, and "rigctld Network" is a rigctld the
// operator runs elsewhere. So the bind is loopback always. If remote access to
// it is ever added, the switch belongs here and nowhere else.
//
// 127.0.0.1, not "localhost": on a dual-stack machine "localhost" can resolve
// to ::1, and a rigctld bound to 127.0.0.1 is not listening there.

const RIGCTLD_HOST = '127.0.0.1';
const RIGCTLD_DEFAULT_PORT = 4532;

/** The address POTACAT's rigctld binds. Loopback whatever the target says. */
function rigctldBindAddress(_target) {
  return RIGCTLD_HOST;
}

/** The listen part of rigctld's arguments: -T <bind> -t <port>. */
function rigctldListenArgs(port, target) {
  const n = Number(port);
  const p = Number.isInteger(n) && n >= 1 && n <= 65535 ? n : RIGCTLD_DEFAULT_PORT;
  return ['-T', rigctldBindAddress(target), '-t', String(p)];
}

module.exports = { RIGCTLD_HOST, RIGCTLD_DEFAULT_PORT, rigctldBindAddress, rigctldListenArgs };
