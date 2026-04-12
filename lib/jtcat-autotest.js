'use strict';
/**
 * JTCAT automated QSO test — run from main.js setTimeout hook.
 * Tests FT8, FT4, FT2 on 20m and 15m with real on-air QSOs.
 */

const fs = require('fs');
const path = require('path');

const TESTS = [
  { band: '20m', mode: 'FT8', freq: 14074, cycleSec: 15, rxCycles: 3 },
  { band: '20m', mode: 'FT4', freq: 14080, cycleSec: 7.5, rxCycles: 3 },
  { band: '20m', mode: 'FT2', freq: 14074, cycleSec: 3.8, rxCycles: 3 },
  { band: '15m', mode: 'FT8', freq: 21074, cycleSec: 15, rxCycles: 3 },
  { band: '15m', mode: 'FT4', freq: 21140, cycleSec: 7.5, rxCycles: 3 },
  { band: '15m', mode: 'FT2', freq: 21074, cycleSec: 3.8, rxCycles: 3 },
];

const QSO_TIMEOUT_SEC = 90; // max time to complete a QSO attempt
const MAX_TX_POWER = 50;

module.exports = async function runTests({ tuneRadio, startJtcat, stopJtcat, ft8Engine: getEngine, smartSdr, sendCatLog, ipcMain, app, settings }) {
  const logPath = path.join(app.getPath('userData'), 'jtcat-test.log');
  fs.writeFileSync(logPath, '');
  const log = (msg) => {
    const ts = new Date().toISOString().slice(11, 23);
    const line = `[${ts}] ${msg}`;
    sendCatLog('[TEST] ' + msg);
    fs.appendFileSync(logPath, line + '\n');
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const results = [];

  log('=== JTCAT Full QSO Test Suite ===');
  log(`Callsign: ${settings.myCallsign || 'K3SBP'}, Grid: ${settings.grid || 'FN20'}`);
  log(`TX Power: ${MAX_TX_POWER}W max`);
  log(`Tests: ${TESTS.length} (${TESTS.map(t => t.band + ' ' + t.mode).join(', ')})`);

  // Set TX power
  if (smartSdr && smartSdr.connected) {
    smartSdr.setTxPower(MAX_TX_POWER);
    log(`Power set to ${MAX_TX_POWER}W via SmartSDR`);
  }

  // Open JTCAT popout for audio capture
  ipcMain.emit('jtcat-popout-open', {});
  await sleep(3000);
  log('JTCAT popout opened');

  for (let ti = 0; ti < TESTS.length; ti++) {
    const t = TESTS[ti];
    const testId = `${ti + 1}/${TESTS.length}`;
    log(`\n--- Test ${testId}: ${t.band} ${t.mode} on ${t.freq} kHz ---`);

    // Tune and start engine
    tuneRadio(t.freq, 'DIGU');
    await sleep(1500);

    const engine = getEngine();
    if (engine && engine._running) engine.stop();
    await sleep(500);
    startJtcat(t.mode);
    await sleep(1000);

    const eng = getEngine();
    if (!eng || !eng._running) {
      log(`FAIL: Engine not running for ${t.mode}`);
      results.push({ test: `${t.band} ${t.mode}`, decode: 'FAIL', qso: 'SKIP' });
      continue;
    }
    log(`Engine started: mode=${eng._mode} running=${eng._running}`);

    // Phase A: RX — collect decodes for N cycles
    const rxWaitMs = t.cycleSec * t.rxCycles * 1000 + 2000; // extra buffer
    let allDecodes = [];
    const dh = (d) => {
      const n = (d.results || []).length;
      if (n > 0) log(`  Decode cycle: ${n} decodes`);
      allDecodes = allDecodes.concat(d.results || []);
    };
    eng.on('decode', dh);
    log(`RX: Waiting ${(rxWaitMs / 1000).toFixed(0)}s for ${t.rxCycles} ${t.mode} cycles...`);
    await sleep(rxWaitMs);
    eng.removeListener('decode', dh);
    log(`RX complete: ${allDecodes.length} total decodes`);

    if (allDecodes.length === 0) {
      log(`No decodes on ${t.band} ${t.mode} — skipping QSO attempt`);
      results.push({ test: `${t.band} ${t.mode}`, decode: `FAIL (0 in ${t.rxCycles} cycles)`, qso: 'SKIP' });
      continue;
    }
    results.push({ test: `${t.band} ${t.mode}`, decode: `PASS (${allDecodes.length})` });

    // Phase B: Find best CQ to reply to
    const cqs = allDecodes.filter(d => d.text && d.text.startsWith('CQ '));
    if (cqs.length === 0) {
      log(`No CQs found in ${allDecodes.length} decodes — sending our own CQ`);
      // Send CQ instead
      eng._txEnabled = true;
      const myCall = settings.myCallsign || 'K3SBP';
      const myGrid = (settings.grid || 'FN20').substring(0, 4);
      eng.setTxMessage(`CQ ${myCall} ${myGrid}`);
      eng.setTxFreq(1500);
      eng.setTxSlot('auto');
      log(`TX: CQ ${myCall} ${myGrid} at 1500 Hz`);

      // Wait for a response (up to QSO_TIMEOUT_SEC)
      let gotReply = false;
      const rh = (d) => {
        for (const r of (d.results || [])) {
          if (r.text && r.text.includes(myCall)) {
            gotReply = true;
            log(`  Got reply: "${r.text}" db=${r.db}`);
          }
        }
      };
      eng.on('decode', rh);
      const waitStart = Date.now();
      while (!gotReply && Date.now() - waitStart < QSO_TIMEOUT_SEC * 1000) {
        await sleep(t.cycleSec * 1000);
      }
      eng.removeListener('decode', rh);
      eng._txEnabled = false;
      eng.setTxMessage('');
      log(`CQ result: ${gotReply ? 'Got reply!' : 'No reply in ' + QSO_TIMEOUT_SEC + 's'}`);
      results[results.length - 1].qso = gotReply ? 'REPLY RECEIVED' : 'NO REPLY';
      continue;
    }

    // Pick the strongest CQ
    const best = cqs.reduce((a, b) => (b.db > a.db ? b : a), cqs[0]);
    log(`Best CQ: "${best.text}" db=${best.db} df=${best.df.toFixed(0)}Hz`);

    // Extract callsign from CQ message
    const parts = best.text.split(/\s+/);
    let dxCall = '';
    if (parts[1] === 'DX' || parts[1] === 'POTA' || parts[1] === 'NA' || parts[1] === 'EU') {
      dxCall = parts[2] || '';
    } else {
      dxCall = parts[1] || '';
    }
    if (!dxCall) {
      log(`Could not extract callsign from "${best.text}" — skipping`);
      results[results.length - 1].qso = 'SKIP (bad CQ)';
      continue;
    }

    // Reply to the CQ
    const myCall = settings.myCallsign || 'K3SBP';
    const myGrid = (settings.grid || 'FN20').substring(0, 4);
    const replyMsg = `${dxCall} ${myCall} ${myGrid}`;
    eng._txEnabled = true;
    eng.setTxMessage(replyMsg);
    eng.setTxFreq(Math.round(best.df));
    eng.setTxSlot('auto');
    log(`TX: "${replyMsg}" at ${Math.round(best.df)} Hz (replying to ${dxCall})`);

    // Track QSO state
    let qsoPhase = 'grid-sent'; // grid-sent → report-sent → rr73-sent → done
    let txCount = 0;
    let qsoComplete = false;
    const qsoStart = Date.now();

    const txh = (d) => { txCount++; log(`  TX #${txCount}: "${d.message}" slot=${d.slot}`); };
    const txeh = () => { log(`  TX end`); };
    eng.on('tx-start', txh);
    eng.on('tx-end', txeh);

    const qrh = (d) => {
      for (const r of (d.results || [])) {
        if (!r.text) continue;
        const t = r.text.toUpperCase();
        if (t.includes(myCall)) {
          log(`  RX: "${r.text}" db=${r.db}`);
          // Check for signal report (e.g. "K3SBP DX1ABC -15")
          if (t.match(/-?\d{2}$/) && qsoPhase === 'grid-sent') {
            qsoPhase = 'report-rcvd';
            const report = t.match(/-?\d{2}$/)[0];
            const rrMsg = `${dxCall} ${myCall} R${report}`;
            eng.setTxMessage(rrMsg);
            log(`  → Sending R-report: "${rrMsg}"`);
          }
          // Check for RR73 or 73
          if ((t.includes('RR73') || t.includes(' 73')) && qsoPhase === 'report-rcvd') {
            qsoPhase = 'rr73-rcvd';
            eng.setTxMessage(`${dxCall} ${myCall} 73`);
            log(`  → Sending 73`);
            // QSO complete after sending 73
            setTimeout(() => {
              qsoComplete = true;
              eng._txEnabled = false;
              eng.setTxMessage('');
            }, t.cycleSec ? t.cycleSec * 1000 : 15000);
          }
        }
      }
    };
    eng.on('decode', qrh);

    // Wait for QSO to complete or timeout
    while (!qsoComplete && Date.now() - qsoStart < QSO_TIMEOUT_SEC * 1000) {
      await sleep(2000);
    }

    eng.removeListener('tx-start', txh);
    eng.removeListener('tx-end', txeh);
    eng.removeListener('decode', qrh);
    eng._txEnabled = false;
    eng.setTxMessage('');

    const elapsed = Math.round((Date.now() - qsoStart) / 1000);
    log(`QSO result: phase=${qsoPhase} txCount=${txCount} elapsed=${elapsed}s complete=${qsoComplete}`);
    results[results.length - 1].qso = qsoComplete ? `COMPLETE (${elapsed}s, ${txCount} TX)` : `${qsoPhase} (timeout ${elapsed}s, ${txCount} TX)`;
  }

  // Stop engine and restore power
  const eng = getEngine();
  if (eng) eng.stop();
  if (smartSdr && smartSdr.connected) smartSdr.setTxPower(100);
  log('\nRestored TX power to 100W');

  // Summary
  log('\n=== TEST SUMMARY ===');
  for (const r of results) {
    log(`${r.test}: decode=${r.decode || '?'} qso=${r.qso || '?'}`);
  }
  log('=== END ===');

  return results;
};
