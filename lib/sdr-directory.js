'use strict';
//
// Curated directory of public KiwiSDR / WebSDR.org receivers, used by the
// "Browse..." picker in Settings → WebSDR. Every entry was probed live on
// 2026-05-01: GET /status (KiwiSDR) or GET / (WebSDR.org) returned a
// well-formed response. Host self-reported metadata (loc, bands) was also
// captured then.
//
// Stations come and go — that's the nature of hobbyist-run receivers. The
// "find more" links in Settings point at the live directories so users can
// always discover currently-online sites. The manual Label/Host fields are
// still the authoritative input; this list is just a quick-pick convenience.
//
// Adding a station: probe with `node scripts/probe-sdrs.js`, paste a new
// entry in the appropriate region group, sorted alphabetically.
//

const STATIONS = [
  // ── Recommended (long-running, institutional) ──────────────────────────
  {
    label: 'Twente',
    host: 'websdr.ewi.utwente.nl',
    port: 8901,
    type: 'WebSDR.org',
    location: 'Twente, Netherlands',
    region: 'Europe',
    coverage: 'HF (0–29 MHz)',
    notes: 'University-operated since 2008; canonical reference site',
    recommended: true,
  },
  {
    label: 'KPH Coast',
    host: 'kphsdr.com',
    port: 8073,
    type: 'KiwiSDR',
    location: 'Point Reyes, California',
    region: 'USA',
    coverage: 'HF (0–30 MHz)',
    notes: 'Maritime Radio Historical Society at the historic KPH coastal station',
    recommended: true,
  },
  {
    label: 'Bucks PA',
    host: 'bucks.hopto.org',
    port: 8073,
    type: 'KiwiSDR',
    location: 'Bucks County, PA',
    region: 'USA',
    coverage: 'HF (0–30 MHz)',
    recommended: true,
  },

  // ── USA & Canada ───────────────────────────────────────────────────────
  {
    label: 'K3FEF',
    host: 'k3fef.com',
    port: 8073,
    type: 'KiwiSDR',
    location: 'Milford, Pennsylvania',
    region: 'USA',
    coverage: 'HF (0–30 MHz)',
  },
  {
    label: 'WA2ZKD',
    host: 'sdr.wa2zkd.net',
    port: 8073,
    type: 'KiwiSDR',
    location: 'Rochester, New York',
    region: 'USA',
    coverage: 'HF (10 kHz–30 MHz)',
  },
  {
    label: 'NA5B',
    host: 'na5b.com',
    port: 8902,
    type: 'WebSDR.org',
    location: 'Washington DC area',
    region: 'USA',
    coverage: 'VHF/UHF (6m, 2m, 70cm, airband, weather)',
    notes: 'No HF coverage — VHF and up only',
  },
  {
    label: 'KFS Kansas',
    host: 'websdr1.kfsdr.com',
    port: 8901,
    type: 'WebSDR.org',
    location: 'Kansas, USA',
    region: 'USA',
    coverage: 'HF (ham bands only)',
  },
  {
    label: 'ATX TX',
    host: 'atxsdr.zapto.org',
    port: 8073,
    type: 'KiwiSDR',
    location: 'Austin, Texas',
    region: 'USA',
    coverage: 'HF (0–30 MHz)',
  },
  {
    label: 'Caprock TX',
    host: 'data3.caprockweather.com',
    port: 8073,
    type: 'KiwiSDR',
    location: 'Lubbock, Texas',
    region: 'USA',
    coverage: 'HF + 6m (0–32 MHz)',
  },

  // ── Europe ─────────────────────────────────────────────────────────────
  {
    label: 'DB0OVP',
    host: 'db0ovp.de',
    port: 8073,
    type: 'KiwiSDR',
    location: 'Greifswald, Germany',
    region: 'Europe',
    coverage: 'HF (0–30 MHz)',
  },
  {
    label: 'DF0TWN',
    host: 'df0twn.dnsuser.de',
    port: 8073,
    type: 'KiwiSDR',
    location: 'Bad Bentheim, Germany',
    region: 'Europe',
    coverage: 'HF (0–30 MHz)',
  },
  {
    label: 'DB0BBB',
    host: 'db0bbb.dnshome.de',
    port: 8073,
    type: 'KiwiSDR',
    location: 'Bernau bei Berlin, Germany',
    region: 'Europe',
    coverage: 'HF (0–30 MHz)',
  },
  {
    label: 'DL1KGT',
    host: 'dl1kgt.hopto.org',
    port: 8073,
    type: 'KiwiSDR',
    location: 'Niederkassel, Germany',
    region: 'Europe',
    coverage: 'HF (3–30 MHz)',
  },
  {
    label: 'Aspliden',
    host: 'aspliden.kostet.se',
    port: 8074,
    type: 'KiwiSDR',
    location: 'Måla, Northern Sweden',
    region: 'Europe',
    coverage: 'HF (0–30 MHz)',
    notes: 'Quiet Arctic site; excellent on LF',
  },
  {
    label: 'EchoFox FR',
    host: 'echofox.fr',
    port: 8073,
    type: 'KiwiSDR',
    location: 'Tours, France',
    region: 'Europe',
    coverage: 'HF (6–30 MHz)',
  },
  {
    label: 'F4JOY',
    host: 'f4joy.ddns.net',
    port: 8073,
    type: 'KiwiSDR',
    location: 'Pradières, France',
    region: 'Europe',
    coverage: 'HF (0–30 MHz)',
  },
  {
    label: 'DijonSE',
    host: 'dijonse.fr',
    port: 8073,
    type: 'KiwiSDR',
    location: 'Bourgogne, France',
    region: 'Europe',
    coverage: 'HF (0–30 MHz)',
  },
  {
    label: 'Argyll UK',
    host: 'argyllsdr.ddns.net',
    port: 8073,
    type: 'KiwiSDR',
    location: 'Tighnabruaich, W Scotland',
    region: 'Europe',
    coverage: 'HF (0–30 MHz)',
  },

  // ── Asia / Pacific ─────────────────────────────────────────────────────
  {
    label: 'BV7AU',
    host: 'bv7au.ddns.net',
    port: 8073,
    type: 'KiwiSDR',
    location: 'Pingtung, Taiwan',
    region: 'Asia/Pacific',
    coverage: 'HF (0–30 MHz)',
  },
  {
    label: 'DS1TUW',
    host: 'ds1tuw.iptime.org',
    port: 8073,
    type: 'KiwiSDR',
    location: 'Seoul, South Korea',
    region: 'Asia/Pacific',
    coverage: 'HF (0–30 MHz)',
  },
  {
    label: 'Barossa AU',
    host: 'barossa.servebeer.com',
    port: 8073,
    type: 'KiwiSDR',
    location: 'Angaston, South Australia',
    region: 'Asia/Pacific',
    coverage: 'HF (0–30 MHz)',
  },
];

module.exports = { STATIONS };
