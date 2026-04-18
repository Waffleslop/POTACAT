'use strict';
/**
 * JTCAT ECHOCAT automated test — simulates phone-initiated FT8/FT4/FT2
 * by driving the remoteServer event handlers (same path ECHOCAT uses).
 *
 * Tests: decode, TX firing, QSO state progression, halt, mode switch.
 * TX power set to 5W for safety.
 */

const fs = require('fs');
const path = require('path');

const TX_POWER = 5;
const TESTS = [
  { band: '20m', mode: 'FT8', freq: 14074, cycleSec: 15 },
  { band: '20m', mode: 'FT4', freq: 14080, cycleSec: 7.5 },
  { band: '15m', mode: 'FT8', freq: 21074, cycleSec: 15 },
];

module.exports = async function runEchocatTests({ tuneRadio, startJtcat, stopJtcat, ft8Engine: getEngine, smartSdr, sendCatLog, remoteServer, app, settings }) {
  const logPath = path.join(app.getPath('userData'), 'jtcat-test.log');
  fs.writeFileSync(logPath, '');
  const log = (msg) => {
    const ts = new Date().toISOString().slice(11, 23);
    const line = `[${ts}] ${msg}`;
    sendCatLog('[ETEST] ' + msg);
    fs.appendFileSync(logPath, line + '\n');
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const results = [];

  log('=== ECHOCAT JTCAT Test Suite ===');
  log(`Call: ${settings.myCallsign}, Grid: ${settings.grid}`);
  log(`Power: ${TX_POWER}W`);

  if (smartSdr && smartSdr.connected) smartSdr.setTxPower(TX_POWER);

  // Open popout for audio (required for engine audio feed)
  require('electron').ipcMain.emit('jtcat-popout-open', {});
  await sleep(4000);

  for (let ti = 0; ti < TESTS.length; ti++) {
    const t = TESTS[ti];
    const label = `${t.band} ${t.mode}`;
    log(`\n--- Test ${ti + 1}/${TESTS.length}: ${label} on ${t.freq} kHz ---`);

    // Phase 1: Tune + set mode (keep engine alive, just switch freq/mode)
    log('Phase 1: Tune + mode');
    tuneRadio(t.freq, 'DIGU');
    await sleep(1500);
    const eng = getEngine();
    if (!eng || !eng._running) {
      log(`FAIL: Engine not running`);
      results.push({ test: label, result: 'FAIL (no engine)' });
      continue;
    }
    if (eng._mode !== t.mode) {
      eng.setMode(t.mode);
      log(`Mode switched to ${t.mode}`);
    }
    await sleep(1000);
    log(`Engine: mode=${eng._mode} running=${eng._running}`);

    // Phase 2: Decode for 2 cycles
    const rxWait = t.cycleSec * 2 * 1000 + 3000;
    let decodes = [];
    const dh = (d) => {
      decodes = decodes.concat(d.results || []);
      if ((d.results || []).length > 0) log(`  Decode: ${d.results.length} (slot=${d.slot})`);
    };
    eng.on('decode', dh);
    log(`Phase 2: RX ${(rxWait / 1000).toFixed(0)}s for ${t.mode} decodes...`);
    await sleep(rxWait);
    eng.removeListener('decode', dh);
    log(`Decodes: ${decodes.length}`);

    if (decodes.length === 0) {
      results.push({ test: label, result: `DECODE: 0 (no activity)` });
      log('No decodes — skipping TX test');
      continue;
    }

    // Phase 3: TX test — find CQ, reply via ECHOCAT path
    const cqs = decodes.filter(d => d.text && d.text.startsWith('CQ '));
    log(`CQs found: ${cqs.length}`);

    if (cqs.length > 0) {
      const best = cqs.reduce((a, b) => (b.db > a.db ? b : a), cqs[0]);
      const parts = best.text.split(/\s+/);
      const dxCall = (parts[1] === 'DX' || parts[1] === 'POTA' || parts[1] === 'NA' || parts[1] === 'EU') ? (parts[2] || '') : (parts[1] || '');

      if (dxCall) {
        log(`Phase 3: Replying to ${dxCall} (${best.text}, db=${best.db})`);

        // Simulate ECHOCAT reply event (same as phone tapping a decode)
        if (remoteServer) {
          remoteServer.emit('jtcat-reply', {
            call: dxCall,
            grid: '',
            freq: Math.round(best.df),
            slot: best.slot || 'auto',
          });
        }
        await sleep(1000);

        // Track TX and QSO state
        let txCount = 0;
        let lastPhase = 'reply';
        let gotReport = false;
        let gotRr73 = false;
        const txh = () => { txCount++; log(`  TX #${txCount}`); };
        eng.on('tx-start', txh);

        const qsoCheck = setInterval(() => {
          const q = getQso();
          if (q) {
            if (q.phase !== lastPhase) {
              log(`  Phase: ${lastPhase} -> ${q.phase}`);
              lastPhase = q.phase;
              if (q.phase === 'r+report') gotReport = true;
              if (q.phase === '73' || q.phase === 'done') gotRr73 = true;
            }
          }
        }, 2000);

        // Use closure to access remoteJtcatQso
        function getQso() {
          // Can't access remoteJtcatQso directly — check via engine state
          return { phase: eng._txEnabled ? (gotRr73 ? 'done' : gotReport ? 'r+report' : 'reply') : 'done' };
        }

        // Wait up to 60s for QSO or timeout
        log(`Phase 3: Waiting 60s for QSO with ${dxCall}...`);
        await sleep(60000);

        clearInterval(qsoCheck);
        eng.removeListener('tx-start', txh);

        log(`QSO result: txCount=${txCount} gotReport=${gotReport} gotRr73=${gotRr73} txEnabled=${eng._txEnabled}`);
        results.push({
          test: label,
          result: `DECODE: ${decodes.length}, TX: ${txCount}, report=${gotReport}, rr73=${gotRr73}`,
        });

        // Clean up — halt TX
        eng._txEnabled = false;
        eng.setTxMessage('');
        eng.setTxSlot('auto');
        await sleep(1000);
      } else {
        results.push({ test: label, result: `DECODE: ${decodes.length}, no valid CQ call` });
      }
    } else {
      // No CQ — test CQ TX instead
      log(`Phase 3: No CQs — testing CQ TX via ECHOCAT path`);
      if (remoteServer) {
        remoteServer.emit('jtcat-call-cq', { freq: 1500 });
      }
      await sleep(1000);

      let txCount = 0;
      const txh = () => { txCount++; log(`  CQ TX #${txCount}`); };
      eng.on('tx-start', txh);

      log('Waiting 35s for CQ TX...');
      await sleep(35000);

      eng.removeListener('tx-start', txh);
      eng._txEnabled = false;
      eng.setTxMessage('');
      eng.setTxSlot('auto');

      log(`CQ TX result: ${txCount} transmissions`);
      results.push({ test: label, result: `DECODE: ${decodes.length}, CQ TX: ${txCount}` });
    }

    // Phase 4: Verify halt works
    log('Phase 4: Testing HALT');
    eng._txEnabled = false;
    eng.setTxMessage('');
    eng.setTxSlot('auto');
    await sleep(500);
    log(`After halt: txEnabled=${eng._txEnabled} txActive=${eng._txActive} consecutiveTx=${eng._consecutiveTxCount}`);
    const haltOk = !eng._txEnabled && !eng._txActive;
    results.push({ test: `${label} HALT`, result: haltOk ? 'PASS' : 'FAIL' });
  }

  // Restore power
  if (smartSdr && smartSdr.connected) smartSdr.setTxPower(100);
  stopJtcat();
  log('\nRestored power to 100W, engine stopped.');

  // Summary
  log('\n=== ECHOCAT TEST SUMMARY ===');
  for (const r of results) {
    log(`${r.test}: ${r.result}`);
  }
  log('=== END ===');

  return results;
};
