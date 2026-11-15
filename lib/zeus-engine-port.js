'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

let lastDetectedPort;

function zeusLogPath() {
  const home = os.homedir();
  let dataDir = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  if (process.platform === 'win32') dataDir = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  if (process.platform === 'darwin') dataDir = path.join(home, 'Library', 'Application Support');
  return path.join(dataDir, 'Zeus', 'logs', 'zeus-app.log');
}

async function recentZeusPorts(logPath) {
  let log;
  try {
    log = await fs.open(logPath, 'r');
    const { size } = await log.stat();
    const buffer = Buffer.alloc(Math.min(size, 128 * 1024));
    const { bytesRead } = await log.read(buffer, 0, buffer.length, size - buffer.length);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const matches = text.matchAll(/Diagnostics Request (?:starting|finished) HTTP\/1\.1 GET http:\/\/(?:127\.0\.0\.1|localhost|x\.x\.x\.x):(\d{1,5})\/api\/(?:display\/bandwidth-spectrum|rx\/adc-protection|state)\b/g);
    return [...new Set([...matches].reverse().map(match => Number(match[1])))].filter(port => port > 0 && port <= 65535);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return [];
  } finally {
    await log?.close();
  }
}

function requestZeusEngine(port, endpoint, payload) {
  const body = payload == null ? null : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: endpoint,
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : undefined,
      signal: AbortSignal.timeout(1500),
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Zeus ${endpoint} returned HTTP ${response.statusCode}`));
        return;
      }
      response.setEncoding('utf8');
      let json = '';
      response.on('data', chunk => {
        json += chunk;
        if (json.length > 1024 * 1024) request.destroy(new Error('Zeus engine response is too large'));
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          resolve(JSON.parse(json));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function readZeusEngineState(port) {
  const state = await requestZeusEngine(port, '/api/state');
  if (typeof state.agc?.mode !== 'string' || typeof state.autoAgcEnabled !== 'boolean' ||
      typeof state.status !== 'string') throw new Error('The port did not report Zeus engine state');
  return { port, state };
}

async function findZeusEngineState(overridePort) {
  if (overridePort) {
    try {
      return await readZeusEngineState(overridePort);
    } catch (error) {
      if (error.code !== 'ECONNREFUSED') throw error;
      // A saved loopback port can go stale after the local engine restarts.
    }
  }
  if (lastDetectedPort) {
    try {
      return await readZeusEngineState(lastDetectedPort);
    } catch {
      lastDetectedPort = undefined;
    }
  }
  const logPath = zeusLogPath();
  const tried = new Set();
  for (const candidate of [logPath, logPath.replace(/\.log$/, '.1.log')]) {
    for (const port of (await recentZeusPorts(candidate)).slice(0, 3)) {
      if (tried.has(port)) continue;
      tried.add(port);
      try {
        const engine = await readZeusEngineState(port);
        lastDetectedPort = port;
        return engine;
      } catch {
        // A Zeus restart can leave an old port in the log.
      }
    }
  }
  return null;
}

const ZEUS_NR_MODES = ['Off', 'Anr', 'Emnr', 'Rnnr', 'Sbnr', 'Nnr'];

async function cycleZeusEngineNr(engine, canChange) {
  const current = engine.state.receivers?.[0]?.nrMode ?? engine.state.nr?.nrMode;
  const available = ZEUS_NR_MODES.filter(mode => mode !== 'Rnnr' || engine.state.wdspNr3RnnrAvailable !== false);
  const next = available[(available.indexOf(current) + 1) % available.length];
  if (!canChange()) return null;
  const state = await requestZeusEngine(engine.port, '/api/receivers/0', { nrMode: next });
  const confirmed = state.receivers?.[0]?.nrMode ?? state.nr?.nrMode;
  if (confirmed !== next) throw new Error('Zeus did not confirm the NR mode change');
  return ZEUS_NR_MODES.indexOf(confirmed);
}

module.exports = { findZeusEngineState, cycleZeusEngineNr };
