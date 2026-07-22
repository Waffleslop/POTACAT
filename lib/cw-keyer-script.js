'use strict';

// Builds the inline Python for the PERSISTENT CW keyer used on serial ports
// whose driver rejects node-serialport's TIOCMSET (Linux cp210x / cdc_acm —
// the KM4CFT FT-891 case, and any radio whose built-in USB is a CP2105).
//
// One long-running python process OWNS the port and toggles the keying line
// via pyserial (which uses TIOCMBIS/TIOCMBIC, accepted where TIOCMSET is not),
// driven by newline-terminated commands on stdin:
//   '1'                 key down
//   '0'                 key up
//   'A'                 abort in-flight text, key up
//   'T <wpm> <MESSAGE>' render Morse for MESSAGE at <wpm> (interruptible)
//   'Q'                 quit (also quits on stdin EOF)
//
// Unifying real-time paddle keying (1/0 from the iambic keyer) and text macros
// (T ...) through a SINGLE owner avoids the per-message open/close the old
// spawn-per-send used — which is why paddle keying (touchscreen key / TinyMIDI)
// couldn't work on these ports before. `select` on stdin is POSIX-only, which
// is fine: these ports only reject TIOCMSET on Linux (on Windows cp210x honors
// it and node-serialport is used instead), so the persistent keyer is gated to
// non-win32 by the caller.
//
// Pure + dependency-free so the generated script is unit-testable.

/**
 * @param {object} o
 * @param {string} o.portPath  serial device path
 * @param {string} o.line      'dtr' | 'rts' | 'both' — which modem line follows the key
 * @param {object} o.morse     char -> dot/dash string table
 * @returns {string} python source for `python3 -c`
 */
function buildPersistentKeyerScript({ portPath, line, morse } = {}) {
  const keyLine = line === 'rts' ? 'rts' : (line === 'both' ? 'both' : 'dtr');
  const setBody =
    keyLine === 'both' ? '    port.dtr = on\n    port.rts = on\n'
    : keyLine === 'rts' ? '    port.rts = on\n'
    : '    port.dtr = on\n';
  // portPath and message reach python inside single-quoted literals; the caller
  // sanitizes the message to a quote/backslash-free charset, and we strip any
  // stray quote/backslash from the path defensively.
  const escPath = String(portPath == null ? '' : portPath).replace(/[\\']/g, '');
  const morseJson = JSON.stringify(morse || {});
  return (
    'import sys, select, time, json, serial\n' +
    'port = serial.Serial()\n' +
    `port.port = '${escPath}'\n` +
    'port.baudrate = 4800\n' +
    'port.dtr = False\n' +
    'port.rts = False\n' +
    'port.open()\n' +
    `MORSE = json.loads('${morseJson.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')\n` +
    'def key(on):\n' +
    setBody +
    'def readcmd(timeout):\n' +
    '    r, _, _ = select.select([sys.stdin], [], [], timeout)\n' +
    '    if r:\n' +
    '        s = sys.stdin.readline()\n' +
    '        if s == "": return "Q"\n' +
    '        return s.strip()\n' +
    '    return None\n' +
    'try:\n' +
    '    key(False)\n' +
    '    while True:\n' +
    '        cmd = readcmd(None)\n' +
    '        if cmd is None: continue\n' +
    '        if cmd == "Q": break\n' +
    '        elif cmd == "1": key(True)\n' +
    '        elif cmd == "0": key(False)\n' +
    '        elif cmd == "A": key(False)\n' +
    '        elif cmd[:1] == "T":\n' +
    '            parts = cmd.split(" ", 2)\n' +
    '            if len(parts) < 3: continue\n' +
    '            wpm = max(5, min(60, int(parts[1]) if parts[1].isdigit() else 20))\n' +
    '            DIT = 1.2 / wpm; DAH = 3 * DIT\n' +
    '            brk = False\n' +
    '            for ch in parts[2]:\n' +
    '                if ch == " ":\n' +
    '                    time.sleep(7 * DIT)\n' +
    '                elif ch in MORSE:\n' +
    '                    for sym in MORSE[ch]:\n' +
    '                        key(True); time.sleep(DIT if sym == "." else DAH)\n' +
    '                        key(False); time.sleep(DIT)\n' +
    '                    time.sleep(2 * DIT)\n' +
    '                nxt = readcmd(0)\n' +
    '                if nxt is not None:\n' +
    '                    key(False)\n' +
    '                    if nxt == "Q": brk = True\n' +
    '                    elif nxt == "1": key(True)\n' +
    '                    break\n' +
    '            if brk: break\n' +
    'finally:\n' +
    '    key(False)\n' +
    '    port.close()\n'
  );
}

module.exports = { buildPersistentKeyerScript };
