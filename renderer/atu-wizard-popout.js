// Tuner Memories pop-out — the ATU Calibration Wizard's window.
//
// Five pages, one footer. The window shows the plan main built and the
// readings main pushes (`atu-wizard-state`); every decision — which point is
// legal, when to key, what a reading means, when to stop — is main's
// (lib/atu-wizard.js). STOP is in the footer on every page while a run is
// live and unkeys at once.
function _applyPopoutTheme(payload) {
  // The shared rule (popout-theme-boot*.js) also sets data-ds (#376).
  if (window.applyPopoutTheme) return window.applyPopoutTheme(payload);
  const theme = typeof payload === 'string' ? payload : ((payload && payload.theme) || 'dark');
  const variant = (payload && typeof payload === 'object' && payload.variant) || 'navy';
  document.documentElement.setAttribute('data-theme', theme);
  if (theme === 'dark' && variant !== 'navy') document.documentElement.setAttribute('data-dark-variant', variant);
  else document.documentElement.removeAttribute('data-dark-variant');
}
'use strict';

const $ = (id) => document.getElementById(id);
const PAGES = ['preflight', 'plan', 'review', 'run', 'results'];
const MODES = ['CW', 'DIGITAL', 'SSB'];
const MODE_LABEL = { CW: 'CW', DIGITAL: 'Digital', SSB: 'SSB' };
const COLOUR = { NATIVE: 'green', TUNED: 'green', RECALLED: 'green', MARGINAL: 'amber', FAILED: 'red', SKIPPED: 'grey', TIMEOUT: 'red' };
const RESULT_TEXT = { NATIVE: 'Good as is', TUNED: 'Tuned', RECALLED: 'Recalled', MARGINAL: 'Marginal', FAILED: 'Failed', SKIPPED: 'Skipped', TIMEOUT: 'No answer' };

let info = null;          // atu-wizard-get payload
let page = 'preflight';
let state = null;         // last run state from main
let plan = { points: [], dropped: [], estimateMs: 0 };
let unticked = new Set(); // point ids the operator unticked on Review
const custom = [];
let lastRunShown = null;

document.body.classList.add('platform-' + window.api.platform);
$('aw-min').onclick = () => window.api.minimize();
$('aw-max').onclick = () => window.api.maximize();
$('aw-close').onclick = () => window.api.close();
window.api.onPopoutTheme(_applyPopoutTheme);

const fmtSwr = (v) => (Number.isFinite(v) ? v.toFixed(1) + ':1' : '—');
const fmtMhz = (khz) => FreqDots.fromKhz(khz); // the VFO way, 14.074.00
const fmtMin = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? 'under a minute' : `about ${m} minute${m === 1 ? '' : 's'}`; };
const fmtAtu = (s) => (s ? String(s).replace(/^TUNE_/, '').replace(/_/g, ' ').toLowerCase() : '—');

function show(p) {
  page = p;
  for (const id of PAGES) $('page-' + id).classList.toggle('show', id === p);
  document.querySelectorAll('.aw-step').forEach(el => {
    el.classList.toggle('on', el.dataset.step === p);
    el.classList.toggle('done', PAGES.indexOf(el.dataset.step) < PAGES.indexOf(p));
  });
  renderFooter();
}

function running() { return !!(state && (state.phase === 'running' || state.phase === 'paused')); }

function renderFooter() {
  const live = running();
  $('f-back').style.display = live || page === 'preflight' ? 'none' : '';
  $('f-pause').style.display = live ? '' : 'none';
  $('f-skip').style.display = live && !state.verify ? '' : 'none';
  $('f-stop').style.display = live ? '' : 'none';
  $('f-pause').textContent = state && state.phase === 'paused' ? 'Resume' : 'Pause';
  const results = page === 'results' && state && !live;
  $('f-verify').style.display = results && !state.verify && state.summary && state.summary.done > 0 ? '' : 'none';
  $('f-csv').style.display = results ? '' : 'none';
  const next = $('f-next');
  next.style.display = live ? 'none' : '';
  if (page === 'preflight') { next.textContent = 'Next'; next.disabled = !(info && info.available && $('pf-antenna').checked && $('pf-amp').checked); }
  else if (page === 'plan') { next.textContent = 'Review the plan'; next.disabled = false; }
  else if (page === 'review') { next.textContent = `Start (${selectedPoints().length} points)`; next.disabled = selectedPoints().length === 0; }
  else if (page === 'run') { next.textContent = 'Results'; next.disabled = !state; }
  else { next.textContent = 'Run again'; next.disabled = false; }
}

// ─── 1. Preflight ───
async function refreshInfo() {
  info = await window.api.get();
  const pills = $('pf-pills');
  pills.innerHTML = '';
  const pill = (ok, text) => { const s = document.createElement('span'); s.className = 'aw-pill ' + (ok === true ? 'ok' : ok === false ? 'bad' : 'warn'); s.textContent = text; pills.appendChild(s); };
  pill(info.connected, info.rig ? `${info.rig.name || info.rig.model || 'Radio'}${info.connected ? ' connected' : ' not connected'}` : 'No active rig');
  pill(info.mode === 'self' ? true : info.mode ? false : null, info.mode === 'self' ? 'Flex Direct' : info.mode === 'bound' ? 'Sharing with SmartSDR' : 'Mode unknown');
  pill(info.atu && info.atu.status != null ? true : null, info.atu && info.atu.status != null ? `Tuner: ${fmtAtu(info.atu.status)}` : 'Tuner not reported yet');
  pill(info.atu && info.atu.memories_enabled === '1' ? true : null, info.atu && info.atu.memories_enabled === '1' ? 'Memories on' : 'Memories off (turned on by the run)');
  if (info.antennaPort) pill(true, `Antenna ${info.antennaPort}`);
  const reason = $('pf-reason');
  reason.classList.toggle('show', !info.available);
  reason.classList.toggle('bad', !info.available);
  reason.textContent = info.available ? '' : info.reason;
  $('pf-call').textContent = info.callsign ? `The run transmits short unmodulated carriers under ${info.callsign}. POTACAT shows your callsign here so you can identify when the rules ask you to.` : 'Set your callsign in Settings before transmitting.';
  $('s-class').value = classLabel(info.licenseClass);
  if (!$('s-power').value) {
    $('s-power').value = info.defaults.tunePowerW; $('s-swr').value = info.defaults.swrThreshold; $('s-density').value = info.defaults.density;
    $('s-dwell').value = Math.round(info.defaults.dwellMs / 1000); $('s-pause').value = Math.round(info.defaults.pauseMs / 1000); $('s-busy').value = info.defaults.busyAction;
  }
  buildGrid();
  renderRuns();
  if (info.state && !state) applyState(info.state);
  renderFooter();
}
function classLabel(c) { return { us_extra: 'US Extra', us_general: 'US General', us_technician: 'US Technician', ca_basic: 'Canada Basic', ca_honours: 'Canada Basic with Honours' }[c] || 'Not set (full band edges)'; }
$('pf-antenna').onchange = renderFooter;
$('pf-amp').onchange = renderFooter;

// ─── 2. Plan ───
const DEFAULT_BANDS = new Set(['40m', '30m', '20m', '17m', '15m', '12m', '10m']);
function buildGrid() {
  const g = $('plan-grid');
  if (g.dataset.built) return;
  g.dataset.built = '1';
  const hd = (t) => { const d = document.createElement('div'); d.className = 'hd'; d.textContent = t; g.appendChild(d); };
  hd('Band'); for (const m of MODES) hd(MODE_LABEL[m]);
  for (const band of info.bands) {
    const d = document.createElement('div'); d.textContent = band; g.appendChild(d);
    for (const m of MODES) {
      const cell = document.createElement('div');
      if (band === '30m' && m === 'SSB') { cell.textContent = '—'; cell.style.color = 'var(--text-secondary)'; g.appendChild(cell); continue; }
      const l = document.createElement('label'); l.className = 'aw-check';
      const c = document.createElement('input'); c.type = 'checkbox'; c.dataset.band = band; c.dataset.mode = m; c.checked = DEFAULT_BANDS.has(band);
      l.appendChild(c); cell.appendChild(l); g.appendChild(cell);
    }
  }
  const cb = $('c-band'); cb.innerHTML = '';
  for (const band of info.bands) { const o = document.createElement('option'); o.value = band; o.textContent = band; cb.appendChild(o); }
  if (info.bands.includes('40m')) cb.value = '40m';
}
function selection() {
  const bands = new Set(), modes = new Set(), pairs = new Set();
  document.querySelectorAll('#plan-grid input:checked').forEach(c => { bands.add(c.dataset.band); modes.add(c.dataset.mode); pairs.add(c.dataset.band + ':' + c.dataset.mode); });
  return { bands: [...bands], modes: [...modes], pairs };
}
function settingsFromForm() {
  return {
    tunePowerW: Math.min(25, Math.max(1, parseFloat($('s-power').value) || 10)),
    swrThreshold: Math.min(5, Math.max(1.1, parseFloat($('s-swr').value) || 2)),
    density: $('s-density').value,
    dwellMs: Math.max(2, parseInt($('s-dwell').value, 10) || 3) * 1000,
    pauseMs: Math.max(0, parseInt($('s-pause').value, 10) || 0) * 1000,
    busyAction: $('s-busy').value,
  };
}
$('c-add').onclick = () => {
  const mhz = parseFloat($('c-mhz').value);
  if (!Number.isFinite(mhz)) return;
  custom.push({ band: $('c-band').value, mode: $('c-mode').value, freqKhz: Math.round(mhz * 10000) / 10, label: $('c-label').value.trim() || 'custom' });
  $('c-mhz').value = ''; $('c-label').value = '';
  renderCustom();
};
function renderCustom() {
  const ul = $('c-list'); ul.innerHTML = '';
  custom.forEach((c, i) => {
    const li = document.createElement('li');
    li.textContent = `${c.band} ${MODE_LABEL[c.mode]} ${fmtMhz(c.freqKhz)} MHz — ${c.label} `;
    const b = document.createElement('button'); b.className = 'aw-btn'; b.textContent = 'Remove'; b.onclick = () => { custom.splice(i, 1); renderCustom(); };
    li.appendChild(b); ul.appendChild(li);
  });
}

// ─── 3. Review ───
async function buildReview() {
  const sel = selection();
  const s = settingsFromForm();
  plan = await window.api.plan({ bands: sel.bands, modes: sel.modes, density: s.density, custom, settings: s });
  // The grid is per band AND mode; the plan is per band × modes, so drop the unticked pairs here.
  plan.points = plan.points.filter(p => sel.pairs.has(p.band + ':' + p.mode) || p.label === 'custom' || custom.some(c => c.freqKhz === p.freqKhz));
  unticked = new Set();
  const tb = $('rv-table').querySelector('tbody'); tb.innerHTML = '';
  for (const p of plan.points) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="checkbox" checked data-id="${p.id}"></td><td>${p.band}</td><td>${MODE_LABEL[p.mode]}</td><td>${fmtMhz(p.freqKhz)}</td><td>${p.label || ''}</td>`;
    tr.querySelector('input').onchange = (e) => { if (e.target.checked) unticked.delete(p.id); else unticked.add(p.id); renderReviewSummary(); };
    tb.appendChild(tr);
  }
  const d = $('rv-dropped');
  d.classList.toggle('show', plan.dropped.length > 0);
  d.textContent = plan.dropped.length ? `Left out under ${classLabel(info.licenseClass)}: ` + plan.dropped.map(x => `${fmtMhz(x.freqKhz)} ${MODE_LABEL[x.mode]} (${x.reason})`).join('; ') : '';
  renderReviewSummary();
}
function selectedPoints() { return plan.points.filter(p => !unticked.has(p.id)); }
function renderReviewSummary() {
  const n = selectedPoints().length;
  const s = settingsFromForm();
  $('rv-summary').textContent = `${n} point${n === 1 ? '' : 's'} at ${s.tunePowerW} W, ${fmtMin(plan.estimateMs * (n / Math.max(1, plan.points.length)))}. Untick anything you do not want transmitted on.`;
  renderFooter();
}

// ─── 4. Run / 5. Results ───
async function startRun(verify) {
  const points = verify ? state.points.filter(p => p.result && p.result !== 'SKIPPED') : selectedPoints();
  const res = await window.api.start({ points, settings: settingsFromForm(), verify: !!verify });
  if (!res.ok) { $('f-note').textContent = res.reason; setTimeout(() => { $('f-note').textContent = ''; }, 8000); return; }
  $('f-note').textContent = '';
  show('run');
}
function pointRow(p, now) {
  const tr = document.createElement('tr');
  if (now) tr.className = 'now'; else if (!p.result) tr.className = 'dim';
  const r = p.result ? `<span class="res ${COLOUR[p.result] || ''}">${RESULT_TEXT[p.result] || p.result}</span>` : (now ? 'measuring…' : '');
  tr.innerHTML = `<td>${p.band}</td><td>${MODE_LABEL[p.mode] || p.mode}</td><td>${fmtMhz(p.freqKhz)}</td><td>${fmtSwr(p.bypassSwr)}</td><td>${fmtSwr(p.tunedSwr)}</td><td>${p.usingMem ? 'memory' : fmtAtu(p.atuStatus)}</td><td>${r}</td>`;
  return tr;
}
function applyState(s) {
  state = s;
  const live = running();
  if (live && page !== 'run') show('run');
  if (page === 'run' || live) {
    $('run-title').textContent = s.verify ? (live ? 'Verifying the memories' : 'Verification finished') : (s.phase === 'paused' ? 'Paused' : live ? 'Filling the tuner memories' : s.phase === 'stopped' ? 'Stopped' : 'Finished');
    const sum = s.summary || { done: 0, total: 0 };
    const cur = s.index >= 0 ? s.points[s.index] : null;
    $('run-line').textContent = cur ? `Point ${s.index + 1} of ${sum.total}: ${cur.band} ${MODE_LABEL[cur.mode] || cur.mode} ${fmtMhz(cur.freqKhz)} MHz${s.keyed ? ' — transmitting' : ''}` : `${sum.done} of ${sum.total} points done`;
    $('run-bar').style.width = sum.total ? `${Math.round(100 * sum.done / sum.total)}%` : '0';
    const b = $('run-banner');
    const text = s.phase === 'paused' ? `Paused: ${s.pauseReason}. Press Resume to continue.` : s.phase === 'stopped' ? `Stopped: ${s.stopReason}` : '';
    b.classList.toggle('show', !!text); b.classList.toggle('bad', s.phase === 'stopped'); b.textContent = text;
    $('run-busy').classList.toggle('show', !!s.asking);
    if (s.asking) $('run-busy-dbm').textContent = Number.isFinite(s.asking.peakDbm) ? `${Math.round(s.asking.peakDbm)} dBm heard` : 'signal heard';
    const tb = $('run-table').querySelector('tbody'); tb.innerHTML = '';
    s.points.forEach((p, i) => tb.appendChild(pointRow(p, i === s.index)));
    const nowRow = tb.querySelector('tr.now'); if (nowRow) nowRow.scrollIntoView({ block: 'nearest' });
  }
  if (!live && (s.phase === 'done' || s.phase === 'stopped')) {
    renderResults(s);
    if (page === 'run') show('results');
  }
  renderFooter();
}
function renderResults(s) {
  const sum = s.summary;
  $('res-title').textContent = s.verify ? 'Verification results' : (s.phase === 'stopped' ? `Stopped early: ${s.stopReason}` : 'Results');
  const box = $('res-summary'); box.innerHTML = '';
  const tile = (n, l) => { const d = document.createElement('div'); d.innerHTML = `<div class="n">${n}</div><div class="l">${l}</div>`; box.appendChild(d); };
  tile(sum.green, 'match'); tile(sum.counts.NATIVE, 'good as is'); tile(sum.counts.TUNED, 'tuned'); tile(sum.counts.RECALLED, 'recalled');
  tile(sum.counts.MARGINAL, 'marginal'); tile(sum.counts.FAILED + sum.counts.TIMEOUT, 'failed'); tile(sum.counts.SKIPPED, 'skipped');
  const adv = $('res-advice'); adv.classList.toggle('show', !!s.advice); adv.classList.toggle('ok', !sum.problems); adv.textContent = s.advice || '';
  if (!s.advice && sum.done > 0) { adv.classList.add('show', 'ok'); adv.textContent = s.verify ? 'Every point recalled a memory or needs no tuner.' : 'Every measured point matches. The radio now recalls these on every band change.'; }
  const tr = $('res-trend');
  const flags = s.trend || [];
  const b = s.bands || null;
  const bandLines = [];
  if (b && b.hidden && b.hidden.length) bandLines.push(`No tuner match on ${b.hidden.join(', ')}: hidden from this radio's bands, so their spots are not shown. Run again to re-check; a match puts them back.`);
  if (b && b.restored && b.restored.length) bandLines.push(`${b.restored.join(', ')} matched this time and are back in this radio's bands.`);
  if (b && b.noMatch && b.noMatch.length && !(b.hidden && b.hidden.length)) bandLines.push(`Still hidden from this radio's bands (no tuner match): ${b.noMatch.join(', ')}.`);
  if (flags.length) bandLines.push('Since the previous run the antenna looks worse here (bypass SWR up by more than 0.5): ' + flags.map(f => `${f.band} ${fmtMhz(f.freqKhz)} MHz ${f.from.toFixed(1)} → ${f.to.toFixed(1)}`).join('; ') + '. An early sign of coax or antenna trouble.');
  tr.classList.toggle('show', bandLines.length > 0);
  tr.textContent = bandLines.join(' ');
  const tb = $('res-table').querySelector('tbody'); tb.innerHTML = '';
  for (const p of s.points) tb.appendChild(pointRow(p, false));
  lastRunShown = s.saved || null;
  refreshInfo();
}
function renderRuns() {
  const ul = $('res-runs'); ul.innerHTML = '';
  if (!info || !info.runs.length) { ul.innerHTML = '<li style="color:var(--text-secondary)">None yet.</li>'; return; }
  for (const r of info.runs) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.textContent = `${new Date(r.at).toLocaleString()} — ${r.verify ? 'verification' : 'calibration'}, ${r.green} of ${r.total} match${r.problems ? `, ${r.problems} to look at` : ''}${r.phase === 'stopped' ? ' (stopped early)' : ''}`;
    a.onclick = async () => {
      const run = await window.api.runGet(r.file);
      if (!run) return;
      const points = run.points || [];
      const counts = {}; for (const k of Object.keys(COLOUR)) counts[k] = points.filter(p => p.result === k).length;
      const green = counts.NATIVE + counts.TUNED + counts.RECALLED;
      applyState({ phase: run.phase || 'done', verify: run.verify, index: -1, points, stopReason: run.stopReason, saved: r.file, trend: [], advice: '',
        summary: { total: points.length, done: points.filter(p => p.result).length, counts, green, problems: points.filter(p => p.result && !['NATIVE', 'TUNED', 'RECALLED', 'SKIPPED'].includes(p.result)).length } });
      show('results');
    };
    li.appendChild(a); ul.appendChild(li);
  }
}

// ─── footer ───
$('f-back').onclick = () => { const i = PAGES.indexOf(page); if (i > 0) show(PAGES[i - 1]); };
$('f-next').onclick = async () => {
  if (page === 'preflight') { await refreshInfo(); if (info.available) show('plan'); }
  else if (page === 'plan') { await buildReview(); show('review'); }
  else if (page === 'review') startRun(false);
  else if (page === 'run') { if (state) { renderResults(state); show('results'); } }
  else { await refreshInfo(); show('plan'); }
};
$('f-pause').onclick = () => { if (state && state.phase === 'paused') window.api.resume(); else window.api.pause(); };
$('f-skip').onclick = () => window.api.skip();
$('f-stop').onclick = () => window.api.stop();
$('f-verify').onclick = () => startRun(true);
$('f-csv').onclick = async () => { const r = await window.api.exportCsv(lastRunShown); $('f-note').textContent = r.ok ? `Saved ${r.path}` : (r.reason === 'cancelled' ? '' : r.reason); setTimeout(() => { $('f-note').textContent = ''; }, 8000); };
$('busy-skip').onclick = () => window.api.busy('skip');
$('busy-shift').onclick = () => window.api.busy('shift');
$('busy-go').onclick = () => window.api.busy('go');

window.api.onState(applyState);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && running()) window.api.stop();
  if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) window.api.setZoom(Math.min(2, window.api.getZoom() + 0.1));
  if ((e.ctrlKey || e.metaKey) && e.key === '-') window.api.setZoom(Math.max(0.6, window.api.getZoom() - 0.1));
});
show('preflight');
refreshInfo();
setInterval(() => { if (page === 'preflight' && !running()) refreshInfo(); }, 3000);
