'use strict';
/**
 * Is the radio's serial port there at all? (G90 owner, 2026-10-24: radio
 * unplugged, COM5 gone, and POTACAT flapped "Radio link restored" / "Radio
 * link lost" for as long as it ran. rigctld starts and listens even when it
 * cannot open the port, so the TCP connect to it read as a link, then ten
 * seconds of silence as a loss, then the transport reconnected — forever.)
 *
 * Pure decisions; main does the listing (serialport's SerialPort.list()).
 */

/** The local serial device a CAT target opens, or '' (network targets, no-CAT, Flex, Icom Network). */
function portOfTarget(target) {
  if (!target) return '';
  if (target.type === 'rigctld') return String(target.serialPort || '').trim();
  if (target.type === 'serial') return String(target.path || '').trim();
  return '';
}

/** A device path this check can judge: COMn on Windows, /dev/... elsewhere. Anything else (a host:port, a pipe) is assumed present. */
function isDevicePort(port, platform = process.platform) {
  const p = String(port || '').trim();
  if (!p) return false;
  if (platform === 'win32') return /^(\\\\\.\\)?COM\d+$/i.test(p);
  return p.startsWith('/dev/');
}

/**
 * Is `port` among the listed devices? Case-insensitive on Windows; macOS cu./tty. twins count as the same device.
 * On Linux/macOS main asks the filesystem FIRST (`fs.existsSync`): a /dev/serial/by-id/
 * symlink is never in serialport's list, which names the /dev/ttyUSBn it points at.
 */
function portListed(port, listed, platform = process.platform) {
  const norm = (s) => {
    let v = String(s || '').trim();
    if (platform === 'win32') v = v.replace(/^\\\\\.\\/, '').toUpperCase();
    if (platform === 'darwin') v = v.replace(/^\/dev\/(cu|tty)\./, '/dev/@.');
    return v;
  };
  const want = norm(port);
  return (listed || []).some((x) => norm(x && typeof x === 'object' ? x.path : x) === want);
}

/**
 * The ports Windows itself records (`reg query HKLM\HARDWARE\DEVICEMAP\SERIALCOMM`).
 * serialport's list misses ports whose driver registers no COM-port
 * interface (virtual pairs, port sharers, some older USB-serial drivers), and
 * a port missing from that list alone must never be called "not there": the
 * radio would never be connected (Ten-Tec Jupiter owner, 2026-10-24).
 * Lines look like `    \Device\Serial0    REG_SZ    COM1`.
 */
function parseSerialCommRegistry(stdout) {
  const out = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /\sREG_SZ\s+(\S+)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

module.exports = { portOfTarget, isDevicePort, portListed, parseSerialCommRegistry };
