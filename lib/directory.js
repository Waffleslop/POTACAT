// lib/directory.js — Fetch & parse HF Nets and SWL broadcast directory from Google Sheets CSV
const https = require('https');

const NETS_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vS_bScWO5wpOxl0VkXLkSJWQX04bduORlKV26qD0bozTtAWja7ewdDOyYdLeFRdlIKeLWx6FjjZBtQD/pub?output=csv&gid=2114262526';
const SWL_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vS_bScWO5wpOxl0VkXLkSJWQX04bduORlKV26qD0bozTtAWja7ewdDOyYdLeFRdlIKeLWx6FjjZBtQD/pub?output=csv&gid=820214356';

function fetchCsv(url) {
  return new Promise((resolve, reject) => {
    const get = (u, depth) => {
      if (depth > 5) return reject(new Error('Too many redirects'));
      https.get(u, { headers: { 'User-Agent': 'POTACAT/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return get(res.headers.location, depth + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }).on('error', reject);
    };
    get(url, 0);
  });
}

// Simple CSV parser handling quoted fields with commas
function parseCsvRows(csv) {
  const lines = csv.split('\n');
  const rows = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
        else if (ch === '"') { inQuotes = false; }
        else { current += ch; }
      } else {
        if (ch === '"') { inQuotes = true; }
        else if (ch === ',') { fields.push(current.trim()); current = ''; }
        else { current += ch; }
      }
    }
    fields.push(current.trim());
    rows.push(fields);
  }
  return rows;
}

function parseNetsCsv(csv) {
  const rows = parseCsvRows(csv);
  if (rows.length < 2) return [];
  const nets = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0]) continue;
    nets.push({
      name: r[0] || '',
      frequency: parseFloat(r[1]) || 0,
      mode: r[2] || 'SSB',
      days: r[3] || 'Daily',
      startTimeUtc: r[4] || '',
      duration: parseInt(r[5], 10) || 60,
      region: r[6] || '',
      url: r[7] || '',
      notes: r[8] || '',
    });
  }
  return nets;
}

function parseSwlCsv(csv) {
  const rows = parseCsvRows(csv);
  if (rows.length < 2) return [];
  const entries = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0]) continue;
    entries.push({
      station: r[0] || '',
      frequency: parseFloat(r[1]) || 0,
      mode: r[2] || 'AM',
      startTimeUtc: (r[3] || '').replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1'),
      endTimeUtc: (r[4] || '').replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1'),
      language: r[5] || '',
      powerKw: parseFloat(r[6]) || 0,
      regionTarget: r[7] || '',
      notes: r[8] || '',
    });
  }
  return entries;
}

async function fetchNets() {
  const csv = await fetchCsv(NETS_URL);
  return parseNetsCsv(csv);
}

async function fetchSwl() {
  const csv = await fetchCsv(SWL_URL);
  return parseSwlCsv(csv);
}

module.exports = { fetchNets, fetchSwl, parseNetsCsv, parseSwlCsv };
