// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// TCI can turn these blocks off, but cannot read every setting or restore
// every NR algorithm. Use the local Zeus state and RX-only setters instead.
function createZeusFt8Rx(port, profileDir) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Zeus DSP recall needs a valid local engine port');
  }
  const base = `http://127.0.0.1:${port}`;
  const savedPath = path.join(profileDir, 'zeus-ft8-rx-restore.json');
  let busy = false;

  async function request(endpoint, body) {
    const options = { signal: AbortSignal.timeout(1500), redirect: 'error' };
    if (body) {
      options.method = 'POST';
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }
    const response = await fetch(base + endpoint, options);
    if (!response.ok) throw new Error(`Zeus ${endpoint} returned HTTP ${response.status}`);
    return response.json();
  }

  return async function setFt8Rx(enter, isReceiving) {
    if (busy) throw new Error('Wait for the current Zeus DSP change');
    if (!enter && !fs.existsSync(savedPath)) return;
    busy = true;
    try {
      const { agc, nr, squelch, autoAgcEnabled, rxLevelerEnabled, status } = await request('/api/state');
      if (status !== 'Connected' || !agc || !nr || !squelch ||
          typeof autoAgcEnabled !== 'boolean' || typeof rxLevelerEnabled !== 'boolean') {
        throw new Error('Zeus did not report its RX DSP settings');
      }
      const current = { agc, nr, squelch, autoAgcEnabled, rxLevelerEnabled };
      const saved = fs.existsSync(savedPath) ? JSON.parse(fs.readFileSync(savedPath, 'utf8')) : null;
      if (!isReceiving()) throw new Error('Wait for Zeus to return to receive');
      if (enter && !saved) {
        // Save before any change so a failed request or app restart can
        // still restore the original values on the next exit from FT8.
        const staged = savedPath + '.tmp';
        fs.writeFileSync(staged, JSON.stringify(current), { mode: 0o600, flush: true });
        fs.renameSync(staged, savedPath);
      }
      // Preserve the settings that tune each DSP block while switching its
      // mode or enable flag for FT8.
      const desired = enter ? {
        agc: { ...agc, mode: 'Fixed' },
        nr: { ...nr, nrMode: 'Off', nbMode: 'Off', anfEnabled: false, snbEnabled: false, nbpNotchesEnabled: false },
        squelch: { ...squelch, enabled: false },
        autoAgcEnabled: false,
        rxLevelerEnabled: false,
      } : saved;
      if (!desired?.agc || !desired.nr || !desired.squelch ||
          typeof desired.autoAgcEnabled !== 'boolean' || typeof desired.rxLevelerEnabled !== 'boolean') {
        throw new Error('The saved Zeus DSP settings are incomplete');
      }
      const changes = [
        ['/api/auto-agc', 'autoAgcEnabled', 'enabled'],
        ['/api/rx/agc', 'agc', 'agc'],
        ['/api/rx/nr', 'nr', 'nr'],
        ['/api/rx/squelch', 'squelch', 'squelch'],
        ['/api/rx/leveler', 'rxLevelerEnabled', 'enabled'],
      ];
      for (const [endpoint, key, field] of changes) {
        if (JSON.stringify(current[key]) === JSON.stringify(desired[key])) continue;
        if (!isReceiving()) throw new Error('Wait for Zeus to return to receive');
        await request(endpoint, { [field]: desired[key] });
      }
      if (!enter) fs.unlinkSync(savedPath);
    } finally {
      busy = false;
    }
  };
}

module.exports = { createZeusFt8Rx };
