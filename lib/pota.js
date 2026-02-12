// POTA API client — fetches activator spots
const https = require('https');

const SPOT_URL = 'https://api.pota.app/spot/activator';

function fetchSpots() {
  return new Promise((resolve, reject) => {
    https.get(SPOT_URL, { headers: { 'User-Agent': 'flex-lookup/1.0' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Failed to parse POTA response'));
        }
      });
    }).on('error', reject);
  });
}

module.exports = { fetchSpots };
