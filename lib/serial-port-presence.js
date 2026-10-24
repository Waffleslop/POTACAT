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

/** Is `port` among the listed devices? Case-insensitive on Windows; macOS cu./tty. twins count as the same device. */
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

module.exports = { portOfTarget, isDevicePort, portListed };
