// Conditions popout — standalone window showing solar + propagation.
// Mirrors the data shape of the main `solar-data` IPC (hamqsl XML +
// NOAA Kp history + SWPC alerts), and reuses the same theme tokens
// as the rest of the app via styles.css.

(function () {
  'use strict';

  document.documentElement.setAttribute('data-platform', window.api.platform || '');
  document.body.classList.add('platform-' + (window.api.platform || 'unknown'));

  // ---------------------------------------------------------------------
  // Window chrome
  // ---------------------------------------------------------------------
  document.getElementById('tb-min').addEventListener('click', () => window.api.minimize());
  document.getElementById('tb-max').addEventListener('click', () => window.api.maximize());
  document.getElementById('tb-close').addEventListener('click', () => window.api.close());
  // On macOS the system chrome ("hiddenInset") draws traffic lights, so
  // hide our custom controls to avoid double sets.
  if (window.api.platform === 'darwin') {
    const ctrls = document.querySelector('.titlebar-controls');
    if (ctrls) ctrls.style.display = 'none';
  }
  // Esc closes — Conditions is read-only so there's no save-on-close gotcha.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.api.close(); });

  // Ctrl/Cmd + wheel → zoom step. preventDefault stops Chromium's own
  // pinch-zoom (which would scale the page in addition to our IPC step
  // and feel sluggish). passive:false is required for preventDefault.
  window.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    if (e.deltaY === 0) return;
    window.api.zoomBy(e.deltaY < 0 ? +1 : -1);
  }, { passive: false });

  // ---------------------------------------------------------------------
  // Theme — hydrate from settings, then live updates
  // ---------------------------------------------------------------------
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
  }
  window.api.onTheme(applyTheme);
  window.api.getSettings().then((s) => {
    if (s && s.lightMode) applyTheme('light');
  }).catch(() => {});

  // ---------------------------------------------------------------------
  // Refresh button — kicks an out-of-cycle fetch
  // ---------------------------------------------------------------------
  const conditionsBody = document.getElementById('conditions-body');
  const conditionsUpdated = document.getElementById('conditions-updated');
  document.getElementById('conditions-refresh-btn').addEventListener('click', () => {
    conditionsUpdated.textContent = 'refreshing…';
    window.api.refreshSolar();
  });

  // ---------------------------------------------------------------------
  // Render helpers (ported from app.js — see git history of that file
  // for thresholds + tooltip text). Kept self-contained so the popout
  // has no dependency on app.js.
  // ---------------------------------------------------------------------
  function _condClass(condition) {
    const c = String(condition || '').toLowerCase();
    if (c === 'good') return 'good';
    if (c === 'fair') return 'fair';
    if (c === 'poor') return 'poor';
    return 'unknown';
  }
  function _vhfClass(status) {
    const s = String(status || '').toLowerCase();
    if (s.includes('open')) return 'open';
    if (s.includes('closed')) return 'closed';
    return 'unknown';
  }
  function _vhfLabel(name) {
    return ({
      'vhf-aurora':  'VHF Aurora',
      'e-skip_6m':   'E-skip 6m',
      'e-skip_4m':   'E-skip 4m',
      'e-skip_2m':   'E-skip 2m',
      'path_eu_6m':  '6m → EU',
      'path_na_6m':  '6m → NA',
    }[name] || name.replace(/_/g, ' '));
  }
  function _kpBarClass(kp) {
    if (kp <= 2) return '';
    if (kp <= 4) return 'warn';
    return 'bad';
  }
  function _formatKpTime(t) {
    if (!t) return '';
    const parts = t.split(' ');
    if (parts.length < 2) return t;
    return parts[1].slice(0, 5) + 'Z';
  }

  function renderConditions(payload) {
    if (!payload || payload.sfi == null) {
      conditionsBody.innerHTML = '<div class="conditions-empty">No data yet — waiting for hamqsl.com / NOAA SWPC…</div>';
      conditionsUpdated.textContent = '—';
      return;
    }

    const p = payload;
    conditionsUpdated.textContent = p.updated ? ('Updated ' + p.updated) : 'Updated just now';

    const sfiClass = p.sfi >= 120 ? 'good' : p.sfi >= 90 ? 'warn' : 'bad';
    const snClass  = (p.sunspots ?? 0) >= 100 ? 'good' : (p.sunspots ?? 0) >= 40 ? 'warn' : 'bad';
    const kClass   = p.kIndex <= 2 ? 'good' : p.kIndex <= 4 ? 'warn' : 'bad';
    const aClass   = p.aIndex <= 7 ? 'good' : p.aIndex <= 20 ? 'warn' : 'bad';

    const xrayLetter = (p.xray || '').trim().charAt(0).toUpperCase();
    const xrayClass = (xrayLetter === 'A' || xrayLetter === 'B') ? 'good'
                    : (xrayLetter === 'C') ? 'warn'
                    : (xrayLetter === 'M' || xrayLetter === 'X') ? 'bad' : '';

    const heNum = parseInt(p.heliumLine, 10);
    const heClass = !Number.isNaN(heNum)
      ? (heNum >= 150 ? 'good' : heNum >= 100 ? 'warn' : 'bad') : '';

    const swNum = parseInt(p.solarWind, 10);
    const swClass = !Number.isNaN(swNum)
      ? (swNum < 400 ? 'good' : swNum < 600 ? 'warn' : 'bad') : '';

    const bzNum = parseFloat(p.magneticField);
    const bzClass = !Number.isNaN(bzNum)
      ? (bzNum >= 0 ? 'good' : bzNum > -5 ? 'warn' : 'bad') : '';

    const sfiSub = p.sfi >= 120 ? 'strong' : p.sfi >= 90 ? 'moderate' : p.sfi >= 70 ? 'weak' : 'very weak';
    const snSub  = (p.sunspots ?? 0) >= 100 ? 'high' : (p.sunspots ?? 0) >= 40 ? 'moderate' : 'low';
    const xraySub = xrayLetter === 'X' ? 'major flare' : xrayLetter === 'M' ? 'moderate' : xrayLetter === 'C' ? 'minor' : 'quiet';
    const heSub  = !Number.isNaN(heNum) ? (heNum >= 150 ? 'strong' : heNum >= 100 ? 'moderate' : 'weak') : 'helium';
    const swSub  = !Number.isNaN(swNum) ? (swNum < 400 ? 'calm' : swNum < 600 ? 'elevated' : 'high') : 'km/s';
    const bzSub  = !Number.isNaN(bzNum) ? (bzNum >= 0 ? 'northward' : bzNum > -5 ? 'mild south' : 'storm-prone') : 'nT';
    const kSub   = p.kIndex <= 1 ? 'very quiet' : p.kIndex <= 2 ? 'quiet'
                 : p.kIndex <= 3 ? 'unsettled' : p.kIndex <= 4 ? 'active'
                 : p.kIndex <= 5 ? 'minor storm' : p.kIndex <= 6 ? 'moderate storm'
                 : p.kIndex <= 7 ? 'strong storm' : 'severe storm';
    const aSub   = p.aIndex <= 7 ? 'quiet' : p.aIndex <= 15 ? 'unsettled'
                 : p.aIndex <= 30 ? 'active' : p.aIndex <= 50 ? 'minor storm'
                 : 'major storm';

    const TIP = {
      sfi:    'Solar Flux Index — 10.7 cm radio flux from the Sun, a proxy for ionization. >120 supports good HF DX; <90 means weak F-layer.',
      sn:     'International Sunspot Number — Wolf number. Higher = more solar activity = better HF propagation.',
      xray:   'Background X-ray flux class. A/B = quiet, C = minor flare, M = moderate (R1–R2 blackout possible), X = major (R3+).',
      he304:  '304 Å EUV emission (helium II). Drives F-layer ionization that bends HF signals back to Earth. >150 strong.',
      muf:    'Maximum Usable Frequency — highest frequency that reflects off the F-layer for a typical 3000 km hop right now.',
      fof2:   'F2 critical frequency — highest signal a vertical wave will reflect back. Sets your local NVIS ceiling.',
      proton: 'Proton flux (≥10 MeV). Elevated levels indicate a solar particle event and may cause polar HF blackouts.',
      electron:'Electron flux (≥2 MeV). Elevated levels stress satellites and can degrade VHF/UHF satellite QSOs.',
      snoise: 'Estimated band noise floor in S-units. Higher = more atmospheric / geomagnetic QRN.',
      norm:   'Hamqsl normalization factor used in the band conditions calculation.',
      k:      'Planetary K-index — 3-hour geomagnetic activity (0–9 quasi-log scale). 0–2 quiet, 5+ storm.',
      a:      'Planetary A-index — daily linear-scale geomagnetic activity. <7 quiet, >30 storm.',
      sw:     'Solar wind speed at L1 (km/s). <400 nominal, >600 elevated and likely to disturb the geomagnetic field.',
      bz:     'Bz — Z-component of the interplanetary magnetic field (nT). Strong negative Bz couples with Earth\'s field and triggers storms.',
      field:  'Geomagnetic field state — N0NBH descriptor (quiet / unsettled / active / storm).',
      aurora: 'Aurora activity level (0–10). Higher = stronger oval = more chance of VHF aurora and HF polar blackouts.',
      auroraLat:'Estimated southernmost latitude where the aurora oval is currently visible.',
      kpnt:   'Estimated near-real-time Kp from N0NBH (NoaaTec) — finer-grained companion to the planetary K above.',
    };

    const solarCard = `
      <div class="cond-card card-solar">
        <h3>Solar Activity</h3>
        <div class="cond-hero-row">
          <div class="cond-hero ${sfiClass}" title="${TIP.sfi}">
            <div class="hero-label">SFI</div>
            <div class="hero-value">${p.sfi}</div>
            <div class="hero-sub">${sfiSub}</div>
          </div>
          <div class="cond-hero ${snClass}" title="${TIP.sn}">
            <div class="hero-label">Sunspots</div>
            <div class="hero-value">${p.sunspots ?? '—'}</div>
            <div class="hero-sub">${snSub}</div>
          </div>
          <div class="cond-hero ${xrayClass}" title="${TIP.xray}">
            <div class="hero-label">X-Ray</div>
            <div class="hero-value" style="font-size:18px">${p.xray ?? '—'}</div>
            <div class="hero-sub">${xraySub}</div>
          </div>
          <div class="cond-hero ${heClass}" title="${TIP.he304}">
            <div class="hero-label">304 Å</div>
            <div class="hero-value" style="font-size:18px">${p.heliumLine ?? '—'}</div>
            <div class="hero-sub">${heSub}</div>
          </div>
        </div>
        <div class="cond-kv">
          <div class="kv-row" title="${TIP.muf}"><span class="kv-label">MUF</span><span class="kv-value">${p.muf ? p.muf + ' MHz' : '—'}</span></div>
          <div class="kv-row" title="${TIP.fof2}"><span class="kv-label">foF2</span><span class="kv-value">${p.fof2 ? p.fof2 + ' MHz' : '—'}</span></div>
          <div class="kv-row" title="${TIP.proton}"><span class="kv-label">Proton flux</span><span class="kv-value dim">${p.protonFlux ?? '—'}</span></div>
          <div class="kv-row" title="${TIP.electron}"><span class="kv-label">Electron flux</span><span class="kv-value dim">${p.electronFlux ?? '—'}</span></div>
          <div class="kv-row" title="${TIP.snoise}"><span class="kv-label">Signal noise</span><span class="kv-value">${p.signalNoise ?? '—'}</span></div>
          <div class="kv-row" title="${TIP.norm}"><span class="kv-label">Normalization</span><span class="kv-value dim">${p.normalization ?? '—'}</span></div>
        </div>
      </div>`;

    const geoCard = `
      <div class="cond-card card-geo">
        <h3>Geomagnetic</h3>
        <div class="cond-hero-row">
          <div class="cond-hero ${kClass}" title="${TIP.k}">
            <div class="hero-label">K-index</div>
            <div class="hero-value">${p.kIndex}</div>
            <div class="hero-sub">${kSub}</div>
          </div>
          <div class="cond-hero ${aClass}" title="${TIP.a}">
            <div class="hero-label">A-index</div>
            <div class="hero-value">${p.aIndex}</div>
            <div class="hero-sub">${aSub}</div>
          </div>
          <div class="cond-hero ${swClass}" title="${TIP.sw}">
            <div class="hero-label">SW Speed</div>
            <div class="hero-value" style="font-size:18px">${p.solarWind ?? '—'}</div>
            <div class="hero-sub">${swSub}</div>
          </div>
          <div class="cond-hero ${bzClass}" title="${TIP.bz}">
            <div class="hero-label">Bz</div>
            <div class="hero-value" style="font-size:18px">${p.magneticField ?? '—'}</div>
            <div class="hero-sub">${bzSub}</div>
          </div>
        </div>
        <div class="cond-kv">
          <div class="kv-row" title="${TIP.field}"><span class="kv-label">Field state</span><span class="kv-value">${p.geomagField ?? '—'}</span></div>
          <div class="kv-row" title="${TIP.aurora}"><span class="kv-label">Aurora</span><span class="kv-value">${p.aurora ?? '—'}</span></div>
          <div class="kv-row" title="${TIP.auroraLat}"><span class="kv-label">Aurora limit</span><span class="kv-value">${p.latDegree ? p.latDegree + '°' : '—'}</span></div>
          <div class="kv-row" title="${TIP.kpnt}"><span class="kv-label">Kp (NT)</span><span class="kv-value dim">${p.kIndexNt ?? '—'}</span></div>
        </div>
      </div>`;

    let bandsRows = '';
    if (Array.isArray(p.bands) && p.bands.length) {
      const byBand = new Map();
      for (const b of p.bands) {
        if (!byBand.has(b.band)) byBand.set(b.band, { day: null, night: null });
        byBand.get(b.band)[b.time] = b.condition;
      }
      for (const [band, slot] of byBand) {
        bandsRows += `<tr>
          <td class="band-name">${band}</td>
          <td><span class="cond-cell ${_condClass(slot.day)}">${slot.day || '—'}</span></td>
          <td><span class="cond-cell ${_condClass(slot.night)}">${slot.night || '—'}</span></td>
        </tr>`;
      }
    }
    const bandsCard = `
      <div class="cond-card card-bands">
        <h3>HF Bands</h3>
        ${bandsRows
          ? `<table class="cond-bands-table">
               <thead><tr><th>Band</th><th>Day</th><th>Night</th></tr></thead>
               <tbody>${bandsRows}</tbody>
             </table>`
          : '<div class="cond-alerts-empty">No band ratings reported.</div>'}
      </div>`;

    let vhfRows = '';
    if (Array.isArray(p.vhf) && p.vhf.length) {
      for (const v of p.vhf) {
        vhfRows += `<tr>
          <td>${_vhfLabel(v.phenomenon)}</td>
          <td style="color:var(--text-tertiary);font-size:11px">${v.location.replace(/_/g, ' ')}</td>
          <td><span class="cond-cell ${_vhfClass(v.status)}">${v.status}</span></td>
        </tr>`;
      }
    }
    const vhfCard = `
      <div class="cond-card card-vhf">
        <h3>VHF / E-Skip</h3>
        ${vhfRows
          ? `<table class="cond-bands-table">
               <thead><tr><th>Mode</th><th>Region</th><th>Status</th></tr></thead>
               <tbody>${vhfRows}</tbody>
             </table>`
          : '<div class="cond-alerts-empty">No VHF data.</div>'}
      </div>`;

    let kpSparkHtml = '<div class="cond-alerts-empty">No Kp history yet.</div>';
    if (Array.isArray(p.kpHistory) && p.kpHistory.length) {
      const bars = p.kpHistory.map((s) => {
        const h = Math.max(8, Math.min(100, (s.kp / 9) * 100));
        return `<div class="bar ${_kpBarClass(s.kp)}" style="height:${h}%" title="${s.time}  Kp=${s.kp.toFixed(2)}"><span class="lbl">${s.kp.toFixed(1)}</span></div>`;
      }).join('');
      const latest = p.kpHistory[p.kpHistory.length - 1];
      const peak = p.kpHistory.reduce((m, s) => s.kp > m ? s.kp : m, 0);
      kpSparkHtml = `
        <div class="kp-spark-wrap">
          <div class="kp-spark">${bars}</div>
          <div class="kp-spark-axis">
            <span>${_formatKpTime(p.kpHistory[0].time)}</span>
            <span>now</span>
          </div>
        </div>
        <div class="kp-current-strip">
          <span>Current: <strong>${latest.kp.toFixed(2)}</strong></span>
          <span>24h peak: <strong>${peak.toFixed(2)}</strong></span>
        </div>`;
    }
    const kpCard = `
      <div class="cond-card card-kp">
        <h3>Kp — last 24 hours</h3>
        ${kpSparkHtml}
      </div>`;

    let alertsHtml = '<div class="cond-alerts-empty">No space-weather alerts in the last 24 hours.</div>';
    if (Array.isArray(p.alerts) && p.alerts.length) {
      alertsHtml = '<ul class="cond-alerts">' + p.alerts.map((a) => {
        const msg = (a.message || '').slice(0, 360);
        const severity = /severe|extreme|G[45]/i.test(msg) ? 'severe'
                       : /moderate|warning|alert|G[123]|M\d|X\d/i.test(msg) ? 'warn' : '';
        return `<li class="${severity}">
          <span class="alert-time">${a.issue_datetime || ''}</span>
          <span class="alert-msg">${msg.replace(/</g, '&lt;')}</span>
        </li>`;
      }).join('') + '</ul>';
    }
    const alertsCard = `
      <div class="cond-card card-alerts">
        <h3>NOAA SWPC Alerts (last 24 h)</h3>
        ${alertsHtml}
      </div>`;

    conditionsBody.innerHTML = solarCard + geoCard + bandsCard + vhfCard + kpCard + alertsCard;
  }

  // ---------------------------------------------------------------------
  // Wire up data updates + paint initial cached state
  // ---------------------------------------------------------------------
  window.api.onSolarData(renderConditions);
  window.api.getSolar().then((cached) => {
    if (cached && (cached.sfi != null || cached.kpHistory || cached.alerts)) {
      renderConditions(cached);
    } else {
      renderConditions(null);
      conditionsUpdated.textContent = 'fetching…';
      window.api.refreshSolar();
    }
  }).catch(() => renderConditions(null));
})();
